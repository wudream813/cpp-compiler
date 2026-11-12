'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { terminateProcessTree } = require('./cancelProcess');

function hashFile(file) {
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0);
  const fd = fs.openSync(file, flags);
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.nlink !== 1 || st.size > 128 * 1024 * 1024) return null;
    const hash = crypto.createHash('sha256'); const buf = Buffer.allocUnsafe(65536);
    let n; while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) hash.update(buf.subarray(0, n));
    const after = fs.fstatSync(fd), actual = fs.lstatSync(file);
    if (st.dev !== actual.dev || st.ino !== actual.ino || st.size !== after.size || st.mtimeMs !== after.mtimeMs || st.ctimeMs !== after.ctimeMs || actual.isSymbolicLink()) return null;
    return hash.digest('hex');
  } finally { fs.closeSync(fd); }
}
function resolveCompiler(name) {
  const candidates = path.isAbsolute(name) || name.includes('/') || name.includes('\\')
    ? [path.resolve(name)] : (process.env.PATH || '').split(path.delimiter).map(dir => path.join(dir || '.', name));
  if (process.platform === 'win32' && !path.extname(name)) candidates.push(...candidates.map(p => p + '.exe'));
  for (const candidate of candidates) {
    try {
      const real = fs.realpathSync(candidate), st = fs.statSync(real);
      if (!st.isFile()) continue;
      const fd = fs.openSync(real, 'r'), magic = Buffer.alloc(4);
      try { fs.readSync(fd, magic, 0, 4, 0); } finally { fs.closeSync(fd); }
      // Script wrappers can depend on arbitrary external state, so skip caching.
      if (!((magic[0] === 0x7f && magic.toString('ascii', 1) === 'ELF') || (magic[0] === 0x4d && magic[1] === 0x5a) || ['feedfacf', 'cffaedfe', 'cafebabe'].includes(magic.toString('hex')))) return null;
      return { real, st, digest: hashFile(real) };
    } catch (_) {}
  }
  return null;
}
function preprocess(compiler, flags, file, cwd, signal) {
  return new Promise(resolve => {
    if (signal?.aborted) return resolve(null);
    let proc;
    try { proc = spawn(compiler, [...flags, '-E', file], { cwd, env: process.env, detached: process.platform !== 'win32', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }); }
    catch (_) { return resolve(null); }
    const hash = crypto.createHash('sha256'); let size = 0, failed = false;
    const abort = () => { if (failed) return; failed = true; terminateProcessTree(proc); };
    if (signal) signal.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    const timer = setTimeout(abort, 30000); timer.unref();
    proc.stdout.on('data', chunk => { size += chunk.length; if (size > 256 * 1024 * 1024) abort(); else hash.update(chunk); });
    proc.on('error', () => { failed = true; });
    proc.on('close', code => {
      clearTimeout(timer); if (signal) signal.removeEventListener('abort', abort);
      resolve(!failed && code === 0 ? hash.digest('hex') : null);
    });
  });
}
async function fingerprint(request) {
  try {
    if (request.signal?.aborted || request.linkFlags.length || request.flags.includes('-static')) return null;
    const compiler = resolveCompiler(request.compilerPath);
    if (!compiler || !compiler.digest) return null;
    const hash = crypto.createHash('sha256');
    hash.update(JSON.stringify({ source: request.source, compiler: compiler.real, compilerDigest: compiler.digest,
      compilerStat: [compiler.st.dev, compiler.st.ino, compiler.st.size, compiler.st.mtimeMs, compiler.st.ctimeMs],
      flags: request.flags, linkFlags: request.linkFlags, env: Object.entries(process.env).filter(([k]) => k !== 'VSCODE_L10N_BUNDLE_LOCATION').sort(([a], [b]) => a.localeCompare(b)) }));
    for (const file of [request.source, request.helper]) {
      const digest = await preprocess(compiler.real, request.flags, file, path.dirname(request.source), request.signal);
      if (!digest) return null;
      hash.update(digest);
    }
    // Raw source changes must invalidate the build even if preprocessed output
    // happens to be equivalent (for example, changed comments or whitespace).
    const sourceDigest = hashFile(request.source), helperDigest = hashFile(request.helper);
    if (!sourceDigest || !helperDigest) return null;
    hash.update(sourceDigest); hash.update(helperDigest);
    return hash.digest('hex');
  } catch (_) { return null; }
}
class DebugBuildCache {
  constructor(limit = 8) { this.entries = []; this.limit = limit; this.disposed = false; }
  cleanup(entry) {
    entry.retired = true;
    if (!entry.busy) { try { entry.cleanup(); } catch (_) {} this.entries = this.entries.filter(e => e !== entry); }
  }
  borrow(entry, cacheHit) {
    entry.busy = true;
    let released = false;
    return { ...entry.result, cleanupBuild: () => {
      if (released) return true;
      released = true; entry.busy = false;
      if (this.disposed || entry.retired) this.cleanup(entry);
      return true;
    }, integration: { ...entry.result.integration, cacheHit } };
  }
  async acquire(request, compile) {
    const before = await fingerprint(request);
    if (request.signal?.aborted) return { success: false, cancelled: true, diagnostics: [], errors: [], warnings: [] };
    if (before && !this.disposed) {
      for (const entry of this.entries) {
        if (!entry.busy && !entry.retired && entry.key === before) {
          let digest; try { digest = hashFile(entry.result.executable); } catch (_) {}
          if (digest === entry.binaryDigest) return this.borrow(entry, true);
          this.cleanup(entry); // Cleanup itself validates ownership; altered files are retained.
        }
      }
    }
    const result = await compile();
    if (!result.success || typeof result.cleanupBuild !== 'function') return result;
    if (request.signal?.aborted) { result.cleanupBuild(); return { success: false, cancelled: true, diagnostics: [], errors: [], warnings: [] }; }
    const after = before && !this.disposed ? await fingerprint(request) : null;
    if (request.signal?.aborted) { result.cleanupBuild(); return { success: false, cancelled: true, diagnostics: [], errors: [], warnings: [] }; }
    let binaryDigest; try { binaryDigest = hashFile(result.executable); } catch (_) {}
    if (!before || before !== after || !binaryDigest || this.disposed) return result;
    while (this.entries.length >= this.limit) {
      const idle = this.entries.find(e => !e.busy);
      if (!idle) return result;
      this.cleanup(idle);
    }
    const entry = { key: before, result, cleanup: result.cleanupBuild, binaryDigest, busy: false, retired: false };
    this.entries.push(entry);
    return this.borrow(entry, false);
  }
  dispose() { this.disposed = true; for (const entry of [...this.entries]) this.cleanup(entry); }
}
module.exports = { DebugBuildCache, fingerprint, hashFile };
