/**
 * Dream C++ Debugger — Smart C/C++ Compiler & Runner
 * Compiles C/C++ source files with debug symbols (-g -O0), parses GCC/Clang diagnostics,
 * and supports preset text, file-based, and live streaming stdin execution.
 */
'use strict';

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { appendBounded } = require('./outputLimits');
const { openRegularFile } = require('./safeFiles');
const { createBuildLease } = require('./buildCleanup');

const SOURCE_EXTS = new Set(['.cpp', '.cc', '.cxx', '.c++', '.c']);
const DIAG_REGEX = /^(.+?):(\d+):(?:(\d+):)?\s*(fatal error|error|warning|note|致命错误|错误|警告|附注):\s*(.+)$/i;

function isSourceFile(filePath) {
  if (!filePath) return false;
  const ext = path.extname(filePath).toLowerCase();
  return SOURCE_EXTS.has(ext);
}

/**
 * Parse GCC / Clang stderr output into structured diagnostic objects.
 * Strictly separates compile errors ('error') from warnings ('warning') and notes ('info').
 */
function parseCompilerDiagnostics(stderrText, defaultFile = '') {
  const diagnostics = [];
  if (!stderrText) return diagnostics;
  const lines = String(stderrText).split(/\r?\n/);
  for (const line of lines) {
    const m = line.match(DIAG_REGEX);
    if (m) {
      const rawSeverity = m[4].toLowerCase();
      let severity = 'info';
      if (rawSeverity.includes('error') || rawSeverity.includes('错误')) {
        severity = 'error';
      } else if (rawSeverity.includes('warning') || rawSeverity.includes('警告')) {
        severity = 'warning';
      }
      diagnostics.push({
        file: m[1].trim() || defaultFile,
        line: Math.max(1, parseInt(m[2], 10)),
        column: m[3] ? Math.max(1, parseInt(m[3], 10)) : 1,
        severity,
        message: m[5].trim()
      });
    }
  }
  return diagnostics;
}

/**
 * Compile a C/C++ source file with debug symbols for GDB.
 */
function compileSourceFile(sourceFile, options = {}) {
  return new Promise((resolve) => {
    const startTime = Date.now();
    const absSource = path.resolve(sourceFile);
    const sourceDir = path.dirname(absSource);
    const ext = path.extname(absSource).toLowerCase();

    let compiler = options.compilerPath || 'g++';
    if (ext === '.c' && compiler === 'g++') {
      compiler = 'gcc';
    }

    const userFlags = Array.isArray(options.compileFlags)
      ? [...options.compileFlags]
      : ['-g', '-O0', '-std=c++17'];

    // Filter out C++ standard flags when compiling plain C with gcc
    const flags = ext === '.c'
      ? userFlags.filter((f) => !f.startsWith('-std=c++'))
      : userFlags;

    if (!flags.some((f) => f === '-g' || f.startsWith('-g'))) {
      flags.unshift('-g');
    }

    // Each build gets a private, unique directory; never delete or overwrite
    // another file merely because it shares a source-name prefix.
    let outDir;
    try {
      const root = path.join(sourceDir, '.dream-debug');
      fs.mkdirSync(root, { recursive: true });
      outDir = fs.mkdtempSync(path.join(root, 'build-'));
    } catch (_) {
      outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dream-build-'));
    }

    const extSuffix = process.platform === 'win32' ? '.exe' : '.debug.out';
    const outputBinary = path.join(outDir, `program${extSuffix}`);
    const lease = options.autoCleanup ? createBuildLease(outDir, outputBinary) : null;
    let completed = false;
    function complete(result) {
      if (completed) return;
      completed = true;
      if (lease) {
        lease.capture();
        if (result.success) result.cleanupBuild = lease.cleanup;
        else lease.cleanup();
      }
      resolve(result);
    }

    // Add typed mutation helpers only for C++ debug builds explicitly requesting them.
    const helper = options.vectorHelpers && ext !== '.c' ? [path.join(__dirname, 'vectorHelpers.cpp')] : [];
    const args = [...flags, absSource, ...helper, ...(options.linkFlags || []), '-o', outputBinary];
    const commandLine = `${compiler} ${args.map((a) => (a.includes(' ') ? `"${a}"` : a)).join(' ')}`;

    let stdout = '';
    let stderr = '';
    let proc;

    try {
      proc = spawn(compiler, args, {
        cwd: options.cwd || sourceDir,
        env: process.env
      });
    } catch (err) {
      return complete({
        success: false,
        executable: null,
        commandLine,
        stdout: '',
        stderr: err.message,
        durationMs: Date.now() - startTime,
        diagnostics: [{
          file: absSource,
          line: 1,
          column: 1,
          severity: 'error',
          message: `无法启动编译器 "${compiler}": ${err.message}`
        }],
        errors: [{
          file: absSource,
          line: 1,
          column: 1,
          severity: 'error',
          message: `无法启动编译器 "${compiler}": ${err.message}`
        }],
        warnings: []
      });
    }

    proc.stdout.on('data', (chunk) => { stdout = appendBounded(stdout, chunk.toString()); });
    proc.stderr.on('data', (chunk) => { stderr = appendBounded(stderr, chunk.toString()); });

    proc.on('error', (err) => {
      const errItem = {
        file: absSource,
        line: 1,
        column: 1,
        severity: 'error',
        message: `未找到编译器 "${compiler}" (${err.message})，请检查系统 PATH 或设置 dreamCppDebug.compilerPath`
      };
      complete({
        success: false,
        executable: null,
        commandLine,
        stdout,
        stderr: `${stderr}\n${err.message}`.trim(),
        durationMs: Date.now() - startTime,
        diagnostics: [errItem],
        errors: [errItem],
        warnings: []
      });
    });

    proc.on('close', (code) => {
      const diagnostics = parseCompilerDiagnostics(stderr, absSource);
      const errors = diagnostics.filter((d) => d.severity === 'error');
      const warnings = diagnostics.filter((d) => d.severity === 'warning');
      const success = code === 0 && fs.existsSync(outputBinary);
      complete({
        success,
        exitCode: code,
        executable: success ? outputBinary : null,
        commandLine,
        stdout,
        stderr,
        durationMs: Date.now() - startTime,
        diagnostics,
        errors,
        warnings
      });
    });
  });
}

