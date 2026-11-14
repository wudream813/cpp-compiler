'use strict';
// 回归测试：WorkDir / workDirDirect 相关修复（7.4.7）
//   - Windows 下 parseShellTokens 不再把反斜杠当转义符
//   - 全局 workDirDirectDefaultValue 优先于自动探测
//   - 注释/字符串里的 #include 不会误触发自动探测
//   - 侧边栏保存时 workDirDirect 不会被丢弃
//   - 模块缓存指纹带扩展版本号
// 运行：node tests/workdir-tests.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { createRequire } = require('module');

const root = path.join(__dirname, '..');
const filename = path.join(root, 'extension.js');
const realRequire = createRequire(filename);
const TEMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'dream-workdir-'));

const noopDisposable = () => ({ dispose() {} });
const outputChannel = () => ({
  appendLine() {}, append() {}, show() {}, clear() {}, dispose() {},
  info() {}, warn() {}, error() {}
});

function createStub(settings = {}) {
  const vscode = {
    extensions: { getExtension: () => undefined, onDidChange: noopDisposable },
    window: {
      activeTextEditor: undefined,
      createOutputChannel: outputChannel,
      createStatusBarItem: () => ({ show() {}, hide() {}, dispose() {}, text: '' }),
      createTerminal: () => ({ name: 'dream', sendText() {}, show() {}, dispose() {} }),
      terminals: [],
      showErrorMessage() {},
      showWarningMessage() {},
      showInformationMessage: async () => undefined,
      withProgress: async (options, task) => task({ report() {} }, { onCancellationRequested: noopDisposable }),
      onDidChangeActiveTextEditor: noopDisposable,
      onDidStartTerminalShellExecution: () => noopDisposable(),
      onDidEndTerminalShellExecution: () => noopDisposable(),
      onDidCloseTerminal: () => noopDisposable(),
      registerWebviewViewProvider: () => noopDisposable()
    },
    workspace: {
      isTrusted: true,
      workspaceFolders: [{ uri: { fsPath: TEMP_ROOT } }],
      getConfiguration: () => ({
        inspect: (section) => (section in settings ? { globalValue: settings[section] } : undefined),
        update: async () => {}
      }),
      onDidChangeConfiguration: noopDisposable,
      onDidSaveTextDocument: noopDisposable
    },
    commands: { registerCommand: () => noopDisposable(), executeCommand: async () => {} },
    StatusBarAlignment: { Left: 1, Right: 2 },
    ProgressLocation: { Notification: 15 },
    ConfigurationTarget: { Global: 1 },
    Uri: { file: (p) => ({ fsPath: p }) },
    languages: { setTextDocumentLanguage: async () => {} },
    Position: class { constructor(line, character) { this.line = line; this.character = character; } },
    Range: class { constructor(start, end) { this.start = start; this.end = end; } }
  };
  return { vscode };
}

function loadExtension(stub) {
  const moduleObj = { exports: {} };
  const loader = vm.runInThisContext(
    '(function(require,module,exports,__filename,__dirname){' + fs.readFileSync(filename, 'utf8') + '\n' +
    'module.exports.__test = { parseFileHeaderConfig, parseShellTokens, stripCommentsAndStrings,' +
    ' detectWorkDirDirect, getExtensionVersion, FILE_HEADER_KEYS,' +
    ' };\n})'
  );
  loader(
    (id) => (id === 'vscode' ? stub.vscode : realRequire(id)),
    moduleObj, moduleObj.exports, filename, root
  );
  return moduleObj.exports.__test;
}

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }
function writeSource(name, content) {
  const file = path.join(TEMP_ROOT, name);
  fs.writeFileSync(file, content, 'utf8');
  return file;
}

// ---------------- 1. Windows 命令行解析：反斜杠不能当转义符 ----------------
test('parseShellTokens(win32) 保留反斜杠路径', () => {
  const t = loadExtension(createStub()).parseShellTokens;
  assert.deepStrictEqual(
    t('"C:\\Program Files\\LLVM\\bin\\g++.exe" -O2 "C:\\a b\\main.cpp"', 'win32'),
    ['C:\\Program Files\\LLVM\\bin\\g++.exe', '-O2', 'C:\\a b\\main.cpp'],
    '引号包裹的 Windows 路径应原样保留'
  );
  assert.deepStrictEqual(
    t('g++ C:\\work\\main.cpp -o out.exe', 'win32'),
    ['g++', 'C:\\work\\main.cpp', '-o', 'out.exe'],
    '未加引号的反斜杠路径不应被吃掉'
  );
  assert.deepStrictEqual(
    t('"D:\\x\\" -static', 'win32'),
    ['D:\\x\\', '-static'],
    '结尾反斜杠不应把结束引号转义掉'
  );
});

// ---------------- 2. POSIX 解析保持不变 ----------------
test('parseShellTokens(posix) 行为不变', () => {
  const t = loadExtension(createStub()).parseShellTokens;
  assert.deepStrictEqual(t("g++ 'a b.cpp' -o \"c d.out\"", 'linux'), ['g++', 'a b.cpp', '-o', 'c d.out']);
  assert.deepStrictEqual(t('g++ a\\ b.cpp', 'linux'), ['g++', 'a b.cpp'], 'POSIX 反斜杠转义仍然生效');
  assert.deepStrictEqual(t('echo "a\\"b"', 'linux'), ['echo', 'a"b'], 'POSIX 引号内转义仍然生效');
});

