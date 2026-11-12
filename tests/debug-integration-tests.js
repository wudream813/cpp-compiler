'use strict';
const assert = require('assert');
const { tokenize, debugFlags } = require('../src/debugIntegration');
assert.deepStrictEqual(tokenize('-std=c++20 -I"folder name" -DNAME="x y" -IC:\\tools'),
  ['-std=c++20', '-Ifolder name', '-DNAME=x y', '-IC:\\tools']);
assert.throws(() => tokenize('-I"unfinished'), /引号/);
assert.throws(() => debugFlags('-I', false), /缺少/);
const result = debugFlags('-O2 -g0 -std=c++20 -I"folder name" -DNAME=3 -L"lib dir" -lm -Wl,--stack=42 @foo -o bad', false);
assert.deepStrictEqual(result.flags, ['-std=c++20', '-Ifolder name', '-DNAME=3', '-g', '-O0']);
assert.deepStrictEqual(result.linkerFlags, ['-Llib dir', '-lm']);
assert.deepStrictEqual(result.ignored, ['-Wl,--stack=42', '@foo', '-o', 'bad']);
assert(debugFlags('', true).flags.includes('-static'));
console.log('compiler debug option tests passed');
