const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { exec } = require('child_process');

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

function openInTerminal(targetPath) {
    const platform = process.platform;

    if (platform === 'win32') {
        // Windows: cmd
        exec(`start cmd.exe /K "cd /d ${targetPath}"`);
    } else if (platform === 'darwin') {
        // macOS: osascript
        const appleScript = `
            tell application "Terminal"
                activate
                do script "cd '${targetPath.replace(/'/g, "'\\''")}'"
            end tell
        `;
        exec(`osascript -e '${appleScript}'`);
    } else {
        // Linux: gnome-terminal
        exec(`gnome-terminal --working-directory=${targetPath}`);
    }
}

function makeTerminal() {
    if (process.platform === 'win32') {
        return vscode.window.createTerminal({ name: "dream-cpp-compiler:运行", shellPath: "C:\\Windows\\System32\\cmd.exe" });
    } else {
        return vscode.window.createTerminal("dream-cpp-compiler:运行");
    }
}

function getTempDir() {
    const TempDir = path.join(os.tmpdir(), 'dream-cpp-compiler');
    fs.mkdirSync(path.join(TempDir, 'Module'), { recursive: true });
    return TempDir;
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

function GetExePath(cppPath) {
    // 获取输出路径模板
    const outputPathTemplate = getFileConfig(cppPath, 'outputPath') || '{cppDir}/{baseName}';

    // 替换模板中的变量
    const baseName = path.basename(cppPath, '.cpp');
    const cppDir = path.dirname(cppPath);
    const workdir = vscode.workspace.workspaceFolders ?
        vscode.workspace.workspaceFolders[0].uri.fsPath : cppDir;
    const tmpDir = os.tmpdir();

    let outputPath = outputPathTemplate
        .replace(/\{cppDir\}/g, cppDir)
        .replace(/\{baseName\}/g, baseName)
        .replace(/\{workdir\}/g, workdir)
        .replace(/\{tmpDir\}/g, tmpDir);

    if (process.platform === 'win32' && path.extname(outputPath) === '') {
        outputPath += '.exe';
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

// 判断是否需要重新编译
function needsRecompile(filePath, compileOptions, compilerPath) {
    try {
        const fileContent = fs.readFileSync(filePath, 'utf8');
        const currentHash = md5(fileContent);
        const cachedData = getCachedHash(filePath);
        const executablePath = GetExePath(filePath);

        if (!cachedData) return true;
        if (!fs.existsSync(executablePath)) return true;

        return cachedData !== `${currentHash}|${compileOptions}|${compilerPath}`;
    } catch (err) {
        ShowError(`检查是否需要重新编译时出错:${err.message}`);
        return true;
    }
}

function parseFileHeaderConfig(filePath) {
    const baseName = path.basename(filePath, ".cpp");
    let config = {
        inputFile: (getConfig('FileInputDefaultValue') || `{base}.in`).replace(/\{base\}/g, baseName),
        outputFile: (getConfig('FileOutputDefaultValue') || `{base}.out`).replace(/\{base\}/g, baseName),
        unFileInputFile: (getConfig('UnFileInputDefaultValue') || `{base}.in`).replace(/\{base\}/g, baseName),
        unFileOutputFile: (getConfig('UnFileOutputDefaultValue') || `{base}.out`).replace(/\{base\}/g, baseName),
        useFileRedirect: getConfig('useFileRedirectDefaultValue') || false,
        useUnFileRedirect: getConfig('useUnFileRedirectDefaultValue') || false,
        compileOptionsCardOpen: getConfig('compileOptionsCardDefaultStatus') || true,
        runControlCardOpen: getConfig('runControlCardDefaultStatus') || true,
        advancedCardOpen: getConfig('advancedCardDefaultStatus') || false,
        fileOperationsCardOpen: getConfig('fileOperationsCardDefaultStatus') || false,
        compileOptions: getConfig('CompileDefaultValue') || '-std=c++14 -O2 -Wall -Wextra -Wl,--stack=400000000',
        useStaticLinking: getConfig('useStaticDefaultValue') || false,
        moreCommand: (getConfig('moreCommandDefaultValue') || '').replace(/\{base\}/g, baseName),
        customVariable: getConfig('customVariableDefaultValue') || '',
        outputPath: (getConfig('outputPath') || '{cppDir}/{baseName}'),
        staticOption: getConfig('staticOption') || '-static',
        compileCommand: getConfig('compileCommand') || '"{cPath}" "{cppPath}" {option} -o "{outPath}"'
    };
    try {
        if (!fs.existsSync(filePath)) {
            return null;
        }

        const content = fs.readFileSync(filePath, 'utf8');
        const lines = content.split('\n');

        // 只检查前50行，避免读取整个大文件
        for (let i = 0; i < Math.min(lines.length, 50); i++) {
            const line = lines[i].trim();
            const pos = line.indexOf(':');
            if(pos === -1) continue;
            let end = -1;
            for (let j = pos - 1; j >= 0; --j) {
                const c = line.charCodeAt(j);
                if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122)) {
                    end = j;
                    break;
                }
            }
            if (end === -1) continue;

            let start = end;
            while (start >= 0) {
                const c = line.charCodeAt(start);
                if (!((c >= 65 && c <= 90) || (c >= 97 && c <= 122))) break;
                --start;
            }

            let key = line.slice(start + 1, end + 1);

            let j = pos + 1;
            while (j < line.length && line[j] === ' ') j++;

            let value = line.slice(j);

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
            }
        }
    } catch (error) {
        ShowWarn(`解析文件 ${filePath} 头部配置时出错: ${error.message}`);
    }
    return config;
}

// 获取当前文件的配置
function getFileConfig(filePath, key) {
    if (!fileConfigs[filePath]) {
        // 默认配置
        fileConfigs[filePath] = parseFileHeaderConfig(filePath);
    }
    return fileConfigs[filePath][key];
}

