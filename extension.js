const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { exec, execFile, spawn } = require('child_process');
const { compileSourceFile } = require('./src/compiler');
const { debugFlags } = require('./src/debugIntegration');
const { DebugBuildCache } = require('./src/debugCache');
const debugBuildCache = new DebugBuildCache();

// Global variables
let statusBarInternal;
let statusBarExternal;
let statusBarCompile;
let compileStatus;
let HaveBuildTask = false;
let cache = {};
let sidebarPanel;
const compileOutput = vscode.window.createOutputChannel('dream-cpp-compiler:编译器输出', 'log');
const commandOutput = vscode.window.createOutputChannel('dream-cpp-compiler', {log: true});
let fileConfigs = {};

// 每个终端里正在运行的 shell 命令数量。只有当终端确实有命令在运行时才发送 Ctrl+C：
// 向空闲的 shell 写入 ETX(\x03) 会让 cmd.exe 以 STATUS_CONTROL_C_EXIT(-1073741510) 退出，
// 这正是内置终端“编译成功、运行时却提示终端进程已终止”的根因。
const terminalsWithRunningCommand = new Map();

function trackTerminalShellExecutions(context) {
    if (typeof vscode.window.onDidStartTerminalShellExecution === 'function') {
        context.subscriptions.push(vscode.window.onDidStartTerminalShellExecution((e) => {
            terminalsWithRunningCommand.set(e.terminal, (terminalsWithRunningCommand.get(e.terminal) || 0) + 1);
        }));
    }
    if (typeof vscode.window.onDidEndTerminalShellExecution === 'function') {
        context.subscriptions.push(vscode.window.onDidEndTerminalShellExecution((e) => {
            const left = (terminalsWithRunningCommand.get(e.terminal) || 0) - 1;
            if (left > 0) terminalsWithRunningCommand.set(e.terminal, left);
            else terminalsWithRunningCommand.delete(e.terminal);
        }));
    }
    if (typeof vscode.window.onDidCloseTerminal === 'function') {
        context.subscriptions.push(vscode.window.onDidCloseTerminal((terminal) => {
            terminalsWithRunningCommand.delete(terminal);
        }));
    }
}

// 单引号转义，用于 POSIX shell / AppleScript 中的路径
function shellEscapePosix(value) {
    return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function shellEscapeWin(value) {
    return `"${String(value).replace(/"/g, '""').replace(/%/g, '%%')}"`;
}

function appleScriptEscape(str) {
    return String(str).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r?\n/g, '\\n');
}

// 把命令模板切成 argv。必须按平台区分：
// Windows 的反斜杠是路径分隔符（CommandLineToArgvW 语义），只有双引号成对才算转义；
// 之前一律把 \ 当转义符，导致 "C:\mingw64\bin\g++.exe" 被切成 "C:mingw64bing++.exe"，
// Windows 上任何绝对路径都会 ENOENT。
function parseShellTokens(cmd, platform) {
    const text = String(cmd == null ? '' : cmd);
    const isWindows = (platform || process.platform) === 'win32';
    const tokens = [];
    let cur = '';
    let started = false;
    let inSingle = false, inDouble = false;
    const flush = () => { if (started) { tokens.push(cur); cur = ''; started = false; } };

    for (let i = 0; i < text.length; i++) {
        const ch = text[i];

        if (isWindows) {
            if (ch === '"') {
                if (inDouble && text[i + 1] === '"') { cur += '"'; i++; continue; }
                inDouble = !inDouble;
                started = true;
                continue;
            }
            if (!inDouble && /\s/.test(ch)) { flush(); continue; }
            cur += ch;
            started = true;
            continue;
        }

        if (inSingle) {
            if (ch === "'") inSingle = false; else cur += ch;
            started = true;
            continue;
        }
        if (inDouble) {
            if (ch === '\\' && i + 1 < text.length && '"\\$`\n'.includes(text[i + 1])) {
                cur += text[++i]; started = true; continue;
            }
            if (ch === '"') { inDouble = false; continue; }
            cur += ch; started = true;
            continue;
        }
        if (ch === '\\' && i + 1 < text.length) { cur += text[++i]; started = true; continue; }
        if (ch === "'") { inSingle = true; started = true; continue; }
        if (ch === '"') { inDouble = true; started = true; continue; }
        if (/\s/.test(ch)) { flush(); continue; }
        cur += ch; started = true;
    }
    flush();
    return tokens;
}

function spawnAsync(command, args, options = {}) {
    return new Promise((resolve, reject) => {
        const { spawn } = require('child_process');
        const proc = spawn(command, args, { ...options, windowsHide: true });
        let stdout = '', stderr = '';
        proc.stdout && proc.stdout.on('data', c => stdout += c.toString());
        proc.stderr && proc.stderr.on('data', c => stderr += c.toString());
        proc.on('error', reject);
        proc.on('close', code => code === 0 ? resolve({ stdout, stderr }) : reject(Object.assign(new Error(stderr || `exit ${code}`), { code, stdout, stderr })));
    });
}

// 判断路径是否指向控制台设备（CON / CONIN$ / NUL / /dev/tty 等）。
// 反文件读写里如果输入或输出文件是 CON，不应该当成普通文件去创建临时文件；
// 支持“控制台读入、文件输出”或“文件读入、控制台输出”的混合模式。
function isConsoleDevicePath(filePath) {
    if (!filePath) return false;
    const p = String(filePath).trim();
    if (!p) return false;
    const lower = p.toLowerCase();
    // 裸设备名
    if (lower === 'con' || lower === 'conin$' || lower === 'conout$' || lower === 'nul' || lower === 'aux' || lower === 'prn') return true;
    // POSIX 控制台设备
    if (lower === '/dev/stdin' || lower === '/dev/stdout' || lower === '/dev/stderr' || lower === '/dev/tty' || lower === '/dev/console') return true;
    if (lower.startsWith('/dev/pts/')) return true;
    // 按 basename 判断：保留设备名在 Windows 上即使带路径或带扩展名也属于设备（con.txt 仍是保留名），兼容 / 与 \ 两种分隔符
    const base = p.split(/[\/\\]/).pop() || path.basename(p);
    const ext = path.extname(base);
    const nameNoExt = ext ? base.slice(0, -ext.length) : base;
    const nameLower = nameNoExt.toLowerCase();
    const reserved = new Set(['con','conin$','conout$','nul','aux','prn','com1','com2','com3','com4','com5','com6','com7','com8','com9','lpt1','lpt2','lpt3','lpt4','lpt5','lpt6','lpt7','lpt8','lpt9']);
    if (reserved.has(nameLower)) return true;
    // basename 本身是 CON 等但带扩展名的情况已通过 nameNoExt 覆盖；再兜底判断 base 本身
    const baseLower = base.toLowerCase();
    if (reserved.has(baseLower)) return true;
    return false;
}

// 去掉扩展名后的文件名，供 <baseName> / <base> 使用（支持 .cc/.cxx/.c++/.CPP 等）
function getBaseName(filePath) {
    const name = path.basename(String(filePath || ''));
    const ext = path.extname(name);
    return ext ? name.slice(0, -ext.length) : name;
}

function execFileAsync(command, args) {
    return new Promise((resolve, reject) => {
        execFile(command, args, (error, stdout) => (error ? reject(error) : resolve(stdout)));
    });
}

function openInTerminal(targetPath) {
    const platform = process.platform;

    if (platform === 'win32') {
        // Windows: 用参数数组启动，避免路径中的空格、& 等字符被 cmd 解释
        const comspec = process.env.ComSpec || 'cmd.exe';
        try {
            // windowsVerbatimArguments：自行拼好命令行，避免 Node 把引号转义成 \" 导致 cmd 解析失败
            const child = spawn(comspec, ['/c', 'start', '""', 'cmd.exe', '/K', `cd /d "${targetPath}"`], {
                detached: true,
                stdio: 'ignore',
                windowsHide: false,
                windowsVerbatimArguments: true
            });
            child.on('error', (err) => ShowError(`打开外部终端失败：${err.message}`));
            child.unref();
        } catch (err) {
            ShowError(`打开外部终端失败：${err.message}`);
        }
    } else if (platform === 'darwin') {
        // macOS: osascript
        const cdCmd = `cd ${shellEscapePosix(targetPath)}`;
        const appleScript = [
            `tell application "Terminal"`,
            `activate`,
            `do script ${JSON.stringify(cdCmd)}`,
            `end tell`,
        ].join("\n");

        execFileAsync('osascript', ['-e', appleScript]).catch((err) => {
            ShowError(`打开外部终端失败：${err.message}`);
        });
    } else {
        // Linux: 依次尝试常见终端
        const candidates = [
            ['gnome-terminal', [`--working-directory=${targetPath}`]],
            ['konsole', ['--workdir', targetPath]],
            ['xfce4-terminal', [`--working-directory=${targetPath}`]],
            ['x-terminal-emulator', ['--working-directory', targetPath]],
            ['xterm', ['-e', `cd ${shellEscapePosix(targetPath)} && exec $SHELL`]]
        ];
        (async () => {
            let lastError;
            for (const [command, args] of candidates) {
                try {
                    const child = spawn(command, args, { detached: true, stdio: 'ignore' });
                    await new Promise((resolve, reject) => {
                        child.once('spawn', resolve);
                        child.once('error', reject);
                    });
                    child.unref();
                    return;
                } catch (err) {
                    lastError = err;
                }
            }
            ShowError(`打开外部终端失败：${lastError ? lastError.message : '未找到可用终端'}`);
        })();
    }
}

function makeTerminal() {
    if (process.platform === 'win32') {
        // 不要硬编码 C:\Windows：系统盘不一定是 C 盘
        return vscode.window.createTerminal({ name: "dream-cpp-compiler:运行", shellPath: process.env.ComSpec || 'cmd.exe' });
    } else {
        return vscode.window.createTerminal("dream-cpp-compiler:运行");
    }
}

function getTempDir() {
    const TempDir = path.join(os.tmpdir(), 'dream-cpp-compiler');
    fs.mkdirSync(path.join(TempDir, 'Module'), { recursive: true });
    return TempDir;
}

function getTempCodeRoot() {
    return path.join(os.tmpdir(), 'dream-cpp-compiler', 'tmpcode');
}

// 判断目录是否位于本扩展的临时代码根目录之下。
// 删除前必须过这道检查：侧边栏取消勾选时曾把用户的工作目录当成临时目录删掉。
function isTempCodeDir(dirPath) {
    if (!dirPath) return false;
    try {
        const root = path.resolve(getTempCodeRoot());
        const target = path.resolve(String(dirPath));
        const rel = path.relative(root, target);
        return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
    } catch (e) {
        return false;
    }
}

function cleanupTempCodeRoot() {
    const tmpRoot = getTempCodeRoot();
    let maxTempCodes = Number(getConfig('maxTempCodes'));
    if (!Number.isFinite(maxTempCodes) || maxTempCodes < 1) maxTempCodes = 20;
    try {
        const entries = fs.readdirSync(tmpRoot, { withFileTypes: true });
        const dirs = entries.filter(e => e.isDirectory()).map(e => {
            // 目录名形如 `${stamp}-${rand}`，优先按时间戳排序，取不到时退回 mtime
            const stamp = parseInt(String(e.name).split('-')[0], 10);
            let mtime = 0;
            try { mtime = fs.statSync(path.join(tmpRoot, e.name)).mtimeMs; } catch (_) { }
            return { name: e.name, order: Number.isFinite(stamp) && stamp > 0 ? stamp : mtime };
        });
        if (dirs.length <= maxTempCodes) return;

        // 只删最旧的若干个。原来是整棵树清空，会连带删掉其他窗口正在使用的目录，
        // 以及某个还在运行的程序所在的目录。
        dirs.sort((a, b) => a.order - b.order);
        const excess = dirs.length - maxTempCodes;
        for (let i = 0; i < excess; i++) {
            const target = path.join(tmpRoot, dirs[i].name);
            if (!isTempCodeDir(target)) continue;
            try { fs.rmSync(target, { recursive: true, force: true }); } catch (_) { }
        }
    } catch (e) {

    }
}

function getConfig(section) {
    const config = vscode.workspace.getConfiguration('dream-cpp-compiler').inspect(section);
    return config ? config.globalValue : undefined;
}

// 计算MD5哈希
function md5(str) {
    const crypto = require('crypto');
    return crypto.createHash('md5').update(str).digest('base64');
}

function showErrorText(content) {
    compileOutput.clear();
    compileOutput.appendLine(content);
    compileOutput.show(true);
}

function ShowInfo(content) {
    commandOutput.info(content + '\n');
}

function ShowInfos(Array) {
    Array.forEach(str => {
        commandOutput.info(str);
    });
}

function ShowWarn(content) {
    commandOutput.warn(content + '\n');
}

function ShowWarns(Array) {
    Array.forEach(str => {
        commandOutput.warn(str);
    });
}

function ShowError(content) {
    commandOutput.error(content + '\n');
}

function ShowErrors(Array) {
    Array.forEach(str => {
        commandOutput.error(str);
    });
}

async function GetTempPath(content) {
    const tmpRoot = getTempCodeRoot();

    cleanupTempCodeRoot();


    const rand = Math.random().toString(36).slice(2, 8); // 六位左右
    const stamp = Date.now();
    const tmpDir = path.join(tmpRoot, `${stamp}-${rand}`);

    try {
        fs.mkdirSync(tmpDir, { recursive: true });
    } catch (e) {
        ShowError(`创建临时代码目录失败：${e.message}`);
    }

    // 4. 在该目录里保存 code.cpp
    try {
        const codePath = path.join(tmpDir, 'code.cpp');
        fs.writeFileSync(codePath, content, 'utf8');
    } catch (e) {
        ShowError(`写入临时代码文件失败：${e.message}`);
    }

    // 5. 返回路径（建议返回 { codePath, tmpDir } 两个信息）
    return tmpDir;
}

