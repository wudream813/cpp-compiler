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
    const useFileRedirect = getConfig('useFileRedirect') || false;
    const useUnFileRedirect = getConfig('useUnFileRedirect') || false;
    const inputFile = getConfig('inputFile') || 'input.txt';
    const outputFile = getConfig('outputFile') || 'output.txt';
    const unFileInputFile = getConfig('unFileInputFile') || 'input.txt';
    const unFileOutputFile = getConfig('unFileOutputFile') || 'output.txt';

    let cdCommand, runCommand;
    if (process.platform === 'win32') {
        cdCommand = `cd /d "${programDir}"`;
        
        // 如果同时启用了文件读写和反文件读写
        if (useFileRedirect && useUnFileRedirect) {
            if (UseConsoleInfo) {
                // 使用 ConsoleInfoChangeFileIO.exe
                const ConsoleInfoChangeFileIOPath = path.join(__dirname, 'ConsoleInfoChangeFileIO.exe');
                runCommand = `cmd /c "${ConsoleInfoChangeFileIOPath} "${executableName}.exe" "${unFileInputFile}" "${unFileOutputFile}" "${inputFile}" "${outputFile}""`;
            } else {
                // 使用 ChangeFileIO.exe
                const ChangeFileIOPath = path.join(__dirname, 'ChangeFileIO.exe');
                runCommand = `cmd /c "${ChangeFileIOPath} "${executableName}.exe" "${unFileInputFile}" "${unFileOutputFile}" "${inputFile}" "${outputFile}""`;
            }
        } else if (useFileRedirect) {
            if (UseConsoleInfo) {
                // 使用 ConsoleInfoFileIO.exe
                const ConsoleInfoFileIOPath = path.join(__dirname, 'ConsoleInfoFileIO.exe');
                runCommand = `cmd /c "${ConsoleInfoFileIOPath} "${executableName}.exe" "${inputFile}" "${outputFile}""`;
            } else {
                // 使用标准重定向
                runCommand = `.\\"${executableName}.exe" < "${inputFile}" > "${outputFile}"`;
            }
        } else if (useUnFileRedirect) {
            if (UseConsoleInfo) {
                // 使用 ConsoleInfoUnFileIO.exe
                const ConsoleInfoUnFileIOPath = path.join(__dirname, 'ConsoleInfoUnFileIO.exe');
                runCommand = `cmd /c "${ConsoleInfoUnFileIOPath} "${executableName}.exe" "${unFileInputFile}" "${unFileOutputFile}""`;
            } else {
                // 使用 UnFileIO.exe
                const UnFileIOPath = path.join(__dirname, 'UnFileIO.exe');
                runCommand = `cmd /c "${UnFileIOPath} "${executableName}.exe" "${unFileInputFile}" "${unFileOutputFile}""`;
            }
        } else {
            if (UseConsoleInfo) {
                const ConsoleInfoPath = path.join(__dirname, 'ConsoleInfo.exe');
                runCommand = `cmd /c "${ConsoleInfoPath} "${executableName}.exe""`;
            } else {
                runCommand = `.\\"${executableName}.exe"`;
            }
        }
    } else {
        cdCommand = `cd "${programDir}"`;
        
        if (useFileRedirect) {
            // Linux/Mac 使用标准重定向
            runCommand = `./${executableName} < "${inputFile}" > "${outputFile}"`;
        } else if (useUnFileRedirect) {
            // Linux/Mac 使用标准重定向
            runCommand = `./${executableName}`;
        } else {
            runCommand = `./${executableName}`;
        }
    }

    if (terminalType === 'internal') {
        RunTerminal.show();
        RunTerminal.sendText('^exit\x03');
        RunTerminal.sendText(cdCommand);
        RunTerminal.sendText(runCommand);
    } else {
        let terminalCommand;
        if (process.platform === 'win32') {
            // 如果同时启用了文件读写和反文件读写
            if (useFileRedirect && useUnFileRedirect) {
                if (UseConsoleInfo) {
                    // 使用 ConsoleInfoChangeFileIO.exe
                    const ConsoleInfoChangeFileIOPath = path.join(__dirname, 'ConsoleInfoChangeFileIO.exe');
                    terminalCommand = `start "${executableName}.exe" cmd /c "${cdCommand} & ${ConsoleInfoChangeFileIOPath} "${executableName}.exe" "${unFileInputFile}" "${unFileOutputFile}" "${inputFile}" "${outputFile}" & echo. & pause"`;
                } else {
                    // 使用 ChangeFileIO.exe
                    const ChangeFileIOPath = path.join(__dirname, 'ChangeFileIO.exe');
                    terminalCommand = `start "${executableName}.exe" cmd /c "${cdCommand} & ${ChangeFileIOPath} "${executableName}.exe" "${unFileInputFile}" "${unFileOutputFile}" "${inputFile}" "${outputFile}" & echo. & pause"`;
                }
            } else if (useFileRedirect) {
                if (UseConsoleInfo) {
                    // 使用 ConsoleInfoFileIO.exe
                    const ConsoleInfoFileIOPath = path.join(__dirname, 'ConsoleInfoFileIO.exe');
                    terminalCommand = `start "${executableName}.exe" cmd /c "${cdCommand} & ${ConsoleInfoFileIOPath} "${executableName}.exe" "${inputFile}" "${outputFile}" & echo. & pause"`;
                } else {
                    // 使用标准重定向
                    terminalCommand = `start "${executableName}.exe" cmd /c "${cdCommand} & .\\"${executableName}.exe" < "${inputFile}" > "${outputFile}" & echo. & pause"`;
                }
            } else if (useUnFileRedirect) {
                if (UseConsoleInfo) {
                    // 使用 ConsoleInfoUnFileIO.exe
                    const ConsoleInfoUnFileIOPath = path.join(__dirname, 'ConsoleInfoUnFileIO.exe');
                    terminalCommand = `start "${executableName}.exe" cmd /c "${cdCommand} & ${ConsoleInfoUnFileIOPath} "${executableName}.exe" "${unFileInputFile}" "${unFileOutputFile}" & echo. & pause"`;
                } else {
                    // 使用 UnFileIO.exe
                    const UnFileIOPath = path.join(__dirname, 'UnFileIO.exe');
                    terminalCommand = `start "${executableName}.exe" cmd /c "${cdCommand} & ${UnFileIOPath} "${executableName}.exe" "${unFileInputFile}" "${unFileOutputFile}" & echo. & pause"`;
                }
            } else {
                if (UseConsoleInfo) {
                    const ConsoleInfoPath = path.join(__dirname, 'ConsoleInfo.exe');
                    terminalCommand = `start "${executableName}.exe" cmd /c "${cdCommand} & ${ConsoleInfoPath} "${executableName}.exe" & echo. & pause"`;
                } else {
                    terminalCommand = `start "${executableName}.exe" cmd /c "${cdCommand} & .\\"${executableName}.exe" & echo. & pause"`;
                }
            }
        } else if (process.platform === 'darwin') {
            if (useFileRedirect) {
                terminalCommand = `osascript -e 'tell application "Terminal" to do script "cd '${programDir.replace(/"/g, '\\"')}'; ./'${executableName.replace(/"/g, '\\"')}' < '${inputFile.replace(/"/g, '\\"')}' > '${outputFile.replace(/"/g, '\\"')}'; read -p \"按Enter键退出...\""'`;
            } else {
                terminalCommand = `osascript -e 'tell application "Terminal" to do script "cd '${programDir.replace(/"/g, '\\"')}'; ./'${executableName.replace(/"/g, '\\"')}'; read -p \"按Enter键退出...\""'`;
            }
        } else {
            if (useFileRedirect) {
                terminalCommand = `gnome-terminal -- bash -c "cd '${programDir}'; ./'${executableName}' < '${inputFile}' > '${outputFile}'; read -p '按Enter键退出...'"`;
            } else {
                terminalCommand = `gnome-terminal -- bash -c "cd '${programDir}'; ./'${executableName}'; read -p '按Enter键退出...'"`;
            }
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
        const inputFile = getConfig('inputFile') || 'input.txt';
        const outputFile = getConfig('outputFile') || 'output.txt';
        const unFileInputFile = getConfig('unFileInputFile') || 'input.txt';
        const unFileOutputFile = getConfig('unFileOutputFile') || 'output.txt';
        const useFileRedirect = getConfig('useFileRedirect') || false;
        const useUnFileRedirect = getConfig('useUnFileRedirect') || false;

        // 监听来自webview的消息
        webviewView.webview.onDidReceiveMessage(async (data) => {
            switch (data.type) {
                case 'runInternal':
                    showCommand(`用户在侧边栏选择了在内置终端编译运行，编译选项：${compileOptions}，${useStatic ? `启用` : `禁用`}静态编译，${useConsoleInfo ? `使用` : `禁用`} ConsoleInfo.exe 运行程序，${useFileRedirect ? `启用文件重定向，输入文件为 ${inputFile}，输出文件为 ${outputFile}` : ''}${useFileRedirect && useUnFileRedirect ? '，' : ''}${useUnFileRedirect ? `启用反文件重定向，输入文件为 ${unFileInputFile}，输出文件为 ${unFileOutputFile}` : ''}${!useFileRedirect && !useUnFileRedirect ? `禁用文件重定向` : ''}`);
                    compileAndRun('internal');
                    break;
                case 'runExternal':
                    showCommand(`用户在侧边栏选择了在外部终端编译运行，编译选项：${compileOptions}，${useStatic ? `启用` : `禁用`}静态编译，${useConsoleInfo ? `使用` : `禁用`} ConsoleInfo.exe 运行程序，${useFileRedirect ? `启用文件重定向，输入文件为 ${inputFile}，输出文件为 ${outputFile}` : ''}${useFileRedirect && useUnFileRedirect ? '，' : ''}${useUnFileRedirect ? `启用反文件重定向，输入文件为 ${unFileInputFile}，输出文件为 ${unFileOutputFile}` : ''}${!useFileRedirect && !useUnFileRedirect ? `禁用文件重定向` : ''}`);
                    compileAndRun('external');
                    break;
                case 'onlyCompile':
                    showCommand(`用户在侧边栏选择了仅编译，编译选项：${compileOptions}，${useStatic ? `启用` : `禁用`}静态编译，${useConsoleInfo ? `使用` : `禁用`} ConsoleInfo.exe 运行程序，${useFileRedirect ? `启用文件重定向，输入文件为 ${inputFile}，输出文件为 ${outputFile}` : ''}${useFileRedirect && useUnFileRedirect ? '，' : ''}${useUnFileRedirect ? `启用反文件重定向，输入文件为 ${unFileInputFile}，输出文件为 ${unFileOutputFile}` : ''}${!useFileRedirect && !useUnFileRedirect ? `禁用文件重定向` : ''}`);
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
                case 'updateInputFile':
                    if(data.value !== '') {
                        showCommand(`用户在侧边栏更新了输入文件，输入文件现在为：${data.value}`);
                        const inputConfig = vscode.workspace.getConfiguration('cpp-compiler');
                        await inputConfig.update('inputFile', data.value, vscode.ConfigurationTarget.Global);
                    }else{
                        vscode.window.showErrorMessage('文件路径不能为空！');
                    }
                    this.updateWebviewContent();
                    break;
                case 'updateOutputFile':
                    if(data.value !== '') {
                        showCommand(`用户在侧边栏更新了输出文件，输出文件现在为：${data.value}`);
                        const outputConfig = vscode.workspace.getConfiguration('cpp-compiler');
                        await outputConfig.update('outputFile', data.value, vscode.ConfigurationTarget.Global);
                    }else{
                        vscode.window.showErrorMessage('文件路径不能为空！');
                    }
                    this.updateWebviewContent();
                    break;
                case 'updateUnFileInputFile':
                    if(data.value !== '') {
                        showCommand(`用户在侧边栏更新了反文件输入文件，反文件输入文件现在为：${data.value}`);
                        const unFileInputConfig = vscode.workspace.getConfiguration('cpp-compiler');
                        await unFileInputConfig.update('unFileInputFile', data.value, vscode.ConfigurationTarget.Global);
                    }else{
                        vscode.window.showErrorMessage('文件路径不能为空！');
                    }
                    this.updateWebviewContent();
                    break;
                case 'updateUnFileOutputFile':
                    if(data.value !== '') {
                        showCommand(`用户在侧边栏更新了反文件输出文件，反文件输出文件现在为：${data.value}`);
                        const unFileOutputConfig = vscode.workspace.getConfiguration('cpp-compiler');
                        await unFileOutputConfig.update('unFileOutputFile', data.value, vscode.ConfigurationTarget.Global);
                    }else{
                        vscode.window.showErrorMessage('文件路径不能为空！');
                    }
                    this.updateWebviewContent();
                    break;
                case 'toggleFileRedirect':
                    showCommand(`用户在侧边栏更新了文件重定向选项，文件重定向选项现在为：${data.value}`);
                    const fileRedirectConfig = vscode.workspace.getConfiguration('cpp-compiler');
                    await fileRedirectConfig.update('useFileRedirect', data.value, vscode.ConfigurationTarget.Global);
                    this.updateWebviewContent();
                    break;
                case 'toggleUnFileRedirect':
                    showCommand(`用户在侧边栏更新了反文件重定向选项，反文件重定向选项现在为：${data.value}`);
                    const unFileRedirectConfig = vscode.workspace.getConfiguration('cpp-compiler');
                    await unFileRedirectConfig.update('useUnFileRedirect', data.value, vscode.ConfigurationTarget.Global);
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
        const inputFile = getConfig('inputFile') || 'input.txt';
        const outputFile = getConfig('outputFile') || 'output.txt';
        const unFileInputFile = getConfig('unFileInputFile') || 'input.txt';
        const unFileOutputFile = getConfig('unFileOutputFile') || 'output.txt';
        const useFileRedirect = getConfig('useFileRedirect') || false;
        const useUnFileRedirect = getConfig('useUnFileRedirect') || false;

        sidebarPanel.webview.postMessage({
            type: 'updateConfig',
            compileOptions: compileOptions,
            useStatic: useStatic,
            useConsoleInfo: useConsoleInfo,
            inputFile: inputFile,
            outputFile: outputFile,
            unFileInputFile: unFileInputFile,
            unFileOutputFile: unFileOutputFile,
            useFileRedirect: useFileRedirect,
            useUnFileRedirect: useUnFileRedirect
        });
    }

    // 在 CppCompilerSidebarProvider 类的 _getHtmlForWebview 方法中修改
    _getHtmlForWebview(webview) {
        const compileOptions = getConfig('compileOptions') || '';
        const useStatic = getConfig('useStaticLinking') || false;
        const useConsoleInfo = getConfig('useConsoleInfo') || false;
        const inputFile = getConfig('inputFile') || 'input.txt';
        const outputFile = getConfig('outputFile') || 'output.txt';
        const unFileInputFile = getConfig('unFileInputFile') || 'input.txt';
        const unFileOutputFile = getConfig('unFileOutputFile') || 'output.txt';
        const useFileRedirect = getConfig('useFileRedirect') || false;
        const useUnFileRedirect = getConfig('useUnFileRedirect') || false;
    
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
                }
                
                .container {
                    padding: 12px;
                    background-color: var(--vscode-sideBar-background);
                    min-height: 100%;
                    display: flex;
                    flex-direction: column;
                    gap: 12px;
                    /* 固定容器宽度（匹配VS Code侧边栏默认宽度），避免拉伸 */
                    width: 100%;
                }
            
                /* 区块容器样式 */
                .collapsible-section {
                    border-radius: 6px;
                    background-color: var(--vscode-sideBarSectionHeader-background);
                    border: 1px solid var(--vscode-panel-border);
                    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
                    transition: box-shadow 0.2s ease;
                    /* 关键：强制占满父容器宽度，且宽度不随内容变化 */
                    width: 100%;
                    min-width: 100%;
                }
            
                .collapsible-section:hover {
                    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
                }
            
                /* 标题栏样式 */
                .section-header {
                    font-weight: 600;
                    padding: 10px 14px;
                    color: var(--vscode-titleBar-activeForeground);
                    font-size: 14px;
                    display: flex;
                    align-items: center;
                    justify-content: space-between;
                    cursor: pointer;
                    user-select: none;
                }
                
                .section-header:hover {
                    background-color: rgba(255, 255, 255, 0.05);
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
                    transition: transform 0.2s ease;
                    font-size: 16px;
                }
                
                .rotate {
                    transform: rotate(90deg);
                }
                
                /* 内容区域样式 */
                .section-content {
                    /* 左右内边距固定14px，仅上下内边距随折叠状态变化 */
                    padding: 0 14px;
                    max-height: 0;
                    overflow: hidden;
                    /* 仅过渡上下内边距和最大高度，避免宽度相关动画 */
                    transition: max-height 0.2s ease-in-out, padding-top 0.2s ease-in-out, padding-bottom 0.2s ease-in-out;
                }
                
                .section-content.expanded {
                    /* 展开时仅增加上下内边距，左右内边距保持14px不变 */
                    padding: 14px 14px;
                    max-height: 800px;
                }
            
                /* 输入框样式 */
                input[type="text"] {
                    width: 100%;
                    padding: 8px 12px;
                    border: 1px solid var(--vscode-input-border);
                    background-color: var(--vscode-input-background);
                    color: var(--vscode-input-foreground);
                    font-size: 13px;
                    box-sizing: border-box;
                    height: 32px;
                    border-radius: 4px;
                    transition: all 0.2s ease;
                    font-family: var(--vscode-font-family);
                }
            
                input[type="text"]:focus {
                    border-color: var(--vscode-focusBorder);
                    outline: none;
                    box-shadow: 0 0 0 2px rgba(0, 120, 212, 0.15);
                }
                
                input[type="text"]::placeholder {
                    color: var(--vscode-input-placeholderForeground);
                }
            
                .button-group {
                    display: flex;
                    flex-direction: column;
                    gap: 8px;
                    margin-top: 12px;
                }
                
                button {
                    padding: 10px;
                    background-color: var(--vscode-button-background);
                    color: var(--vscode-button-foreground);
                    border: none;
                    border-radius: 4px;
                    cursor: pointer;
                    font-size: 13px;
                    font-weight: 500;
                    /* 添加按钮过渡动画 */
                    transition: all 0.2s ease-in-out;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    /* 基础阴影 */
                    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
                }
                    
                button:disabled {
                    background-color: var(--vscode-button-background);
                    opacity: 0.6;
                    cursor: not-allowed;
                    box-shadow: none;
                    transform: none;
                }
                
                button:hover:not(:disabled) {
                    background-color: var(--vscode-button-hoverBackground);
                    /* 悬停时增强阴影 */
                    box-shadow: 0 3px 6px rgba(0, 0, 0, 0.15);
                    /* 轻微上浮效果 */
                    transform: translateY(-1px);
                }
                
                button:active:not(:disabled) {
                    /* 点击时阴影收缩 */
                    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.1);
                    /* 点击时下沉效果 */
                    transform: translateY(0);
                }
                
                .checkbox-container {
                    display: flex;
                    align-items: center;
                    margin: 10px 0;
                    font-size: 13px;
                    padding: 6px 0;
                }
                
                input[type="checkbox"] {
                    margin-right: 8px;
                    width: 16px;
                    height: 16px;
                    accent-color: var(--vscode-button-background);
                    cursor: pointer;
                }
                
                .save-options-container {
                    margin-top: 10px;
                    display: flex;
                    justify-content: center;
                }
                
                #saveOptions {
                    padding: 8px 20px;
                    background-color: var(--vscode-button-background);
                    color: var(--vscode-button-foreground);
                }
                
                .file-input-container {
                    margin-bottom: 10px;
                    position: relative;
                }
                
                .file-input-label {
                    display: block;
                    margin-bottom: 6px;
                    font-size: 13px;
                    color: var(--vscode-descriptionForeground);
                    font-weight: 500;
                }
                
                .subsection {
                    margin-bottom: 12px;
                    padding: 12px;
                    border-radius: 5px;
                    background-color: var(--vscode-sideBar-background);
                    border: 1px solid var(--vscode-panel-border);
                    /* 继承盒模型，宽度不超出父容器 */
                    width: 100%;
                }
                
                .subsection-title {
                    font-weight: 600;
                    margin-bottom: 8px;
                    color: var(--vscode-titleBar-activeForeground);
                    font-size: 13px;
                    padding-bottom: 5px;
                    border-bottom: 1px solid var(--vscode-panel-border);
                }
                
                .save-status {
                    position: absolute;
                    right: 0;
                    top: 0;
                    font-size: 12px;
                    color: var(--vscode-testing-iconPassed);
                    opacity: 0;
                    transition: opacity 0.3s ease;
                    pointer-events: none;
                }
                
                .save-status.visible {
                    opacity: 1;
                }
                
                .disabled-section {
                    opacity: 0.6;
                }
            </style>
        </head>
        <body>
            <!-- 主容器 -->
            <div class="container">
                <!-- 编译选项区块（可折叠） -->
                <div class="collapsible-section">
                    <div class="section-header" data-section="compileOptions">
                        <div class="section-title">编译选项</div>
                        <span class="collapse-icon">▶</span>
                    </div>
                    <div class="section-content expanded" id="compileOptionsContent">
                        <input type="text" id="compileOptions" value="${compileOptions.replace(/"/g, '&quot;')}" placeholder="输入编译选项，如：-std=c++17 -Wall">
                        <div class="save-options-container">
                            <button id="saveOptions">保存编译选项</button>
                        </div>
                        <div class="checkbox-container">
                            <input type="checkbox" id="staticLinking" ${useStatic ? 'checked' : ''}>
                            <label for="staticLinking">使用静态链接</label>
                        </div>
                    </div>
                </div>
                
                <!-- 运行控制区块（可折叠） -->
                <div class="collapsible-section">
                    <div class="section-header" data-section="runControl">
                        <div class="section-title">运行控制</div>
                        <span class="collapse-icon">▶</span>
                    </div>
                    <div class="section-content expanded" id="runControlContent">
                        <div class="button-group">
                            <button id="runInternal">内置终端运行</button>
                            <button id="runExternal">外部终端运行</button>
                            <button id="onlyCompile">仅编译</button>
                        </div>
                        ${process.platform === 'win32' ? `
                            <div class="checkbox-container">
                                <input type="checkbox" id="useConsoleInfo" ${useConsoleInfo ? 'checked' : ''}>
                                <label for="useConsoleInfo">使用 ConsoleInfo.exe 运行程序</label>
                            </div>
                            ` : `
                            <div class="checkbox-container disabled-section">
                                <input type="checkbox" id="useConsoleInfo" disabled>
                                <label for="useConsoleInfo">使用 ConsoleInfo.exe 运行程序 (仅 Windows)</label>
                            </div>
                        `}
                    </div>
                </div>
                
                <!-- 文件读写区块（可折叠） -->
                <div class="collapsible-section">
                    <div class="section-header" data-section="fileOperations">
                        <div class="section-title">文件读写操作</div>
                        <span class="collapse-icon">▶</span>
                    </div>
                    <div class="section-content expanded" id="fileOperationsContent">
                        <!-- 文件读写子区块 -->
                        <div class="subsection">
                            <div class="subsection-title">文件读写</div>
                            <div class="file-input-container">
                                <div class="file-input-label">输入文件</div>
                                <input type="text" id="inputFile" value="${inputFile.replace(/"/g, '&quot;')}" placeholder="输入文件路径">
                                <div class="save-status" id="inputFileStatus">✓ 已保存</div>
                            </div>
                            <div class="file-input-container">
                                <div class="file-input-label">输出文件</div>
                                <input type="text" id="outputFile" value="${outputFile.replace(/"/g, '&quot;')}" placeholder="输出文件路径">
                                <div class="save-status" id="outputFileStatus">✓ 已保存</div>
                            </div>
                            <div class="checkbox-container">
                                <input type="checkbox" id="useFileRedirect" ${useFileRedirect ? 'checked' : ''}>
                                <label for="useFileRedirect">启用文件读写</label>
                            </div>
                        </div>
                        
                        <!-- 反文件读写子区块 -->
                        <div class="subsection">
                            <div class="subsection-title">反文件读写</div>
                            <div class="file-input-container">
                                <div class="file-input-label">输入文件</div>
                                <input type="text" id="unFileInputFile" value="${unFileInputFile.replace(/"/g, '&quot;')}" placeholder="反文件输入文件路径">
                                <div class="save-status" id="unFileInputFileStatus">✓ 已保存</div>
                            </div>
                            <div class="file-input-container">
                                <div class="file-input-label">输出文件</div>
                                <input type="text" id="unFileOutputFile" value="${unFileOutputFile.replace(/"/g, '&quot;')}" placeholder="反文件输出文件路径">
                                <div class="save-status" id="unFileOutputFileStatus">✓ 已保存</div>
                            </div>
                            ${process.platform === 'win32' ? `
                            <div class="checkbox-container">
                                <input type="checkbox" id="useUnFileRedirect" ${useUnFileRedirect ? 'checked' : ''}>
                                <label for="useUnFileRedirect">启用反文件读写</label>
                            </div>
                            ` : `
                            <div class="checkbox-container disabled-section">
                                <input type="checkbox" id="useUnFileRedirect" disabled>
                                <label for="useUnFileRedirect">启用反文件读写 (仅 Windows)</label>
                            </div>
                            `}
                        </div>
                    </div>
                </div>
            </div>
    
            <script>
                const vscode = acquireVsCodeApi();
                
                // 初始化可折叠功能
                document.querySelectorAll('.section-header').forEach(header => {
                    header.addEventListener('click', () => {
                        // 获取对应的内容区域和图标
                        const sectionId = header.getAttribute('data-section');
                        const content = document.getElementById(sectionId + 'Content');
                        const icon = header.querySelector('.collapse-icon');
                        
                        // 切换展开/折叠状态
                        content.classList.toggle('expanded');
                        icon.classList.toggle('rotate');
                    });
                });
                
                // 显示保存状态
                function showSaveStatus(elementId) {
                    const statusElement = document.getElementById(elementId);
                    statusElement.classList.add('visible');
                    setTimeout(() => {
                        statusElement.classList.remove('visible');
                    }, 2000);
                }
                
                // 保存编译选项
                document.getElementById('saveOptions').addEventListener('click', () => {
                    const options = document.getElementById('compileOptions').value.trim();
                    vscode.postMessage({
                        type: 'updateCompileOptions',
                        value: options
                    });
                });
                
                // 静态链接选项
                document.getElementById('staticLinking').addEventListener('change', (e) => {
                    vscode.postMessage({
                        type: 'toggleStaticLinking',
                        value: e.target.checked
                    });
                });
                
                // ConsoleInfo选项
                document.getElementById('useConsoleInfo').addEventListener('change', (e) => {
                    vscode.postMessage({
                        type: 'toggleuseConsoleInfo',
                        value: e.target.checked
                    });
                });
                
                // 文件读写输入框失去焦点时保存
                document.getElementById('inputFile').addEventListener('blur', (e) => {
                    const inputFile = e.target.value.trim();
                    if (inputFile) {
                        vscode.postMessage({
                            type: 'updateInputFile',
                            value: inputFile
                        });
                        showSaveStatus('inputFileStatus');
                    }
                });
                
                // 文件读写输出框失去焦点时保存
                document.getElementById('outputFile').addEventListener('blur', (e) => {
                    const outputFile = e.target.value.trim();
                    if (outputFile) {
                        vscode.postMessage({
                            type: 'updateOutputFile',
                            value: outputFile
                        });
                        showSaveStatus('outputFileStatus');
                    }
                });
                
                // 反文件读写输入框失去焦点时保存
                document.getElementById('unFileInputFile').addEventListener('blur', (e) => {
                    const unFileInputFile = e.target.value.trim();
                    if (unFileInputFile) {
                        vscode.postMessage({
                            type: 'updateUnFileInputFile',
                            value: unFileInputFile
                        });
                        showSaveStatus('unFileInputFileStatus');
                    }
                });
                
                // 反文件读写输出框失去焦点时保存
                document.getElementById('unFileOutputFile').addEventListener('blur', (e) => {
                    const unFileOutputFile = e.target.value.trim();
                    if (unFileOutputFile) {
                        vscode.postMessage({
                            type: 'updateUnFileOutputFile',
                            value: unFileOutputFile
                        });
                        showSaveStatus('unFileOutputFileStatus');
                    }
                });
                
                // 文件重定向选项
                document.getElementById('useFileRedirect').addEventListener('change', (e) => {
                    vscode.postMessage({
                        type: 'toggleFileRedirect',
                        value: e.target.checked
                    });
                });
                
                // 反文件重定向选项
                document.getElementById('useUnFileRedirect').addEventListener('change', (e) => {
                    vscode.postMessage({
                        type: 'toggleUnFileRedirect',
                        value: e.target.checked
                    });
                });
                
                // 运行按钮
                document.getElementById('runInternal').addEventListener('click', () => {
                    vscode.postMessage({ type: 'runInternal' });
                });
                
                document.getElementById('runExternal').addEventListener('click', () => {
                    vscode.postMessage({ type: 'runExternal' });
                });
                
                document.getElementById('onlyCompile').addEventListener('click', () => {
                    vscode.postMessage({ type: 'onlyCompile' });
                });
                
                // 监听来自扩展的消息
                window.addEventListener('message', event => {
                    const data = event.data;
                    if (data.type === 'updateButtonStates') {
                        document.getElementById('runInternal').disabled = !data.enabled;
                        document.getElementById('runExternal').disabled = !data.enabled;
                        document.getElementById('onlyCompile').disabled = !data.enabled;
                    }
                    if (data.type === 'updateConfig') {
                        document.getElementById('compileOptions').value = data.compileOptions;
                        document.getElementById('staticLinking').checked = data.useStatic;
                        document.getElementById('useConsoleInfo').checked = data.useConsoleInfo;
                        document.getElementById('inputFile').value = data.inputFile;
                        document.getElementById('outputFile').value = data.outputFile;
                        document.getElementById('unFileInputFile').value = data.unFileInputFile;
                        document.getElementById('unFileOutputFile').value = data.unFileOutputFile;
                        document.getElementById('useFileRedirect').checked = data.useFileRedirect;
                        document.getElementById('useUnFileRedirect').checked = data.useUnFileRedirect;
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