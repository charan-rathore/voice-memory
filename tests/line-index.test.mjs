import test from "node:test";
import assert from "node:assert/strict";
import { lineOf, lineIndexCacheStats } from "../dist/engine.mjs";

const ref = (text, pos) => text.slice(0, pos).split("\n").length;

test("lineOf matches slice+split for LF, CRLF, lone CR, unicode, empty and trailing newline", () => {
  const texts = [
    "",
    "\n",
    "a",
    "a\n",
    "a\nb\nc",
    "a\r\nb\r\nc",
    "a\rb\rc",
    "héllo\nwörld\n✓",
    "one\n\nthree\n",
  ];
  for (const t of texts)
    for (let pos = 0; pos <= t.length; pos++)
      assert.equal(lineOf(t, pos), ref(t, pos), `${JSON.stringify(t)} @${pos}`);
});

test("line-index cache is bounded by total keyed text size, not only entry count", () => {
  const before = lineIndexCacheStats();
  // One text larger than the whole budget: computed, never cached.
  const huge = ("x".repeat(1000) + "\n").repeat(3000); // ~3.0M chars > 2.8M budget
  assert.equal(lineOf(huge, huge.length), ref(huge, huge.length));
  let s = lineIndexCacheStats();
  assert.ok(s.chars < huge.length, "oversized text was cached");
  // Fill past the budget with cacheable texts: FIFO eviction keeps the
  // total under the budget regardless of the 128-entry cap.
  const doc = ("y".repeat(999) + "\n").repeat(700); // ~700k chars (upload cap)
  for (let i = 0; i < 6; i++) assert.equal(lineOf(doc + i, 0), 1);
  s = lineIndexCacheStats();
  assert.ok(s.chars <= 2_800_000, `byte budget exceeded: ${s.chars}`);
  assert.ok(s.texts <= 128, `entry cap exceeded: ${s.texts}`);
  // Values stay exact for evicted and resident texts alike.
  assert.equal(
    lineOf(doc + "6", (doc + "6").length),
    ref(doc + "6", (doc + "6").length),
  );
});