function GetExePath(cppPath) {
    // 获取输出路径模板
    const outputPathTemplate = getFileConfig(cppPath, 'outputPath') || '<cppDir>/<baseName>';

    // 替换模板中的变量
    const baseName = getBaseName(cppPath);
    const cppDir = path.dirname(cppPath);
    const workdir = vscode.workspace.workspaceFolders ?
        vscode.workspace.workspaceFolders[0].uri.fsPath : cppDir;
    const tmpDir = os.tmpdir();

    let outputPath = outputPathTemplate
        .replace(/<cppDir>/g, cppDir)
        .replace(/<baseName>/g, baseName)
        .replace(/<workdir>/g, workdir)
        .replace(/<tmpDir>/g, tmpDir);

    if (process.platform === 'win32') {
        if(path.extname(outputPath) === '')outputPath += '.exe';
        outputPath = outputPath.replace(/\//g, "\\");
    }

    return outputPath;
}

// 保存哈希缓存
function saveHashCache(key, hash) {
    cache[key] = hash;
}

// 获取缓存的哈希数据
function getCachedHash(key) {
    return cache[key] || null;
}

// 判断是否需要重新编译。signature 包含编译选项、编译器路径与编译命令模板，
// 任何一项变化都会触发重新编译（否则改了编译命令却不会重编）。
function needsRecompile(filePath, signature) {
    try {
        const fileContent = fs.readFileSync(filePath, 'utf8');
        const currentHash = md5(fileContent);
        const cachedData = getCachedHash(filePath);
        const executablePath = GetExePath(filePath);

        if (!cachedData) return true;
        if (!fs.existsSync(executablePath)) return true;

        return cachedData !== `${currentHash}|${signature}`;
    } catch (err) {
        ShowError(`检查是否需要重新编译时出错:${err.message}`);
        return true;
    }
}

// 文件头配置只解析注释行里的 `key: value`。
// 之前不分注释/代码，一律按“冒号前最后一个单词”匹配，于是
// printf("workdir: /tmp") 这类普通语句也会劫持配置，保存设置时还会被就地改写。
// 这里先找出注释片段（// 行、/* */ 行、块注释续行），再在片段内取 key/value。
function headerCommentSpans(lines, limit) {
    const spans = [];
    const max = Math.min(lines.length, typeof limit === 'number' ? limit : lines.length);
    let inBlock = false;
    for (let i = 0; i < max; i++) {
        const line = String(lines[i] || '');
        if (inBlock) {
            const close = line.indexOf('*/');
            spans.push({ lineIndex: i, bodyStart: 0, bodyEnd: close === -1 ? line.length : close });
            if (close !== -1) inBlock = false;
            continue;
        }
        const m = /^[ \t]*(\/\/|\/\*)/.exec(line);
        if (!m) continue;
        const bodyStart = m[0].length;
        if (m[1] === '//') {
            spans.push({ lineIndex: i, bodyStart, bodyEnd: line.length });
        } else {
            const close = line.indexOf('*/', bodyStart);
            spans.push({ lineIndex: i, bodyStart, bodyEnd: close === -1 ? line.length : close });
            if (close === -1) inBlock = true;
        }
    }
    return spans;
}

// 从注释片段里取出 { key, colonIndex, valueStart, valueEnd }；不是 `key: value` 形态时返回 null。
// valueEnd 指向去掉尾部空白后的值末尾，替换时可以保留行尾的 */ 与缩进。
function headerKeyValue(lineText, span) {
    const line = String(lineText || '');
    const body = line.slice(span.bodyStart, span.bodyEnd);
    const pos = body.indexOf(':');
    if (pos === -1) return null;

    const isLetter = (c) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
    let end = -1;
    for (let j = pos - 1; j >= 0; --j) {
        if (isLetter(body.charCodeAt(j))) { end = j; break; }
    }
    if (end === -1) return null;

    let start = end;
    while (start >= 0 && isLetter(body.charCodeAt(start))) --start;

    // key 前面紧贴数字或下划线时不算（例如 v2workdir / my_workdir），避免把标识符尾巴当成 key
    if (start >= 0 && /[0-9_]/.test(body[start])) return null;

    let valueStart = pos + 1;
    while (valueStart < body.length && (body[valueStart] === ' ' || body[valueStart] === '\t')) valueStart++;

    const key = body.slice(start + 1, end + 1);
    const value = body.slice(valueStart).replace(/\s+$/, '');
    return {
        key,
        value,
        colonIndex: span.bodyStart + pos,
        valueStart: span.bodyStart + valueStart,
        valueEnd: span.bodyStart + valueStart + value.length
    };
}

// 去掉注释和字符串字面量，避免注释里的 fopen、字符串里的 "ifstream" 误触发直跑模式
function stripCommentsAndStrings(content) {
    let out = '';
    let i = 0;
    const n = content.length;
    while (i < n) {
        const ch = content[i];
        const next = content[i + 1];
        if (ch === '/' && next === '/') {
            while (i < n && content[i] !== '\n') i++;
            continue;
        }
        if (ch === '/' && next === '*') {
            i += 2;
            while (i < n && !(content[i] === '*' && content[i + 1] === '/')) i++;
            i += 2;
            continue;
        }
        if (ch === '"' || ch === "'") {
            const quote = ch;
            i++;
            while (i < n && content[i] !== quote) {
                if (content[i] === '\\') i++;
                i++;
            }
            i++;
            out += '""';
            continue;
        }
        out += ch;
        i++;
    }
    return out;
}

function detectWorkDirDirect(filePath) {
    try {
        if (!filePath || !fs.existsSync(filePath)) return false;
        const content = stripCommentsAndStrings(fs.readFileSync(filePath, 'utf8'));
        const patterns = [/\bfopen\s*\(/, /\bfreopen\s*\(/, /\bifstream\b/, /\bofstream\b/, /\bfstream\b/, /\bstd\s*::\s*filesystem\b/, /#\s*include\s*<filesystem>/, /#\s*include\s*<fstream>/];
        return patterns.some(re => re.test(content));
    } catch { return false; }
}

function parseFileHeaderConfig(filePath) {
    const baseName = getBaseName(filePath);
    let config = {
        inputFile: (getConfig('FileInputDefaultValue') || `<base>.in`).replace(/<base>/g, baseName),
        outputFile: (getConfig('FileOutputDefaultValue') || `<base>.out`).replace(/<base>/g, baseName),
        unFileInputFile: (getConfig('UnFileInputDefaultValue') || `<base>.in`).replace(/<base>/g, baseName),
        unFileOutputFile: (getConfig('UnFileOutputDefaultValue') || `<base>.out`).replace(/<base>/g, baseName),
        useFileRedirect: getConfig('useFileRedirectDefaultValue') || false,
        useUnFileRedirect: getConfig('useUnFileRedirectDefaultValue') || false,
        // 注意：不能用 `|| true`，否则用户把默认值设为 false 会被强制成 true
        compileOptionsCardOpen: getConfig('compileOptionsCardDefaultStatus') ?? true,
        runControlCardOpen: getConfig('runControlCardDefaultStatus') ?? true,
        advancedCardOpen: getConfig('advancedCardDefaultStatus') ?? false,
        fileOperationsCardOpen: getConfig('fileOperationsCardDefaultStatus') ?? false,
        compileOptions: getConfig('CompileDefaultValue') || getDefaultCompileOptions(),
        useStaticLinking: getConfig('useStaticDefaultValue') || false,
        moreCommand: (getConfig('moreCommandDefaultValue') || '').replace(/<base>/g, baseName),
        customVariable: getConfig('customVariableDefaultValue') || '',
        outputPath: (getConfig('outputPath') || '<cppDir>/<baseName>'),
        WorkDir: (getConfig('WorkDirDefaultValue') || '<cppDir>'),
        workDirDirect: getConfig('workDirDirectDefaultValue') || false,
        tempCppPath: '',
        staticOption: getStaticOption(),
        compileCommand: getConfig('compileCommand') || '"<cPath>" "<cppPath>" <option> -o "<outPath>"'
    };
    let hasExplicitWorkDirDirect = false;
    try {
        if (!fs.existsSync(filePath)) {
            // 文件不存在也返回默认配置：调用方（getFileConfig / 侧边栏）不应因此崩溃
            return config;
        }

        const content = fs.readFileSync(filePath, 'utf8');
        const lines = content.split('\n');

        // 只检查前50行，避免读取整个大文件。只认注释行里的 `key: value`：
        // 普通代码行（例如 printf("workdir: /tmp")）同样含 "word:"，宽松匹配会把配置劫持走。
        for (const span of headerCommentSpans(lines, 50)) {
            const entry = headerKeyValue(lines[span.lineIndex], span);
            if (!entry) continue;

            const key = entry.key;
            const value = entry.value;

            switch (key.toLowerCase()) {
                case 'compileoptions':
                    config.compileOptions = value;
                    break;
                case 'usestaticlinking':
                    config.useStaticLinking = value.toLowerCase() === 'true';
                    break;
                case 'outputpath':
                    config.outputPath = value;
                    break;
                case 'compilecommand':
                    config.compileCommand = value;
                    break;
                case 'inputfile':
                    config.inputFile = value;
                    break;
                case 'outputfile':
                    config.outputFile = value;
                    break;
                case 'unfileinputfile':
                    config.unFileInputFile = value;
                    break;
                case 'unfileoutputfile':
                    config.unFileOutputFile = value;
                    break;
                case 'usefileredirect':
                    config.useFileRedirect = (value.toLowerCase() === 'true' || value.toLowerCase() === 'yes' || value.toLowerCase() === 'y' || value === '1');
                    break;
                case 'useunfileredirect':
                    config.useUnFileRedirect = (value.toLowerCase() === 'true' || value.toLowerCase() === 'yes' || value.toLowerCase() === 'y' || value === '1');
                    break;
                case 'morecommand':
                    config.moreCommand = value;
                    break;
                case 'customvariable':
                    config.customVariable = value;
                    break;
                case 'workdir':
                    config.WorkDir = value;
                    break;
                case 'workdirdirect':
                    config.workDirDirect = (value.toLowerCase() === 'true' || value.toLowerCase() === 'yes' || value.toLowerCase() === 'y' || value === '1');
                    hasExplicitWorkDirDirect = true;
                    break;
            }
        }
        // 优先级：文件头注释 > 全局设置 > 自动检测。
        // 原来自动检测会无条件覆盖全局设置，导致 workDirDirectDefaultValue 永远不生效。
        if (!hasExplicitWorkDirDirect && getConfig('workDirDirectDefaultValue') === undefined) {
            try { config.workDirDirect = detectWorkDirDirect(filePath); } catch {}
        }
    } catch (error) {
        ShowWarn(`解析文件 ${filePath} 头部配置时出错: ${error.message}`);
    }
    return config;
}

// 能从文件头注释解析出来的 key（与 parseFileHeaderConfig 保持一致）。
// useConsoleInfo 属于全局设置，写入文件头没有任何作用，只会污染源码。
const FILE_HEADER_KEYS = new Set([
    'compileoptions', 'usestaticlinking', 'outputpath', 'compilecommand',
    'inputfile', 'outputfile', 'unfileinputfile', 'unfileoutputfile',
    'usefileredirect', 'useunfileredirect', 'morecommand', 'customvariable', 'workdir',
    'workdirdirect'
]);

async function updateCppConfigInEditor(editor, newConfig) {
    if (!editor) return;

    const document = editor.document;

    // 使用 editor.edit 进行事务性编辑
    await editor.edit(editBuilder => {
        const lineCount = document.lineCount;
        const scanLimit = Math.min(lineCount, 50);

        // 记录已经处理过的 Key (转为小写以便对比)
        const processedKeys = new Set();

        // 获取 newConfig 的所有 key（只要文件头能解析的）
        const configKeys = Object.keys(newConfig).filter(k => FILE_HEADER_KEYS.has(k.toLowerCase()));

        // 1. 扫描并修改现有行
        // 只处理注释行：否则 printf("workdir: /tmp") 这类代码会被当成配置行改写，把源码改坏。
        const lineTexts = [];
        for (let i = 0; i < scanLimit; i++) {
            lineTexts.push(document.lineAt(i).text);
        }

        for (const span of headerCommentSpans(lineTexts, scanLimit)) {
            const entry = headerKeyValue(lineTexts[span.lineIndex], span);
            if (!entry) continue;

            // 查找 newConfig 中是否有对应的 Key
            const matchingConfigKey = configKeys.find(k => k.toLowerCase() === entry.key.toLowerCase());
            if (!matchingConfigKey) continue;

            const newValue = newConfig[matchingConfigKey];

            // 从冒号后到值结尾替换：保留缩进、注释符号和 Key，
            // 块注释的 */ 也不会被吃掉（原来是替换到行尾）。
            const startPos = new vscode.Position(span.lineIndex, entry.colonIndex + 1);
            const endPos = new vscode.Position(span.lineIndex, entry.valueEnd);
            editBuilder.replace(new vscode.Range(startPos, endPos), ` ${newValue}`);

            processedKeys.add(matchingConfigKey);
        }

        // 2. 处理不存在的新配置 -> 插入到顶部
        let textToInsert = '';
        for (const key of configKeys) {
            // 如果这个 key 没有被处理过
            if (!processedKeys.has(key)) {
                const val = newConfig[key];
                // 过滤空值
                if (val !== undefined && val !== null && val !== '') {
                    textToInsert += `// ${key}: ${val}\n`;
                }
            }
        }

        if (textToInsert.length > 0) {
            // 在文件开头 (0, 0) 插入
            editBuilder.insert(new vscode.Position(0, 0), textToInsert);
        }
    });
}

// 获取当前文件的配置
function getFileConfig(filePath, key) {
    if (!filePath) return undefined;
    if (!fileConfigs[filePath]) {
        // 默认配置
        fileConfigs[filePath] = parseFileHeaderConfig(filePath);
    }
    return fileConfigs[filePath][key];
}

// 设置当前文件的配置
function setFileConfig(filePath, key, value) {
    if (!filePath) return;
    if (!fileConfigs[filePath]) {
        // 默认配置
        fileConfigs[filePath] = parseFileHeaderConfig(filePath);
    }
    fileConfigs[filePath][key] = value;
}

// 文件被保存后丢弃缓存，使手改文件头注释立即生效
function invalidateFileConfig(filePath) {
    if (filePath && fileConfigs[filePath]) {
        delete fileConfigs[filePath];
    }
}

function checkFilePath() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        vscode.window.showErrorMessage('没有活动的编辑器！');
        return null;
    }

    const document = editor.document;

    if (!document) {
        vscode.window.showErrorMessage('没有活动的文件！');
        return null;
    }

    if (document.languageId !== 'cpp') {
        vscode.window.showErrorMessage('活动文件不是C++文件！');
        return null;
    }

    if (editor.document.uri.scheme !== 'file') {
        return "TEMP_FILE";
    }

    return document.uri.fsPath;
}

async function syncEditorContentToFile(targetFilePath, originalFilePath) {
    if (!targetFilePath || targetFilePath === "TEMP_FILE") return;

    const editor = vscode.window.activeTextEditor;
    if (!editor) return;

    const doc = editor.document;
    const originalPath = originalFilePath || targetFilePath;

    if (doc.uri.scheme === 'file' && doc.uri.fsPath === originalPath) {
        if (doc.isDirty) {
            await doc.save();
        }
    }

    if (doc.uri.scheme !== 'file' || doc.uri.fsPath !== targetFilePath) {
        try {
            fs.writeFileSync(targetFilePath, doc.getText(), 'utf8');
        } catch (e) {
            ShowError(`写入编译文件失败: ${e.message}`);
        }
    }
}

async function resolveCompileSourcePath(filePath) {
    if (!filePath || filePath === "TEMP_FILE") return null;

    const useTemp = !!getFileConfig(filePath, 'useTempFile');
    if (!useTemp) return filePath;

    if (path.basename(filePath).toLowerCase() === 'code.cpp') {
        return filePath;
    }

    let tempDir = getFileConfig(filePath, 'tempDir');
    let tempCppPath = getFileConfig(filePath, 'tempCppPath');

    if (tempDir && !tempCppPath) {
        tempCppPath = path.join(tempDir, "code.cpp");
        setFileConfig(filePath, 'tempCppPath', tempCppPath);
    }

    if (!tempDir || !fs.existsSync(tempDir)) {
        const editor = vscode.window.activeTextEditor;
        const content = editor ? editor.document.getText() : fs.readFileSync(filePath, 'utf8');
        tempDir = await GetTempPath(content);
        tempCppPath = path.join(tempDir, "code.cpp");
        setFileConfig(filePath, 'tempDir', tempDir);
        setFileConfig(filePath, 'tempCppPath', tempCppPath);
        setFileConfig(tempCppPath, 'useTempFile', true);
        setFileConfig(tempCppPath, 'tempDir', tempDir);
    }

    return tempCppPath || filePath;
}

// 扩展版本号，用于模块缓存指纹（读 package.json，失败时回退空串）
let extensionVersionCache;
function getExtensionVersion() {
    if (extensionVersionCache !== undefined) return extensionVersionCache;
    try {
        const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8').replace(/^\uFEFF/, ''));
        extensionVersionCache = String(pkg.version || '');
    } catch (err) {
        extensionVersionCache = '';
    }
    return extensionVersionCache;
}

function execAsync(command) {
    return new Promise((resolve, reject) => {
        exec(command, (error) => (error ? reject(error) : resolve()));
    });
}

async function CompileModule(filePath, ModuleName, executablePath) {
    const compilerPath = getConfig('compilerPath') || 'g++';
    const staticOption = getConfig('staticOption');
    const toArgs = (s) => parseShellTokens(String(s || '').trim()).filter(Boolean);
    const baseArgs = [filePath];
    const commands = [];
    if (staticOption !== '') {
        const stArgs = toArgs(staticOption || '-static');
        commands.push([...baseArgs, ...stArgs, '-o', executablePath]);
    }
    commands.push([...baseArgs, '-o', executablePath]);

    const displayCmd = (args) => `${shellEscapePosix(compilerPath)} ${args.map(a => shellEscapePosix(a)).join(' ')}`;
    ShowInfos([`开始编译模块：${ModuleName}`, `模块位于 ${filePath}`, `输出至 ${executablePath}`, `编译命令：${displayCmd(commands[0])}\n`]);

    // 缓存是否可用必须看“helper 源码内容 + 扩展版本”，不能只看 exe 是否存在：
    // 旧版本编译出来的模块留在临时目录里会被直接复用，而 7.4.5 起 helper 的参数位数变了，
    // 旧二进制只会打印一行“用法：…”然后返回 -1，表现为反文件读写彻底失效。
    const stampPath = `${executablePath}.srchash`;
    let sourceStamp = '';
    try {
        sourceStamp = md5(fs.readFileSync(filePath).toString('base64')) + '|' + getExtensionVersion();
    } catch (err) {
        sourceStamp = '';
    }
    let cachedStamp = '';
    try { cachedStamp = fs.readFileSync(stampPath, 'utf8').trim(); } catch (err) { cachedStamp = ''; }

    if (sourceStamp && fs.existsSync(executablePath) && cachedStamp === sourceStamp) {
        ShowInfo(`模块：${ModuleName} 曾被编译，无需再次编译`);
        return 1;
    }
    // 源码/版本变了或没有指纹（旧版本留下的二进制）：删掉重新编译
    try {
        if (fs.existsSync(executablePath)) fs.unlinkSync(executablePath);
        if (fs.existsSync(stampPath)) fs.unlinkSync(stampPath);
    } catch (err) {
        ShowWarn(`清理旧模块 ${ModuleName} 失败：${err.message}`);
    }

    return await vscode.window.withProgress({location: vscode.ProgressLocation.Notification, title: `模块 ${ModuleName} 正在编译...`}, async () => {
        let lastError = null;
        for (let i = 0; i < commands.length; i++) {
            try {
                await spawnAsync(compilerPath, commands[i], { cwd: path.dirname(filePath) });
                ShowInfo(`模块：${ModuleName} 编译成功`);
                try {
                    if (sourceStamp) fs.writeFileSync(stampPath, sourceStamp, 'utf8');
                } catch (err) {
                    ShowWarn(`写入模块 ${ModuleName} 指纹失败：${err.message}`);
                }
                return 1;
            } catch (error) {
                lastError = error;
                if (i + 1 < commands.length) {
                    ShowWarn(`模块 ${ModuleName} 静态编译失败，尝试动态链接：${error.message}`);
                }
            }
        }
        ShowErrors([`编译 ${ModuleName} 对应模块失败！`, `错误原因：\n${lastError ? lastError.message : '未知错误'}`]);
        showErrorText(lastError ? lastError.message : `编译 ${ModuleName} 失败`);
        vscode.window.showErrorMessage(`编译 ${ModuleName} 模块失败！`);
        return 0;
    });
}

// 静态编译选项：允许用户把它设成空字符串（表示不加任何静态编译参数），
// 所以不能用 `|| '-static'` 兜底，否则空值会被吃掉。
function getStaticOption() {
    const value = getConfig('staticOption');
    return value === undefined || value === null ? '-static' : String(value);
}

// 默认编译选项：-Wl,--stack 是 Windows(MinGW) 专用，Linux/macOS 的 ld 会直接报错
function getDefaultCompileOptions() {
    if (process.platform === 'win32') {
        return '-std=c++14 -O2 -Wall -Wextra -Wl,--stack=400000000';
    }
    return '-std=c++14 -O2 -Wall -Wextra';
}

// 用户可能把 Windows 版默认值抄到了 Linux/macOS 的设置里，这里去掉链接器不认识的参数
function sanitizeCompileOptions(options) {
    if (process.platform === 'win32') return options;
    return String(options).replace(/(^|\s)-Wl,(?:--stack|--heap)[=\s]?\S*/g, ' ').trim();
}

// 编译命令模板：支持 <cPath> 等占位符，同时兼容旧版的 {cPath} 写法。
// 用 split/join 而不是 String.replace，避免路径里的 $& 等被当成替换模式。
function buildCompileCommand(template, params) {
    let command = String(template || '"<cPath>" "<cppPath>" <option> -o "<outPath>"');
    for (const name of Object.keys(params)) {
        command = command.split(`<${name}>`).join(params[name]);
        command = command.split(`{${name}}`).join(params[name]);
    }
    return command;
}

async function OnlyCompile(askUser, filePath, sourcePathOverride) {
    if(!filePath)return 0;

    const sourcePath = sourcePathOverride || filePath;
    await syncEditorContentToFile(sourcePath, filePath);

    const compilerPath = getConfig('compilerPath') || 'g++';
    const iSstatic = getFileConfig(filePath, 'useStaticLinking');
    const staticFlag = iSstatic ? String(getFileConfig(filePath, 'staticOption') ?? '-static') : '';
    const compileOptions = sanitizeCompileOptions(getFileConfig(filePath, 'compileOptions')
        + (staticFlag ? ` ${staticFlag}` : ''));
    const executablePath = GetExePath(filePath);

    const compileCommandTemplate = getFileConfig(filePath, 'compileCommand') || '"<cPath>" "<cppPath>" <option> -o "<outPath>"';
    const compileSignature = `${compileOptions}|${compilerPath}|${compileCommandTemplate}`;

    let forceCompile = false;
    if (!needsRecompile(filePath, compileSignature)) {
        ShowWarn(`程序 ${filePath} 未检测到变化，无需重新编译`);
        if (askUser) {
            const result = await vscode.window.showInformationMessage('未检测到变化，是否仍然编译？', '是', '否');
            if (result !== '是') {
                ShowInfo(`程序 ${filePath} 未检测到变化，用户选择取消了编译`);
                return 1;
            }
            forceCompile = true;
            ShowInfo(`程序 ${filePath} 未检测到变化，但用户选择强制重新编译`);
        } else {
            return 1;
        }
    } else {
        forceCompile = true;
    }

    // 只有确定需要编译时才显示动画
    if (forceCompile) {
        // 同一时间只允许一个编译任务（v4.1.0 的行为）
        if (HaveBuildTask) {
            ShowWarn(`程序 ${filePath} 跳过编译：已有编译任务正在进行`);
            vscode.window.showWarningMessage('已有编译任务正在进行，请稍后再试');
            return 0;
        }

        try {
            if (fs.existsSync(executablePath)) {
                fs.unlinkSync(executablePath);
            }
        } catch (err) {
            ShowWarn('删除旧可执行文件时出错:' + err);
        }

        const compileCommand = buildCompileCommand(compileCommandTemplate, {
            cPath: compilerPath,
            cppPath: sourcePath,
            option: compileOptions,
            outPath: executablePath
        });
        ShowInfos([`开始编译，编译程序：${filePath}`, `编译命令：${compileCommand}\n`]);

        compileStatus.text = '$(loading~spin) 正在编译...';
        compileStatus.show();

        const compileTokens = parseShellTokens(compileCommand);
        const compileCmd = compileTokens[0];
        const compileArgs = compileTokens.slice(1);

        return await vscode.window.withProgress({location: vscode.ProgressLocation.Notification, title: "正在编译...", cancellable: true}, async (progress, token) => {
            return new Promise((resolve) => {
                HaveBuildTask = true;

                const proc = require('child_process').spawn(compileCmd, compileArgs, { windowsHide: true });
                let stdoutBuf = '', stderrBuf = '';
                proc.stdout && proc.stdout.on('data', d => stdoutBuf += d.toString());
                proc.stderr && proc.stderr.on('data', d => stderrBuf += d.toString());
                proc.on('error', (err) => {
                    if (!HaveBuildTask) return;
                    HaveBuildTask = false;
                    ShowErrors([`程序 ${filePath} 编译失败`, `编译命令：${compileCommand}`, `编译器报错：\n${err.message}`]);
                    compileStatus.text = '$(error) 编译失败';
                    compileStatus.show();
                    showErrorText(err.message);
                    setTimeout(() => { compileStatus.hide(); }, 5000);
                    vscode.window.showErrorMessage('编译失败');
                    resolve(0);
                });
                proc.on('close', (code) => {
                    if (!HaveBuildTask) return;
                    HaveBuildTask = false;
                    const stderr = stderrBuf;
                    if (code !== 0) {
                        ShowErrors([`程序 ${filePath} 编译失败`, `编译命令：${compileCommand}`, `编译器报错：\n${stderr || `exit code ${code}`}`]);
                        compileStatus.text = '$(error) 编译失败';
                        compileStatus.show();
                        showErrorText(stderr || `exit code ${code}`);
                        setTimeout(() => { compileStatus.hide(); }, 5000);
                        vscode.window.showErrorMessage('编译失败');
                        resolve(0);
                    } else {
                        const fileContent = fs.readFileSync(filePath, 'utf8');
                        const currentHash = md5(fileContent);
                        saveHashCache(filePath, `${currentHash}|${compileSignature}`);
                        if (stderr) {
                            ShowWarns([`程序 ${filePath} 编译出现警告`, `编译命令：${compileCommand}`, `编译器警告：\n${stderr}`]);
                            compileStatus.text = '$(warning) 编译出现警告';
                            vscode.window.showWarningMessage('编译出现警告', "查看详情", "忽略").then(selection => {
                                if(selection === "查看详情") { showErrorText(stderr); }
                            });
                        } else {
                            ShowInfos([`程序 ${filePath} 编译成功`, `编译命令：${compileCommand}`, `未出现警告与错误\n`]);
                            compileStatus.text = '$(check) 编译成功';
                            setTimeout(() => { vscode.window.showInformationMessage('编译成功'); }, 50);
                        }
                        compileStatus.show();
                        setTimeout(() => { compileStatus.hide(); }, 5000);
                        resolve(1);
                    }
                });

                token.onCancellationRequested(() => {
                    if (!HaveBuildTask) return;
                    HaveBuildTask = false;

                    proc.kill();
                    ShowWarns([`程序 ${filePath} 编译被用户取消`, `编译命令：${compileCommand}`]);

                    setTimeout(() => {
                        vscode.window.showWarningMessage('编译被取消');
                    }, 50);

                    compileStatus.text = '$(close) 编译被用户取消';
                    compileStatus.show();

                    setTimeout(() => {
                        compileStatus.hide();
                    }, 5000);

                    resolve(0);
                });
            });
        });
    }

    return 1;
}

// 核心编译逻辑
async function compileAndRun(terminalType, filePathOverride) {
    const FilePath = filePathOverride || checkFilePath();
    if (FilePath === "TEMP_FILE") {
        // 非本地文件（未保存的 Untitled 等）：给出提示而不是静默失败
        vscode.window.showWarningMessage('当前文件不是本地文件，请先在侧边栏勾选「以临时文件进行编译运行」');
        ShowWarn('当前文件不是本地文件，已取消运行；请先勾选「以临时文件进行编译运行」');
        return 0;
    }
    if (!FilePath) return 0;
    const sourcePath = await resolveCompileSourcePath(FilePath);
    if (!sourcePath) return 0;
    const result = await OnlyCompile(0, FilePath, sourcePath);
    if (result) {
        await runProgram(FilePath, terminalType);
    }
}

async function compileOnly(filePathOverride) {
    const FilePath = filePathOverride || checkFilePath();
    if (FilePath === "TEMP_FILE") {
        vscode.window.showWarningMessage('当前文件不是本地文件，请先在侧边栏勾选「以临时文件进行编译运行」');
        ShowWarn('当前文件不是本地文件，已取消编译；请先勾选「以临时文件进行编译运行」');
        return 0;
    }
    if (!FilePath) return 0;
    const sourcePath = await resolveCompileSourcePath(FilePath);
    if (!sourcePath) return 0;
    return await OnlyCompile(1, FilePath, sourcePath);
}

// 运行程序
async function runProgram(filePath, terminalType) {
    const executablePath = GetExePath(filePath);
    const programDir = path.dirname(executablePath);
    const baseName = getBaseName(filePath);
    const cppDir = path.dirname(filePath);
    const workdir = vscode.workspace.workspaceFolders ?
        vscode.workspace.workspaceFolders[0].uri.fsPath : cppDir;
    const tmpDir = os.tmpdir();
    const WorkDir = (getFileConfig(filePath, 'WorkDir') || '')
        .replace(/<cppDir>/g, cppDir)
        .replace(/<baseName>/g, baseName)
        .replace(/<workdir>/g, workdir)
        .replace(/<tmpDir>/g, tmpDir);
    const workDirDirect = !!getFileConfig(filePath, 'workDirDirect');
    const effectiveWorkdir = WorkDir ? WorkDir : programDir;
    const UseConsoleInfo = getConfig('useConsoleInfo') || false;

    // 文件特定配置。<base> 与 <baseName> 等价，两者都要替换：
    // 侧边栏预览会用 <base>，文档也把它作为 moreCommand / 文件读写的占位符，
    // 之前后端只替换 <baseName>，导致 <base> 被原样传给程序。
    const customVariable = getFileConfig(filePath, 'customVariable');
    const replacePlaceholders = (template) => String(template || '')
        .replace(/<var>/g, customVariable)
        .replace(/<cppDir>/g, cppDir)
        .replace(/<baseName>/g, baseName)
        .replace(/<base>/g, baseName);
    const inputFile = replacePlaceholders(getFileConfig(filePath, 'inputFile'));
    const outputFile = replacePlaceholders(getFileConfig(filePath, 'outputFile'));
    const unFileInputFile = replacePlaceholders(getFileConfig(filePath, 'unFileInputFile'));
    const unFileOutputFile = replacePlaceholders(getFileConfig(filePath, 'unFileOutputFile'));
    const useFileRedirect = getFileConfig(filePath, 'useFileRedirect');
    const useUnFileRedirect = getFileConfig(filePath, 'useUnFileRedirect');

    // 工具目录 (存放 ChangeFileIO.cpp 等的父目录)
    const toolPath = path.join(__dirname, 'tools');

    // 处理额外命令
    let moreCommand = replacePlaceholders(getFileConfig(filePath, 'moreCommand'));
    if (moreCommand && /[;&|`$()]/.test(moreCommand)) {
        ShowWarn(`moreCommand 含 shell 元字符，已按用户配置原样执行：${moreCommand}`);
    }

    let cdCommand, runCommand;

    // ---------------- Windows ----------------
    if (process.platform === 'win32') {
        cdCommand = `cd /d "${effectiveWorkdir}"`;
        runCommand = await buildRunCommandWin(toolPath, executablePath, {
            UseConsoleInfo, useFileRedirect, useUnFileRedirect,
            inputFile, outputFile, unFileInputFile, unFileOutputFile,
            workDir: effectiveWorkdir,
            workDirDirect: workDirDirect
        });

        if (moreCommand) {
            runCommand += `& ${moreCommand}`;
        }

    // ---------------- Linux ----------------
    } else if (process.platform === 'linux') {
        cdCommand = `cd "${effectiveWorkdir}"`;
        // 注意：这里传入 toolPath 作为 baseDir
        runCommand = await buildRunCommandLinux(toolPath, executablePath, {
            UseConsoleInfo, useFileRedirect, useUnFileRedirect,
            inputFile, outputFile, unFileInputFile, unFileOutputFile,
            workDir: effectiveWorkdir,
            workDirDirect: workDirDirect
        });

        if (moreCommand) {
            runCommand += `; ${moreCommand}`;
        }

    // ---------------- macOS (新增/修改) ----------------
    } else if (process.platform === 'darwin') {
        cdCommand = `cd "${effectiveWorkdir}"`;

        // 使用之前定义的构建函数生成核心 Shell 命令
        runCommand = await buildRunCommandMacOS(toolPath, executablePath, {
            UseConsoleInfo, useFileRedirect, useUnFileRedirect,
            inputFile, outputFile, unFileInputFile, unFileOutputFile,
            workDir: effectiveWorkdir,
            workDirDirect: workDirDirect
        });

        if (moreCommand) {
            runCommand += `; ${moreCommand}`;
        }
    }

    // 如果编译辅助模块失败（返回 null），则终止运行
    if (!runCommand) {
        return;
    }

    // ---------------- 执行逻辑 ----------------

    // 1. 内置终端运行
    if (terminalType === 'internal') {
        let RunTerminal = vscode.window.terminals.find(
            term => term.name === 'dream-cpp-compiler:运行'
        );

        if (!RunTerminal) {
            RunTerminal = makeTerminal();
        }

        RunTerminal.show();
        // 只有在终端里确实有命令在运行时才发送 Ctrl+C。
        // 向空闲的 cmd.exe 写入 ETX(\x03) 会让它直接以 -1073741510 (STATUS_CONTROL_C_EXIT) 退出，
        // 原来的 '^C\x03' 还会把字面量 ^C 打进命令行。
        if (terminalsWithRunningCommand.get(RunTerminal)) {
            RunTerminal.sendText('\x03', false);
            // 留出一点时间让 Ctrl+C 生效，避免后续命令被正在退出的程序读走
            await new Promise((resolve) => setTimeout(resolve, 150));
        }
        RunTerminal.sendText(cdCommand);
        RunTerminal.sendText(runCommand);

    // 2. 外部终端运行
    } else {
        let terminalCommand;

        if (process.platform === 'win32') {
            terminalCommand = await buildTerminalCommandWin(executablePath, cdCommand, runCommand);
        } else if (process.platform === 'linux') {
            terminalCommand = await buildTerminalCommandLinux(executablePath, cdCommand, runCommand);
        } else if (process.platform === 'darwin') {
            terminalCommand = await buildTerminalCommandMacOS(executablePath, cdCommand, runCommand);
        }

        ShowInfo(`外部终端命令: ${terminalCommand}`);

        exec(terminalCommand, (error) => {
            if (error) {
                vscode.window.showErrorMessage("打开外部终端失败！");
                ShowError(`打开外部终端失败！错误原因：${error.message}`);
            } else {
                ShowInfo(`程序 ${filePath} 运行已结束`);
            }
        });
    }
}

// ---------------- Windows 构建命令 ----------------
async function buildRunCommandWin(baseDir, exeName, opt) {
    if (opt.useFileRedirect && opt.useUnFileRedirect) {
        // 若反侧的输入输出都是 CON，直接跑程序即可；helper 内部也会处理混合的 CON
        if (isConsoleDevicePath(opt.unFileInputFile) && isConsoleDevicePath(opt.unFileOutputFile)) {
            if (opt.UseConsoleInfo) {
                const ModuleName = 'ConsoleInfo';
                const executablePath = path.join(getTempDir(), 'Module', `${ModuleName}.exe`);
                const result = await CompileModule(path.join(baseDir, 'windows', `${ModuleName}.cpp`), ModuleName, executablePath);
                if(!result) return null;
                return `cmd /c ""${shellEscapeWin(executablePath)}" ${shellEscapeWin(exeName)} ${shellEscapeWin(opt.workDir || "")} ${shellEscapeWin(opt.workDirDirect ? "1" : "0")}""`;
            } else {
                return `cmd /c "${exeName}"`;
            }
        }
        if (opt.UseConsoleInfo) {
            const ModuleName = 'ConsoleInfoChangeFileIO';
            const executablePath = path.join(getTempDir(), 'Module', `${ModuleName}.exe`);
            const result = await CompileModule(path.join(baseDir, 'windows', `${ModuleName}.cpp`), ModuleName, executablePath);
            if(!result){
                return null;
            }
            return `cmd /c ""${shellEscapeWin(executablePath)}" ${shellEscapeWin(exeName)} ${shellEscapeWin(opt.inputFile)} ${shellEscapeWin(opt.outputFile)} ${shellEscapeWin(opt.unFileInputFile)} ${shellEscapeWin(opt.unFileOutputFile)} ${shellEscapeWin(opt.workDir || "")} ${shellEscapeWin(opt.workDirDirect ? "1" : "0")}""`;
        } else {
            const ModuleName = 'ChangeFileIO';
            const executablePath = path.join(getTempDir(), 'Module', `${ModuleName}.exe`);
            const result = await CompileModule(path.join(baseDir, 'windows', `${ModuleName}.cpp`), ModuleName, executablePath);
            if(!result){
                return null;
            }
            return `cmd /c ""${shellEscapeWin(executablePath)}" ${shellEscapeWin(exeName)} ${shellEscapeWin(opt.inputFile)} ${shellEscapeWin(opt.outputFile)} ${shellEscapeWin(opt.unFileInputFile)} ${shellEscapeWin(opt.unFileOutputFile)} ${shellEscapeWin(opt.workDir || "")} ${shellEscapeWin(opt.workDirDirect ? "1" : "0")}""`;
        }
    } else if (opt.useFileRedirect) {
        const inputIsCon = isConsoleDevicePath(opt.inputFile);
        const outputIsCon = isConsoleDevicePath(opt.outputFile);
        if (opt.UseConsoleInfo) {
            // ConsoleInfoFileIO 暂不支持单侧 CON 的部分重定向，回退到直接运行+shell 透传
            if (inputIsCon || outputIsCon) {
                let cmd = `cmd /c "${exeName}"`;
                if (!inputIsCon && opt.inputFile) cmd = `cmd /c ""${shellEscapeWin(exeName)}" < ${shellEscapeWin(opt.inputFile)}""`;
                if (!outputIsCon && opt.outputFile) {
                    if (cmd.includes('<')) cmd += ` > ${shellEscapeWin(opt.outputFile)}`;
                    else cmd = `cmd /c ""${shellEscapeWin(exeName)}" > ${shellEscapeWin(opt.outputFile)}""`;
                }
                if (inputIsCon && outputIsCon) cmd = `cmd /c "${exeName}"`;
                return cmd;
            }
            const ModuleName = 'ConsoleInfoFileIO';
            const executablePath = path.join(getTempDir(), 'Module', `${ModuleName}.exe`);
            const result = await CompileModule(path.join(baseDir, 'windows', `${ModuleName}.cpp`), ModuleName, executablePath);
            if(!result){
                return null;
            }
            return `cmd /c ""${shellEscapeWin(executablePath)}" ${shellEscapeWin(exeName)} ${shellEscapeWin(opt.inputFile)} ${shellEscapeWin(opt.outputFile)} ${shellEscapeWin(opt.workDir || "")} ${shellEscapeWin(opt.workDirDirect ? "1" : "0")}""`;
        } else {
            if (inputIsCon && outputIsCon) return `cmd /c "${exeName}"`;
            if (inputIsCon) return `cmd /c ""${shellEscapeWin(exeName)}" > ${shellEscapeWin(opt.outputFile)}""`;
            if (outputIsCon) return `cmd /c ""${shellEscapeWin(exeName)}" < ${shellEscapeWin(opt.inputFile)}""`;
            return `cmd /c ""${shellEscapeWin(exeName)}" < ${shellEscapeWin(opt.inputFile)} > ${shellEscapeWin(opt.outputFile)}""`;
        }
    } else if (opt.useUnFileRedirect) {
        const inIsCon = isConsoleDevicePath(opt.unFileInputFile);
        const outIsCon = isConsoleDevicePath(opt.unFileOutputFile);
        if (inIsCon && outIsCon) {
            if (opt.UseConsoleInfo) {
                const ModuleName = 'ConsoleInfo';
                const executablePath = path.join(getTempDir(), 'Module', `${ModuleName}.exe`);
                const result = await CompileModule(path.join(baseDir, 'windows', `${ModuleName}.cpp`), ModuleName, executablePath);
                if(!result) return null;
                return `cmd /c ""${shellEscapeWin(executablePath)}" ${shellEscapeWin(exeName)} ${shellEscapeWin(opt.workDir || "")} ${shellEscapeWin(opt.workDirDirect ? "1" : "0")}""`;
            } else {
                return `cmd /c "${exeName}"`;
            }
        }
        if (opt.UseConsoleInfo) {
            const ModuleName = 'ConsoleInfoUnFileIO';
            const executablePath = path.join(getTempDir(), 'Module', `${ModuleName}.exe`);
            const result = await CompileModule(path.join(baseDir, 'windows', `${ModuleName}.cpp`), ModuleName, executablePath);
            if(!result){
                return null;
            }
            return `cmd /c ""${shellEscapeWin(executablePath)}" ${shellEscapeWin(exeName)} ${shellEscapeWin(opt.unFileInputFile)} ${shellEscapeWin(opt.unFileOutputFile)} ${shellEscapeWin(opt.workDir || "")} ${shellEscapeWin(opt.workDirDirect ? "1" : "0")}""`;
        } else {
            const ModuleName = 'UnFileIO';
            const executablePath = path.join(getTempDir(), 'Module', `${ModuleName}.exe`);
            const result = await CompileModule(path.join(baseDir, 'windows', `${ModuleName}.cpp`), ModuleName, executablePath);
            if(!result){
                return null;
            }
            return `cmd /c ""${shellEscapeWin(executablePath)}" ${shellEscapeWin(exeName)} ${shellEscapeWin(opt.unFileInputFile)} ${shellEscapeWin(opt.unFileOutputFile)} ${shellEscapeWin(opt.workDir || "")} ${shellEscapeWin(opt.workDirDirect ? "1" : "0")}""`;
        }
    } else {
        if (opt.UseConsoleInfo) {
            const ModuleName = 'ConsoleInfo';
            const executablePath = path.join(getTempDir(), 'Module', `${ModuleName}.exe`);
            const result = await CompileModule(path.join(baseDir, 'windows', `${ModuleName}.cpp`), ModuleName, executablePath);
            if(!result){
                return null;
            }
            return `cmd /c ""${shellEscapeWin(executablePath)}" ${shellEscapeWin(exeName)} ${shellEscapeWin(opt.workDir || "")} ${shellEscapeWin(opt.workDirDirect ? "1" : "0")}""`;
        } else {
            return `cmd /c "${exeName}"`;
        }
    }
}


async function buildTerminalCommandWin(exePath, cdCommand, runCommand, moreCommand) {
    if(moreCommand)return `start "${exePath}" cmd /c "${cdCommand} & ${runCommand} & echo. & ${moreCommand} & pause"`;
    return `start "${exePath}" cmd /c "${cdCommand} & ${runCommand} & echo. & pause"`;
}

// ---------------- Linux 构建命令 ----------------
async function buildRunCommandLinux(baseDir, exeName, opt) {
    if (opt.useFileRedirect && opt.useUnFileRedirect) {
        if (isConsoleDevicePath(opt.unFileInputFile) && isConsoleDevicePath(opt.unFileOutputFile)) {
            if (opt.UseConsoleInfo) {
                const ModuleName = 'ConsoleInfo';
                const executablePath = path.join(getTempDir(), 'Module', ModuleName);
                const result = await CompileModule(path.join(baseDir, 'linux', `${ModuleName}.cpp`), ModuleName, executablePath);
                if(!result) return null;
                return `${shellEscapePosix(executablePath)} ${shellEscapePosix(exeName)} ${shellEscapePosix(opt.workDir || "")} ${shellEscapePosix(opt.workDirDirect ? "1" : "0")}; echo`;
            } else {
                return `"${exeName}"; echo`;
            }
        }
        if (opt.UseConsoleInfo) {
            const ModuleName = 'ConsoleInfoChangeFileIO';
            const executablePath = path.join(getTempDir(), 'Module', ModuleName);
            const result = await CompileModule(path.join(baseDir, 'linux', `${ModuleName}.cpp`), ModuleName, executablePath);
            if(!result){
                return null;
            }
            return `${shellEscapePosix(executablePath)} ${shellEscapePosix(exeName)} ${shellEscapePosix(opt.inputFile)} ${shellEscapePosix(opt.outputFile)} ${shellEscapePosix(opt.unFileInputFile)} ${shellEscapePosix(opt.unFileOutputFile)} ${shellEscapePosix(opt.workDir || "")} ${shellEscapePosix(opt.workDirDirect ? "1" : "0")}; echo`;
        } else {
            const ModuleName = 'ChangeFileIO';
            const executablePath = path.join(getTempDir(), 'Module', ModuleName);
            const result = await CompileModule(path.join(baseDir, 'linux', `${ModuleName}.cpp`), ModuleName, executablePath);
            if(!result){
                return null;
            }
            return `${shellEscapePosix(executablePath)} ${shellEscapePosix(exeName)} ${shellEscapePosix(opt.inputFile)} ${shellEscapePosix(opt.outputFile)} ${shellEscapePosix(opt.unFileInputFile)} ${shellEscapePosix(opt.unFileOutputFile)} ${shellEscapePosix(opt.workDir || "")} ${shellEscapePosix(opt.workDirDirect ? "1" : "0")}; echo`;
        }
    } else if (opt.useFileRedirect) {
        const inputIsCon = isConsoleDevicePath(opt.inputFile);
        const outputIsCon = isConsoleDevicePath(opt.outputFile);
        if (opt.UseConsoleInfo) {
            if (inputIsCon || outputIsCon) {
                // ConsoleInfoFileIO 不支持部分 CON，直接用 shell 透传
                let cmd = `${shellEscapePosix(exeName)}`;
                if (!inputIsCon && opt.inputFile) cmd = `${shellEscapePosix(exeName)} < ${shellEscapePosix(opt.inputFile)}`;
                if (!outputIsCon && opt.outputFile) {
                    if (cmd.includes('<')) cmd += ` > ${shellEscapePosix(opt.outputFile)}`;
                    else cmd = `${shellEscapePosix(exeName)} > ${shellEscapePosix(opt.outputFile)}`;
                }
                if (inputIsCon && outputIsCon) cmd = `"${exeName}"`;
                return `${cmd}; echo`;
            }
            const ModuleName = 'ConsoleInfoFileIO';
            const executablePath = path.join(getTempDir(), 'Module', ModuleName);
            const result = await CompileModule(path.join(baseDir, 'linux', `${ModuleName}.cpp`), ModuleName, executablePath, '');
            if(!result){
                return null;
            }
            return `${shellEscapePosix(executablePath)} ${shellEscapePosix(exeName)} ${shellEscapePosix(opt.inputFile)} ${shellEscapePosix(opt.outputFile)} ${shellEscapePosix(opt.workDir || "")} ${shellEscapePosix(opt.workDirDirect ? "1" : "0")}; echo`;
        } else {
            if (inputIsCon && outputIsCon) return `"${exeName}"; echo`;
            if (inputIsCon) return `${shellEscapePosix(exeName)} > ${shellEscapePosix(opt.outputFile)}; echo`;
            if (outputIsCon) return `${shellEscapePosix(exeName)} < ${shellEscapePosix(opt.inputFile)}; echo`;
            return `${shellEscapePosix(exeName)} < ${shellEscapePosix(opt.inputFile)} > ${shellEscapePosix(opt.outputFile)}; echo`;
        }
    } else if (opt.useUnFileRedirect) {
        const inIsCon = isConsoleDevicePath(opt.unFileInputFile);
        const outIsCon = isConsoleDevicePath(opt.unFileOutputFile);
        if (inIsCon && outIsCon) {
            if (opt.UseConsoleInfo) {
                const ModuleName = 'ConsoleInfo';
                const executablePath = path.join(getTempDir(), 'Module', ModuleName);
                const result = await CompileModule(path.join(baseDir, 'linux', `${ModuleName}.cpp`), ModuleName, executablePath, '');
                if(!result) return null;
                return `${shellEscapePosix(executablePath)} ${shellEscapePosix(exeName)} ${shellEscapePosix(opt.workDir || "")} ${shellEscapePosix(opt.workDirDirect ? "1" : "0")}; echo`;
            } else {
                return `"${exeName}"; echo`;
            }
        }
        if (opt.UseConsoleInfo) {
            const ModuleName = 'ConsoleInfoUnFileIO';
            const executablePath = path.join(getTempDir(), 'Module', ModuleName);
            const result = await CompileModule(path.join(baseDir, 'linux', `${ModuleName}.cpp`), ModuleName, executablePath, '');
            if(!result){
                return null;
            }
            return `${shellEscapePosix(executablePath)} ${shellEscapePosix(exeName)} ${shellEscapePosix(opt.unFileInputFile)} ${shellEscapePosix(opt.unFileOutputFile)} ${shellEscapePosix(opt.workDir || "")} ${shellEscapePosix(opt.workDirDirect ? "1" : "0")}; echo`;
        } else {
            const ModuleName = 'UnFileIO';
            const executablePath = path.join(getTempDir(), 'Module', ModuleName);
            const result = await CompileModule(path.join(baseDir, 'linux', `${ModuleName}.cpp`), ModuleName, executablePath, '');
            if(!result){
                return null;
            }
            return `${shellEscapePosix(executablePath)} ${shellEscapePosix(exeName)} ${shellEscapePosix(opt.unFileInputFile)} ${shellEscapePosix(opt.unFileOutputFile)} ${shellEscapePosix(opt.workDir || "")} ${shellEscapePosix(opt.workDirDirect ? "1" : "0")}; echo`;
        }
    } else {
        if (opt.UseConsoleInfo) {
            const ModuleName = 'ConsoleInfo';
            const executablePath = path.join(getTempDir(), 'Module', ModuleName);
            const result = await CompileModule(path.join(baseDir, 'linux', `${ModuleName}.cpp`), ModuleName, executablePath, '');
            if(!result){
                return null;
            }
            return `${shellEscapePosix(executablePath)} ${shellEscapePosix(exeName)} ${shellEscapePosix(opt.workDir || "")} ${shellEscapePosix(opt.workDirDirect ? "1" : "0")}; echo`;
        } else {
            return `"${exeName}"; echo`;
        }
    }
}


async function buildTerminalCommandLinux(executablePath, cdCommand, runCommand) {
    // cdCommand / runCommand 里已经用双引号包了路径，这里不能再套一层双引号：
    // 外层 sh 会在第一个内层引号处截断，路径含空格时程序根本不会启动。
    const script = `${cdCommand}; ${runCommand}; read -s -n1 -p '按任意键退出...'`;
    return `gnome-terminal --title=${shellEscapePosix(executablePath)} -- bash -c ${shellEscapePosix(script)}`;
}

// ---------------- macOS (Darwin) 构建命令 ----------------

async function buildRunCommandMacOS(baseDir, exeName, opt) {
    if (opt.useFileRedirect && opt.useUnFileRedirect) {
        if (isConsoleDevicePath(opt.unFileInputFile) && isConsoleDevicePath(opt.unFileOutputFile)) {
            if (opt.UseConsoleInfo) {
                const ModuleName = 'ConsoleInfo';
                const executablePath = path.join(getTempDir(), 'Module', ModuleName);
                const result = await CompileModule(path.join(baseDir, 'macOS', `${ModuleName}.cpp`), ModuleName, executablePath);
                if(!result) return null;
                return `${shellEscapePosix(executablePath)} ${shellEscapePosix(exeName)} ${shellEscapePosix(opt.workDir || "")} ${shellEscapePosix(opt.workDirDirect ? "1" : "0")}; echo`;
            } else {
                return `"${exeName}"; echo`;
            }
        }
        if (opt.UseConsoleInfo) {
            const ModuleName = 'ConsoleInfoChangeFileIO';
            const executablePath = path.join(getTempDir(), 'Module', ModuleName);
            const result = await CompileModule(path.join(baseDir, 'macOS', `${ModuleName}.cpp`), ModuleName, executablePath);
            if(!result) return null;
            // macOS 下通常不需要 .exe 后缀，且路径处理逻辑与 Linux 类似
            return `${shellEscapePosix(executablePath)} ${shellEscapePosix(exeName)} ${shellEscapePosix(opt.inputFile)} ${shellEscapePosix(opt.outputFile)} ${shellEscapePosix(opt.unFileInputFile)} ${shellEscapePosix(opt.unFileOutputFile)} ${shellEscapePosix(opt.workDir || "")} ${shellEscapePosix(opt.workDirDirect ? "1" : "0")}; echo`;
        } else {
            const ModuleName = 'ChangeFileIO';
            const executablePath = path.join(getTempDir(), 'Module', ModuleName);
            const result = await CompileModule(path.join(baseDir, 'macOS', `${ModuleName}.cpp`), ModuleName, executablePath);
            if(!result) return null;
            return `${shellEscapePosix(executablePath)} ${shellEscapePosix(exeName)} ${shellEscapePosix(opt.inputFile)} ${shellEscapePosix(opt.outputFile)} ${shellEscapePosix(opt.unFileInputFile)} ${shellEscapePosix(opt.unFileOutputFile)} ${shellEscapePosix(opt.workDir || "")} ${shellEscapePosix(opt.workDirDirect ? "1" : "0")}; echo`;
        }
    } else if (opt.useFileRedirect) {
        const inputIsCon = isConsoleDevicePath(opt.inputFile);
        const outputIsCon = isConsoleDevicePath(opt.outputFile);
        if (opt.UseConsoleInfo) {
            if (inputIsCon || outputIsCon) {
                let cmd = `${shellEscapePosix(exeName)}`;
                if (!inputIsCon && opt.inputFile) cmd = `${shellEscapePosix(exeName)} < ${shellEscapePosix(opt.inputFile)}`;
                if (!outputIsCon && opt.outputFile) {
                    if (cmd.includes('<')) cmd += ` > ${shellEscapePosix(opt.outputFile)}`;
                    else cmd = `${shellEscapePosix(exeName)} > ${shellEscapePosix(opt.outputFile)}`;
                }
                if (inputIsCon && outputIsCon) cmd = `"${exeName}"`;
                return `${cmd}; echo`;
            }
            const ModuleName = 'ConsoleInfoFileIO';
            const executablePath = path.join(getTempDir(), 'Module', ModuleName);
            const result = await CompileModule(path.join(baseDir, 'macOS', `${ModuleName}.cpp`), ModuleName, executablePath, '');
            if(!result) return null;
            return `${shellEscapePosix(executablePath)} ${shellEscapePosix(exeName)} ${shellEscapePosix(opt.inputFile)} ${shellEscapePosix(opt.outputFile)} ${shellEscapePosix(opt.workDir || "")} ${shellEscapePosix(opt.workDirDirect ? "1" : "0")}; echo`;
        } else {
            // macOS 也是类 Unix 系统，标准重定向符号与 Linux 一致
            if (inputIsCon && outputIsCon) return `"${exeName}"; echo`;
            if (inputIsCon) return `${shellEscapePosix(exeName)} > ${shellEscapePosix(opt.outputFile)}; echo`;
            if (outputIsCon) return `${shellEscapePosix(exeName)} < ${shellEscapePosix(opt.inputFile)}; echo`;
            return `${shellEscapePosix(exeName)} < ${shellEscapePosix(opt.inputFile)} > ${shellEscapePosix(opt.outputFile)}; echo`;
        }
    } else if (opt.useUnFileRedirect) {
        const inIsCon = isConsoleDevicePath(opt.unFileInputFile);
        const outIsCon = isConsoleDevicePath(opt.unFileOutputFile);
        if (inIsCon && outIsCon) {
            if (opt.UseConsoleInfo) {
                const ModuleName = 'ConsoleInfo';
                const executablePath = path.join(getTempDir(), 'Module', ModuleName);
                const result = await CompileModule(path.join(baseDir, 'macOS', `${ModuleName}.cpp`), ModuleName, executablePath, '');
                if(!result) return null;
                return `${shellEscapePosix(executablePath)} ${shellEscapePosix(exeName)} ${shellEscapePosix(opt.workDir || "")} ${shellEscapePosix(opt.workDirDirect ? "1" : "0")}; echo`;
            } else {
                return `"${exeName}"; echo`;
            }
        }
        if (opt.UseConsoleInfo) {
            const ModuleName = 'ConsoleInfoUnFileIO';
            const executablePath = path.join(getTempDir(), 'Module', ModuleName);
            const result = await CompileModule(path.join(baseDir, 'macOS', `${ModuleName}.cpp`), ModuleName, executablePath, '');
            if(!result) return null;
            return `${shellEscapePosix(executablePath)} ${shellEscapePosix(exeName)} ${shellEscapePosix(opt.unFileInputFile)} ${shellEscapePosix(opt.unFileOutputFile)} ${shellEscapePosix(opt.workDir || "")} ${shellEscapePosix(opt.workDirDirect ? "1" : "0")}; echo`;
        } else {
            const ModuleName = 'UnFileIO';
            const executablePath = path.join(getTempDir(), 'Module', ModuleName);
            const result = await CompileModule(path.join(baseDir, 'macOS', `${ModuleName}.cpp`), ModuleName, executablePath, '');
            if(!result) return null;
            return `${shellEscapePosix(executablePath)} ${shellEscapePosix(exeName)} ${shellEscapePosix(opt.unFileInputFile)} ${shellEscapePosix(opt.unFileOutputFile)} ${shellEscapePosix(opt.workDir || "")} ${shellEscapePosix(opt.workDirDirect ? "1" : "0")}; echo`;
        }
    } else {
        if (opt.UseConsoleInfo) {
            const ModuleName = 'ConsoleInfo';
            const executablePath = path.join(getTempDir(), 'Module', ModuleName);
            const result = await CompileModule(path.join(baseDir, 'macOS', `${ModuleName}.cpp`), ModuleName, executablePath, '');
            if(!result) return null;
            return `${shellEscapePosix(executablePath)} ${shellEscapePosix(exeName)} ${shellEscapePosix(opt.workDir || "")} ${shellEscapePosix(opt.workDirDirect ? "1" : "0")}; echo`;
        } else {
            return `"${exeName}"; echo`;
        }
    }
}


async function buildTerminalCommandMacOS(executablePath, cdCommand, runCommand) {
    let fullShellCmd = `${cdCommand}; ${runCommand};`;
    fullShellCmd += ` echo; read -n 1 -s -p '按任意键退出...'; exit`;
    const escCmd = appleScriptEscape(fullShellCmd);
    const escTitle = appleScriptEscape(executablePath);
    return `osascript -e 'tell application "Terminal" to activate' -e 'tell application "Terminal" to do script "${escCmd}"' -e 'tell application "Terminal" to set custom title of front window to "${escTitle}"'`;
}

// 侧边栏提供者类
class CppCompilerSidebarProvider {
    constructor(context) {
        this._context = context;
        // 记录“非本地 C++ 文件”中，哪些文档启用了临时文件编译
        this._nonLocalTempMap = new Map(); // docKey -> { tempCppPath, tempDir }
        this._configChangeDisposable = null;
        this._editorChangeDisposable = null;
    }

    updateButtonStates() {
        if (!sidebarPanel) return;

        const editor = vscode.window.activeTextEditor;
        const document = editor && editor.document;

        let enabled = false;

        // 只有 C++ 文件才有意义
            if (document && document.languageId === 'cpp') {
                if (document.uri.scheme === 'file') {
                    // 本地 C++ 文件：始终启用
                    enabled = true;
                } else {
                    // 非本地 C++ 文件：仅当当前文档勾选了“以临时文件进行编译运行”时启用
                    const docKey = document.uri.toString();
                    enabled = this._nonLocalTempMap.has(docKey);
                }
            }

        sidebarPanel.webview.postMessage({
            type: 'updateButtonStates',
            enabled: enabled,
            debuggerAvailable: !!vscode.extensions.getExtension('wudream.dream-cpp-debuger'),
            debugEnabled: !!(document && document.languageId === 'cpp' && document.uri.scheme === 'file' && /\.(?:cpp|cc|cxx|c\+\+)$/i.test(document.uri.fsPath))
        });
    }

    resolveWebviewView(webviewView) {
        try {
            sidebarPanel = webviewView;

            webviewView.webview.options = {
                enableScripts: true,
                localResourceRoots: [
                    this._context.extensionUri
                ]
            };

            webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

            webviewView.onDidChangeVisibility(() => {
                // 当视图重新可见时更新按钮状态
                if (webviewView.visible) {
                    this.updateButtonStates();
                    this.updateWebviewContent();
                }
            });
        } catch (e) {
            const errMsg = `cppCompilerSidebar 还原失败: ${e?.message || e}`;
            ShowError(errMsg);
            if (webviewView?.webview) {
                webviewView.webview.html = `<!DOCTYPE html><html><body><pre>${errMsg}</pre></body></html>`;
            }
        }

        // 监听活动编辑器变化（视图重建时先释放旧监听，避免重复累积）
        if (this._editorChangeDisposable) this._editorChangeDisposable.dispose();
        this._editorChangeDisposable = vscode.window.onDidChangeActiveTextEditor(() => {
            this.updateButtonStates();
            this.updateWebviewContent();
        });
        if (typeof webviewView.onDidDispose === 'function') {
            webviewView.onDidDispose(() => {
                if (this._editorChangeDisposable) {
                    this._editorChangeDisposable.dispose();
                    this._editorChangeDisposable = null;
                }
            });
        }

        // 初始检查状态
        this.updateButtonStates();
        this.updateWebviewContent();

        const useConsoleInfo = getConfig('useConsoleInfo') || false;

        // 监听来自webview的消息
        webviewView.webview.onDidReceiveMessage(async (data) => {
            switch (data.type) {
                case 'webviewReady': {
                    this.updateButtonStates();
                    this.updateWebviewContent();
                    break;
                }
                case 'startDebug': {
                    await startCompanionDebug(data.filePath);
                    break;
                }
                case 'runInternal': {
                    const customVariable = getFileConfig(data.filePath, 'customVariable') || '';
                    const moreCommand = getFileConfig(data.filePath, 'moreCommand') || '';
                    const compileOptions = getFileConfig(data.filePath, 'compileOptions');
                    const useStatic = getFileConfig(data.filePath, 'useStaticLinking');
                    const useFileRedirect = getFileConfig(data.filePath, 'useFileRedirect');
                    const useUnFileRedirect = getFileConfig(data.filePath, 'useUnFileRedirect');

                    ShowInfos([`用户在侧边栏选择了编译后在内置终端运行`, `编译选项为：${compileOptions}`, `${useStatic ? '启用' : '禁用'}静态编译`, `${useConsoleInfo ? '使用' : '禁用'} ConsoleInfo.exe 运行程序`, `${useFileRedirect ? `启用文件重定向，输入文件为 ${getFileConfig(data.filePath, 'inputFile')}，输出文件为 ${getFileConfig(data.filePath, 'outputFile')}` : '禁用文件重定向'}`, `${useUnFileRedirect ? `启用反文件重定向，输入文件为 ${getFileConfig(data.filePath, 'unFileInputFile')}，输出文件为 ${getFileConfig(data.filePath, 'unFileOutputFile')}` : '禁用反文件重定向'}`, `${moreCommand ? `额外运行命令为 ${moreCommand}` : '无额外运行命令'}`, `自定义变量 var 为 "${customVariable}"`]);
                    compileAndRun('internal', data.filePath);
                    break;
                }

                case 'runExternal': {
                    const customVariable = getFileConfig(data.filePath, 'customVariable') || '';
                    const moreCommand = getFileConfig(data.filePath, 'moreCommand') || '';
                    const compileOptions = getFileConfig(data.filePath, 'compileOptions');
                    const useStatic = getFileConfig(data.filePath, 'useStaticLinking');
                    const useFileRedirect = getFileConfig(data.filePath, 'useFileRedirect');
                    const useUnFileRedirect = getFileConfig(data.filePath, 'useUnFileRedirect');

                    ShowInfos([`用户在侧边栏选择了编译后在外部终端运行`, `编译选项为：${compileOptions}`, `${useStatic ? '启用' : '禁用'}静态编译`, `${useConsoleInfo ? '使用' : '禁用'} ConsoleInfo.exe 运行程序`, `${useFileRedirect ? `启用文件重定向，输入文件为 ${getFileConfig(data.filePath, 'inputFile')}，输出文件为 ${getFileConfig(data.filePath, 'outputFile')}` : '禁用文件重定向'}`, `${useUnFileRedirect ? `启用反文件重定向，输入文件为 ${getFileConfig(data.filePath, 'unFileInputFile')}，输出文件为 ${getFileConfig(data.filePath, 'unFileOutputFile')}` : '禁用反文件重定向'}`, `${moreCommand ? `额外运行命令为 ${moreCommand}` : '无额外运行命令'}`, `自定义变量 var 为 "${customVariable}"`]);
                    compileAndRun('external', data.filePath);
                    break;
                }

                case 'onlyCompile': {
                    const customVariable = getFileConfig(data.filePath, 'customVariable') || '';
                    const moreCommand = getFileConfig(data.filePath, 'moreCommand') || '';
                    const compileOptions = getFileConfig(data.filePath, 'compileOptions');
                    const useStatic = getFileConfig(data.filePath, 'useStaticLinking');
                    const useFileRedirect = getFileConfig(data.filePath, 'useFileRedirect');
                    const useUnFileRedirect = getFileConfig(data.filePath, 'useUnFileRedirect');

                    ShowInfos([`用户在侧边栏选择了仅编译`, `编译选项为：${compileOptions}`, `${useStatic ? '启用' : '禁用'}静态编译`, `${useConsoleInfo ? '使用' : '禁用'} ConsoleInfo.exe 运行程序`, `${useFileRedirect ? `启用文件重定向，输入文件为 ${getFileConfig(data.filePath, 'inputFile')}，输出文件为 ${getFileConfig(data.filePath, 'outputFile')}` : '禁用文件重定向'}`, `${useUnFileRedirect ? `启用反文件重定向，输入文件为 ${getFileConfig(data.filePath, 'unFileInputFile')}，输出文件为 ${getFileConfig(data.filePath, 'unFileOutputFile')}` : '禁用反文件重定向'}`, `${moreCommand ? `额外运行命令为 ${moreCommand}` : '无额外运行命令'}`, `自定义变量 var 为 "${customVariable}"`]);
                    compileOnly(data.filePath);
                    break;
                }

                case 'updateCompileOptions': {
                    ShowInfo(`用户在侧边栏更新了 ${data.filePath} 的编译选项，现在为：${data.value}`);
                    setFileConfig(data.filePath, 'compileOptions', data.value);
                    this.updateWebviewContent();
                    break;
                }

                case 'toggleStaticLinking': {
                    ShowInfo(`用户在侧边栏更新了 ${data.filePath} 的静态编译选项，现在为：${data.value}`);
                    setFileConfig(data.filePath, 'useStaticLinking', data.value);
                    this.updateWebviewContent();
                    break;
                }

                case 'toggleUseConsoleInfo': {
                    ShowInfo(`用户在侧边栏更新了 ConsoleInfo.exe 运行选项，现在为：${data.value}`);
                    const Config = vscode.workspace.getConfiguration('dream-cpp-compiler');
                    await Config.update('useConsoleInfo', data.value, vscode.ConfigurationTarget.Global);
                    this.updateWebviewContent();
                    break;
                }

                case 'changeCompilerPath': {
                    ShowInfo(`用户在侧边栏更改了编译器路径，现在为：${data.value}`);
                    const Config = vscode.workspace.getConfiguration('dream-cpp-compiler');
                    await Config.update('compilerPath', data.value, vscode.ConfigurationTarget.Global);
                    this.updateWebviewContent();
                    break;
                }

                case 'toggleFileRedirect': {
                    ShowInfo(`用户在侧边栏设置 ${data.filePath} 的文件重定向为：${data.value}`);
                    setFileConfig(data.filePath, 'useFileRedirect', data.value);
                    this.updateWebviewContent();
                    break;
                }

                case 'toggleUnFileRedirect': {
                    ShowInfo(`用户在侧边栏更新了 ${data.filePath} 的反文件重定向，现在为：${data.value}`);
                    setFileConfig(data.filePath, 'useUnFileRedirect', data.value);
                    this.updateWebviewContent();
                    break;
                }

                case 'updateInputFile': {
                    ShowInfo(`用户在侧边栏更新了 ${data.filePath} 的输入文件路径，现在为：${data.value}`);
                    setFileConfig(data.filePath, 'inputFile', data.value);
                    this.updateWebviewContent();
                    break;
                }

                case 'updateOutputFile': {
                    ShowInfo(`用户在侧边栏更新了 ${data.filePath} 的输出文件路径，现在为：${data.value}`);
                    setFileConfig(data.filePath, 'outputFile', data.value);
                    this.updateWebviewContent();
                    break;
                }

                case 'updateUnFileInputFile': {
                    ShowInfo(`用户在侧边栏更新了 ${data.filePath} 的反输入文件路径，现在为：${data.value}`);
                    setFileConfig(data.filePath, 'unFileInputFile', data.value);
                    this.updateWebviewContent();
                    break;
                }

                case 'updateUnFileOutputFile': {
                    ShowInfo(`用户在侧边栏更新了 ${data.filePath} 的反输出文件路径，现在为：${data.value}`);
                    setFileConfig(data.filePath, 'unFileOutputFile', data.value);
                    this.updateWebviewContent();
                    break;
                }

                case 'updateCardState': {
                    setFileConfig(data.filePath, data.section + 'CardOpen', data.value);
                    ShowInfo(`用户在侧边栏更新了 ${data.filePath} 的 ${data.section} 区域卡片状态，打开状态现在为：${data.value}`);
                    break;
                }

                case 'updateMoreCommand': {
                    ShowInfo(`用户在侧边栏设置了 ${data.filePath} 的运行后额外命令，现在为：${data.value}`);
                    setFileConfig(data.filePath, 'moreCommand', data.value);
                    break;
                }

                case 'updateOutputPath': {
                    ShowInfo(`用户在侧边栏更新了 ${data.filePath} 的输出路径模板，现在为：${data.value}`);
                    setFileConfig(data.filePath, 'outputPath', data.value);
                    this.updateWebviewContent();
                    break;
                }

                case 'updateCustomVariable': {
                    ShowInfo(`用户在侧边栏更新了 ${data.filePath} 的自定义变量 var 的值，现在为：${data.value}`);
                    setFileConfig(data.filePath, 'customVariable', data.value);
                    this.updateWebviewContent();
                    break;
                }

                case 'updateWorkDir': {
                    ShowInfo(`用户在侧边栏更新了临时文件 ${data.filePath} 的工作目录，现在为：${data.value}`);
                    setFileConfig(data.filePath, 'WorkDir', data.value);
                    this.updateWebviewContent();
                    break;
                }
                case 'updateWorkDirDirect': {
                    ShowInfo(`用户在侧边栏更新了 ${data.filePath} 的工作目录直跑，现在为：${data.value}`);
                    setFileConfig(data.filePath, 'workDirDirect', data.value);
                    this.updateWebviewContent();
                    break;
                }

                case 'saveConfigToFile': {
                    try {
                        await updateCppConfigInEditor(vscode.window.activeTextEditor, data.config);
                        if (data.filePath && data.config) {
                            Object.keys(data.config).forEach(key => {
                                setFileConfig(data.filePath, key, data.config[key]);
                            });
                        }

                        ShowInfo(`保存了 ${data.filePath} 的${data.mode === 'raw' ? '模板配置 (保留变量)' : '设置 (绝对路径)'}，内容：${JSON.stringify(data.config, null, 4)}`)
                    } catch (e) {
                        vscode.window.showErrorMessage(`保存失败: ${e.message}`);
                    }
                    break;
                }

                case 'toggleTempFile': {
                    const editor = vscode.window.activeTextEditor;
                    const document = editor && editor.document;
                    const docKey = document ? document.uri.toString() : null;

                    if (!data.enabled) {
                        // 取消勾选：清理临时目录 + 关闭非本地文件的启用状态
                        if (data.filePath) {
                            setFileConfig(data.filePath, 'useTempFile', false);
                        }
                        const entry = docKey ? this._nonLocalTempMap.get(docKey) : null;
                        const tempDirFromConfig = data.filePath ? getFileConfig(data.filePath, 'tempDir') : '';
                        // 只删本扩展自己的临时代码目录。原来还会兜底到 data.tempDir
                        // （webview 传来的工作目录），一旦没有记录就会把用户的工程目录 rm -rf 掉。
                        const dirToRemove = entry?.tempDir || tempDirFromConfig || '';
                        const removable = isTempCodeDir(dirToRemove);

                        ShowInfo(`用户在侧边栏取消了 ${data.filePath} 的以临时文件编译运行设置` +
                            (removable
                                ? `，即将删除临时目录 ${dirToRemove}`
                                : (dirToRemove ? `，目录 ${dirToRemove} 不在扩展临时目录内，已跳过删除` : '')));

                        if (removable) {
                            try {
                                fs.rmSync(dirToRemove, { recursive: true, force: true });
                            } catch (e) {
                                ShowError(`删除临时目录失败：${e.message}`);
                            }
                        }
                        if (data.filePath) {
                            setFileConfig(data.filePath, 'tempDir', '');
                            setFileConfig(data.filePath, 'tempCppPath', '');
                        }

                        if (docKey) {
                            this._nonLocalTempMap.delete(docKey);
                        }

                        this.updateWebviewContent(null);
                    } else {
                        // 勾选：为当前文档创建临时代码目录，并记录状态
                        const tempDir = await GetTempPath(vscode.window.activeTextEditor.document.getText());
                        const tempCppPath = path.join(tempDir, "code.cpp");
                        setFileConfig(tempCppPath, 'useTempFile', true);
                        setFileConfig(tempCppPath, 'tempDir', tempDir);
                        if (document && document.languageId !== 'cpp') {
                            try {
                                await vscode.languages.setTextDocumentLanguage(document, 'cpp');
                            } catch (e) {
                                ShowWarn(`切换语言为 cpp 失败：${e.message}`);
                            }
                        }
                        if (data.filePath) {
                            setFileConfig(data.filePath, 'useTempFile', true);
                            setFileConfig(data.filePath, 'tempDir', tempDir);;
                        }

                        if (document && docKey) {
                            this._nonLocalTempMap.set(docKey, { tempCppPath, tempDir });
                        }

                        this.updateWebviewContent(tempCppPath);
                    }

                    // 勾选 / 取消后都重新刷新按钮状态
                    this.updateButtonStates();
                    break;
                }
            }
        });

        // 监听配置变化，更新UI（之前的 disposable 没有登记，视图重建后监听会重复累积）
        if (this._configChangeDisposable) this._configChangeDisposable.dispose();
        this._configChangeDisposable = vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('dream-cpp-compiler')) {
                this.updateWebviewContent();
            }
        });
        if (typeof webviewView.onDidDispose === 'function') {
            webviewView.onDidDispose(() => {
                if (this._configChangeDisposable) {
                    this._configChangeDisposable.dispose();
                    this._configChangeDisposable = null;
                }
            });
        }
    }

    updateWebviewContent(filePath) {
        if (!sidebarPanel) return;

        const useConsoleInfo = getConfig('useConsoleInfo') || false;
        const compilerPath = getConfig('compilerPath') || 'g++';

        // 如果未显式指定 filePath，则根据当前活动编辑器推断
        if (!filePath) {
            const editor = vscode.window.activeTextEditor;
            const document = editor && editor.document;
            if (document && document.languageId === 'cpp') {
                const docKey = document.uri.toString();
                const entry = this._nonLocalTempMap.get(docKey);
                if (entry) filePath = entry.tempCppPath;
                else if (document.uri.scheme === 'file') {
                    // 本地文件：直接使用真实路径
                    filePath = document.uri.fsPath;
                }
            }
        }

        // 获取当前文件的配置
        let inputFile = '';
        let outputFile = '';
        let unFileInputFile = '';
        let unFileOutputFile = '';
        let useFileRedirect = false;
        let useUnFileRedirect = false;
        let isCppFile = false;
        let compileOptionsCardOpen = true;
        let runControlCardOpen = true;
        let advancedCardOpen = false;
        let fileOperationsCardOpen = false;
        let baseName = '';
        let compileOptions = '';
        let useStatic = false;
        let moreCommand = '';
        let customVariable = '';
        let outputPath = '';
        let cppDir = '';
        let workdir = '';
        let tmpDir = '';
        let WorkDir = '';
        let workDirDirect = false;
        let useTempFile = false;

        if (filePath) {
            baseName = getBaseName(filePath);
            inputFile = getFileConfig(filePath, 'inputFile');
            outputFile = getFileConfig(filePath, 'outputFile');
            unFileInputFile = getFileConfig(filePath, 'unFileInputFile');
            unFileOutputFile = getFileConfig(filePath, 'unFileOutputFile');
            useFileRedirect = getFileConfig(filePath, 'useFileRedirect');
            useUnFileRedirect = getFileConfig(filePath, 'useUnFileRedirect');
            compileOptionsCardOpen = getFileConfig(filePath, 'compileOptionsCardOpen');
            runControlCardOpen = getFileConfig(filePath, 'runControlCardOpen');
            advancedCardOpen = getFileConfig(filePath, 'advancedCardOpen');
            fileOperationsCardOpen = getFileConfig(filePath, 'fileOperationsCardOpen');
            isCppFile = true;
            compileOptions = getFileConfig(filePath, 'compileOptions');
            useStatic = getFileConfig(filePath, 'useStaticLinking');
            moreCommand = getFileConfig(filePath, 'moreCommand');
            customVariable = getFileConfig(filePath, 'customVariable');
            outputPath = getFileConfig(filePath, 'outputPath');
            WorkDir = getFileConfig(filePath, 'WorkDir') || '';
            workDirDirect = !!getFileConfig(filePath, 'workDirDirect');
            useTempFile = !!getFileConfig(filePath, 'useTempFile');
            cppDir = path.dirname(filePath) || '';
            workdir = vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath || cppDir || '';
            tmpDir = os.tmpdir();
        }

        sidebarPanel.webview.postMessage({
            type: 'init',
            filePath: filePath,
            baseName: baseName
        });

        sidebarPanel.webview.postMessage({
            type: 'updateConfig',
            compilerPath: compilerPath,
            useConsoleInfo: useConsoleInfo,
            inputFile: inputFile,
            outputFile: outputFile,
            unFileInputFile: unFileInputFile,
            unFileOutputFile: unFileOutputFile,
            useFileRedirect: useFileRedirect,
            useUnFileRedirect: useUnFileRedirect,
            compileOptionsCardOpen: compileOptionsCardOpen,
            runControlCardOpen: runControlCardOpen,
            advancedCardOpen: advancedCardOpen,
            fileOperationsCardOpen: fileOperationsCardOpen,
            isCppFile: isCppFile,
            compileOptions: compileOptions,
            useStaticLinking: useStatic,
            moreCommand: moreCommand,
            customVariable: customVariable,
            outputPath: outputPath,
            WorkDir: WorkDir,
            workDirDirect: workDirDirect,
            useTempFile: useTempFile
        });

        sidebarPanel.webview.postMessage({
            type: 'updateContext',
            customVariable: customVariable,
            baseName: baseName,
            cppDir: cppDir,
            workdir: workdir,
            tmpDir: tmpDir
        });
    }

    _getHtmlForWebview() {
        return `<!DOCTYPE html>
        <html lang="zh-CN">

        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>C++编译控制</title>
            <style>
                :root{
                    --radius-xl: 14px;
                    --radius-lg: 12px;
                    --radius-md: 10px;
                    --radius-sm: 8px;

                    --shadow-1: 0 1px 2px rgba(0,0,0,.10), 0 1px 1px rgba(0,0,0,.06) inset;
                    --shadow-2: 0 10px 28px rgba(0,0,0,.20), 0 1px 0 rgba(255,255,255,.04) inset;

                    --ring: 0 0 0 2px color-mix(in srgb, var(--vscode-focusBorder) 45%, transparent);
                    --ring-soft: 0 0 0 1px color-mix(in srgb, var(--vscode-focusBorder) 30%, transparent);

                    --card-bg: color-mix(in srgb, var(--vscode-sideBarSectionHeader-background) 78%, #ffffff12);
                    --card-bg-hover: color-mix(in srgb, var(--vscode-sideBarSectionHeader-background) 70%, #ffffff1f);

                    --muted: var(--vscode-descriptionForeground);
                    --fg: var(--vscode-foreground);
                }

                *{
                    margin: 0;
                    padding: 0;
                    box-sizing: border-box;
                    scrollbar-width: none;
                }

                *,
                *::before,
                *::after{
                    transition:
                        color .18s ease,
                        background-color .18s ease,
                        border-color .18s ease,
                        box-shadow .22s ease,
                        transform .22s ease,
                        opacity .22s ease,
                        filter .22s ease;
                }

                body{
                    background:
                        radial-gradient(1200px 400px at 20% -10%, rgba(255,255,255,.06), transparent 55%),
                        radial-gradient(900px 300px at 90% 0%, rgba(255,255,255,.04), transparent 50%),
                        color-mix(in srgb, var(--vscode-sideBar-background) 92%, #fcf7ef55);
                    color: var(--fg);
                    font-family: var(--vscode-font-family);
                    font-size: 13px;
                    line-height: 1.55;
                    padding: 10px;
                }

                .container{
                    display: flex;
                    flex-direction: column;
                    gap: 14px;
                    width: 100%;
                }

                /* ============ 卡片区块 ============ */
                .collapsible-section{
                    width: 100%;
                    overflow: hidden;
                    border-radius: var(--radius-xl);
                    border: 1px solid color-mix(in srgb, var(--vscode-panel-border) 65%, transparent);
                    background: linear-gradient(
                        180deg,
                        color-mix(in srgb, var(--card-bg) 92%, transparent),
                        color-mix(in srgb, var(--vscode-sideBar-background) 92%, transparent)
                    );
                    box-shadow: var(--shadow-1);
                    position: relative;
                }

                .collapsible-section::before{
                    content:"";
                    position:absolute;
                    inset:0;
                    pointer-events:none;
                    background: radial-gradient(800px 200px at 30% 0%, rgba(255,255,255,.08), transparent 55%);
                    opacity:.9;
                }

                .collapsible-section:hover{
                    transform: translateY(-2px);
                    border-color: color-mix(in srgb, var(--vscode-focusBorder) 65%, transparent);
                    background: linear-gradient(
                        180deg,
                        var(--card-bg-hover),
                        color-mix(in srgb, var(--vscode-sideBar-background) 92%, transparent)
                    );
                    box-shadow: var(--shadow-2);
                }

                /* ============ 标题栏 ============ */
                .section-header{
                    padding: 14px 16px;
                    display: flex;
                    align-items: center;
                    justify-content: space-between;

                    cursor: pointer;
                    user-select: none;

                    background: color-mix(in srgb, var(--vscode-sideBarSectionHeader-background) 70%, transparent);
                    backdrop-filter: blur(6px);
                    position: relative;
                }

                .section-header:active{
                    transform: translateY(1px);
                }

                .section-header::after{
                    content:"";
                    position:absolute;
                    left: 14px;
                    right: 14px;
                    bottom: 0;
                    height: 1px;
                    background: color-mix(in srgb, var(--vscode-panel-border) 60%, transparent);
                    opacity: .55;
                }

                .section-title{
                    display:flex;
                    align-items:center;
                    gap: 10px;
                    font-weight: 700;
                    color: var(--vscode-titleBar-activeForeground);
                    letter-spacing: .2px;
                }

                .section-title::before{
                    content:"";
                    width: 10px;
                    height: 10px;
                    border-radius: 999px;
                    background: var(--vscode-button-background);
                    box-shadow: 0 0 0 3px color-mix(in srgb, var(--vscode-button-background) 25%, transparent);
                }

                /* 折叠箭头 */
                .collapse-icon{
                    width: 16px;
                    height: 16px;
                    color: color-mix(in srgb, var(--muted) 95%, transparent);
                    transform-origin: 50% 55%;
                }

                .rotate{
                    transform: rotate(180deg);
                }

                /* ============ 内容区域（折叠动画） ============ */
                .section-content{
                    padding: 0 16px;
                    max-height: 0;
                    overflow: hidden;
                    opacity: 0;
                    transform: translateY(-6px);
                    transition:
                        max-height .55s cubic-bezier(.2,.9,.2,1),
                        padding .35s cubic-bezier(.2,.9,.2,1),
                        opacity .25s ease,
                        transform .35s cubic-bezier(.2,.9,.2,1);
                }

                .section-content.expanded{
                    padding: 16px;
                    max-height: 1200px;
                    opacity: 1;
                    transform: translateY(0);
                }

                /* ============ 输入区域 ============ */
                .text-input-container{
                    margin-bottom: 14px;
                    position: relative;
                }

                .text-input-label{
                    display: flex;
                    align-items: center;
                    gap: 8px;
                    margin-bottom: 6px;
                    font-size: 12px;
                    color: var(--muted);
                    font-weight: 600;
                    letter-spacing: .2px;
                }

                .text-input-label::before{
                    content:"";
                    width: 6px;
                    height: 6px;
                    border-radius: 999px;
                    background: color-mix(in srgb, var(--vscode-button-background) 55%, transparent);
                }

                input[type="text"]{
                    width: 100%;
                    height: 38px;
                    padding: 10px 12px;

                    border-radius: var(--radius-lg);
                    border: 1px solid color-mix(in srgb, var(--vscode-input-border) 70%, transparent);

                    background: linear-gradient(
                        180deg,
                        color-mix(in srgb, var(--vscode-input-background) 92%, #ffffff08),
                        color-mix(in srgb, var(--vscode-input-background) 96%, transparent)
                    );

                    color: var(--vscode-input-foreground);
                    font-size: 13px;
                    font-family: var(--vscode-font-family);

                    outline: none;
                    box-shadow:
                        0 1px 0 rgba(255,255,255,.05) inset,
                        0 6px 18px rgba(0,0,0,.08);
                }

                input[type="text"]::placeholder{
                    color: var(--vscode-input-placeholderForeground);
                    opacity: .65;
                }

                input[type="text"]:hover{
                    border-color: color-mix(in srgb, var(--vscode-focusBorder) 55%, transparent);
                    box-shadow:
                        var(--ring-soft),
                        0 8px 22px rgba(0,0,0,.12);
                }

                input[type="text"]:focus{
                    border-color: var(--vscode-focusBorder);
                    box-shadow:
                        var(--ring),
                        0 10px 26px rgba(0,0,0,.14);
                }

                input:disabled{
                    opacity: .65;
                    cursor: not-allowed;
                    filter: grayscale(20%);
                }

                /* ============ 保存状态（更像小 Badge） ============ */
                .save-status{
                    position: absolute;
                    right: 12px;
                    top: 50%;
                    transform: translateY(-50%) scale(.96);
                    font-size: 11px;
                    font-weight: 700;
                    letter-spacing: .2px;

                    color: color-mix(in srgb, var(--vscode-testing-iconPassed) 95%, white);
                    opacity: 0;
                    pointer-events: none;

                    padding: 3px 8px;
                    border-radius: 999px;

                    background: color-mix(in srgb, var(--vscode-testing-iconPassed) 18%, transparent);
                    border: 1px solid color-mix(in srgb, var(--vscode-testing-iconPassed) 35%, transparent);

                    box-shadow: 0 8px 18px rgba(0, 200, 120, 0.18);
                }

                .save-status.visible{
                    opacity: 1;
                    transform: translateY(-50%) scale(1);
                    animation: savePulse .85s ease forwards;
                }

                @keyframes savePulse{
                    0%{ opacity:0; transform: translateY(-50%) scale(.88); }
                    55%{ opacity:1; transform: translateY(-50%) scale(1.06); }
                    100%{ opacity:1; transform: translateY(-50%) scale(1); }
                }

                /* ============ 按钮 ============ */
                .button-group{
                    display: grid;
                    grid-template-columns: 1fr;
                    gap: 10px;
                }

                button{
                    height: 40px;
                    padding: 10px 14px;
                    border-radius: var(--radius-lg);
                    border: 1px solid transparent;

                    background: linear-gradient(
                        180deg,
                        color-mix(in srgb, var(--vscode-button-background) 86%, #ffffff12),
                        color-mix(in srgb, var(--vscode-button-background) 70%, #00000012)
                    );

                    color: var(--vscode-button-foreground);
                    font-size: 13px;
                    font-weight: 800;
                    letter-spacing: .2px;

                    cursor: pointer;
                    display: flex;
                    align-items: center;
                    justify-content: center;

                    box-shadow: 0 10px 22px rgba(0,0,0,.22);
                }

                button[hidden] { display: none !important; }

                button:hover:not(:disabled){
                    transform: translateY(-2px);
                    border-color: color-mix(in srgb, var(--vscode-focusBorder) 70%, transparent);
                    box-shadow:
                        var(--ring-soft),
                        0 14px 28px rgba(0,0,0,.28);
                }

                button:active:not(:disabled){
                    transform: translateY(0px);
                    box-shadow: 0 6px 14px rgba(0,0,0,.20);
                }

                button:disabled{
                    opacity: .55;
                    cursor: not-allowed;
                    transform: none;
                    box-shadow: 0 6px 14px rgba(0,0,0,.18);
                }

                /* ============ Checkbox ============ */
                .checkbox-container{
                    display:flex;
                    align-items:center;
                    gap: 10px;

                    margin-top: 10px;
                    padding: 10px 12px;
                    border-radius: var(--radius-lg);

                    border: 1px solid color-mix(in srgb, var(--vscode-panel-border) 55%, transparent);
                    background: color-mix(in srgb, var(--vscode-sideBar-background) 90%, #ffffff10);

                    cursor: pointer;
                    user-select: none;
                }

                .checkbox-container:hover{
                    border-color: color-mix(in srgb, var(--vscode-focusBorder) 55%, transparent);
                    box-shadow: var(--ring-soft);
                }

                input[type="checkbox"]{
                    width: 18px;
                    height: 18px;
                    accent-color: var(--vscode-button-background);
                    cursor: pointer;
                }

                /* ============ 子区块 ============ */
                .subsection{
                    margin-bottom: 14px;
                    padding: 14px;
                    border-radius: var(--radius-xl);

                    border: 1px solid color-mix(in srgb, var(--vscode-panel-border) 55%, transparent);
                    background: linear-gradient(
                        180deg,
                        color-mix(in srgb, var(--vscode-sideBar-background) 92%, #ffffff0d),
                        color-mix(in srgb, var(--vscode-sideBar-background) 96%, transparent)
                    );

                    box-shadow: 0 8px 18px rgba(0,0,0,.10);
                }

                .subsection:hover{
                    border-color: color-mix(in srgb, var(--vscode-focusBorder) 55%, transparent);
                    box-shadow:
                        var(--ring-soft),
                        0 12px 22px rgba(0,0,0,.14);
                }

                .subsection-title{
                    font-weight: 900;
                    font-size: 13px;
                    color: var(--vscode-titleBar-activeForeground);
                    margin-bottom: 12px;

                    display:flex;
                    align-items:center;
                    gap: 8px;
                }

                .subsection-title::before{
                    content:"";
                    width: 14px;
                    height: 2px;
                    border-radius: 999px;
                    background: color-mix(in srgb, var(--vscode-button-background) 70%, transparent);
                }

                /* ============ 模态框 ============ */
                .modal{
                    display: none;
                    position: fixed;
                    inset: 0;
                    background: rgba(0,0,0,.55);
                    z-index: 1000;
                    align-items: center;
                    justify-content: center;
                    backdrop-filter: blur(4px);
                }

                .modal-content{
                    width: 520px;
                    max-width: 92%;
                    border-radius: 16px;
                    border: 1px solid color-mix(in srgb, var(--vscode-panel-border) 70%, transparent);

                    background: linear-gradient(
                        180deg,
                        color-mix(in srgb, var(--vscode-sideBar-background) 92%, #ffffff12),
                        color-mix(in srgb, var(--vscode-sideBar-background) 98%, transparent)
                    );

                    box-shadow: 0 22px 60px rgba(0,0,0,.45);
                    overflow: hidden;
                    animation: modalFadeIn .22s ease;
                }

                @keyframes modalFadeIn{
                    from{ opacity: 0; transform: translateY(-10px) scale(.98); }
                    to{ opacity: 1; transform: translateY(0) scale(1); }
                }

                .modal-header{
                    padding: 16px 18px;
                    border-bottom: 1px solid color-mix(in srgb, var(--vscode-panel-border) 65%, transparent);
                    display:flex;
                    align-items:center;
                    justify-content: space-between;
                }

                .modal-header h3{
                    margin: 0;
                    font-size: 15px;
                    font-weight: 900;
                    color: var(--vscode-titleBar-activeForeground);
                }

                .close-btn{
                    width: 34px;
                    height: 34px;
                    border-radius: 10px;
                    border: 1px solid color-mix(in srgb, var(--vscode-panel-border) 55%, transparent);
                    background: color-mix(in srgb, var(--vscode-sideBar-background) 90%, #ffffff10);
                    color: var(--fg);
                    font-size: 20px;
                    cursor: pointer;
                    display:flex;
                    align-items:center;
                    justify-content:center;
                }

                .close-btn:hover{
                    border-color: color-mix(in srgb, var(--vscode-focusBorder) 60%, transparent);
                    box-shadow: var(--ring-soft);
                }

                .modal-body{
                    padding: 18px;
                }

                .modal-footer{
                    padding: 14px 18px;
                    border-top: 1px solid color-mix(in srgb, var(--vscode-panel-border) 65%, transparent);
                    display:flex;
                    justify-content:flex-end;
                    gap: 10px;
                }

                .modal-footer button{
                    height: 36px;
                    padding: 8px 14px;
                    border-radius: 12px;
                    font-weight: 900;
                }

                #cancelEdit{
                    background: color-mix(in srgb, var(--vscode-input-background) 92%, #ffffff10);
                    color: var(--fg);
                    border: 1px solid color-mix(in srgb, var(--vscode-panel-border) 65%, transparent);
                    box-shadow: none;
                }

                #saveEdit{
                    border: 1px solid color-mix(in srgb, var(--vscode-focusBorder) 65%, transparent);
                }

                /* 模态框激活时主界面变灰 */
                .modal-active .container{
                    filter: grayscale(45%) blur(1px);
                    opacity: .55;
                    pointer-events: none;
                }
            </style>
        </head>

        <body>
            <!-- 主容器 -->
            <div class="container">
                <!-- 编译选项区块（可折叠） -->
                <div class="collapsible-section">
                    <div class="section-header" data-section="compileOptions">
                        <div class="section-title">编译设置</div>
                        <svg class="collapse-icon" aria-hidden="true" focusable="false" xmlns="http://www.w3.org/2000/svg"
                            viewBox="0 0 512 512" fill="currentColor">
                            <path d="M267.3 395.3c-6.2 6.2-16.4 6.2-22.6 0l-192-192c-6.2-6.2-6.2-16.4 0-22.6s16.4-6.2 22.6 0L256 361.4 436.7 180.7c6.2-6.2 16.4-6.2 22.6 0s6.2 16.4 0 22.6l-192 192z" />
                        </svg>
                    </div>
                    <div class="section-content" id="compileOptionsContent">
                        <div class="text-input-container">
                            <div class="text-input-label">编译器路径</div>
                            <input type="text" id="compilerPath" placeholder="请输入编译器路径" title="编译器路径，如：C:\\mingw64\\g++ 或 /usr/bin/g++ 或 g++">
                            <div class="save-status" id="compilerPathStatus">✓ 已保存</div>
                        </div>
                        <div class="text-input-container">
                            <div class="text-input-label">编译器编译选项</div>
                            <input type="text" id="compileOptions" placeholder="输入编译选项，如：-std=c++17 -Wall">
                            <div class="save-status" id="compileOptionsStatus">✓ 已保存</div>
                        </div>
                        <div class="text-input-container">
                            <div class="text-input-label">输出文件路径</div>
                            <input type="text" id="outputPath" placeholder="输出文件路径模板" title="输出的可执行文件的路径 (<cppDir> 代表源文件所在目录，<baseName> 代表不带后缀名的文件名，<workdir> 代表工作目录(未打开则就是源文件所在目录)，<tmpDir> 代表临时目录)">
                            <div class="save-status" id="outputPathStatus">✓ 已保存</div>
                        </div>
                        <div class="checkbox-container">
                            <input type="checkbox" id="staticLinking">
                            <label for="staticLinking">使用静态链接</label>
                        </div>
                    </div>
                </div>

                <!-- 运行控制区块（可折叠） -->
                <div class="collapsible-section">
                    <div class="section-header" data-section="runControl">
                        <div class="section-title">运行控制</div>
                        <svg class="collapse-icon" aria-hidden="true" focusable="false" xmlns="http://www.w3.org/2000/svg"
                            viewBox="0 0 512 512" fill="currentColor">
                            <path d="M267.3 395.3c-6.2 6.2-16.4 6.2-22.6 0l-192-192c-6.2-6.2-6.2-16.4 0-22.6s16.4-6.2 22.6 0L256 361.4 436.7 180.7c6.2-6.2 16.4-6.2 22.6 0s6.2 16.4 0 22.6l-192 192z" />
                        </svg>
                    </div>
                    <div class="section-content" id="runControlContent">
                        <div class="button-group">
                            <button id="runInternal">内置终端运行</button>
                            <button id="runExternal">外部终端运行</button>
                            <button id="onlyCompile">仅编译</button>
                            <button id="startDebug" hidden>GDB 调试</button>
                        </div>
                        <div class="checkbox-container">
                            <input type="checkbox" id="useConsoleInfo">
                            <label for="useConsoleInfo">使用 ConsoleInfo 运行程序</label>
                        </div>
                        <div class="text-input-container">
                            <div class="text-input-label">在指定目录运行</div>
                            <input type="text" id="WorkDir" placeholder="留空以使用自动保存的路径" title="留空以使用自动保存的路径">
                            <div class="save-status" id="WorkDirStatus">✓ 已保存</div>
                        </div>
                    </div>
                </div>

                <!-- 高级设置区块 -->
                <div class="collapsible-section">
                    <div class="section-header" data-section="advanced">
                        <div class="section-title">高级选项</div>
                        <svg class="collapse-icon" aria-hidden="true" focusable="false" xmlns="http://www.w3.org/2000/svg"
                            viewBox="0 0 512 512" fill="currentColor">
                            <path d="M267.3 395.3c-6.2 6.2-16.4 6.2-22.6 0l-192-192c-6.2-6.2-6.2-16.4 0-22.6s16.4-6.2 22.6 0L256 361.4 436.7 180.7c6.2-6.2 16.4-6.2 22.6 0s6.2 16.4 0 22.6l-192 192z" />
                        </svg>
                    </div>

                    <div class="section-content" id="advancedContent">
                        <!-- 运行后额外命令 -->
                        <div class="text-input-container">
                            <div class="text-input-label">运行后额外命令</div>
                            <input type="text" id="moreCommand" placeholder="输入运行后额外命令" title="在暂停之前执行的命令，如\"./my_checker my.out bf.out\"（可以使用 <var> 占位符来使用自定义变量，<base> 占位符将会被替换为当前文件的无拓展名形式）">
                            <div class="save-status" id="moreCommandStatus">✓ 已保存</div>
                        </div>

                        <!-- 自定义变量 -->
                        <div class="text-input-container">
                            <div class="text-input-label">自定义变量</div>
                            <input type="text" id="customVariable" placeholder="输入自定义 var 变量的值">
                            <div class="save-status" id="customVariableStatus">✓ 已保存</div>
                        </div>

                        <!-- 保存设置 -->
                        <div class="save-actions-section">
                            <div class="button-group">
                                <button id="saveSettings" title="将当前设置替换变量后保存 (保存的是 C:\\test.exe)">保存设置</button>
                                <button id="saveTemplateSettings" title="将当前设置保留变量后保存 (保存的是 <cppDir>\\<baseName>.exe)">保存模板设置</button>
                            </div>
                        </div>

                        <!-- 以临时文件进行编译运行 -->
                        <div class="checkbox-container">
                            <input type="checkbox" id="useTempFile">
                            <label for="useTempFile">以临时文件进行编译运行</label>
                        </div>
                        <div class="checkbox-container">
                            <input type="checkbox" id="workDirDirect">
                            <label for="workDirDirect" title="有额外文件读写时直接在工作目录运行，不拷贝到临时目录（自动检测可覆盖）">工作目录直跑（有额外文件读取）</label>
                        </div>
                    </div>
                </div>

                <!-- 文件读写区块（可折叠） -->
                <div class="collapsible-section">
                    <div class="section-header" data-section="fileOperations">
                        <div class="section-title">文件读写操作</div>
                        <svg class="collapse-icon" aria-hidden="true" focusable="false" xmlns="http://www.w3.org/2000/svg"
                            viewBox="0 0 512 512" fill="currentColor">
                            <path d="M267.3 395.3c-6.2 6.2-16.4 6.2-22.6 0l-192-192c-6.2-6.2-6.2-16.4 0-22.6s16.4-6.2 22.6 0L256 361.4 436.7 180.7c6.2-6.2 16.4-6.2 22.6 0s6.2 16.4 0 22.6l-192 192z" />
                        </svg>
                    </div>
                    <div class="section-content" id="fileOperationsContent">
                        <!-- 文件读写子区块 -->
                        <div class="subsection">
                            <div class="subsection-title">文件读写</div>
                            <div class="text-input-container">
                                <div class="text-input-label">输入文件</div>
                                <input type="text" id="inputFile" value="" placeholder="输入文件路径" title="可以使用 <var> 占位符来使用自定义变量，<base> 占位符将会被替换为当前文件的无拓展名形式">
                                <div class="save-status" id="inputFileStatus">✓ 已保存</div>
                            </div>
                            <div class="text-input-container">
                                <div class="text-input-label">输出文件</div>
                                <input type="text" id="outputFile" value="" placeholder="输入文件路径" title="可以使用 <var> 占位符来使用自定义变量，<base> 占位符将会被替换为当前文件的无拓展名形式">
                                <div class="save-status" id="outputFileStatus">✓ 已保存</div>
                            </div>
                            <div class="checkbox-container">
                                <input type="checkbox" id="useFileRedirect">
                                <label for="useFileRedirect">启用文件读写</label>
                            </div>
                        </div>

                        <!-- 反文件读写子区块 -->
                        <div class="subsection">
                            <div class="subsection-title">反文件读写</div>
                            <div class="text-input-container">
                                <div class="text-input-label">输入文件</div>
                                <input type="text" id="unFileInputFile" value="" placeholder="输入文件路径" title="可以使用 <var> 占位符来使用自定义变量，<base> 占位符将会被替换为当前文件的无拓展名形式">
                                <div class="save-status" id="unFileInputFileStatus">✓ 已保存</div>
                            </div>
                            <div class="text-input-container">
                                <div class="text-input-label">输出文件</div>
                                <input type="text" id="unFileOutputFile" value="" placeholder="输入文件路径" title="可以使用 <var> 占位符来使用自定义变量，<base> 占位符将会被替换为当前文件的无拓展名形式">
                                <div class="save-status" id="unFileOutputFileStatus">✓ 已保存</div>
                            </div>
                            <div class="checkbox-container">
                                <input type="checkbox" id="useUnFileRedirect">
                                <label for="useUnFileRedirect">启用反文件读写</label>
                            </div>
                        </div>
                    </div>
                </div>
            </div>

            <!-- 变量编辑模态框 -->
            <div id="variableEditorModal" class="modal">
                <div class="modal-content">
                    <div class="modal-header">
                        <h3 id="modalTitle">编辑带变量内容</h3>
                        <button class="close-btn" id="closeModal">&times;</button>
                    </div>
                    <div class="modal-body">
                        <div class="text-input-container">
                            <div class="text-input-label">模板编辑框（可包含变量）</div>
                            <input type="text" id="templateInput" placeholder="输入模板内容">
                            <div class="variable-hint" id="variableHint"></div>
                        </div>
                        <div class="text-input-container">
                            <div class="text-input-label">预览编辑框（变量已替换）</div>
                            <input type="text" id="previewInput" placeholder="预览内容">
                        </div>
                        <div class="variable-reference">
                            <div class="reference-title">可用变量：</div>
                            <div class="variable-buttons" id="variableButtons"></div>
                        </div>
                    </div>
                    <div class="modal-footer">
                        <button id="cancelEdit">取消</button>
                        <button id="saveEdit">保存</button>
                    </div>
                </div>
            </div>

            <script>
                const vscode = acquireVsCodeApi();
                let filePath = '', baseName = ''; // 全局状态
                let useTempFile = false;
                let workDirDirect = false;
                let WorkDir = '';

                // ==========================================
                // 1. 配置区域
                // ==========================================
                const VARIABLE_CONFIG = {
                    // 定义变量获取逻辑
                    definitions: {
                        '<var>': {
                            desc: '自定义变量的值',
                            valueFn: function(ctx) { return ctx.varValue; }
                        },
                        '<base>': {
                            desc: '文件名(无后缀)',
                            valueFn: function(ctx) { return ctx.baseName; }
                        },
                        '<baseName>': {
                            desc: '文件名(无后缀)',
                            valueFn: function(ctx) { return ctx.baseName; }
                        },
                        '<cppDir>': {
                            desc: '源文件所在目录',
                            valueFn: function(ctx) { return ctx.cppDir; }
                        },
                        '<workdir>': {
                            desc: '工作区目录',
                            valueFn: function(ctx) { return ctx.workdir; }
                        },
                        '<tmpDir>': {
                            desc: '系统临时目录',
                            valueFn: function(ctx) { return ctx.tmpDir; }
                        }
                    },

                    // 定义变量组
                    groups: {
                        // 通用组：包含 <var>
                        'common': ['<var>', '<base>'],

                        // 【修改点1】变量定义组：专门给 customVariable 使用，严禁包含 <var> 防止递归
                        'varDef': ['<base>', '<cppDir>', '<workdir>'],

                        // 文件操作组
                        'fileOps': ['<var>', '<base>', '<cppDir>'],

                        // 路径生成组：严禁包含 <var>
                        'pathGen': ['<cppDir>', '<baseName>', '<workdir>', '<tmpDir>']
                    },

                    // 绑定输入框规则
                    inputRules: {
                        'moreCommand': 'common',

                        // 【修改点2】自定义变量使用 varDef 组 (不含 <var>)
                        'customVariable': 'varDef',

                        'inputFile': 'fileOps',
                        'outputFile': 'fileOps',
                        'unFileInputFile': 'fileOps',
                        'unFileOutputFile': 'fileOps',
                        'outputPath': 'pathGen',
                        'WorkDir': 'pathGen'
                    }
                };

                // ==========================================
                // 2. 核心逻辑类
                // ==========================================
                class VariableProcessor {
                    constructor() {
                        this.context = {};
                    }

                    setContext(newContext) {
                        this.context = Object.assign({}, this.context, newContext);
                    }

                    getAllowedVariables(inputId) {
                        const rule = VARIABLE_CONFIG.inputRules[inputId] || 'common';

                        let varNames = [];
                        if (Array.isArray(rule)) {
                            varNames = rule;
                        } else if (VARIABLE_CONFIG.groups[rule]) {
                            varNames = VARIABLE_CONFIG.groups[rule];
                        } else {
                            varNames = VARIABLE_CONFIG.groups['common'];
                        }

                        return varNames
                            .filter(function(name) { return VARIABLE_CONFIG.definitions[name]; })
                            .map(function(name) {
                                return {
                                    name: name,
                                    description: VARIABLE_CONFIG.definitions[name].desc
                                };
                            });
                    }

                    replace(template, inputId) {
                        if (!template) return '';

                        const allowedVars = this.getAllowedVariables(inputId || 'common');
                        // 按长度排序防止部分匹配
                        allowedVars.sort(function(a, b) { return b.name.length - a.name.length; });

                        let result = template;

                        for (let i = 0; i < allowedVars.length; i++) {
                            const v = allowedVars[i];
                            const def = VARIABLE_CONFIG.definitions[v.name];
                            if (def) {
                                const value = def.valueFn(this.context) || '';
                                result = result.split(v.name).join(value);
                            }
                        }
                        return result;
                    }
                }

                const processor = new VariableProcessor();

                // ==========================================
                // 3. UI 交互逻辑
                // ==========================================

                function updateInputWithRaw(elementId, rawValue) {
                    const element = document.getElementById(elementId);
                    if (!element) return;

                    // 存原始值 (Truth)
                    element.dataset.rawValue = rawValue || '';
                    // 显预览值 (Display)
                    element.value = processor.replace(rawValue || '', elementId);
                }

                let currentEditingInput = null;
                let currentInputId = null;

                function openVariableEditor(inputElement) {
                    currentEditingInput = inputElement;
                    currentInputId = inputElement.id;

                    document.getElementById('modalTitle').textContent = '编辑 ' + currentInputId;

                    // 【修改点3】强制预览框只读，并设置灰色背景，防止用户误编辑预览内容
                    const previewBox = document.getElementById('previewInput');
                    previewBox.readOnly = true;
                    previewBox.style.backgroundColor = 'var(--vscode-editor-inactiveSelectionBackground)';
                    previewBox.style.cursor = 'not-allowed';
                    previewBox.title = '预览结果不可直接编辑，请编辑上方的模板框';

                    const allowedVars = processor.getAllowedVariables(currentInputId);
                    const buttonsContainer = document.getElementById('variableButtons');
                    buttonsContainer.innerHTML = '';

                    if (allowedVars.length === 0) {
                        document.getElementById('variableHint').textContent = "此字段无可用变量";
                    } else {
                        document.getElementById('variableHint').textContent = '可用变量：' + allowedVars.map(function(v) { return v.name; }).join(' ');
                        allowedVars.forEach(function(v) {
                            const button = document.createElement('button');
                            button.className = 'variable-btn';
                            button.textContent = v.name;
                            button.title = v.description;
                            button.onclick = function() { insertVariable(v.name); };
                            buttonsContainer.appendChild(button);
                        });
                    }

                    // 优先读取 dataset 中的原始值
                    const rawVal = inputElement.dataset.rawValue !== undefined ? inputElement.dataset.rawValue : inputElement.value;

                    document.getElementById('templateInput').value = rawVal;
                    document.getElementById('previewInput').value = processor.replace(rawVal, currentInputId);

                    document.getElementById('variableEditorModal').style.display = 'flex';
                    document.body.classList.add('modal-active');

                    setTimeout(function() {
                        const el = document.getElementById('templateInput');
                        el.focus();
                        el.select();
                    }, 50);
                }

                function insertVariable(varName) {
                    const input = document.getElementById('templateInput');
                    const start = input.selectionStart;
                    const end = input.selectionEnd;
                    input.value = input.value.substring(0, start) + varName + input.value.substring(end);
                    input.setSelectionRange(start + varName.length, start + varName.length);
                    updatePreview();
                }

                function updatePreview() {
                    // 始终基于 templateInput (原始模板) 计算预览
                    const raw = document.getElementById('templateInput').value;
                    const preview = processor.replace(raw, currentInputId);
                    document.getElementById('previewInput').value = preview;
                }

                function closeVariableEditor() {
                    document.getElementById('variableEditorModal').style.display = 'none';
                    document.body.classList.remove('modal-active');
                    currentEditingInput = null;
                    currentInputId = null;
                }

                // ==========================================
                // 4. 事件监听绑定
                // ==========================================

                document.getElementById('templateInput').addEventListener('input', updatePreview);
                document.getElementById('closeModal').addEventListener('click', closeVariableEditor);
                document.getElementById('cancelEdit').addEventListener('click', closeVariableEditor);

                document.getElementById('saveEdit').addEventListener('click', function() {
                    if (currentEditingInput && currentInputId) {
                        // 【关键】始终获取 templateInput 的值 (原始模板)，而不是 previewInput
                        const finalRaw = document.getElementById('templateInput').value;
                        // 1. 更新前端 UI: 存 raw, 显 preview
                        updateInputWithRaw(currentInputId, finalRaw);

                        // 2. 发送 raw 值给后端保存
                        const messageMap = {
                            'moreCommand': 'updateMoreCommand',
                            'inputFile': 'updateInputFile',
                            'outputFile': 'updateOutputFile',
                            'unFileInputFile': 'updateUnFileInputFile',
                            'unFileOutputFile': 'updateUnFileOutputFile',
                            'outputPath': 'updateOutputPath',
                            'customVariable': 'updateCustomVariable',
                            'WorkDir': 'updateWorkDir'
                        };

                        if (messageMap[currentInputId] && filePath) {
                            if (currentInputId === 'WorkDir') {
                                WorkDir = finalRaw;
                            }
                            vscode.postMessage({
                                type: messageMap[currentInputId],
                                filePath: filePath,
                                value: finalRaw
                            });
                            showSaveStatus(currentInputId + 'Status');
                        }
                    }
                    closeVariableEditor();
                });

                // 绑定点击/聚焦事件
                Object.keys(VARIABLE_CONFIG.inputRules).forEach(function(id) {
                    const el = document.getElementById(id);
                    if (el) {
                        el.addEventListener('focus', function(e) {
                            e.preventDefault();
                            openVariableEditor(this);
                        });
                    }
                });

                // ==========================================
                // 5. 消息处理
                // ==========================================
                window.addEventListener('message', function(event) {
                    const data = event.data;

                    if (data.type === 'init') {
                        filePath = data.filePath;
                        baseName = data.baseName;
                    }

                    if (data.type === 'updateContext') {
                        processor.setContext({
                            varValue: data.customVariable,
                            baseName: data.baseName,
                            cppDir: data.cppDir,
                            workdir: data.workdir,
                            tmpDir: data.tmpDir
                        });

                        // 刷新所有带变量输入框的显示
                        Object.keys(VARIABLE_CONFIG.inputRules).forEach(function(id) {
                            const el = document.getElementById(id);
                            // 仅当已有原始值时刷新，避免覆盖
                            if (el && el.dataset.rawValue !== undefined) {
                                updateInputWithRaw(id, el.dataset.rawValue);
                            }
                        });

                        if (document.getElementById('variableEditorModal').style.display === 'flex') {
                            updatePreview();
                        }
                    }

                    if (data.type === 'updateConfig') {
                        document.getElementById('useConsoleInfo').checked = data.useConsoleInfo;
                        document.getElementById('compilerPath').value = data.compilerPath;
                        // 恢复“以临时文件进行编译运行”的勾选状态和子区块显示

                        if (data.isCppFile) {
                            WorkDir = data.WorkDir || '';
                            document.getElementById('compileOptions').value = data.compileOptions;
                            document.getElementById('staticLinking').checked = data.useStaticLinking;
                            document.getElementById('useFileRedirect').checked = data.useFileRedirect;
                            document.getElementById('useUnFileRedirect').checked = data.useUnFileRedirect;

                            // 使用 updateInputWithRaw 统一处理带变量字段
                            updateInputWithRaw('inputFile', data.inputFile);
                            updateInputWithRaw('outputFile', data.outputFile);
                            updateInputWithRaw('unFileInputFile', data.unFileInputFile);
                            updateInputWithRaw('unFileOutputFile', data.unFileOutputFile);
                            updateInputWithRaw('moreCommand', data.moreCommand);
                            updateInputWithRaw('customVariable', data.customVariable);
                            updateInputWithRaw('outputPath', data.outputPath);
                            updateInputWithRaw('WorkDir', data.WorkDir);

                            // 恢复「以临时文件进行编译运行」的勾选状态。之前漏了这一项，
                            // 切换文件后会沿用上一个文件的状态，取消勾选时就会误删目录。
                            useTempFile = !!data.useTempFile;
                            document.getElementById('useTempFile').checked = useTempFile;
                            workDirDirect = !!data.workDirDirect;
                            document.getElementById('workDirDirect').checked = workDirDirect;
                        }

                        ['compileOptions', 'runControl', 'advanced', 'fileOperations'].forEach(function(id) {
                            const open = data[id + "CardOpen"];
                            const content = document.getElementById(id + "Content");
                            const icon = document.querySelector('.section-header[data-section="' + id + '"] .collapse-icon');
                            if(content && icon) {
                                content.classList.toggle('expanded', open);
                                icon.classList.toggle('rotate', open);
                            }
                        });
                    }

                    if (data.type === 'updateButtonStates') {
                        const enabled = data.enabled;
                        const ids = ['runInternal', 'runExternal', 'onlyCompile', 'useFileRedirect', 'useUnFileRedirect', 'staticLinking'];
                        ids.forEach(function(id) {
                            const el = document.getElementById(id);
                            if(el) el.disabled = !enabled;
                        });

                        const debugButton = document.getElementById('startDebug');
                        debugButton.hidden = !data.debuggerAvailable;
                        debugButton.disabled = !data.debuggerAvailable || !data.debugEnabled;

                        const inputIds = Object.keys(VARIABLE_CONFIG.inputRules).concat(['compileOptions', 'WorkDir']);
                        inputIds.forEach(function(id) {
                            const el = document.getElementById(id);
                            if(el) {
                                el.disabled = !enabled;
                                if(!enabled) {
                                el.value = '';
                        }
                            }
                        });
                    }
                });

                // ==========================================
                // 6. 其他 UI 事件
                // ==========================================

                document.querySelectorAll('.section-header').forEach(function(header) {
                    header.addEventListener('click', function() {
                        const sectionId = header.getAttribute('data-section');
                        const content = document.getElementById(sectionId + 'Content');
                        const icon = header.querySelector('.collapse-icon');
                        const isExpanded = content.classList.toggle('expanded');
                        icon.classList.toggle('rotate');
                        if(filePath) vscode.postMessage({ type: 'updateCardState', section: sectionId, filePath: filePath, value: isExpanded });
                    });
                });

                document.getElementById('compilerPath').addEventListener('blur', function(e) {
                    vscode.postMessage({ type: 'changeCompilerPath', value: e.target.value.trim() });
                    showSaveStatus('compilerPathStatus');
                });

                document.getElementById('compileOptions').addEventListener('blur', function(e) {
                    if(filePath) {
                        vscode.postMessage({ type: 'updateCompileOptions', filePath: filePath, value: e.target.value.trim() });
                        showSaveStatus('compileOptionsStatus');
                    }
                });

                document.getElementById('useTempFile').addEventListener('change', (e) => {
                    useTempFile = e.target.checked;
                    vscode.postMessage({
                        type: 'toggleTempFile',
                        enabled: useTempFile,
                        filePath: filePath
                    });
                });
                document.getElementById('workDirDirect').addEventListener('change', (e) => {
                    workDirDirect = e.target.checked;
                    vscode.postMessage({
                        type: 'updateWorkDirDirect',
                        filePath: filePath,
                        value: workDirDirect
                    });
                });

                const checkMap = {
                    'staticLinking': 'toggleStaticLinking',
                    'useConsoleInfo': 'toggleUseConsoleInfo',
                    'useFileRedirect': 'toggleFileRedirect',
                    'useUnFileRedirect': 'toggleUnFileRedirect'
                };
                Object.keys(checkMap).forEach(function(id) {
                    document.getElementById(id).addEventListener('change', function(e) {
                        if(id === 'useConsoleInfo') {
                            vscode.postMessage({ type: checkMap[id], value: e.target.checked });
                        } else if(filePath) {
                            vscode.postMessage({ type: checkMap[id], filePath: filePath, value: e.target.checked });
                        }
                    });
                });

                ['runInternal', 'runExternal', 'onlyCompile', 'startDebug'].forEach(function(id) {
                    document.getElementById(id).addEventListener('click', function() {
                        if(filePath) vscode.postMessage({ type: id, filePath: filePath });
                    });
                });

                function showSaveStatus(id) {
                    const el = document.getElementById(id);
                    if(el) {
                        el.classList.add('visible');
                        setTimeout(function() { el.classList.remove('visible'); }, 3000);
                    }
                }

                // ==========================================
                // 7. 新增保存按钮逻辑
                // ==========================================

                /**
                 * 收集当前配置并发送给后端
                 * mode 'raw' (保存模板/带变量) 或 'cooked' (保存结果/绝对路径)
                 */
                function collectAndSendConfig(mode) {
                    if (!filePath) return;

                    const configToSave = {};

                    // 1. 获取布尔值 (Checkbox) -> 转为字符串存储
                    configToSave['useStaticLinking'] = document.getElementById('staticLinking').checked.toString();
                    configToSave['useFileRedirect'] = document.getElementById('useFileRedirect').checked.toString();
                    configToSave['useUnFileRedirect'] = document.getElementById('useUnFileRedirect').checked.toString();
                    configToSave['useConsoleInfo'] = document.getElementById('useConsoleInfo').checked.toString();
                    // workDirDirect 也是文件头可覆盖的配置，漏了它会导致侧边栏改动无法持久化
                    const workDirDirectEl = document.getElementById('workDirDirect');
                    if (workDirDirectEl) {
                        configToSave['workDirDirect'] = workDirDirectEl.checked.toString();
                    }
                    configToSave['workDirDirect'] = document.getElementById('workDirDirect').checked.toString();

                    // 2. 获取编译选项 (直接取值)
                    configToSave['compileOptions'] = document.getElementById('compileOptions').value;

                    // 3. 获取带变量的字段
                    const variableFields = [
                        'inputFile', 'outputFile',
                        'unFileInputFile', 'unFileOutputFile',
                        'outputPath', 'moreCommand', 'customVariable', 'WorkDir'
                    ];

                    variableFields.forEach(function(id) {
                        const el = document.getElementById(id);
                        if (!el) return;

                        if (mode === 'raw') {
                            configToSave[id] = el.dataset.rawValue !== undefined ? el.dataset.rawValue : el.value;
                        } else {
                            configToSave[id] = el.value;
                        }
                    });

                    // 发送给后端
                    vscode.postMessage({
                        type: 'saveConfigToFile',
                        filePath: filePath,
                        config: configToSave,
                        mode: mode // 用于区分提示信息
                    });
                }

                vscode.postMessage({ type: 'webviewReady' });

                // 绑定按钮事件
                const btnSaveSettings = document.getElementById('saveSettings');
                if (btnSaveSettings) {
                    btnSaveSettings.addEventListener('click', function() {
                        collectAndSendConfig('cooked');
                    });
                }

                const btnSaveTemplate = document.getElementById('saveTemplateSettings');
                if (btnSaveTemplate) {
                    btnSaveTemplate.addEventListener('click', function() {
                        collectAndSendConfig('raw');
                    });
                }
            </script>
        </body>

        </html>`;
    }
}

