const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { exec } = require('child_process');

function makeTerminal() {
    if(process.platform === 'win32'){
        return vscode.window.createTerminal({name:"cpp-compiler:运行", shellPath:"C:\\Windows\\System32\\cmd.exe"});
    }else{
        return vscode.window.createTerminal("cpp-compiler:运行");
    }
}

function getTerminal() {
    const existingTerminal = vscode.window.terminals.find(terminal => terminal.name === "cpp-compiler:运行");
    if (existingTerminal) {
        return existingTerminal;
    } else {
        return makeTerminal();
    }
}

function getConfig(section) {
    const config = vscode.workspace.getConfiguration('cpp-compiler').inspect(section);
    return config ? config.globalValue : undefined;
}

// 状态栏项
let statusBarInternal;
let statusBarExternal;
let statusBarCompile;
let compileStatus;
let cache = {};
let RunTerminal = getTerminal();
let sidebarPanel;  // 侧边栏面板引用
const compileOutput = vscode.window.createOutputChannel('cpp-compiler:g++ 报错');
const commandOutput = vscode.window.createOutputChannel('cpp-compiler');

// 计算MD5哈希
function md5(str) {
    const crypto = require('crypto');
    return crypto.createHash('md5').update(str).digest('hex');
}

function showText(content) {
    compileOutput.show(true);
    compileOutput.appendLine(content);
    return compileOutput;
}

function getTime() {
    const now = new Date();
    const hours = String(now.getHours()).padStart(2, '0');
    const minutes = String(now.getMinutes()).padStart(2, '0');
    const seconds = String(now.getSeconds()).padStart(2, '0');
    return `[${hours}:${minutes}:${seconds}]:`
}

function showCommand(content) {
    commandOutput.appendLine(getTime() + content + '\n');
    return commandOutput;
}

function GetOutPath(cppPath) {
    const fileName = path.basename(cppPath, '.cpp')
    const outputPath = path.join(path.dirname(cppPath), fileName);
    return outputPath;
}

// 保存哈希缓存
function saveHashCache(filePath, options, hash) {
    if(!getConfig('HashCacheInExtension')){
        const cachePath = path.join(os.tmpdir(), '.cpp_compiler_cache.json');

        try {
            if (fs.existsSync(cachePath)) {
                const cacheContent = fs.readFileSync(cachePath, 'utf8');
                cache = JSON.parse(cacheContent);
            }
        } catch (err) {
            console.error('读取缓存文件错误:', err);
        }
    }
    const key = `${filePath}|${options}`;
    cache[key] = hash;
    if(!getConfig('HashCacheInExtension')){
        const cachePath = path.join(os.tmpdir(), '.cpp_compiler_cache.json');
        try {
            fs.writeFileSync(cachePath, JSON.stringify(cache, null, 2), 'utf8');
        } catch (err) {
            console.error('写入缓存文件错误:', err);
        }
    }
}

// 获取缓存的哈希数据
function getCachedHash(filePath, options) {
    if(!getConfig('HashCacheInExtension')){
        const cachePath = path.join(os.tmpdir(), '.cpp_compiler_cache.json');

        try {
            if (fs.existsSync(cachePath)) {
                const cacheContent = fs.readFileSync(cachePath, 'utf8');
                cache = JSON.parse(cacheContent);
            }
        } catch (err) {
            console.error('读取缓存文件错误:', err);
        }
    }
    const key = `${filePath}|${options}`;

    return cache[key] || null;
}

// 判断是否需要重新编译
function needsRecompile(filePath, compileOptions) {
    try {
        const fileContent = fs.readFileSync(filePath, 'utf8');
        const contentToHash = fileContent + compileOptions;
        const currentHash = md5(contentToHash);
        const cachedData = getCachedHash(filePath, compileOptions);
        const outputPath = GetOutPath(filePath);

        if (!cachedData) return true;

        const executablePath = process.platform === 'win32'
            ? `${outputPath}.exe`
            : outputPath;
        if (!fs.existsSync(executablePath)) return true;

        return currentHash !== cachedData;
    } catch (err) {
        console.error('检查是否需要重新编译时出错:', err);
        return true;
    }
}

