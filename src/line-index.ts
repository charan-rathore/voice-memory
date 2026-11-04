/** 1-based line numbers without O(docsize) rescans per span.
 * lineOf(text, pos) === text.slice(0, pos).split("\n").length for every pos,
 * computed from a bounded cache of line-start offset tables.
 * Memory is bounded by BOTH entry count and total keyed text size: the
 * budget is 4x the server's own 700,000-byte upload cap (src/server.mjs
 * "Upload too large."), counted in UTF-16 code units (text.length), not
 * bytes, so a handful of largest-possible documents stays resident; a
 * single text larger than the whole budget is computed but never cached.
 * Eviction is FIFO insertion order, on insert only.
 */
const MAX_TEXTS = 128;
const MAX_CACHE_CHARS = 4 * 700_000;
const STARTS = new Map<string, number[]>();
let cachedChars = 0;

function lineStarts(text: string): number[] {
  let starts = STARTS.get(text);
  if (!starts) {
    starts = [0];
    for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1))
      starts.push(i + 1);
    if (text.length <= MAX_CACHE_CHARS) {
      while (
        STARTS.size >= MAX_TEXTS ||
        cachedChars + text.length > MAX_CACHE_CHARS
      ) {
        const oldest = STARTS.keys().next();
        if (oldest.done) break;
        cachedChars -= oldest.value.length;
        STARTS.delete(oldest.value);
      }
      STARTS.set(text, starts);
      cachedChars += text.length;
    }
  }
  return starts;
}

/** 1-based line containing offset pos (pos may be text.length). */
export function lineOf(text: string, pos: number): number {
  const starts = lineStarts(text);
  let lo = 0;
  let hi = starts.length; // count of starts <= pos
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (starts[mid] <= pos) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Cache occupancy, for tests and diagnostics. */
export function lineIndexCacheStats(): { texts: number; chars: number } {
  return { texts: STARTS.size, chars: cachedChars };
}
