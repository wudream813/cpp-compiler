'use strict';
// 回归测试：覆盖 7.4.1 修复的若干 bug。
// 运行：node tests/bugfix-tests.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const vm = require('vm');
const { createRequire } = require('module');

const root = path.join(__dirname, '..');
const filename = path.join(root, 'extension.js');
const realRequire = createRequire(filename);

const TEMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'dream-bugfix-'));
const noopDisposable = () => ({ dispose() {} });
const outputChannel = () => ({
  appendLine() {}, append() {}, show() {}, clear() {}, dispose() {},
  info() {}, warn() {}, error() {}
});

function createStub(settings = {}) {
  const execs = [];
  const writes = [];
  const commands = [];
  const listeners = { start: [], end: [], close: [] };
  const terminal = {
    name: 'dream-cpp-compiler:运行',
    sendText: (text, addNewLine) => writes.push({ text, addNewLine }),
    show() {},
    dispose() {}
  };
  const vscode = {
    extensions: { getExtension: () => undefined, onDidChange: noopDisposable },
    window: {
      activeTextEditor: undefined,
      createOutputChannel: outputChannel,
      createStatusBarItem: () => ({ show() {}, hide() {}, dispose() {}, text: '' }),
      createTerminal: () => terminal,
      terminals: [terminal],
      showErrorMessage() {},
      showWarningMessage() {},
      showInformationMessage: async () => undefined,
      withProgress: async (options, task) => task({ report() {} }, { onCancellationRequested: noopDisposable }),
      onDidChangeActiveTextEditor: noopDisposable,
      onDidStartTerminalShellExecution: (cb) => { listeners.start.push(cb); return noopDisposable(); },
      onDidEndTerminalShellExecution: (cb) => { listeners.end.push(cb); return noopDisposable(); },
      onDidCloseTerminal: (cb) => { listeners.close.push(cb); return noopDisposable(); },
      registerWebviewViewProvider: () => noopDisposable()
    },
    workspace: {
      isTrusted: true,
      workspaceFolders: [{ uri: { fsPath: TEMP_ROOT } }],
      getConfiguration: () => ({
        inspect: (section) => ({ globalValue: settings[section] }),
        update: async () => {}
      }),
      onDidChangeConfiguration: noopDisposable,
      onDidSaveTextDocument: noopDisposable
    },
    commands: {
      registerCommand: (id, callback) => { commands.push([id, callback]); return noopDisposable(); },
      executeCommand: async () => {}
    },
    StatusBarAlignment: { Left: 1, Right: 2 },
    ProgressLocation: { Notification: 15 },
    ConfigurationTarget: { Global: 1 },
    Uri: { file: (p) => ({ fsPath: p }) },
    languages: { setTextDocumentLanguage: async () => {} },
    Position: class { constructor(line, character) { this.line = line; this.character = character; } },
    Range: class { constructor(start, end) { this.start = start; this.end = end; } }
  };
  return { vscode, execs, writes, commands, terminal, listeners };
}

// 用假的 vscode 模块加载 extension.js，并导出内部函数用于断言
function loadExtension(stub) {
  const moduleObj = { exports: {} };
  const loader = vm.runInThisContext(
    '(function(require,module,exports,__filename,__dirname){' + fs.readFileSync(filename, 'utf8') + '\n' +
    'module.exports.__test = { parseFileHeaderConfig, getFileConfig, GetExePath, runProgram, activate, deactivate,' +
    ' buildCompileCommand, invalidateFileConfig, CompileModule, CppCompilerSidebarProvider };\n})'
  );
  loader(
    (id) => (id === 'vscode' ? stub.vscode : realRequire(id)),
    moduleObj, moduleObj.exports, filename, root
  );
  return moduleObj.exports;
}

function writeSource(name, content) {
  const file = path.join(TEMP_ROOT, name);
  fs.writeFileSync(file, content);
  return file;
}

function useEditor(stub, file) {
  stub.vscode.window.activeTextEditor = {
    document: {
      languageId: 'cpp',
      isDirty: false,
      uri: { scheme: 'file', fsPath: file, toString: () => 'file://' + file },
      getText: () => fs.readFileSync(file, 'utf8'),
      save: async () => {}
    }
  };
}

