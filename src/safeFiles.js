'use strict';
const fs = require('fs');

// Open only a regular file and re-check the opened handle, with nonblocking
// open on POSIX to avoid hanging if a path is swapped for a FIFO between checks.
async function openRegularFile(filePath) {
  const before = await fs.promises.stat(filePath);
  if (!before.isFile()) throw new Error('只允许读取普通文件');
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK || 0);
  const handle = await fs.promises.open(filePath, flags);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.dev !== before.dev || stat.ino !== before.ino) {
      throw new Error('文件类型或路径已变化，请重试');
    }
    return { handle, stat };
  } catch (err) {
    await handle.close();
    throw err;
  }
}

async function readRegularPrefix(filePath, maxBytes, rejectOversize = false) {
  const { handle, stat } = await openRegularFile(filePath);
  try {
    if (rejectOversize && stat.size > maxBytes) throw new Error('文件过大，跳过读取');
    const buffer = Buffer.alloc(Math.min(stat.size, maxBytes));
    let position = 0;
    while (position < buffer.length) {
      const { bytesRead } = await handle.read(buffer, position, buffer.length - position, position);
      if (!bytesRead) break;
      position += bytesRead;
    }
    return { stat, text: buffer.subarray(0, position).toString('utf8') };
  } finally {
    await handle.close();
  }
}
module.exports = { openRegularFile, readRegularPrefix };