async function OnlyCompile(askUser) {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        vscode.window.showErrorMessage('cpp-compiler:没有活动的编辑器！');
        return 0;
    }

    const document = editor.document;

    if (!document) {
        vscode.window.showErrorMessage('cpp-compiler:没有活动的文件！');
        return 0;
    }

    if (document.languageId !== 'cpp') {
        vscode.window.showErrorMessage('cpp-compiler:活动文件不是C++文件！');
        return 0;
    }

    if (editor.document.uri.scheme !== 'file') {
        vscode.window.showErrorMessage('cpp-compiler:活动文件不是本地文件！');
        return 0;
    }

    const filePath = document.uri.fsPath;
    const outputPath = GetOutPath(filePath);
    const iSstatic = getConfig('useStaticLinking') || false;
    const compileOptions = (getConfig('compileOptions') || '') + (iSstatic ? ' -static' : '');
    const executablePath = process.platform === 'win32' ? `${outputPath}.exe` : outputPath;

    let forceCompile = false;
    if (!needsRecompile(filePath, compileOptions)) {
        showCommand(`程序 ${filePath} 未检测到变化，无需重新编译`);
        if (askUser) {
            const result = await vscode.window.showInformationMessage('cpp-compiler:未检测到变化，是否仍然编译？', '是', '否');
            if (result !== '是') {
                showCommand(`程序 ${filePath} 未检测到变化，用户选择取消了编译`);
                return 1;
            }
            forceCompile = true;
            showCommand(`程序 ${filePath} 未检测到变化，但用户选择强制重新编译`);
        } else {
            vscode.window.showInformationMessage('cpp-compiler:未检测到变化，无需重新编译');
            return 1;
        }
    } else {
        vscode.window.showInformationMessage('cpp-compiler:编译已开始');
        forceCompile = true;
    }

    // 只有确定需要编译时才显示动画
    if (forceCompile) {
        try {
            if (fs.existsSync(executablePath)) {
                fs.unlinkSync(executablePath);
            }
        } catch (err) {
            console.warn('删除旧可执行文件时出错:', err);
        }

        const compileCommand = `g++ "${filePath}" ${compileOptions} -o "${outputPath}"`;
        showCommand(`开始编译，编译程序：${filePath}，编译命令：${compileCommand}`);
        
        compileStatus.text = '$(loading~spin) 正在编译...';
        compileStatus.show();

        // 执行编译命令
        return new Promise((resolve) => {
            exec(compileCommand, (error) => {
                if (error) {
                    showCommand(`程序 ${filePath} 编译失败，g++ 报错：${error.message}`);
                    compileStatus.text = '$(error) 编译失败';
                    compileStatus.show();
                    showText(error.message);
                    
                    setTimeout(() => {
                        compileStatus.hide();
                    }, 5000);
                    resolve(0);
                } else {
                    const fileContent = fs.readFileSync(filePath, 'utf8');
                    const contentToHash = fileContent + compileOptions;
                    const currentHash = md5(contentToHash);
                    saveHashCache(filePath, compileOptions, currentHash);
                    showCommand(`程序 ${filePath} 编译成功，编译命令：${compileCommand}`);
                    compileStatus.text = '$(check) 编译成功';
                    compileStatus.show();
                    
                    setTimeout(() => {
                        compileStatus.hide();
                    }, 5000);
                    resolve(1);
                }
            });
        });
    }
    
    return 1;
}

// 核心编译逻辑
async function compileAndRun(terminalType) {
    const result = await OnlyCompile(0);
    if (result) {
        runProgram(GetOutPath(vscode.window.activeTextEditor.document.uri.fsPath), terminalType);
    }
}

