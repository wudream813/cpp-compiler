'use strict';

// Compile options in the compiler UI are a string, not a shell script. Split
// without executing substitutions. Preserve Windows path separators.
function tokenize(value) {
  const tokens = []; let part = '', quote = '', started = false;
  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    if (quote) {
      if (c === quote) { quote = ''; started = true; }
      else if (c === '\\' && i + 1 < value.length && (value[i + 1] === quote || (quote === '"' && value[i + 1] === '\\'))) { part += value[++i]; }
      else part += c;
    } else if (c === '"' || c === "'") { quote = c; started = true; }
    else if (/\s/.test(c)) { if (started) { tokens.push(part); part = ''; started = false; } }
    else if (c === '\\' && i + 1 < value.length && /\s/.test(value[i + 1])) { part += value[++i]; started = true; }
    else { part += c; started = true; }
  }
  if (quote) throw Error('编译选项的引号未闭合，请修正后重试');
  if (started) tokens.push(part);
  return tokens;
}

// Deliberate allowlist: output paths, plugins, response files, linker scripts,
// shell constructs and optimization/debug flags must not take over the build.
function debugFlags(value, useStatic) {
  const tokens = tokenize(String(value || ''));
  const accepted = [], linker = [], ignored = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (['-I', '-isystem', '-iquote', '-include', '-D', '-U', '-L', '-l'].includes(t)) {
      if (i + 1 >= tokens.length || !tokens[i + 1] || tokens[i + 1].startsWith('-')) throw Error(`编译选项 ${t} 缺少参数`);
      (t === '-l' || t === '-L' ? linker : accepted).push(t, tokens[++i]);
    } else if (/^-(?:l[\w+.-]+|L.+)$/.test(t)) linker.push(t);
    else if (/^(?:-std=[\w+.-]+|-D.+|-U.+|-I.+|-L.+|-l[\w+.-]+|-W(?:all|extra|pedantic|error|no-[\w-]+)|-pedantic|-pthread|-f(?:exceptions|no-exceptions|rtti|no-rtti|input-charset=[\w-]+|exec-charset=[\w-]+))$/.test(t)) accepted.push(t);
    else if (/^-O(?:[0-3sgz]|fast)?$/.test(t) || /^-g(?:[0-3]|gdb[0-3]?)?$/.test(t)) { /* replaced */ }
    else ignored.push(t);
  }
  if (useStatic) accepted.push('-static');
  // Last options win for GCC/Clang. These cannot be overridden by UI flags.
  accepted.push('-g', '-O0');
  return { flags: accepted, linkerFlags: linker, ignored };
}
module.exports = { tokenize, debugFlags };