// 设置当前文件的配置
function setFileConfig(filePath, key, value) {
    if (!fileConfigs[filePath]) {
        // 默认配置
        fileConfigs[filePath] = parseFileHeaderConfig(filePath);
    }
    fileConfigs[filePath][key] = value;
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
        vscode.window.showErrorMessage('活动文件不是本地文件！');
        return null;
    }

    return document.uri.fsPath;
}

async function CompileModule(filePath, ModuleName, executablePath, compilerOption) {
    const compilerPath = getConfig('compilerPath') || 'g++';
    const compileCommand = `"${compilerPath}" "${filePath}" ${getConfig('staticOption') || '-static'} -o "${executablePath}"`;
    ShowInfos([`开始编译模块：${ModuleName}`, `模块位于 ${filePath}`, `输出至 ${executablePath}`, `编译命令：${compileCommand}\n`]);

    if (await fs.existsSync(executablePath)) {
        ShowInfo(`模块：${ModuleName} 曾被编译，无需再次编译`);
        return 1;
    }

    return await vscode.window.withProgress({location: vscode.ProgressLocation.Notification, title: `模块 ${ModuleName} 正在编译...`}, async (progress) => {
        return new Promise((resolve) => {
            exec(compileCommand, (error) => {
                if (error) {
                    ShowErrors([`编译 ${ModuleName} 对应模块失败！`, `错误原因：\n${error.message}`]);
                    showErrorText(error.message);
                    vscode.window.showErrorMessage(`编译 ${ModuleName} 模块失败！`);
                    resolve(0);
                } else {
                    ShowInfo(`模块：${ModuleName} 编译成功`);
                    resolve(1);
                }
            });
        });
    });
}