// 运行程序
function runProgram(programPath, terminalType) {
    const executableName = path.basename(programPath);
    const executablePath = process.platform === 'win32'
        ? `${programPath}.exe`
        : programPath;
    const programDir = path.dirname(executablePath);
    const UseConsoleInfo = getConfig('useConsoleInfo') || false;

    let cdCommand, runCommand;
    if (process.platform === 'win32') {
        cdCommand = `cd /d "${programDir}"`;
        if (UseConsoleInfo) {
            const ConsoleInfoPath = path.join(__dirname, 'ConsoleInfo.exe');
            runCommand = `cmd /c "${ConsoleInfoPath} "${executableName}.exe""`;
        } else {
            runCommand = `.\\"${executableName}.exe"`
        }
    } else {
        cdCommand = `cd "${programDir}"`;
        runCommand = `./${executableName}`;
    }

    if (terminalType === 'internal') {
        RunTerminal.show();
        RunTerminal.sendText('^exit\x03');
        RunTerminal.sendText(cdCommand);
        RunTerminal.sendText(runCommand);
    } else {
        let terminalCommand;
        if (process.platform === 'win32') {
            terminalCommand = `start cmd /c "${cdCommand} & ${runCommand} & echo. & pause"`;
        } else if (process.platform === 'darwin') {
            terminalCommand = `osascript -e 'tell application "Terminal" to do script "cd '${programDir.replace(/"/g, '\\"')}'; ./'${executableName.replace(/"/g, '\\"')}'; read -p \"按Enter键退出...\""'`;
        } else {
            terminalCommand = `gnome-terminal -- bash -c "cd '${programDir}'; ./'${executableName}'; read -p '按Enter键退出...'"`;
        }

        exec(terminalCommand, (error) => {
            if (error) {
                vscode.window.showErrorMessage(`cpp-compiler:打开外部终端失败: ${error.message}`);
            }
        });
    }
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
        });
        this._context.subscriptions.push(editorChangeDisposable);

        // 初始检查状态
        this.updateButtonStates();
        
        const compileOptions = getConfig('compileOptions') || '';
        const useStatic = getConfig('useStaticLinking') || false;
        const useConsoleInfo = getConfig('useConsoleInfo') || false;

        // 监听来自webview的消息
        webviewView.webview.onDidReceiveMessage(async (data) => {
            switch (data.type) {
                case 'runInternal':
                    showCommand(`用户在侧边栏选择了在内置终端编译运行，编译选项：${compileOptions}，${useStatic ? `启用` : `禁用`}静态编译，${useConsoleInfo ? `使用` : `禁用`} ConsoleInfo.exe 运行程序`);
                    compileAndRun('internal');
                    break;
                case 'runExternal':
                    showCommand(`用户在侧边栏选择了在外部终端编译运行，编译选项：${compileOptions}，${useStatic ? `启用` : `禁用`}静态编译，${useConsoleInfo ? `使用` : `禁用`} ConsoleInfo.exe 运行程序`);
                    compileAndRun('external');
                    break;
                case 'onlyCompile':
                    showCommand(`用户在侧边栏选择了仅编译，编译选项：${compileOptions}，${useStatic ? `启用` : `禁用`}静态编译，${useConsoleInfo ? `使用` : `禁用`} ConsoleInfo.exe 运行程序`);
                    OnlyCompile(1);
                    break;
                case 'updateCompileOptions':
                    showCommand(`用户在侧边栏更新了编译选项，编译选项现在为：${data.value}`);
                    const config = vscode.workspace.getConfiguration('cpp-compiler');
                    await config.update('compileOptions', data.value, vscode.ConfigurationTarget.Global);
                    vscode.window.showInformationMessage('C++编译选项更新成功！');
                    this.updateWebviewContent();
                    break;
                case 'toggleStaticLinking':
                    showCommand(`用户在侧边栏更新了静态编译选项，静态编译选项现在为：${data.value}`);
                    const staticConfig = vscode.workspace.getConfiguration('cpp-compiler');
                    await staticConfig.update('useStaticLinking', data.value, vscode.ConfigurationTarget.Global);
                    this.updateWebviewContent();
                    break;
                case 'toggleuseConsoleInfo':
                    showCommand(`用户在侧边栏更新了 ConsoleInfo.exe 运行选项，ConsoleInfo.exe 运行选项选项现在为：${data.value}`);
                    const ConsoleInfoConfig = vscode.workspace.getConfiguration('cpp-compiler');
                    await ConsoleInfoConfig.update('useConsoleInfo', data.value, vscode.ConfigurationTarget.Global);
                    this.updateWebviewContent();
                    break;
            }
        });

        // 监听配置变化，更新UI
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('cpp-compiler')) {
                this.updateWebviewContent();
            }
        });
    }

    updateWebviewContent() {
        if (!sidebarPanel) return;

        const compileOptions = getConfig('compileOptions') || '';
        const useStatic = getConfig('useStaticLinking') || false;
        const useConsoleInfo = getConfig('useConsoleInfo') || false;

        sidebarPanel.webview.postMessage({
            type: 'updateConfig',
            compileOptions: compileOptions,
            useStatic: useStatic,
            useConsoleInfo: useConsoleInfo
        });
    }

    // 在 CppCompilerSidebarProvider 类的 _getHtmlForWebview 方法中修改
    _getHtmlForWebview(webview) {
        const compileOptions = getConfig('compileOptions') || '';
        const useStatic = getConfig('useStaticLinking') || false;
        const useConsoleInfo = getConfig('useConsoleInfo') || false;

        return `<!DOCTYPE html>
        <html lang="zh-CN">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>C++编译控制</title>
            <style>
                /* 主容器样式 - 恢复并增强容器视觉效果 */
                .container {
                    padding: 10px;
                    box-sizing: border-box;
                    background-color: var(--vscode-sideBar-background);
                    min-height: 100%;
                }
                
                /* 区块容器样式 - 明显的视觉分隔 */
                .section {
                    margin-bottom: 15px;
                    padding: 10px;
                    border-radius: 4px;
                    background-color: var(--vscode-sideBarSectionHeader-background);
                    border: 1px solid var(--vscode-editorGroupHeader-tabsBorder);
                    box-sizing: border-box;
                }
                
                .title {
                    font-weight: bold;
                    margin-bottom: 8px;
                    color: var(--vscode-titleBar-activeForeground);
                    font-size: 14px;
                    padding-bottom: 4px;
                    border-bottom: 1px solid var(--vscode-editorGroupHeader-tabsBorder);
                }
                
                /* 输入框样式 */
                #compileOptions {
                    width: 100%;
                    padding: 6px 8px;
                    border: 1px solid var(--vscode-input-border);
                    background-color: var(--vscode-input-background);
                    color: var(--vscode-input-foreground);
                    font-size: 13px;
                    box-sizing: border-box;
                    height: 28px;
                    overflow: hidden;
                    white-space: nowrap;
                }
                
                .button-group {
                    display: flex;
                    flex-direction: column;
                    gap: 8px;
                    margin-top: 10px;
                }
                
                button {
                    padding: 8px;
                    background-color: var(--vscode-button-background);
                    color: var(--vscode-button-foreground);
                    border: 1px solid transparent;
                    border-radius: 4px;
                    cursor: pointer;
                    font-size: 13px;
                    transition: background-color 0.2s;
                }
                    
                button:disabled {
                    background-color: var(--vscode-button-background);
                    opacity: 0.5;
                    cursor: not-allowed;
                    color: #d8d5d5;
                    border: 1px solid var(--vscode-input-border);
                }
                
                button:hover {
                    background-color: var(--vscode-button-hoverBackground);
                }
                
                .checkbox-container {
                    display: flex;
                    align-items: center;
                    margin: 10px 0;
                    font-size: 13px;
                }
                
                input[type="checkbox"] {
                    margin-right: 8px;
                    width: 14px;
                    height: 14px;
                }
                
                .save-options-container {
                    margin-top: 8px;
                    display: flex;
                    justify-content: center;
                }
                
                #saveOptions {
                    padding: 6px 16px;
                }
            </style>
        </head>
        <body>
            <!-- 主容器 -->
            <div class="container">
                <!-- 编译选项区块 -->
                <div class="section">
                    <div class="title">编译选项</div>
                    <input type="text" id="compileOptions" value="${compileOptions.replace(/"/g, '&quot;')}">
                    <div class="save-options-container">
                        <button id="saveOptions">保存编译选项</button>
                    </div>
                    <div class="checkbox-container">
                        <input type="checkbox" id="staticLinking" ${useStatic ? 'checked' : ''}>
                        <label for="staticLinking">使用静态链接</label>
                    </div>
                </div>
                
                <!-- 运行控制区块 -->
                <div class="section">
                    <div class="title">运行控制</div>
                    <div class="button-group">
                        <button id="runInternal">内置终端运行</button>
                        <button id="runExternal">外部终端运行</button>
                        <button id="onlyCompile">仅编译</button>
                    </div>
                    <div class="checkbox-container" title="仅可在 Windows 中生效，且需要按照 ConsoleInfo.exe 置于系统 PATH">
                        <input type="checkbox" id="useConsoleInfo" ${useConsoleInfo ? 'checked' : ''}>
                        <label for="useConsoleInfo">使用 ConsoleInfo.exe 运行程序</label>
                    </div>
                </div>
            </div>

            <script>
                const vscode = acquireVsCodeApi();
                
                document.getElementById('saveOptions').addEventListener('click', () => {
                    const options = document.getElementById('compileOptions').value.trim();
                    vscode.postMessage({
                        type: 'updateCompileOptions',
                        value: options
                    });
                });
                
                document.getElementById('staticLinking').addEventListener('change', (e) => {
                    vscode.postMessage({
                        type: 'toggleStaticLinking',
                        value: e.target.checked
                    });
                });
                
                document.getElementById('useConsoleInfo').addEventListener('change', (e) => {
                    vscode.postMessage({
                        type: 'toggleuseConsoleInfo',
                        value: e.target.checked
                    });
                });
                
                document.getElementById('runInternal').addEventListener('click', () => {
                    vscode.postMessage({ type: 'runInternal' });
                });
                
                document.getElementById('runExternal').addEventListener('click', () => {
                    vscode.postMessage({ type: 'runExternal' });
                });
                
                document.getElementById('onlyCompile').addEventListener('click', () => {
                    vscode.postMessage({ type: 'onlyCompile' });
                });
                
                window.addEventListener('message', event => {
                    const data = event.data;
                    if (data.type === 'updateButtonStates') {
                        document.getElementById('runInternal').disabled = !data.enabled;
                        document.getElementById('runExternal').disabled = !data.enabled;
                        document.getElementById('onlyCompile').disabled = !data.enabled;
                        
                        // 添加提示信息
                        const tips = data.enabled ? '' : '请打开本地C++文件以启用此功能';
                        document.getElementById('runInternal').title = tips;
                        document.getElementById('runExternal').title = tips;
                        document.getElementById('onlyCompile').title = tips;
                    }
                    if (data.type === 'updateConfig') {
                        document.getElementById('compileOptions').value = data.compileOptions;
                        document.getElementById('staticLinking').checked = data.useStatic;
                        document.getElementById('useConsoleInfo').checked = data.useConsoleInfo;
                    } else if (data.type === 'showError') {
                        alert(data.message);
                    }
                });
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
        'cpp-compiler.runInternal',
        () => compileAndRun('internal')
    );
    const externalDisposable = vscode.commands.registerCommand(
        'cpp-compiler.runExternal',
        () => compileAndRun('external')
    );
    const cppCompile = vscode.commands.registerCommand(
        'cpp-compiler.cppCompile',
        () => OnlyCompile(1)
    );

    // 创建状态栏按钮
    statusBarInternal = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    statusBarInternal.text = '$(run) 内置终端运行';
    statusBarInternal.command = 'cpp-compiler.runInternal';
    statusBarInternal.tooltip = '编译并在VS Code内置终端运行C++程序';
    statusBarInternal.show();

    statusBarExternal = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
    statusBarExternal.text = '$(terminal) 外部终端运行';
    statusBarExternal.command = 'cpp-compiler.runExternal';
    statusBarExternal.tooltip = '编译并在系统外部终端运行C++程序';
    statusBarExternal.show();

    statusBarCompile = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 98);
    statusBarCompile.text = '$(gear) 仅编译';
    statusBarCompile.command = 'cpp-compiler.cppCompile';
    statusBarCompile.tooltip = '编译当前C++程序';
    statusBarCompile.show();

    compileStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 0);
    compileStatus.hide();
    
    RunTerminal.sendText("cls");

    // 订阅命令
    context.subscriptions.push(
        internalDisposable,
        externalDisposable,
        cppCompile,
        statusBarInternal,
        statusBarExternal,
        statusBarCompile,
        compileStatus
    );
}

function deactivate() { }

module.exports = {
    activate,
    deactivate
};