// Versioned, optional in-process API for the companion GDB extension. It uses
// separate temporary builds, not the ordinary compiler's output or hash cache.
async function compileForDebug(filePath, options = {}) {
    if (!vscode.workspace.isTrusted) throw new Error('请先信任工作区，再编译调试');
    if (typeof filePath !== 'string' || !path.isAbsolute(filePath) || !/\.(?:cpp|cc|cxx|c\+\+)$/i.test(filePath)) throw new Error('联动调试仅支持本地 C++ 源文件');
    const config = fileConfigs[filePath] || parseFileHeaderConfig(filePath);
    if (!config) throw new Error('无法读取 C++ 源文件配置');
    const { flags, linkerFlags, ignored } = debugFlags(config.compileOptions, config.useStaticLinking);
    const compilerPath = getConfig('compilerPath') || 'g++';
    const request = { source: filePath, helper: path.join(__dirname, 'src', 'vectorHelpers.cpp'),
        compilerPath, flags, linkFlags: linkerFlags, signal: options.signal };
    return debugBuildCache.acquire(request, async () => {
        const result = await compileSourceFile(filePath, {
            compilerPath, compileFlags: flags, linkFlags: linkerFlags, vectorHelpers: true,
            autoCleanup: true, signal: options.signal
        });
        result.integration = { provider: 'dream-cpp-compiler', ignoredFlags: ignored };
        return result;
    });
}

