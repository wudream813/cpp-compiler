'use strict';
const assert = require('assert');
const vscode = require('vscode');
exports.run = async () => {
  const expected = process.env.DREAM_DEBUGGER_EXPECTED === '1';
  const compiler = vscode.extensions.getExtension('wudream.dream-cpp-compiler');
  assert(compiler, 'compiler must be installed');
  await compiler.activate();
  const present = !!vscode.extensions.getExtension('wudream.dream-cpp-debuger');
  assert.strictEqual(present, expected, 'getExtension reflects whether debugger is installed/enabled');
  await vscode.commands.executeCommand('workbench.view.extension.dream-cpp-compiler-sidebar');
  await new Promise(resolve => setTimeout(resolve, 500));
  console.log('REAL_VSCODE_DEBUGGER_' + (expected ? 'AVAILABLE' : 'UNAVAILABLE') + '_PASS');
};