/**
 * Run a compiled binary with support for:
 * - Preset text stdin (`options.stdin`)
 * - File stdin (`options.stdinFile`)
 * - Live streaming stdin (`options.streamMode: true`, exposing `onProcess(proc)` so caller can write chunks & close EOF)
 */
async function runExecutable(executablePath, options = {}) {
  const startTime = Date.now();
  const args = Array.isArray(options.args) ? options.args : [];
  const cwd = options.cwd || path.dirname(executablePath);
  const timeoutMs = options.timeoutMs || (options.streamMode ? 120000 : 15000);
  // Keep the validated handle open: don't re-open a potentially replaced path.
  const input = options.stdinFile ? await openRegularFile(options.stdinFile) : null;
  let inputStream;
  try {
    return await new Promise((resolve) => {
      let stdout = '', stderr = '';
      let killedByTimeout = false, cancelled = false, settled = false;
      let fallbackTimer = null;
      const proc = spawn(executablePath, args, {
        cwd, env: process.env, detached: process.platform !== 'win32', windowsHide: true,
        ...(options.outputCapture ? { stdio: ['pipe', options.outputCapture.fd, options.outputCapture.fd] } : {})
      });

      function finish(code, signal, error) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearTimeout(fallbackTimer);
        if (inputStream) inputStream.destroy();
        // Descendants that escaped the process group can retain the pipes.
        // Destroy our endpoints so completion itself is bounded.
        proc.stdin?.destroy();
        proc.stdout?.destroy();
        proc.stderr?.destroy();
        resolve({ exitCode: code, signal, stdout,
          stderr: error ? `${stderr}\n${error.message}`.trim() : stderr,
          durationMs: Date.now() - startTime, killedByTimeout, cancelled });
      }
      function killTree() {
        if (!proc.pid) return;
        if (process.platform === 'win32') {
          // taskkill /T must run before killing the parent, to discover its tree.
          const taskkill = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe');
          try {
            const killer = spawn(taskkill, ['/PID', String(proc.pid), '/T', '/F'],
              { windowsHide: true, stdio: 'ignore' });
            killer.on('error', () => { try { proc.kill('SIGKILL'); } catch (_) {} });
          } catch (_) { try { proc.kill('SIGKILL'); } catch (__) {} }
        } else {
          try { process.kill(-proc.pid, 'SIGKILL'); }
          catch (_) { try { proc.kill('SIGKILL'); } catch (__) {} }
        }
      }
      function terminate(reason) {
        if (settled) return;
        if (reason === 'timeout') killedByTimeout = true;
        if (reason === 'cancel') cancelled = true;
        killTree();
        if (!fallbackTimer) fallbackTimer = setTimeout(() => {
          try { proc.kill('SIGKILL'); } catch (_) {}
          finish(proc.exitCode, proc.signalCode || 'SIGKILL');
        }, 1000);
      }
      const timer = setTimeout(() => terminate('timeout'), timeoutMs);

      proc.stdout?.on('data', chunk => {
        if (settled) return;
        const text = chunk.toString();
        stdout = appendBounded(stdout, text);
        if (typeof options.onOutput === 'function') options.onOutput(text, stdout, 'stdout');
      });
      proc.stderr?.on('data', chunk => {
        if (settled) return;
        const text = chunk.toString();
        stderr = appendBounded(stderr, text);
        if (typeof options.onOutput === 'function') options.onOutput(text, stdout + (stderr ? `\n[stderr]\n${stderr}` : ''), 'stderr');
      });
      proc.stdin.on('error', () => {});
      proc.on('error', err => finish(-1, null, err));
      proc.on('exit', () => {
        // The leader can exit while descendants keep stdout/stderr open.
        // On Unix terminate the remaining group; on all platforms bound the wait.
        if (settled) return;
        if (process.platform !== 'win32' && proc.pid) {
          try { process.kill(-proc.pid, 'SIGKILL'); } catch (_) {}
        }
        if (!fallbackTimer) fallbackTimer = setTimeout(() => finish(proc.exitCode, proc.signalCode), 1000);
      });
      proc.on('close', (code, signal) => finish(code, signal));
      if (typeof options.onProcess === 'function') options.onProcess(proc, () => terminate('cancel'));

      if (input) {
        inputStream = fs.createReadStream(null, { fd: input.handle.fd, autoClose: false });
        inputStream.on('error', () => { try { proc.stdin.end(); } catch (_) {} });
        inputStream.pipe(proc.stdin);
      } else if (options.streamMode) {
        if (typeof options.stdin === 'string' && options.stdin.length > 0) {
          proc.stdin.write(options.stdin.endsWith('\n') ? options.stdin : `${options.stdin}\n`);
        }
      } else {
        if (typeof options.stdin === 'string' && options.stdin.length > 0) {
          proc.stdin.write(options.stdin.endsWith('\n') ? options.stdin : `${options.stdin}\n`);
        }
        proc.stdin.end();
      }
    });
  } finally {
    if (input) await input.handle.close().catch(() => {});
  }
}

module.exports = {
  isSourceFile,
  parseCompilerDiagnostics,
  compileSourceFile,
  runExecutable
};
