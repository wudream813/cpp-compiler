// CON 设备及混合模式回归测试（v7.4.3）
const assert = require('assert');
const path = require('path');

// 复用 extension.js 里的 isConsoleDevicePath 逻辑（单独拷贝，避免加载 vscode）
function isConsoleDevicePath(filePath) {
    if (!filePath) return false;
    const p = String(filePath).trim();
    if (!p) return false;
    const lower = p.toLowerCase();
    if (lower === 'con' || lower === 'conin$' || lower === 'conout$' || lower === 'nul' || lower === 'aux' || lower === 'prn') return true;
    if (lower === '/dev/stdin' || lower === '/dev/stdout' || lower === '/dev/stderr' || lower === '/dev/tty' || lower === '/dev/console') return true;
    if (lower.startsWith('/dev/pts/')) return true;
    const base = p.split(/[\/\\]/).pop() || path.basename(p);
    const ext = path.extname(base);
    const nameNoExt = ext ? base.slice(0, -ext.length) : base;
    const nameLower = nameNoExt.toLowerCase();
    const reserved = new Set(['con','conin$','conout$','nul','aux','prn','com1','com2','com3','com4','com5','com6','com7','com8','com9','lpt1','lpt2','lpt3','lpt4','lpt5','lpt6','lpt7','lpt8','lpt9']);
    if (reserved.has(nameLower)) return true;
    const baseLower = base.toLowerCase();
    if (reserved.has(baseLower)) return true;
    return false;
}

function test() {
    // 1. 裸 CON 大小写
    assert.strictEqual(isConsoleDevicePath('CON'), true);
    assert.strictEqual(isConsoleDevicePath('con'), true);
    assert.strictEqual(isConsoleDevicePath('Con'), true);
    // 2. 带路径的 CON
    assert.strictEqual(isConsoleDevicePath('C:\\tmp\\CON'), true);
    assert.strictEqual(isConsoleDevicePath('/tmp/CON'), true);
    assert.strictEqual(isConsoleDevicePath('a/b/CON'), true);
    // 3. CON 带扩展名（Windows 保留名即使带扩展名也视为设备）
    assert.strictEqual(isConsoleDevicePath('CON.txt'), true);
    assert.strictEqual(isConsoleDevicePath('con.in'), true);
    // 4. 其他保留名
    assert.strictEqual(isConsoleDevicePath('NUL'), true);
    assert.strictEqual(isConsoleDevicePath('aux'), true);
    assert.strictEqual(isConsoleDevicePath('COM1'), true);
    assert.strictEqual(isConsoleDevicePath('lpt1'), true);
    // 5. POSIX 设备
    assert.strictEqual(isConsoleDevicePath('/dev/tty'), true);
    assert.strictEqual(isConsoleDevicePath('/dev/stdin'), true);
    assert.strictEqual(isConsoleDevicePath('/dev/pts/0'), true);
    // 6. 普通文件不应误判
    assert.strictEqual(isConsoleDevicePath('input.txt'), false);
    assert.strictEqual(isConsoleDevicePath('myCON.txt'), false); // 前缀含 CON 但不是保留名
    assert.strictEqual(isConsoleDevicePath('concatenated'), false);
    // 7. 混合模式：仅一侧 CON 时，另一侧仍需处理（模拟 buildRunCommand 的分支）
    function shouldHandleUnFile(inFile, outFile) {
        const inCon = isConsoleDevicePath(inFile);
        const outCon = isConsoleDevicePath(outFile);
        if (inCon && outCon) return 'direct';
        if (!inCon && !outCon) return 'both';
        return 'single';
    }
    assert.strictEqual(shouldHandleUnFile('CON', 'out.txt'), 'single');
    assert.strictEqual(shouldHandleUnFile('in.txt', 'CON'), 'single');
    assert.strictEqual(shouldHandleUnFile('CON', 'CON'), 'direct');
    assert.strictEqual(shouldHandleUnFile('in.txt', 'out.txt'), 'both');
    // 8. ChangeFileIO 的 4 文件混合：will 侧 CON 时跳过该侧
    function changeFileNeedsTemp(willIn, willOut) {
        return !isConsoleDevicePath(willIn) || !isConsoleDevicePath(willOut);
    }
    assert.strictEqual(changeFileNeedsTemp('CON', 'CON'), false);
    assert.strictEqual(changeFileNeedsTemp('CON', 'out.txt'), true);
    assert.strictEqual(changeFileNeedsTemp('in.txt', 'CON'), true);

    console.log('con-device tests passed');
}

if (require.main === module) test();
module.exports = { isConsoleDevicePath };

