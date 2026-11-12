'use strict';
const path = require('path');
const { spawn } = require('child_process');

// Children inherit the compiler process group on Unix. On Windows taskkill /T
// discovers children before killing the parent. Wait for close before cleanup.
function terminateProcessTree(proc) {
  if (!proc || !proc.pid) return;
  if (process.platform === 'win32') {
    try {
      const taskkill = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe');
      const killer = spawn(taskkill, ['/PID', String(proc.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      killer.on('error', () => { try { proc.kill(); } catch (_) {} });
    } catch (_) { try { proc.kill(); } catch (_) {} }
  } else {
    try { process.kill(-proc.pid, 'SIGKILL'); }
    catch (_) { try { proc.kill('SIGKILL'); } catch (_) {} }
  }
}
module.exports = { terminateProcessTree };
