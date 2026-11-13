'use strict';
// 回归测试：覆盖 7.4.2 修复的 8 个问题（第二轮审计）。
// 运行：node tests/audit2-tests.js
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

const TEMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'dream-audit2-'));
const noopDisposable = () => ({ dispose() {} });
const outputChannel = () => ({
  appendLine() {}, append() {}, show() {}, clear() {}, dispose() {},
  info() {}, warn() {}, error() {}
});

function createStub(settings = {}) {
  const posted = [];
  const vscode = {
    extensions: { getExtension: () => undefined, onDidChange: noopDisposable },
    window: {
      activeTextEditor: undefined,
      createOutputChannel: outputChannel,
      createStatusBarItem: () => ({ show() {}, hide() {}, dispose() {}, text: '' }),
      createTerminal: () => ({ name: 'dream-cpp-compiler:运行', sendText() {}, show() {}, dispose() {} }),
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
        inspect: (section) => ({ globalValue: settings[section] }),
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
  return { vscode, posted };
}

function loadExtension(stub) {
  const moduleObj = { exports: {} };
  const loader = vm.runInThisContext(
    '(function(require,module,exports,__filename,__dirname){' + fs.readFileSync(filename, 'utf8') + '\n' +
    'module.exports.__test = { parseFileHeaderConfig, updateCppConfigInEditor, buildTerminalCommandLinux,' +
    ' isTempCodeDir, getStaticOption, cleanupTempCodeRoot, getTempCodeRoot, CppCompilerSidebarProvider,' +
    ' getFileConfig };\n})'
  );
  loader(
    (id) => (id === 'vscode' ? stub.vscode : realRequire(id)),
    moduleObj, moduleObj.exports, filename, root
  );
  return moduleObj.exports;
}

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }
function writeSource(name, content) {
  const file = path.join(TEMP_ROOT, name);
  fs.writeFileSync(file, content, 'utf8');
  return file;
}

// ---------------- 1. 普通代码行不再被当成文件头配置 ----------------
test('普通代码行不再劫持文件头配置', () => {
  const ext = loadExtension(createStub());
  const file = writeSource('hijack.cpp', [
    '#include <cstdio>',
    'int main() {',
    '    printf("workdir: /tmp/hijacked");',
    '    printf("outputPath: /tmp/evil.exe");',
    '    printf("compileoptions: -O9");',
    '    printf("inputfile: evil.in");',
    '}',
  ].join('\n'));
  const cfg = ext.__test.parseFileHeaderConfig(file);
  assert.strictEqual(cfg.WorkDir, '<cppDir>', 'printf 里的字符串不应改写 WorkDir');
  assert.strictEqual(cfg.outputPath, '<cppDir>/<baseName>', 'printf 里的字符串不应改写 outputPath');
  assert.strictEqual(cfg.inputFile, 'hijack.in', 'printf 里的字符串不应改写 inputFile');
  assert.ok(!String(cfg.compileOptions).includes('-O9'), 'printf 里的字符串不应改写 compileOptions');
});

// ---------------- 2. 合法注释配置仍然生效（// 与块注释） ----------------
test('注释形式的文件头配置仍然生效', () => {
  const ext = loadExtension(createStub());
  const file = writeSource('header.cpp', [
    '// compileOptions: -O3 -Wall',
    '/* outputPath: <cppDir>/bin/<baseName> */',
    '/*',
    ' * workdir: <cppDir>/run',
    ' * useFileRedirect: yes',
    ' */',
    'int main(){return 0;}',
  ].join('\n'));
  const cfg = ext.__test.parseFileHeaderConfig(file);
  assert.strictEqual(cfg.compileOptions, '-O3 -Wall');
  assert.strictEqual(cfg.outputPath, '<cppDir>/bin/<baseName>');
  assert.strictEqual(cfg.WorkDir, '<cppDir>/run', '块注释续行应能解析');
  assert.strictEqual(cfg.useFileRedirect, true);
});

// ---------------- 3. 保存设置不改写代码行 ----------------
test('保存设置不改写普通代码行', async () => {
  const ext = loadExtension(createStub());
  const lines = ['#include <cstdio>', 'int main() {', '    printf("workdir: /tmp/x");', '}'];
  const edits = [];
  const document = {
    lineCount: lines.length,
    lineAt: (i) => ({ text: lines[i], range: { end: { line: i, character: lines[i].length } } })
  };
  const editor = {
    document,
    edit: (cb) => {
      cb({
        replace: (range, text) => edits.push({ kind: 'replace', line: range.start.line, text }),
        insert: (pos, text) => edits.push({ kind: 'insert', line: pos.line, text })
      });
      return Promise.resolve(true);
    }
  };
  await ext.__test.updateCppConfigInEditor(editor, { workdir: '/tmp/NEW' });

  const replaced = edits.filter((e) => e.kind === 'replace');
  assert.strictEqual(replaced.length, 0, '不应就地改写代码行，实际：' + JSON.stringify(replaced));
  const inserted = edits.find((e) => e.kind === 'insert');
  assert.ok(inserted && /\/\/\s*workdir:/.test(inserted.text), '应以注释形式插入新配置，实际：' + JSON.stringify(edits));
});

// ---------------- 4. 改写块注释配置不会吃掉 */ ----------------
test('改写块注释配置不会破坏 */', async () => {
  const ext = loadExtension(createStub());
  const line = '/* outputPath: <cppDir>/<baseName> */';
  const lines = [line, 'int main(){}'];
  const edits = [];
  const document = {
    lineCount: lines.length,
    lineAt: (i) => ({ text: lines[i], range: { end: { line: i, character: lines[i].length } } })
  };
  const editor = {
    document,
    edit: (cb) => { cb({ replace: (range, text) => edits.push({ range, text }), insert: () => {} }); return Promise.resolve(true); }
  };
  await ext.__test.updateCppConfigInEditor(editor, { outputPath: '/tmp/a.out' });

  assert.strictEqual(edits.length, 1);
  assert.strictEqual(edits[0].range.start.character, line.indexOf(':') + 1, '应从冒号后开始替换');
  assert.strictEqual(edits[0].range.end.character, line.indexOf(' */'), '替换范围应止于 */ 之前');
});

// ---------------- 5. Linux 外部终端命令不被空格拆断 ----------------
test('Linux 外部终端命令在含空格路径下完整', async () => {
  const ext = loadExtension(createStub());
  const projDir = path.join(TEMP_ROOT, 'my proj');
  const exe = path.join(projDir, 'hello world');
  const cdCommand = `cd "${projDir}"`;
  const runCommand = `"${exe}" < "hello world.in" > "hello world.out"; echo`;
  const command = await ext.__test.buildTerminalCommandLinux(exe, cdCommand, runCommand);

  // 交给真实的 sh 解析这条命令行，看 bash -c 最终收到什么脚本
  const argv = cp.execFileSync('sh', ['-c', `printf '%s\\0' ${command}`], { encoding: 'utf8' }).split('\0');
  const idx = argv.indexOf('-c');
  assert.ok(idx > 0, '应能解析出 bash -c，实际参数：' + JSON.stringify(argv));
  const script = argv[idx + 1];
  assert.ok(script.includes(exe), 'bash -c 应收到完整可执行文件路径，实际：' + JSON.stringify(script));
  assert.ok(script.includes('hello world.in'), '输入重定向应完整');
  assert.ok(script.includes('按任意键退出'), '退出提示应保留');
});

// ---------------- 6. 取消「临时文件」不会删除工作目录 ----------------
test('取消临时文件不会删除工作目录', async () => {
  const victim = fs.mkdtempSync(path.join(TEMP_ROOT, 'proj-'));
  fs.writeFileSync(path.join(victim, 'main.cpp'), 'int main(){}');
  fs.writeFileSync(path.join(victim, '作业.docx'), 'x');

  const stub = createStub();
  const ext = loadExtension(stub);

  let handler = null;
  const view = {
    visible: true,
    webview: {
      options: {}, html: '',
      postMessage: () => Promise.resolve(),
      onDidReceiveMessage: (fn) => { handler = fn; return noopDisposable(); }
    },
    onDidChangeVisibility: noopDisposable,
    onDidDispose: noopDisposable
  };
  const provider = new ext.__test.CppCompilerSidebarProvider({ extensionUri: { fsPath: root }, subscriptions: [] });
  provider.resolveWebviewView(view);
  assert.strictEqual(typeof handler, 'function', '应注册 webview 消息处理函数');

  // 场景：勾选框残留勾选状态 → 取消勾选当前文件，而该文件从未创建过临时目录
  const filePath = path.join(victim, 'main.cpp');
  await handler({ type: 'toggleTempFile', enabled: false, filePath, tempDir: victim });

  assert.ok(fs.existsSync(victim), '工作目录必须仍然存在');
  assert.ok(fs.existsSync(path.join(victim, '作业.docx')), '用户文件必须仍然存在');
});

// ---------------- 7. 扩展自己的临时目录判定 ----------------
test('临时目录判定只认扩展自己的目录', () => {
  const ext = loadExtension(createStub());
  const I = ext.__test;
  const tempDir = path.join(I.getTempCodeRoot(), `${Date.now()}-abc123`);
  fs.mkdirSync(tempDir, { recursive: true });
  fs.writeFileSync(path.join(tempDir, 'code.cpp'), 'int main(){}');

  assert.strictEqual(I.isTempCodeDir(tempDir), true, '应识别为扩展临时目录');
  assert.strictEqual(I.isTempCodeDir(os.tmpdir()), false, '系统临时目录根不算');
  assert.strictEqual(I.isTempCodeDir(path.join(tempDir, '..', '..', '..')), false, '上级目录不算');
  assert.strictEqual(I.isTempCodeDir(TEMP_ROOT), false, '用户工程目录不算');
  assert.strictEqual(I.isTempCodeDir(''), false);
  assert.strictEqual(I.isTempCodeDir(undefined), false);
});

// ---------------- 8. 临时目录超限只删最旧的 ----------------
test('临时目录超限只删最旧的', () => {
  const ext = loadExtension(createStub({ maxTempCodes: 3 }));
  const I = ext.__test;
  const tempRoot = I.getTempCodeRoot();
  fs.rmSync(tempRoot, { recursive: true, force: true });

  const now = Date.now();
  const names = [];
  for (let i = 0; i < 6; i++) {
    const name = `${now - (6 - i) * 1000}-r${i}`;
    names.push(name);
    fs.mkdirSync(path.join(tempRoot, name), { recursive: true });
  }
  I.cleanupTempCodeRoot();

  const left = fs.readdirSync(tempRoot).filter((n) => fs.statSync(path.join(tempRoot, n)).isDirectory());
  assert.strictEqual(left.length, 3, '应只保留 maxTempCodes 个，实际：' + left.join(','));
  for (const name of names.slice(3)) {
    assert.ok(left.includes(name), `最新的 ${name} 应被保留`);
  }
});

// ---------------- 9. staticOption 允许为空 ----------------
test('staticOption 允许设成空字符串', () => {
  const empty = loadExtension(createStub({ staticOption: '' }));
  assert.strictEqual(empty.__test.getStaticOption(), '', '空字符串应原样返回，不再被 || 兜底吃掉');
  const unset = loadExtension(createStub());
  assert.strictEqual(unset.__test.getStaticOption(), '-static', '未设置时应回退 -static');
});

// ---------------- 10. useStaticDefaultValue 已声明并生效 ----------------
test('useStaticDefaultValue 已声明并生效', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8').replace(/^\uFEFF/, ''));
  const cfg = pkg.contributes.configuration;
  const list = Array.isArray(cfg) ? cfg : [cfg];
  const keys = new Set();
  for (const p of list) for (const k of Object.keys(p.properties || {})) keys.add(k);
  assert.ok(keys.has('dream-cpp-compiler.useStaticDefaultValue'), 'package.json 应声明该设置');

  const ext = loadExtension(createStub({ useStaticDefaultValue: true }));
  const file = writeSource('static.cpp', 'int main(){}');
  assert.strictEqual(ext.__test.parseFileHeaderConfig(file).useStaticLinking, true,
    '设置成 true 后默认配置应启用静态链接');
});

// ---------------- 11. 勾选状态随文件下发 ----------------
test('临时文件勾选状态随文件下发', () => {
  const src = fs.readFileSync(filename, 'utf8');
  assert.ok(/useTempFile:\s*useTempFile/.test(src), 'updateConfig 应下发 useTempFile 状态');
  assert.ok(/getElementById\('useTempFile'\)\.checked\s*=\s*useTempFile/.test(src),
    'webview 应恢复「以临时文件编译运行」勾选框');
});

(async () => {
  let failed = 0;
  for (const t of tests) {
    try {
      await t.fn();
      console.log('  ✓ ' + t.name);
    } catch (e) {
      failed++;
      console.log('  ✗ ' + t.name + '\n      ' + e.message);
    }
  }
  fs.rmSync(TEMP_ROOT, { recursive: true, force: true });
  if (failed) {
    console.log(`\n${failed} 项失败`);
    process.exit(1);
  }
  console.log('\n第二轮审计回归测试全部通过');
})();
