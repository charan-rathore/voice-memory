import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("process-wide document budget refuses uploads beyond it; same bytes are parsed once", async () => {
  process.env.VM_GLOBAL_DOC_MB = "1";
  const L = await import("../src/library.mjs?b=" + Date.now());
  const a = {},
    b = {};
  const big = Buffer.alloc(700 * 1024, 65);
  L.addUpload(a, Buffer.alloc(200 * 1024, 65), "a.txt", () => {});
  assert.throws(
    () => L.addUpload(b, big, "b.txt", () => {}),
    (e) => e.status === 503,
  );
  L.libraryOf(a).length = 0; // session evicted
  const pdf = readFileSync(
    new URL("../ingest/fixtures/files/digital.pdf", import.meta.url),
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

test("retained accounting counts original bytes plus parsed text", async () => {
  const L = await import("../src/library.mjs?c=" + Date.now());
  const s = {};
  const raw = Buffer.alloc(100 * 1024, 120); // 100 KB of 'x'
  L.addUpload(s, raw, "notes.txt", () => {});
  for (
    let i = 0;
    i < 200 &&
    !["ready", "needs_review", "failed"].includes(L.libraryOf(s)[0].status);
    i++
  )
    await new Promise((r) => setTimeout(r, 100));
  assert.equal(L.libraryOf(s)[0].status, "ready");
  const textBytes = Buffer.byteLength(L.libraryOf(s)[0].doc.text, "utf8");
  assert.ok(textBytes >= 100 * 1024, "canonical text retained");
  assert.ok(
    L.globalBytes() >= raw.length + textBytes,
    `globalBytes ${L.globalBytes()} must cover original + parsed text (${
      raw.length + textBytes
    })`,
  );
});

test("parse cache is bounded by bytes, not only count", async () => {
  const up = async (L, buf, name) => {
    const s = {};
    L.addUpload(s, Buffer.from(buf), name, () => {});
    for (
      let i = 0;
      i < 200 &&
      !["ready", "needs_review", "failed"].includes(L.libraryOf(s)[0].status);
      i++
    )
      await new Promise((r) => setTimeout(r, 100));
    assert.equal(L.libraryOf(s)[0].status, "ready", name);
  };

  // A result larger than the whole byte cap is never cached.
  process.env.VM_PARSE_CACHE_MB = "0.05"; // 50 KB
  let L = await import("../src/library.mjs?d=" + Date.now());
  const big = Buffer.alloc(200 * 1024, 121);
  await up(L, big, "one.txt");
  await up(L, big, "two.txt");
  assert.ok(L.parseCacheStats.bytes <= 50 * 1024, "cap holds");
  assert.equal(L.parseCacheStats.hits, 0, "oversize result not cached");
  assert.equal(L.parseCacheStats.misses, 2);
  delete process.env.VM_PARSE_CACHE_MB;

  // Byte pressure evicts LRU even under the count cap of 24.
  process.env.VM_PARSE_CACHE_MB = "1";
  L = await import("../src/library.mjs?e=" + Date.now());
  const d1 = Buffer.alloc(200 * 1024, 97);
  const d2 = Buffer.alloc(200 * 1024, 98);
  const d3 = Buffer.alloc(200 * 1024, 99);
  await up(L, d1, "d1.txt");
  await up(L, d2, "d2.txt");
  await up(L, d3, "d3.txt");
  assert.ok(
    L.parseCacheStats.bytes <= 1024 * 1024,
    `cache bytes ${L.parseCacheStats.bytes} exceed the 1 MB cap`,
  );
  assert.ok(L.parseCacheStats.evictions >= 1, "byte pressure evicted LRU");
  const missesBefore = L.parseCacheStats.misses;
  await up(L, d1, "d1-again.txt");
  assert.equal(L.parseCacheStats.misses, missesBefore + 1, "evicted: miss");
  await up(L, d3, "d3-again.txt");
  assert.ok(L.parseCacheStats.hits >= 1, "retained entry still reusable");
  delete process.env.VM_PARSE_CACHE_MB;
});

test("compressed DOCX expanding far beyond 2x raw is accounted at actual size", async () => {
  const { zipSync, strToU8 } = await import("fflate");
  const para = "Quarterly retention review notes and action items. ".repeat(40); // ~2 KB
  const paras = Array.from(
    { length: 60 },
    () => `<w:p><w:r><w:t>${para}</w:t></w:r></w:p>`,
  ).join("");
  const xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paras}</w:body></w:document>`;
  const raw = Buffer.from(
    zipSync({
      "[Content_Types].xml": strToU8(
        `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
      ),
      "word/document.xml": strToU8(xml),
    }),
  );
  const L = await import("../src/library.mjs?f=" + Date.now());
  const s = {};
  L.addUpload(s, raw, "expanded.docx", () => {});
  for (
    let i = 0;
    i < 200 &&
    !["ready", "needs_review", "failed"].includes(L.libraryOf(s)[0].status);
    i++
  )
    await new Promise((r) => setTimeout(r, 100));
  const e = L.libraryOf(s)[0];
  assert.equal(e.status, "ready", JSON.stringify(e.error));
  const textBytes = Buffer.byteLength(e.doc.text, "utf8");
  assert.ok(
    textBytes > raw.length * 10,
    `fixture must actually expand: ${raw.length} -> ${textBytes}`,
  );
  assert.ok(
    L.globalBytes() >= raw.length + textBytes,
    "retained accounting must cover the EXPANDED text, not 2x raw",
  );
});