async function OnlyCompile(askUser, filePath) {
    if(!filePath)return 0;

    const compilerPath = getConfig('compilerPath') || 'g++';
    const iSstatic = getFileConfig(filePath, 'useStaticLinking');
    const compileOptions = getFileConfig(filePath, 'compileOptions') + (iSstatic ? ` ${getFileConfig(filePath, 'staticOption') || '-static'}` : '');
    const executablePath = GetExePath(filePath);

    let compileCommandTemplate = getFileConfig(filePath, 'compileCommand') || '"{cPath}" "{cppPath}" {option} -o "{outPath}"';

    let compileCommand = compileCommandTemplate
        .replace(/\{cPath\}/g, compilerPath)
        .replace(/\{cppPath\}/g, filePath)
        .replace(/\{option\}/g, compileOptions)
        .replace(/\{outPath\}/g, executablePath);

    let forceCompile = false;
    if (!needsRecompile(filePath, compileOptions, compilerPath)) {
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
        try {
            if (fs.existsSync(executablePath)) {
                fs.unlinkSync(executablePath);
            }
        } catch (err) {
            ShowWarn('删除旧可执行文件时出错:' + err);
        }

        const compileCommand = `"${compilerPath}" "${filePath}" ${compileOptions} -o "${executablePath}"`;
        ShowInfos([`开始编译，编译程序：${filePath}`, `编译命令：${compileCommand}\n`]);

        compileStatus.text = '$(loading~spin) 正在编译...';
        compileStatus.show();

        return await vscode.window.withProgress({location: vscode.ProgressLocation.Notification, title: "正在编译...", cancellable: true}, async (progress, token) => {
            return new Promise((resolve) => {
                HaveBuildTask = true;

                const proc = exec(compileCommand, (error, _stdout, stderr) => {
                    if (!HaveBuildTask) return;
                    HaveBuildTask = false;

                    if (error) {
                        ShowErrors([`程序 ${filePath} 编译失败`, `编译命令：${compileCommand}`, `编译器报错：\n${error.message}`]);
                        compileStatus.text = '$(error) 编译失败';
                        compileStatus.show();
                        showErrorText(error.message);
                        setTimeout(() => {
                            compileStatus.hide();
                        }, 5000);

                        vscode.window.showErrorMessage('编译失败');

                        resolve(0);
                    } else {
                        const fileContent = fs.readFileSync(filePath, 'utf8');
                        const currentHash = md5(fileContent);
                        saveHashCache(filePath, `${currentHash}|${compileOptions}|${compilerPath}`);

                        if (stderr) {
                            ShowWarns([`程序 ${filePath} 编译出现警告`, `编译命令：${compileCommand}`, `编译器警告：\n${stderr}`]);
                            compileStatus.text = '$(warning) 编译出现警告';

                            vscode.window.showWarningMessage('编译出现警告', "查看详情", "忽略").then(selection => {
                                if(selection === "查看详情") {
                                    showErrorText(stderr);
                                }
                            });
                        } else {
                            ShowInfos([`程序 ${filePath} 编译成功`, `编译命令：${compileCommand}`, `未出现警告与错误\n`]);
                            compileStatus.text = '$(check) 编译成功';

                            setTimeout(() => {
                                vscode.window.showInformationMessage('编译成功');
                            }, 50);
                        }

                        compileStatus.show();

                        setTimeout(() => {
                            compileStatus.hide();
                        }, 5000);

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
async function compileAndRun(terminalType) {
    const FilePath = checkFilePath();
    const result = await OnlyCompile(0, FilePath);
    if (result) {
        await runProgram(FilePath, terminalType);
    }
}

// 运行程序
async function runProgram(filePath, terminalType) {
    const executablePath = GetExePath(filePath);
    const programDir = path.dirname(executablePath);
    const UseConsoleInfo = getConfig('useConsoleInfo') || false;

    // 文件特定配置
    const customVariable = getFileConfig(filePath, 'customVariable');
    const inputFile = getFileConfig(filePath, 'inputFile').replace(/\{var\}/g, customVariable);
    const outputFile = getFileConfig(filePath, 'outputFile').replace(/\{var\}/g, customVariable);
    const unFileInputFile = getFileConfig(filePath, 'unFileInputFile').replace(/\{var\}/g, customVariable);
    const unFileOutputFile = getFileConfig(filePath, 'unFileOutputFile').replace(/\{var\}/g, customVariable);
    const useFileRedirect = getFileConfig(filePath, 'useFileRedirect');
    const useUnFileRedirect = getFileConfig(filePath, 'useUnFileRedirect');
    const toolPath = path.join(__dirname, 'tools');
    let moreCommand = getFileConfig(filePath, 'moreCommand').replace(/\{var\}/g, customVariable);

    let cdCommand, runCommand;

    // ---------------- Windows ----------------
    if (process.platform === 'win32') {
        cdCommand = `cd /d "${programDir}"`;
        runCommand = await buildRunCommandWin(toolPath, executablePath, {
            UseConsoleInfo, useFileRedirect, useUnFileRedirect,
            inputFile, outputFile, unFileInputFile, unFileOutputFile
        });

        // ---------------- Linux ----------------
    } else if (process.platform === 'linux') {
        cdCommand = `cd "${programDir}"`;
        runCommand = await buildRunCommandLinux(toolPath, executablePath, {
            UseConsoleInfo, useFileRedirect, useUnFileRedirect,
            inputFile, outputFile, unFileInputFile, unFileOutputFile
        });

        // ---------------- macOS ----------------
    } else if (process.platform === 'darwin') {
        cdCommand = `cd "${programDir}"`;
        if (useFileRedirect) {
            runCommand = `osascript -e 'tell application "Terminal" to do script "cd '${programDir.replace(/"/g, '\\"')}'; ./'${executablePath.replace(/"/g, '\\"')}' < '${inputFile.replace(/"/g, '\\"')}' > '${outputFile.replace(/"/g, '\\"')}'; read -p \\"按Enter键退出...\\""'`;
        } else {
            runCommand = `osascript -e 'tell application "Terminal" to do script "cd '${programDir.replace(/"/g, '\\"')}'; ./'${executablePath.replace(/"/g, '\\"')}'; read -p \\"按Enter键退出...\\""'`;
        }
    }

    if(!runCommand) {
        return;
    }

    // ---------------- 执行逻辑 ----------------
    if (terminalType === 'internal') {
        let RunTerminal = vscode.window.terminals.find(
            term => term.name === 'dream-cpp-compiler:运行'
        );

        if(!RunTerminal) {
            RunTerminal = makeTerminal();
        }

        RunTerminal.show();
        RunTerminal.sendText('^C\x03');
        RunTerminal.sendText(cdCommand);
        if(moreCommand)runCommand += ` && ${moreCommand}`;
        RunTerminal.sendText(runCommand);
    } else {
        let terminalCommand;

        if (process.platform === 'win32') {
            terminalCommand = await buildTerminalCommandWin(executablePath, cdCommand, runCommand, moreCommand);
        } else if (process.platform === 'linux') {
            terminalCommand = await buildTerminalCommandLinux(executablePath, cdCommand, runCommand, moreCommand);
        } else {
            terminalCommand = runCommand; // macOS 已经直接是 osascript
        }

        ShowInfo(`外部终端命令: ${terminalCommand}`);

        exec(terminalCommand, (error) => {
            if (error) {
                vscode.window.showErrorMessage("打开外部终端失败！");
                ShowError(`打开外部终端失败！错误原因：${error.message}`);
            }else{
                ShowInfo(`程序 ${filePath} 运行已结束`);
            }
        });
    }
}

// ---------------- Windows 构建命令 ----------------
async function buildRunCommandWin(baseDir, exeName, opt) {
    if (opt.useFileRedirect && opt.useUnFileRedirect) {
        if (opt.UseConsoleInfo) {
            const ModuleName = 'ConsoleInfoChangeFileIO';
            const executablePath = path.join(getTempDir(), 'Module', `${ModuleName}.exe`);
            const result = await CompileModule(path.join(baseDir, 'windows', `${ModuleName}.cpp`), ModuleName, executablePath);
            if(!result){
                return null;
            }
            return `cmd /c ""${executablePath}" "${exeName}" "${opt.inputFile}" "${opt.outputFile}" "${opt.unFileInputFile}" "${opt.unFileOutputFile}""`;
        } else {
            const ModuleName = 'ChangeFileIO';
            const executablePath = path.join(getTempDir(), 'Module', `${ModuleName}.exe`);
            const result = await CompileModule(path.join(baseDir, 'windows', `${ModuleName}.cpp`), ModuleName, executablePath);
            if(!result){
                return null;
            }
            return `cmd /c ""${executablePath}" "${exeName}" "${opt.inputFile}" "${opt.outputFile}" "${opt.unFileInputFile}" "${opt.unFileOutputFile}""`;
        }
    } else if (opt.useFileRedirect) {
        if (opt.UseConsoleInfo) {
            const ModuleName = 'ConsoleInfoFileIO';
            const executablePath = path.join(getTempDir(), 'Module', `${ModuleName}.exe`);
            const result = await CompileModule(path.join(baseDir, 'windows', `${ModuleName}.cpp`), ModuleName, executablePath);
            if(!result){
                return null;
            }
            return `cmd /c ""${executablePath}" "${exeName}" "${opt.inputFile}" "${opt.outputFile}""`;
        } else {
            return `cmd /c ""${exeName}" < "${opt.inputFile}" > "${opt.outputFile}""`;
        }
    } else if (opt.useUnFileRedirect) {
        if (opt.UseConsoleInfo) {
            const ModuleName = 'ConsoleInfoUnFileIO';
            const executablePath = path.join(getTempDir(), 'Module', `${ModuleName}.exe`);
            const result = await CompileModule(path.join(baseDir, 'windows', `${ModuleName}.cpp`), ModuleName, executablePath);
            if(!result){
                return null;
            }
            return `cmd /c ""${executablePath}" "${exeName}" "${opt.unFileInputFile}" "${opt.unFileOutputFile}""`;
        } else {
            const ModuleName = 'UnFileIO';
            const executablePath = path.join(getTempDir(), 'Module', `${ModuleName}.exe`);
            const result = await CompileModule(path.join(baseDir, 'windows', `${ModuleName}.cpp`), ModuleName, executablePath);
            if(!result){
                return null;
            }
            return `cmd /c ""${executablePath}" "${exeName}" "${opt.unFileInputFile}" "${opt.unFileOutputFile}""`;
        }
    } else {
        if (opt.UseConsoleInfo) {
            const ModuleName = 'ConsoleInfo';
            const executablePath = path.join(getTempDir(), 'Module', `${ModuleName}.exe`);
            const result = await CompileModule(path.join(baseDir, 'windows', `${ModuleName}.cpp`), ModuleName, executablePath);
            if(!result){
                return null;
            }
            return `cmd /c ""${executablePath}" "${exeName}""`;
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
        if (opt.UseConsoleInfo) {
            const ModuleName = 'ConsoleInfoChangeFileIO';
            const executablePath = path.join(getTempDir(), 'Module', ModuleName);
            const result = await CompileModule(path.join(baseDir, 'linux', `${ModuleName}.cpp`), ModuleName, executablePath);
            if(!result){
                return null;
            }
            return `"${executablePath}" "${exeName}" "${opt.inputFile}" "${opt.outputFile}" "${opt.unFileInputFile}" "${opt.unFileOutputFile}"; echo`;
        } else {
            const ModuleName = 'ChangeFileIO';
            const executablePath = path.join(getTempDir(), 'Module', ModuleName);
            const result = await CompileModule(path.join(baseDir, 'linux', `${ModuleName}.cpp`), ModuleName, executablePath);
            if(!result){
                return null;
            }
            return `"${executablePath}" "${exeName}" "${opt.inputFile}" "${opt.outputFile}" "${opt.unFileInputFile}" "${opt.unFileOutputFile}"; echo`;
        }
    } else if (opt.useFileRedirect) {
        if (opt.UseConsoleInfo) {
            const ModuleName = 'ConsoleInfoFileIO';
            const executablePath = path.join(getTempDir(), 'Module', ModuleName);
            const result = await CompileModule(path.join(baseDir, 'linux', `${ModuleName}.cpp`), ModuleName, executablePath, '');
            if(!result){
                return null;
            }
            return `"${executablePath}" "${exeName}" "${opt.inputFile}" "${opt.outputFile}"; echo`;
        } else {
            return `${exeName} < "${opt.inputFile}" > "${opt.outputFile}"; echo`;
        }
    } else if (opt.useUnFileRedirect) {
        if (opt.UseConsoleInfo) {
            const ModuleName = 'ConsoleInfoUnFileIO';
            const executablePath = path.join(getTempDir(), 'Module', ModuleName);
            const result = await CompileModule(path.join(baseDir, 'linux', `${ModuleName}.cpp`), ModuleName, executablePath, '');
            if(!result){
                return null;
            }
            return `"${executablePath}" "${exeName}" "${opt.unFileInputFile}" "${opt.unFileOutputFile}"; echo`;
        } else {
            const ModuleName = 'UnFileIO';
            const executablePath = path.join(getTempDir(), 'Module', ModuleName);
            const result = await CompileModule(path.join(baseDir, 'linux', `${ModuleName}.cpp`), ModuleName, executablePath, '');
            if(!result){
                return null;
            }
            return `"${executablePath}" "${exeName}" "${opt.unFileInputFile}" "${opt.unFileOutputFile}"; echo`;
        }
    } else {
        if (opt.UseConsoleInfo) {
            const ModuleName = 'ConsoleInfo';
            const executablePath = path.join(getTempDir(), 'Module', ModuleName);
            const result = await CompileModule(path.join(baseDir, 'linux', `${ModuleName}.cpp`), ModuleName, executablePath, '');
            if(!result){
                return null;
            }
            return `"${executablePath}" "${exeName}"; echo`;
        } else {
            return `${exeName}; echo`;
        }
    }
}

async function buildTerminalCommandLinux(cdCommand, runCommand, moreCommand) {
    if(moreCommand)return `gnome-terminal --title="test" -- bash -c "${cdCommand}; ${runCommand}; ${moreCommand}; read -s -n1 -p '按任意键退出...'"`;
    return `gnome-terminal --title="test" -- bash -c "${cdCommand}; ${runCommand}; read -s -n1 -p '按任意键退出...'"`;
}

// 侧边栏提供者类
class CppCompilerSidebarProvider {
    constructor(context) {
        this._context = context;
    }

    updateButtonStates() {
        if (!sidebarPanel) return;

        // 严格检查是否为有效的C++文件
        const editor = vscode.window.activeTextEditor;
        const isCppFile = editor &&
            editor.document &&
            editor.document.languageId === 'cpp' &&
            editor.document.uri.scheme === 'file'; // 确保是本地文件

        sidebarPanel.webview.postMessage({
            type: 'updateButtonStates',
            enabled: isCppFile
        });
    }

    resolveWebviewView(webviewView) {
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

        // 监听活动编辑器变化
        const editorChangeDisposable = vscode.window.onDidChangeActiveTextEditor(() => {
            this.updateButtonStates();
            this.updateWebviewContent();
        });
        this._context.subscriptions.push(editorChangeDisposable);

        // 初始检查状态
        this.updateButtonStates();
        this.updateWebviewContent();

        const useConsoleInfo = getConfig('useConsoleInfo') || false;

        // 监听来自webview的消息
        webviewView.webview.onDidReceiveMessage(async (data) => {
            switch (data.type) {
                case 'runInternal': {
                    const customVariable = getFileConfig(data.filePath, 'customVariable') || '';
                    const moreCommand = getFileConfig(data.filePath, 'moreCommand') || '';
                    const compileOptions = getFileConfig(data.filePath, 'compileOptions');
                    const useStatic = getFileConfig(data.filePath, 'useStaticLinking');
                    const useFileRedirect = getFileConfig(data.filePath, 'useFileRedirect');
                    const useUnFileRedirect = getFileConfig(data.filePath, 'useUnFileRedirect');

                    ShowInfos([`用户在侧边栏选择了编译后在内置终端运行`, `编译选项为：${compileOptions}`, `${useStatic ? '启用' : '禁用'}静态编译`, `${useConsoleInfo ? '使用' : '禁用'} ConsoleInfo.exe 运行程序`, `${useFileRedirect ? `启用文件重定向，输入文件为 ${getFileConfig(data.filePath, 'inputFile')}，输出文件为 ${getFileConfig(data.filePath, 'outputFile')}` : '禁用文件重定向'}`, `${useUnFileRedirect ? `启用反文件重定向，输入文件为 ${getFileConfig(data.filePath, 'unFileInputFile')}，输出文件为 ${getFileConfig(data.filePath, 'unFileOutputFile')}` : '禁用反文件重定向'}`, `${moreCommand ? `额外运行命令为 ${moreCommand}` : '无额外运行命令'}`, `自定义变量 var 为 "${customVariable}"`]);
                    compileAndRun('internal');
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
                    compileAndRun('external');
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
                    OnlyCompile(1, checkFilePath());
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
            }
        });

        // 监听配置变化，更新UI
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('dream-cpp-compiler')) {
                this.updateWebviewContent();
            }
        });
    }

    updateWebviewContent() {
        if (!sidebarPanel) return;

        const useConsoleInfo = getConfig('useConsoleInfo') || false;
        const compilerPath = getConfig('compilerPath') || 'g++';

        // 获取当前文件的配置
        const editor = vscode.window.activeTextEditor;
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
        let filePath = '', baseName = '';
        let compileOptions = '';
        let useStatic = false;
        let moreCommand = '';
        let customVariable = '';
        let outputPath = '';
        let cppDir = '';
        let workdir = '';
        let tmpDir = '';

        if (editor && editor.document && editor.document.languageId === 'cpp' && editor.document.uri.scheme === 'file') {
            filePath = editor.document.uri.fsPath;
            baseName = path.basename(filePath, ".cpp");
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
            cppDir = path.dirname(filePath) || '';
            workdir = vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath || cppDir || '';
            tmpDir = require('os').tmpdir();
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
            outputPath: outputPath
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
                * {
                    margin: 0;
                    padding: 0;
                    box-sizing: border-box;
                    scrollbar-width: none;
                    transition: color 0.2s ease,
                                background-color 0.2s ease,
                                border-color 0.2s ease;
                }

                body {
                    background-color: color-mix(in srgb, var(--vscode-sideBar-background) 90%, #fcf7ef85);
                    color: var(--vscode-foreground);
                    font-family: var(--vscode-font-family);
                    font-size: 13px;
                    line-height: 1.5;
                    padding: 10px;
                }

                .container {
                    display: flex;
                    flex-direction: column;
                    gap: 16px;
                    width: 100%;
                }

                .collapsible-section {
                    border-radius: 10px;
                    background: color-mix(in srgb, var(--vscode-sideBarSectionHeader-background) 80%, #ffffff15);
                    border: 1px solid var(--vscode-panel-border);
                    box-shadow: 0 2px 4px rgba(0, 0, 0, 0.04),
                                0 1px 2px rgba(0, 0, 0, 0.02) inset;
                    border-color: rgba(128, 128, 128, 0.4);
                    transition: transform 0.28s cubic-bezier(0.4, 0, 0.2, 1),
                                box-shadow 0.28s cubic-bezier(0.4, 0, 0.2, 1),
                                background 0.35s ease;
                    width: 100%;
                    overflow: hidden;
                }

                .collapsible-section:hover {
                    box-shadow: 0 8px 20px rgba(0, 0, 0, 0.12),
                                0 2px 6px rgba(0, 0, 0, 0.06);
                    border-color: var(--vscode-focusBorder);
                    transform: translateY(-2px);
                    background: linear-gradient(
                        180deg,
                        color-mix(in srgb, var(--vscode-button-background) 40%, #b3fffa77),
                        var(--vscode-sideBarSectionHeader-background) 4%,
                        rgba(202, 202, 202, 0.12) 94%,
                        color-mix(in srgb, var(--vscode-button-background) 40%, #f2c8fd8f)
                    );
                }

                .section-header {
                    font-weight: 600;
                    padding: 14px 18px;
                    color: var(--vscode-titleBar-activeForeground);
                    font-size: 14px;
                    display: flex;
                    align-items: center;
                    justify-content: space-between;
                    cursor: pointer;
                    user-select: none;
                    background: rgba(175, 175, 175, 0.07);
                    backdrop-filter: blur(4px);
                    position: relative;
                }

                .section-header::after {
                    content: '';
                    position: absolute;
                    bottom: 0;
                    left: 0;
                    width: 100%;
                    height: 1px;
                    background-color: var(--vscode-panel-border);
                    opacity: 0;
                    transition: opacity 0.2s ease;
                }

                .section-header:hover::after {
                    opacity: 1;
                }

                .section-title {
                    display: flex;
                    align-items: center;
                }

                .section-title::before {
                    content: '';
                    display: inline-block;
                    width: 3px;
                    height: 14px;
                    background: var(--vscode-button-background);
                    margin-right: 8px;
                    border-radius: 2px;
                }

                .collapse-icon {
                    width: 16px;
                    height: 16px;
                    color: var(--vscode-descriptionForeground);
                    transition: transform 0.5s cubic-bezier(0.25, 1, 0.5, 1);
                    flex-shrink: 0;
                }

                .rotate {
                    transform: rotate(180deg);
                }

                .section-content {
                    padding: 0 18px;
                    max-height: 0;
                    overflow: hidden;
                    opacity: 0;
                    transform: translateY(-8px);
                    transition: max-height 0.55s cubic-bezier(0.4, 0, 0.2, 1),
                                padding 0.45s cubic-bezier(0.4, 0, 0.2, 1),
                                opacity 0.45s ease,
                                transform 0.55s cubic-bezier(0.4, 0, 0.2, 1);
                }

                .section-content.expanded {
                    padding: 20px 18px;
                    max-height: 900px;
                    opacity: 1;
                    transform: translateY(0);
                }

                input[type="text"] {
                    width: 100%;
                    padding: 10px 14px;
                    height: 38px;
                    border: 1px solid var(--vscode-input-border);
                    border-radius: 10px;
                    background: linear-gradient(
                        145deg,
                        var(--vscode-input-background),
                        rgba(206, 206, 206, 0.04)
                    );
                    color: var(--vscode-input-foreground);
                    font-size: 13px;
                    font-family: var(--vscode-font-family);
                    outline: none;
                    position: relative;
                    z-index: 1;
                    box-shadow: inset 0 2px 4px rgba(0, 0, 0, 0.15),
                                inset 0 -1px 2px rgba(255, 255, 255, 0.05);
                    transition: all 0.35s cubic-bezier(0.4, 0, 0.2, 1);
                }

                input[type="text"]:hover {
                    border-color: var(--vscode-focusBorder);
                    box-shadow: inset 0 2px 4px rgba(0, 0, 0, 0.15),
                                0 0 6px color-mix(in srgb, var(--vscode-focusBorder) 35%, transparent);
                }

                input[type="text"]:focus {
                    border-color: var(--vscode-focusBorder);
                    background: linear-gradient(
                        160deg,
                        var(--vscode-input-background),
                        color-mix(in srgb, var(--vscode-focusBorder) 12%, transparent)
                    );
                    box-shadow: 0 0 0 2px color-mix(in srgb, var(--vscode-focusBorder) 40%, transparent),
                                0 0 10px color-mix(in srgb, var(--vscode-focusBorder) 25%, transparent);
                }

                input[type="text"]::placeholder {
                    color: var(--vscode-input-placeholderForeground);
                    opacity: 0.7;
                    transition: opacity 0.25s ease;
                }

                input[type="text"]:focus::placeholder {
                    opacity: 0.35;
                }

                .button-group {
                    display: grid;
                    grid-template-columns: 1fr;
                    gap: 10px;
                    margin-top: 4px;
                }

                button {
                    padding: 12px 18px;
                    background: color-mix(in srgb, var(--vscode-button-background) 70%, transparent);
                    border: 2px solid transparent;
                    color: var(--vscode-button-foreground);
                    border-radius: 10px;
                    cursor: pointer;
                    font-size: 14px;
                    font-weight: 600;
                    letter-spacing: 0.3px;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    box-shadow: 0 4px 10px rgba(0, 0, 0, 0.25),
                                inset 0 1px 2px rgba(255, 255, 255, 0.1);
                    transition: transform 0.2s ease,
                                box-shadow 0.2s ease,
                                background 0.3s ease;
                }

                button:disabled {
                    opacity: 0.5;
                    cursor: not-allowed;
                    box-shadow: 0 6px 14px rgba(0, 0, 0, 0.5);
                    transform: none;
                }

                button:hover:not(:disabled) {
                    transform: translateY(-2px);
                    box-shadow: 0 6px 14px rgba(0, 0, 0, 0.3);
                }

                button:hover {
                    border: 2px solid var(--vscode-focusBorder);
                }

                button:active:not(:disabled) {
                    box-shadow: 0 2px 4px rgba(0, 0, 0, 0.04);
                    transform: translateY(0);
                }

                .checkbox-container {
                    display: flex;
                    align-items: center;
                    margin: 12px 0 0;
                    font-size: 13px;
                    padding: 6px 10px;
                    border-radius: 8px;
                    cursor: pointer;
                    user-select: none;
                    transition: background-color 0.25s ease,
                                transform 0.2s ease;
                }

                .checkbox-container:hover {
                    background-color: rgba(255, 255, 255, 0.05);
                }

                input[type="checkbox"] {
                    flex-shrink: 0;
                    margin-right: 8px;
                    width: 18px;
                    height: 18px;
                    accent-color: var(--vscode-button-background);
                    cursor: pointer;
                    border-radius: 4px;
                    transition: all 0.25s ease;
                    box-shadow: 0 0 4px rgba(0, 0, 0, 0.3);
                }

                input[type="checkbox"]:hover {
                    box-shadow: 0 0 6px var(--vscode-button-background);
                    transform: scale(1.1);
                }

                input[type="checkbox"]:checked {
                    box-shadow: 0 0 10px var(--vscode-button-background);
                    transform: scale(1.15);
                }

                .text-input-container {
                    margin-bottom: 14px;
                    position: relative;
                }

                .text-input-label {
                    display: block;
                    margin-bottom: 6px;
                    font-size: 12px;
                    color: var(--vscode-descriptionForeground);
                    font-weight: 500;
                    text-transform: uppercase;
                    letter-spacing: 0.3px;
                }

                .subsection {
                    margin-bottom: 16px;
                    padding: 16px;
                    border-radius: 8px;
                    background-color: var(--vscode-sideBar-background);
                    border: 1px solid var(--vscode-panel-border);
                    width: 100%;
                    transition: all 0.2s ease;
                    box-shadow: 0 2px 4px rgba(0, 0, 0, 0.02);
                }

                .subsection:hover {
                    border-color: var(--vscode-focusBorder);
                    box-shadow: 0 4px 8px rgba(0, 0, 0, 0.04);
                }

                .subsection-title {
                    font-weight: 600;
                    margin-bottom: 12px;
                    color: var(--vscode-titleBar-activeForeground);
                    font-size: 13px;
                    padding-bottom: 6px;
                    border-bottom: 1px solid var(--vscode-panel-border);
                }

                input:disabled {
                    opacity: 0.7;
                    cursor: not-allowed;
                    background-color: var(--vscode-input-background);
                }

                input:disabled::placeholder {
                    color: var(--vscode-input-placeholderForeground);
                }

                .save-status {
                    position: absolute;
                    right: 14px;
                    top: 50%;
                    transform: translateY(-50%);
                    font-size: 12px;
                    color: var(--vscode-testing-iconPassed);
                    opacity: 0;
                    pointer-events: none;
                    background: linear-gradient(
                        135deg,
                        rgba(0, 200, 120, 0.15),
                        rgba(0, 200, 120, 0.05)
                    );
                    padding: 2px 8px;
                    border-radius: 6px;
                    z-index: 2;
                    font-weight: 500;
                    letter-spacing: 0.3px;
                    border: 1px solid rgba(0, 200, 120, 0.3);
                    box-shadow: 0 2px 6px rgba(0, 200, 120, 0.2);
                    transition: all 0.35s cubic-bezier(0.4, 0, 0.2, 1);
                }

                .save-status.visible {
                    opacity: 1;
                    transform: translateY(-50%) scale(1);
                    animation: savePulse 1s ease forwards;
                }

                @keyframes savePulse {
                    0% {
                        transform: translateY(-50%) scale(0.9);
                        opacity: 0;
                    }
                    40% {
                        transform: translateY(-50%) scale(1.1);
                        opacity: 1;
                    }
                    100% {
                        transform: translateY(-50%) scale(1);
                        opacity: 1;
                    }
                }

                .modal {
                    display: none;
                    position: fixed;
                    top: 0;
                    left: 0;
                    width: 100%;
                    height: 100%;
                    background-color: rgba(0, 0, 0, 0.5);
                    z-index: 1000;
                    align-items: center;
                    justify-content: center;
                    backdrop-filter: blur(2px);
                }

                .modal-content {
                    background: var(--vscode-sideBar-background);
                    border-radius: 10px;
                    box-shadow: 0 10px 30px rgba(0, 0, 0, 0.3);
                    width: 500px;
                    max-width: 90%;
                    border: 1px solid var(--vscode-panel-border);
                    animation: modalFadeIn 0.3s ease;
                }

                @keyframes modalFadeIn {
                    from {
                        opacity: 0;
                        transform: translateY(-20px);
                    }
                    to {
                        opacity: 1;
                        transform: translateY(0);
                    }
                }

                .modal-header {
                    padding: 18px 24px;
                    border-bottom: 1px solid var(--vscode-panel-border);
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                }

                .modal-header h3 {
                    margin: 0;
                    color: var(--vscode-titleBar-activeForeground);
                    font-size: 16px;
                }

                .close-btn {
                    background: none;
                    border: none;
                    color: var(--vscode-foreground);
                    font-size: 24px;
                    cursor: pointer;
                    padding: 0;
                    width: 30px;
                    height: 30px;
                    border-radius: 4px;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    transition: background-color 0.2s ease;
                }

                .close-btn:hover {
                    background-color: rgba(255, 255, 255, 0.1);
                }

                .modal-body {
                    padding: 24px;
                }

                .modal-footer {
                    padding: 18px 24px;
                    border-top: 1px solid var(--vscode-panel-border);
                    display: flex;
                    justify-content: flex-end;
                    gap: 12px;
                }

                .modal-footer button {
                    padding: 10px 24px;
                    border: none;
                    border-radius: 6px;
                    cursor: pointer;
                    font-size: 14px;
                    font-weight: 600;
                    transition: all 0.2s ease;
                }

                .modal-footer button:hover {
                    transform: translateY(-1px);
                }

                #cancelEdit {
                    background: var(--vscode-input-background);
                    color: var(--vscode-foreground);
                    border: 1px solid var(--vscode-panel-border);
                }

                #saveEdit {
                    background: var(--vscode-button-background);
                    color: var(--vscode-button-foreground);
                    border: 1px solid var(--vscode-focusBorder);
                }

                .variable-hint {
                    font-size: 12px;
                    color: var(--vscode-descriptionForeground);
                    margin-top: 6px;
                    font-style: italic;
                }

                /* 模态框激活时主界面变灰 */
                .modal-active .container {
                    filter: grayscale(50%) blur(1px);
                    opacity: 0.5;
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
                            <input type="text" id="outputPath" placeholder="输出文件路径模板" title="输出的可执行文件的路径 ({cppDir} 代表源文件所在目录，{baseName} 代表不带后缀名的文件名，{workdir} 代表工作目录(未打开则就是源文件所在目录)，{tmpDir} 代表临时目录)">
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
                        </div>
                        ${process.platform !== 'darwin' ? `
                        <div class="checkbox-container">
                            <input type="checkbox" id="useConsoleInfo">
                            <label for="useConsoleInfo">使用 ConsoleInfo.exe 运行程序</label>
                        </div>
                        ` : `
                        <div class="checkbox-container" title="macOS 系统不可用">
                            <input type="checkbox" id="useConsoleInfo" disabled>
                            <label for="useConsoleInfo">使用 ConsoleInfo.exe 运行程序 (仅 Windows)</label>
                        </div>
                        `}
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
                            <input type="text" id="moreCommand" placeholder="输入运行后额外命令" title="在暂停之前执行的命令，如\"./my_checker my.out bf.out\"（可以使用 {var} 占位符来使用自定义变量，{base} 占位符将会被替换为当前文件的无拓展名形式）">
                            <div class="save-status" id="moreCommandStatus">✓ 已保存</div>
                        </div>

                        <!-- 自定义变量 -->
                        <div class="text-input-container">
                            <div class="text-input-label">自定义变量</div>
                            <input type="text" id="customVariable" placeholder="输入自定义 var 变量的值">
                            <div class="save-status" id="customVariableStatus">✓ 已保存</div>
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
                                <input type="text" id="inputFile" value="" placeholder="输入文件路径" title="可以使用 {var} 占位符来使用自定义变量，{base} 占位符将会被替换为当前文件的无拓展名形式">
                                <div class="save-status" id="inputFileStatus">✓ 已保存</div>
                            </div>
                            <div class="text-input-container">
                                <div class="text-input-label">输出文件</div>
                                <input type="text" id="outputFile" value="" placeholder="输入文件路径" title="可以使用 {var} 占位符来使用自定义变量，{base} 占位符将会被替换为当前文件的无拓展名形式">
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
                                <input type="text" id="unFileInputFile" value="" placeholder="输入文件路径" title="可以使用 {var} 占位符来使用自定义变量，{base} 占位符将会被替换为当前文件的无拓展名形式">
                                <div class="save-status" id="unFileInputFileStatus">✓ 已保存</div>
                            </div>
                            <div class="text-input-container">
                                <div class="text-input-label">输出文件</div>
                                <input type="text" id="unFileOutputFile" value="" placeholder="输入文件路径" title="可以使用 {var} 占位符来使用自定义变量，{base} 占位符将会被替换为当前文件的无拓展名形式">
                                <div class="save-status" id="unFileOutputFileStatus">✓ 已保存</div>
                            </div>
                            ${process.platform !== 'darwin' ? `
                            <div class="checkbox-container">
                                <input type="checkbox" id="useUnFileRedirect">
                                <label for="useUnFileRedirect">启用反文件读写</label>
                            </div>
                            ` : `
                            <div class="checkbox-container" title="macOS 系统不可用">
                                <input type="checkbox" id="useUnFileRedirect" disabled>
                                <label for="useUnFileRedirect">启用反文件读写</label>
                            </div>
                            `}
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

                // ==========================================
                // 1. 配置区域
                // ==========================================
                const VARIABLE_CONFIG = {
                    // 定义变量获取逻辑
                    definitions: {
                        '{var}': {
                            desc: '自定义变量的值',
                            valueFn: function(ctx) { return ctx.varValue; }
                        },
                        '{base}': {
                            desc: '文件名(无后缀)',
                            valueFn: function(ctx) { return ctx.baseName; }
                        },
                        '{baseName}': {
                            desc: '文件名(无后缀)',
                            valueFn: function(ctx) { return ctx.baseName; }
                        },
                        '{cppDir}': {
                            desc: '源文件所在目录',
                            valueFn: function(ctx) { return ctx.cppDir; }
                        },
                        '{workdir}': {
                            desc: '工作区目录',
                            valueFn: function(ctx) { return ctx.workdir; }
                        },
                        '{tmpDir}': {
                            desc: '系统临时目录',
                            valueFn: function(ctx) { return ctx.tmpDir; }
                        }
                    },

                    // 定义变量组
                    groups: {
                        // 通用组：包含 {var}
                        'common': ['{var}', '{base}'],

                        // 【修改点1】变量定义组：专门给 customVariable 使用，严禁包含 {var} 防止递归
                        'varDef': ['{base}', '{cppDir}', '{workdir}'],

                        // 文件操作组
                        'fileOps': ['{var}', '{base}', '{cppDir}'],

                        // 路径生成组：严禁包含 {var}
                        'pathGen': ['{cppDir}', '{baseName}', '{workdir}', '{tmpDir}']
                    },

                    // 绑定输入框规则
                    inputRules: {
                        'moreCommand': 'common',

                        // 【修改点2】自定义变量使用 varDef 组 (不含 {var})
                        'customVariable': 'varDef',

                        'inputFile': 'fileOps',
                        'outputFile': 'fileOps',
                        'unFileInputFile': 'fileOps',
                        'unFileOutputFile': 'fileOps',
                        'outputPath': 'pathGen'
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
                        console.log("SAVE RAW =", finalRaw);

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
                            'customVariable': 'updateCustomVariable'
                        };

                        if (messageMap[currentInputId] && filePath) {
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

                        if (data.isCppFile) {
                            document.getElementById('compileOptions').value = data.compileOptions;
                            document.getElementById('staticLinking').checked = data.useStaticLinking;
                            document.getElementById('useFileRedirect').checked = data.useFileRedirect;
                            document.getElementById('useUnFileRedirect').checked = data.useUnFileRedirect;

                            // 使用 updateInputWithRaw 统一处理带变量字段
                            console.log("BACKEND VALUE inputFile =", data.outputPath);
                            updateInputWithRaw('inputFile', data.inputFile);
                            updateInputWithRaw('outputFile', data.outputFile);
                            updateInputWithRaw('unFileInputFile', data.unFileInputFile);
                            updateInputWithRaw('unFileOutputFile', data.unFileOutputFile);
                            updateInputWithRaw('moreCommand', data.moreCommand);
                            updateInputWithRaw('customVariable', data.customVariable);
                            updateInputWithRaw('outputPath', data.outputPath);
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

                        const inputIds = Object.keys(VARIABLE_CONFIG.inputRules).concat(['compileOptions']);
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

                ['runInternal', 'runExternal', 'onlyCompile'].forEach(function(id) {
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
            </script>
        </body>

        </html>`;
    }
}

// 激活扩展
function activate(context) {
    // 注册侧边栏提供者
    const sidebarProvider = new CppCompilerSidebarProvider(context);
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
        () => OnlyCompile(1, checkFilePath())
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
        statusBarInternal,
        statusBarExternal,
        statusBarCompile,
        compileStatus,
        OpenTerminalDisposable
    );
}

function deactivate() { }

module.exports = {
    activate,
    deactivate
};