// ---------------- 3. 全局默认值优先于自动探测 ----------------
test('全局 workDirDirectDefaultValue=true 时不被自动探测覆盖', () => {
  const file = writeSource('g1.cpp', ['#include <cstdio>', '#include <fstream>', 'int main(){return 0;}'].join('\n'));
  const cfg = loadExtension(createStub({ workDirDirectDefaultValue: true })).parseFileHeaderConfig(file);
  assert.strictEqual(cfg.workDirDirect, true);
});

test('全局 workDirDirectDefaultValue=false 时不被自动探测覆盖', () => {
  const file = writeSource('g2.cpp', ['#include <fstream>', 'int main(){return 0;}'].join('\n'));
  const cfg = loadExtension(createStub({ workDirDirectDefaultValue: false })).parseFileHeaderConfig(file);
  assert.strictEqual(cfg.workDirDirect, false, '用户显式关掉后，自动探测不应把它改回 true');
});

test('未设置全局默认值时按源码自动探测', () => {
  const fstream = writeSource('a1.cpp', ['#include <fstream>', 'int main(){return 0;}'].join('\n'));
  const plain = writeSource('a2.cpp', ['#include <iostream>', 'int main(){return 0;}'].join('\n'));
  const ext = loadExtension(createStub());
  assert.strictEqual(ext.parseFileHeaderConfig(fstream).workDirDirect, true);
  assert.strictEqual(ext.parseFileHeaderConfig(plain).workDirDirect, false);
});

test('注释与字符串里的 #include 不会误触发自动探测', () => {
  const file = writeSource('a3.cpp', [
    '// #include <fstream>',
    '/* std::ifstream fin; */',
    '#include <iostream>',
    'int main(){ printf("#include <fstream>"); return 0; }'
  ].join('\n'));
  const ext = loadExtension(createStub());
  assert.strictEqual(ext.detectWorkDirDirect(file), false);
  assert.strictEqual(ext.parseFileHeaderConfig(file).workDirDirect, false);
});

// ---------------- 4. 文件头指令优先于全局与探测 ----------------
test('文件头 workDirDirect 指令优先', () => {
  const file = writeSource('h1.cpp', ['// workDirDirect: yes', '#include <iostream>', 'int main(){return 0;}'].join('\n'));
  const ext = loadExtension(createStub({ workDirDirectDefaultValue: false }));
  assert.strictEqual(ext.parseFileHeaderConfig(file).workDirDirect, true);

  const off = writeSource('h2.cpp', ['// workDirDirect: no', '#include <fstream>', 'int main(){return 0;}'].join('\n'));
  const ext2 = loadExtension(createStub({ workDirDirectDefaultValue: true }));
  assert.strictEqual(ext2.parseFileHeaderConfig(off).workDirDirect, false);
});

test('代码行里的 workDirDirect 不会被当成文件头配置', () => {
  const file = writeSource('h3.cpp', [
    '#include <iostream>',
    'int main(){ printf("workDirDirect: yes"); return 0; }'
  ].join('\n'));
  const ext = loadExtension(createStub({ workDirDirectDefaultValue: false }));
  assert.strictEqual(ext.parseFileHeaderConfig(file).workDirDirect, false);
});

// ---------------- 5. 侧边栏保存不能丢掉 workDirDirect ----------------
test('FILE_HEADER_KEYS 收录 workdirdirect', () => {
  const keys = loadExtension(createStub()).FILE_HEADER_KEYS;
  assert.ok(keys.has('workdirdirect'), '缺少 workdirdirect 会导致侧边栏保存的开关在重载后丢失');
});

// ---------------- 6. 模块缓存指纹带版本号 ----------------
test('getExtensionVersion 读取 package.json 版本', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.strictEqual(loadExtension(createStub()).getExtensionVersion(), pkg.version);
});

// ---------------- 7. 直跑参数个数与 helper 约定一致 ----------------
test('helper 参数约定：6 个参数（exe/in/out/workDir/direct）', () => {
  const src = fs.readFileSync(path.join(root, 'tools', 'linux', 'UnFileIO.cpp'), 'utf8');
  assert.ok(/argc == 6/.test(src), 'helper 必须接受 6 个参数，否则直跑拿不到 workDir');
  assert.ok(/argv\[5\]\[0\]\s*==\s*'1'/.test(src), 'helper 应从第 6 个参数读直跑开关');
  assert.ok(/joinWorkDir\(/.test(src), 'helper 应通过 joinWorkDir 处理绝对路径，避免拼成 workDir/abs 这种鬼路径');
});

// ---------------- runner ----------------
(async () => {
  let pass = 0;
  const failures = [];
  for (const { name, fn } of tests) {
    try {
      await fn();
      pass++;
      console.log(`  ✓ ${name}`);
    } catch (err) {
      failures.push({ name, err });
      console.log(`  ✗ ${name}\n      ${err.message}`);
    }
  }
  fs.rmSync(TEMP_ROOT, { recursive: true, force: true });
  console.log(`\nworkdir-tests: ${pass}/${tests.length} 通过`);
  if (failures.length) process.exit(1);
})();