test("over-budget expanded DOCX fails closed post-parse: not indexed, not cached", async () => {
  const { zipSync, strToU8 } = await import("fflate");
  const para = "Post-parse enforcement probe text, repeated to expand. ".repeat(
    40,
  );
  const paras = Array.from(
    { length: 40 },
    () => `<w:p><w:r><w:t>${para}</w:t></w:r></w:p>`,
  ).join("");
  const xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paras}</w:body></w:document>`;
  const raw = Buffer.from(
    zipSync({
      "[Content_Types].xml": strToU8(
        `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
      ),
      "word/document.xml": strToU8(xml),
    }),
  );
  // Budget fits the raw bytes plus the 2x admission heuristic, but NOT the
  // expanded document: enforcement must happen after parsing.
  const xmlBytes = Buffer.byteLength(xml, "utf8");
  process.env.VM_GLOBAL_DOC_MB = String(
    (raw.length * 2 + xmlBytes * 0.6) / 1048576,
  );
  const L = await import("../src/library.mjs?h=" + Date.now());
  const s = {};
  L.addUpload(s, raw, "expanded.docx", () => {}); // admitted on the heuristic
  for (
    let i = 0;
    i < 200 &&
    !["ready", "needs_review", "failed"].includes(L.libraryOf(s)[0].status);
    i++
  )
    await new Promise((r) => setTimeout(r, 100));
  const e = L.libraryOf(s)[0];
  assert.equal(e.status, "failed", "must fail closed post-parse");
  assert.equal(e.error.code, "budget_exceeded");
  assert.equal(e.original, null, "original freed");
  assert.equal(e.doc, null, "parsed doc freed");
  assert.equal(L.globalBytes(), 0, "nothing retained");
  assert.equal(
    L.parseCacheStats.bytes,
    0,
    "rejected result must NOT enter the parse cache",
  );
  delete process.env.VM_GLOBAL_DOC_MB;
});

test("concurrent uploads admitted on estimates are enforced post-parse with actual sizes", async () => {
  process.env.VM_GLOBAL_DOC_MB = "0.75"; // 768 KB
  const L = await import("../src/library.mjs?g=" + Date.now());
  const a = {},
    b = {};
  const doc = (c) => Buffer.alloc(220 * 1024, c); // 220 KB, under the 250k-char limit
  // Both admitted synchronously: estimates are made before either parse runs.
  L.addUpload(a, doc(120), "a.txt", () => {});
  L.addUpload(b, doc(121), "b.txt", () => {});
  const settle = async (s) => {
    for (
      let i = 0;
      i < 200 &&
      !["ready", "needs_review", "failed"].includes(L.libraryOf(s)[0].status);
      i++
    )
      await new Promise((r) => setTimeout(r, 100));
    return L.libraryOf(s)[0];
  };
  const ea = await settle(a);
  const eb = await settle(b);
  // Under contention the loser is whichever post-parse check trips first
  // (the other's pending original legitimately holds budget). The safety
  // invariant is what matters: exactly one commits, the other fails closed
  // with its bytes freed, and retained bytes stay under the budget.
  const entries = [ea, eb];
  const ready = entries.filter((e) => e.status === "ready");
  const failed = entries.filter((e) => e.status === "failed");
  assert.equal(
    ready.length,
    1,
    `exactly one commits: ${entries.map((e) => e.status)}`,
  );
  assert.equal(failed.length, 1);
  assert.equal(failed[0].error.code, "budget_exceeded");
  assert.equal(failed[0].original, null, "freed original bytes");
  assert.equal(failed[0].doc, null, "freed parsed document");
  const committedBytes = 220 * 1024 + 16 + 220 * 1024; // lower bound: original + text
  assert.ok(L.globalBytes() >= committedBytes, "survivor fully accounted");
  assert.ok(
    L.globalBytes() <= 0.75 * 1024 * 1024,
    `retained ${L.globalBytes()} must stay within the budget`,
  );
  delete process.env.VM_GLOBAL_DOC_MB;
});