async function run() {
  const mainCpp = writeSource('main.cpp', '#include <cstdio>\nint main(){puts("hi");}\n');
  const realExec = cp.exec;

  try {
    // 1. 编译命令模板：<> 与旧版 {} 占位符都要生效
    {
      const stub = createStub({
        compilerPath: 'g++',
        compileCommand: '"<cPath>" "<cppPath>" <option> -o "<outPath>" --from-template',
        CompileDefaultValue: '-std=c++14 -O2'
      });
      cp.exec = (command, callback) => {
        stub.execs.push(command);
        if (callback) setImmediate(() => callback(null, '', ''));
        return { kill() {}, pid: 1 };
      };
      const ext = loadExtension(stub);
      useEditor(stub, mainCpp);
      ext.activate({ subscriptions: [], extensionUri: {} });
      await stub.commands.find(([id]) => id === 'dream-cpp-compiler.cppCompile')[1]();
      assert(stub.execs.some((c) => c.includes('--from-template')), 'compileCommand 模板必须真正用于编译');
      ext.deactivate();
    }

    // 2. 旧版 {cPath} 占位符仍然兼容
    {
      const stub = createStub();
      const ext = loadExtension(stub);
      const command = ext.__test.buildCompileCommand('"{cPath}" "{cppPath}" {option} -o "{outPath}"', {
        cPath: 'cc', cppPath: 'a.cpp', option: '-O2', outPath: 'a'
      });
      assert.strictEqual(command, '"cc" "a.cpp" -O2 -o "a"');
    }

    // 3. 内置终端：空闲时绝不能发送 Ctrl+C（否则 Windows cmd 会以 -1073741510 退出）
    {
      const stub = createStub();
      cp.exec = (command, callback) => { if (callback) setImmediate(() => callback(null, '', '')); return { kill() {}, pid: 1 }; };
      const ext = loadExtension(stub);
      ext.activate({ subscriptions: [], extensionUri: {} });
      await ext.__test.runProgram(mainCpp, 'internal');
      assert(!stub.writes.some((w) => /\x03/.test(w.text)), '空闲终端不应收到 ETX(\\x03)');

      // 有命令运行时才发送 Ctrl+C 中断
      stub.listeners.start.forEach((cb) => cb({ terminal: stub.terminal }));
      await ext.__test.runProgram(mainCpp, 'internal');
      assert(stub.writes.some((w) => w.text === '\x03' && w.addNewLine === false), '运行中应发送 Ctrl+C 且不带换行');
      ext.deactivate();
    }

    // 4. 卡片默认展开状态：设置为 false 时不能被 `|| true` 覆盖
    {
      const stub = createStub({
        compileOptionsCardDefaultStatus: false,
        runControlCardDefaultStatus: false,
        advancedCardDefaultStatus: true,
        fileOperationsCardDefaultStatus: true
      });
      const ext = loadExtension(stub);
      const config = ext.__test.parseFileHeaderConfig(mainCpp);
      assert.strictEqual(config.compileOptionsCardOpen, false);
      assert.strictEqual(config.runControlCardOpen, false);
      assert.strictEqual(config.advancedCardOpen, true);
      assert.strictEqual(config.fileOperationsCardOpen, true);
    }

    // 5. 文件不存在时读取配置不应抛异常
    {
      const stub = createStub();
      const ext = loadExtension(stub);
      const config = ext.__test.getFileConfig(path.join(TEMP_ROOT, 'missing.cpp'), 'compileOptions');
      assert.ok(config, '不存在的文件应返回默认配置');
    }

    // 6. baseName 不能只去掉 .cpp
    {
      const stub = createStub();
      const ext = loadExtension(stub);
      assert.strictEqual(ext.__test.GetExePath(path.join(TEMP_ROOT, 'b.cc')), path.join(TEMP_ROOT, 'b'));
      assert.strictEqual(ext.__test.GetExePath(path.join(TEMP_ROOT, 'c.CPP')), path.join(TEMP_ROOT, 'c'));
    }

    // 7. 运行期 <base> 占位符（moreCommand / 文件读写）
    {
      const stub = createStub();
      cp.exec = (command, callback) => { if (callback) setImmediate(() => callback(null, '', '')); return { kill() {}, pid: 1 }; };
      const ext = loadExtension(stub);
      ext.activate({ subscriptions: [], extensionUri: {} });
      const withCommand = writeSource('second.cpp', '// morecommand : echo CHECK-<base>\nint main(){return 0;}\n');
      await ext.__test.runProgram(withCommand, 'internal');
      const text = stub.writes.map((w) => w.text).join(' ');
      assert(text.includes('CHECK-second'), '<base> 应在运行前被替换为文件名');
      assert(!text.includes('<base>'), '运行命令中不应残留 <base> 占位符');
      ext.deactivate();
    }

    // 8. 文件保存后文件头配置缓存失效
    {
      const stub = createStub();
      const ext = loadExtension(stub);
      const file = writeSource('cached.cpp', 'int main(){return 0;}\n');
      ext.__test.getFileConfig(file, 'compileOptions');
      fs.writeFileSync(file, '// compileoptions : -std=c++20\nint main(){return 0;}\n');
      ext.__test.invalidateFileConfig(file);
      assert.strictEqual(ext.__test.getFileConfig(file, 'compileOptions'), '-std=c++20');
    }

    // 9. 静态链接失败时自动回退（macOS 的 clang 不支持 -static）
    if (process.platform !== 'win32') {
      cp.exec = realExec; // 本例需要真的执行脚本（要在加载扩展前恢复）
      const stub = createStub();
      const ext = loadExtension(stub);
      ext.activate({ subscriptions: [], extensionUri: {} });
      const fakeCompiler = path.join(TEMP_ROOT, 'fake compiler');
      fs.writeFileSync(fakeCompiler, `#!/bin/sh
for a in "$@"; do
  if [ "$a" = "-static" ]; then echo "clang: error: unsupported option '-static'" >&2; exit 1; fi
done
out=""; prev=""
for a in "$@"; do if [ "$prev" = "-o" ]; then out="$a"; fi; prev="$a"; done
echo binary > "$out"
`, { mode: 0o755 });
      stub.vscode.workspace.getConfiguration = () => ({
        inspect: (section) => ({ globalValue: section === 'compilerPath' ? fakeCompiler : undefined }),
        update: async () => {}
      });
      const moduleSource = writeSource('module.cpp', 'int main(){return 0;}\n');
      const moduleBinary = path.join(TEMP_ROOT, 'module.bin');
      const ok = await ext.__test.CompileModule(moduleSource, 'TestModule', moduleBinary);
      assert.strictEqual(ok, 1, '静态编译失败后应回退为动态链接');
      assert(fs.existsSync(moduleBinary));
      ext.deactivate();
    }

    console.log('bugfix regression tests passed');
  } finally {
    cp.exec = realExec;
    fs.rmSync(TEMP_ROOT, { recursive: true, force: true });
  }
}

run().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
