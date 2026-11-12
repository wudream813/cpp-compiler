'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createRequire } = require('module');
const { JSDOM, VirtualConsole } = require('jsdom');
const root = path.join(__dirname, '..'), filename = path.join(root, 'extension.js');
const realRequire = createRequire(filename);
let available = false;
const noOpDisposable = () => ({ dispose() {} });
const vscode = {
  extensions: { getExtension: () => available ? {} : undefined },
  window: { activeTextEditor: undefined, createOutputChannel: () => ({}), onDidChangeActiveTextEditor: noOpDisposable },
  workspace: { getConfiguration: () => ({ inspect: () => ({}) }), onDidChangeConfiguration: noOpDisposable }
};
const moduleObj = { exports: {} };
vm.runInThisContext('(function(require,module,exports,__filename,__dirname){' + fs.readFileSync(filename, 'utf8') + '\nmodule.exports.ProviderForTest = CppCompilerSidebarProvider;\n})')(
  id => id === 'vscode' ? vscode : realRequire(id), moduleObj, moduleObj.exports, filename, root);
const provider = new moduleObj.exports.ProviderForTest({ subscriptions: [], extensionUri: {} });
const outgoing = [], fromWebview = [], errors = [];
const vc = new VirtualConsole(); vc.on('jsdomError', e => errors.push(e));
const dom = new JSDOM(provider._getHtmlForWebview(), {
  runScripts: 'dangerously', virtualConsole: vc,
  beforeParse(window) { window.acquireVsCodeApi = () => ({ postMessage: message => fromWebview.push(message) }); }
});
const button = dom.window.document.getElementById('startDebug');
assert(button.hidden, 'button hidden before first message');
assert.strictEqual(dom.window.getComputedStyle(button).display, 'none', 'custom button CSS must not override hidden');
assert(fromWebview.some(m => m.type === 'webviewReady'));
let onMessage;
const view = { webview: { postMessage: m => outgoing.push(m), onDidReceiveMessage: f => { onMessage = f; } }, onDidChangeVisibility: noOpDisposable };
provider.resolveWebviewView(view);
function sync() {
  const msg = outgoing.filter(m => m.type === 'updateButtonStates').at(-1);
  dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data: msg }));
}
sync(); assert(button.hidden);
const doc = (scheme, file) => ({ document: { languageId: 'cpp', uri: { scheme, fsPath: file, toString: () => 'test' } } });
vscode.window.activeTextEditor = doc('file', '/tmp/example.cpp');
available = true; provider.updateButtonStates(); sync();
assert(!button.hidden && !button.disabled, 'installed debugger enables local C++');
vscode.window.activeTextEditor = doc('untitled', '/tmp/example.cpp'); provider.updateButtonStates(); sync();
assert(!button.hidden && button.disabled, 'temporary/virtual documents cannot be debugged through entry');
vscode.window.activeTextEditor = doc('file', '/tmp/example.h'); provider.updateButtonStates(); sync();
assert(button.disabled, 'unsupported local file remains disabled');
available = false; provider.updateButtonStates(); sync(); assert(button.hidden, 'disabling/uninstalling hides button');
assert.strictEqual(typeof onMessage, 'function');
assert.deepStrictEqual(errors, []);
const manifest = require('../package.json');
assert.strictEqual(manifest.contributes.menus.commandPalette.find(x => x.command === 'dream-cpp-compiler.startDebug').when, 'dreamCppCompiler.debuggerAvailable');
dom.window.close();
console.log('debug button visibility and webview tests passed');
