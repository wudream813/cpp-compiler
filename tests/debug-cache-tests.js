'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DebugBuildCache } = require('../src/debugCache');
const { compileSourceFile } = require('../src/compiler');
async function run() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dream-cache-'));
  const source = path.join(dir, 'main.cpp'), header = path.join(dir, 'value.hpp');
  const helper = path.resolve(__dirname, '../src/vectorHelpers.cpp');
  fs.writeFileSync(header, '#define RESULT 1\n');
  fs.writeFileSync(source, '#include "value.hpp"\nint main() { return RESULT - 1; }\n');
  const cache = new DebugBuildCache(); let count = 0;
  const request = { source, helper, compilerPath: 'g++', flags: ['-std=c++17','-g','-O0'], linkFlags: [] };
  const compile = async () => { count++; return compileSourceFile(source, { compilerPath: request.compilerPath, compileFlags: request.flags, vectorHelpers: true, autoCleanup: true }); };
  try {
    let first = await cache.acquire(request, compile); assert(first.success); assert.strictEqual(first.integration.cacheHit, false);
    const firstExe = first.executable; assert(first.cleanupBuild()); assert(fs.existsSync(firstExe));
    let hit = await cache.acquire(request, compile); assert.strictEqual(hit.integration.cacheHit, true); assert.strictEqual(hit.executable, firstExe); assert.strictEqual(count, 1);
    // An active session cannot share the same binary with a concurrent build.
    const concurrent = await cache.acquire(request, compile); assert(concurrent.success); assert.notStrictEqual(concurrent.executable, hit.executable); assert.strictEqual(count, 2);
    concurrent.cleanupBuild(); hit.cleanupBuild();
    fs.writeFileSync(header, '#define RESULT 2\n');
    const changed = await cache.acquire(request, compile); assert(changed.success); assert.notStrictEqual(changed.executable, firstExe); assert.strictEqual(count, 3); changed.cleanupBuild();
    fs.appendFileSync(source, '// changed\n');
    const changedSource = await cache.acquire(request, compile); assert(changedSource.success); assert.strictEqual(count, 4); changedSource.cleanupBuild();
    // Modified user files are not used or removed, even if a cache key matches.
    fs.appendFileSync(changedSource.executable, 'changed by user');
    const replaced = await cache.acquire(request, compile); assert(replaced.success); assert.strictEqual(count, 5); assert(fs.existsSync(changedSource.executable));
    const liveExe = replaced.executable;
    cache.dispose(); assert(fs.existsSync(liveExe), 'active build retained on shutdown');
    replaced.cleanupBuild(); assert(!fs.existsSync(liveExe), 'retired build cleaned after release');
    assert(fs.existsSync(changedSource.executable), 'modified executable preserved');
    assert(!fs.existsSync(firstExe), 'idle cache cleaned on shutdown');

    if (process.platform !== 'win32') {
      const fakeCompiler = path.join(dir, 'slow compiler');
      fs.writeFileSync(fakeCompiler, '#!/bin/sh\nsleep 20\n'); fs.chmodSync(fakeCompiler, 0o700);
      const abort = new AbortController();
      const pending = compileSourceFile(source, { compilerPath: fakeCompiler, autoCleanup: true, signal: abort.signal });
      setTimeout(() => abort.abort(), 150);
      const cancelled = await pending; assert(cancelled.cancelled && !cancelled.success);
      assert.deepStrictEqual(cancelled.errors, []);
    }
    console.log('debug smart cache and compiler cancellation tests passed');
  } finally { cache.dispose(); fs.rmSync(dir, { recursive: true, force: true }); }
}
run().catch(err => { console.error(err); process.exitCode = 1; });
