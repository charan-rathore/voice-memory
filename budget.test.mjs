import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("process-wide document budget refuses uploads beyond it; same bytes are parsed once", async () => {
  process.env.VM_GLOBAL_DOC_MB = "1";
  const L = await import("./library.mjs?b=" + Date.now());
  const a = {},
    b = {};
  const big = Buffer.alloc(700 * 1024, 65);
  L.addUpload(a, big, "a.txt", () => {});
  assert.throws(
    () => L.addUpload(b, big, "b.txt", () => {}),
    (e) => e.status === 503,
  );
  L.libraryOf(a).length = 0; // session evicted
  const pdf = readFileSync(
    new URL("./ingest/fixtures/files/digital.pdf", import.meta.url),
  );
  const s1 = {},
    s2 = {};
  L.addUpload(s1, pdf, "one.pdf", () => {});
  for (
    let i = 0;
    i < 200 &&
    !["ready", "needs_review", "failed"].includes(L.libraryOf(s1)[0].status);
    i++
  )
    await new Promise((r) => setTimeout(r, 100));
  L.addUpload(s2, pdf, "two.pdf", () => {});
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(L.parseCacheStats.hits, 1);
  assert.equal(L.libraryOf(s2)[0].status, L.libraryOf(s1)[0].status);
  assert.equal(L.libraryOf(s2)[0].doc.filename, "two.pdf");
  delete process.env.VM_GLOBAL_DOC_MB;
});
