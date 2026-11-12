'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// A lease is created only for a directory just created by this process. We
// never scan for old build-* directories or recursively remove their contents.
function createBuildLease(directory, executable) {
  const parent = path.dirname(directory);
  const marker = path.join(directory, '.dream-owned-build');
  const secret = crypto.randomBytes(24).toString('hex');
  const same = (a, b) => a.dev === b.dev && a.ino === b.ino;
  let parentStat, dirStat, markerStat, binaryStat = null, captured = false, finished = false;
  try {
    parentStat = fs.lstatSync(parent);
    dirStat = fs.lstatSync(directory);
    if (!parentStat.isDirectory() || parentStat.isSymbolicLink() || !dirStat.isDirectory() || dirStat.isSymbolicLink() || path.dirname(executable) !== directory) return null;
    fs.writeFileSync(marker, secret, { flag: 'wx', mode: 0o600 });
    markerStat = fs.lstatSync(marker);
  } catch (_) { return null; }

  function validOwner() {
    try {
      const p = fs.lstatSync(parent), d = fs.lstatSync(directory), m = fs.lstatSync(marker);
      if (!p.isDirectory() || p.isSymbolicLink() || !same(p, parentStat) ||
          !d.isDirectory() || d.isSymbolicLink() || !same(d, dirStat) ||
          !m.isFile() || m.isSymbolicLink() || !same(m, markerStat) || m.size !== secret.length) return false;
      // Re-check an opened handle; nonblocking prevents FIFO swaps hanging us.
      const flags = fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK || 0) | (fs.constants.O_NOFOLLOW || 0);
      const fd = fs.openSync(marker, flags);
      try {
        const actual = fs.fstatSync(fd);
        if (!actual.isFile() || !same(actual, markerStat) || actual.size !== secret.length) return false;
        const data = Buffer.alloc(secret.length);
        return fs.readSync(fd, data, 0, data.length, 0) === data.length && data.toString('utf8') === secret;
      } finally { fs.closeSync(fd); }
    } catch (_) { return false; }
  }

  function capture() {
    if (captured) return;
    captured = true;
    if (!validOwner()) return;
    try {
      const st = fs.lstatSync(executable);
      if (st.isFile() && !st.isSymbolicLink() && st.nlink === 1) binaryStat = st;
    } catch (_) {}
  }

  function cleanup() {
    if (finished || !captured || !validOwner()) return false;
    try {
      if (binaryStat) {
        let st;
        try { st = fs.lstatSync(executable); } catch (err) { if (err.code !== 'ENOENT') throw err; }
        if (st) {
          // Leave replaced or modified files alone, even in our own directory.
          if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1 || !same(st, binaryStat) || st.size !== binaryStat.size || st.mtimeMs !== binaryStat.mtimeMs || st.ctimeMs !== binaryStat.ctimeMs) return false;
          fs.unlinkSync(executable);
        }
      } else if (fs.existsSync(executable)) {
        return false;
      }
      fs.unlinkSync(marker);
      finished = true;
      // Only an empty directory is removed; never remove files the user added.
      try { fs.rmdirSync(directory); } catch (err) { if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(err.code)) throw err; }
      return true;
    } catch (_) { return false; }
  }
  return { capture, cleanup };
}
// GDB may be killed while its inferior survives. Never unlink an executable
// while that process is alive (or if its identity is uncertain). A reused PID
// or an inaccessible process errs on the side of leaving the artifact behind.
function releaseWhenSafe(cleanup, tracker, attempts = 120) {
  function check(remaining) {
    if (tracker.launchAttempted && !tracker.exited) {
      if (!Number.isSafeInteger(tracker.pid) || tracker.pid <= 0) return;
      try { process.kill(tracker.pid, 0); }
      catch (err) {
        if (err.code === 'ESRCH') return invoke(remaining);
      }
      if (remaining > 0) { const timer = setTimeout(() => check(remaining - 1), 1000); timer.unref(); }
      return;
    }
    invoke(remaining);
  }
  function invoke(remaining) {
    let result;
    try { result = cleanup(); } catch (_) { result = false; }
    if (result === false && remaining > 0) { const timer = setTimeout(() => check(remaining - 1), 1000); timer.unref(); }
  }
  check(attempts);
}
module.exports = { createBuildLease, releaseWhenSafe };