async function startCompanionDebug(filePath) {
    if (!vscode.workspace.isTrusted) { vscode.window.showWarningMessage('请先信任工作区，再启动调试'); return; }
    if (!vscode.extensions.getExtension('wudream.dream-cpp-debuger')) {
        vscode.window.showInformationMessage('请先安装并启用 Dream C++ Debugger。'); return;
    }
    if (filePath) {
        if (!path.isAbsolute(filePath) || !/\.(?:cpp|cc|cxx|c\+\+)$/i.test(filePath)) { vscode.window.showWarningMessage('请选择本地 C++ 源文件'); return; }
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
        await vscode.window.showTextDocument(doc, { preview: false });
    }
    await vscode.commands.executeCommand('dream-cpp-debug.startDebug');
}

// 激活扩展
function activate(context) {
    // 清理超出限制的临时代码目录
    cleanupTempCodeRoot();

    // 跟踪终端里正在运行的命令，避免向空闲终端发送 Ctrl+C
    trackTerminalShellExecutions(context);

    // 文件保存后让文件头配置缓存失效，手改注释无需重载窗口即可生效
    context.subscriptions.push(vscode.workspace.onDidSaveTextDocument((document) => {
        if (document && document.uri && document.uri.scheme === 'file') {
            invalidateFileConfig(document.uri.fsPath);
        }
    }));

    // 注册侧边栏提供者
    const sidebarProvider = new CppCompilerSidebarProvider(context);
    const updateDebuggerAvailability = () => {
        const available = !!vscode.extensions.getExtension('wudream.dream-cpp-debuger');
        void vscode.commands.executeCommand('setContext', 'dreamCppCompiler.debuggerAvailable', available);
        sidebarProvider.updateButtonStates();
    };
    context.subscriptions.push(vscode.extensions.onDidChange(updateDebuggerAvailability));
    updateDebuggerAvailability();
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(
            'cppCompilerSidebar',
            sidebarProvider
        )
    );

    // 注册命令
    const internalDisposable = vscode.commands.registerCommand(
        'dream-cpp-compiler.runInternal',
        () => compileAndRun('internal')
    );
    const externalDisposable = vscode.commands.registerCommand(
        'dream-cpp-compiler.runExternal',
        () => compileAndRun('external')
    );
    const cppCompile = vscode.commands.registerCommand(
        'dream-cpp-compiler.cppCompile',
        () => compileOnly()
    );

    const OpenTerminalDisposable = vscode.commands.registerCommand(
        'dream-cpp-compiler.openInExternalTerminal',
        (uri) => {
            if (!uri || !uri.fsPath) {
                vscode.window.showErrorMessage('未选择文件或文件夹');
                return;
            }

            const targetPath = uri.fsPath;
            openInTerminal(targetPath);
        }
    );

    const debugDisposable = vscode.commands.registerCommand('dream-cpp-compiler.startDebug', () => startCompanionDebug());

    // 创建状态栏按钮
    statusBarInternal = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    statusBarInternal.text = '$(run) 内置终端运行';
    statusBarInternal.command = 'dream-cpp-compiler.runInternal';
    statusBarInternal.tooltip = '编译并在VS Code内置终端运行C++程序';
    statusBarInternal.show();

    statusBarExternal = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
    statusBarExternal.text = '$(terminal) 外部终端运行';
    statusBarExternal.command = 'dream-cpp-compiler.runExternal';
    statusBarExternal.tooltip = '编译并在系统外部终端运行C++程序';
    statusBarExternal.show();

    statusBarCompile = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 98);
    statusBarCompile.text = '$(gear) 仅编译';
    statusBarCompile.command = 'dream-cpp-compiler.cppCompile';
    statusBarCompile.tooltip = '编译当前C++程序';
    statusBarCompile.show();

    compileStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 0);
    compileStatus.hide();

    // 订阅命令
    context.subscriptions.push(
        internalDisposable,
        externalDisposable,
        cppCompile,
        debugDisposable,
        statusBarInternal,
        statusBarExternal,
        statusBarCompile,
        compileStatus,
        OpenTerminalDisposable
    );
    return { apiVersion: 1, compileForDebug };
}

function deactivate() {
    debugBuildCache.dispose();
    compileOutput.dispose();
    commandOutput.dispose();
}

module.exports = {
    activate,
    deactivate
}
