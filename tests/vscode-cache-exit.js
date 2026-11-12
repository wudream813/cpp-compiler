'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vscode = require('vscode');
exports.run = async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dream-cache-close-'));
  const source = path.join(root, 'main.cpp');
  fs.writeFileSync(source, 'int main() { return 0; }\n');
  const api = await vscode.extensions.getExtension('wudream.dream-cpp-compiler').activate();
  const first = await api.compileForDebug(source);
  assert(first.success); first.cleanupBuild(); assert(fs.existsSync(first.executable));
  const next = await api.compileForDebug(source);
  assert(next.integration.cacheHit); next.cleanupBuild();
  fs.writeFileSync(process.env.DREAM_CACHE_EXE_FILE, first.executable);
  console.log('REAL_VSCODE_CACHE_PRE_EXIT_PASS');
};
