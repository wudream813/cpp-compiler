'use strict';
// Bound retained text. Keep the newest output and mark truncation visibly.
const MAX_OUTPUT_CHARS = 1024 * 1024;
const TRUNCATED = '[较早输出已截断]\n';
function appendBounded(current, text, limit = MAX_OUTPUT_CHARS) {
  current = String(current || '');
  text = String(text || '');
  const hadTruncation = current.startsWith(TRUNCATED);
  if (hadTruncation) current = current.slice(TRUNCATED.length);
  if (!hadTruncation && current.length + text.length <= limit) return current + text;
  const keep = Math.max(0, limit - TRUNCATED.length);
  return keep ? TRUNCATED + (current + text).slice(-keep) : TRUNCATED.slice(0, limit);
}
module.exports = { MAX_OUTPUT_CHARS, appendBounded };
