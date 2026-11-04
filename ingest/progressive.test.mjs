// Progressive ingestion: a PDF's text pages are readable before its scanned
// pages are OCR'd, progress is reported without document text, and an OCR
// overrun keeps the pages that were read instead of discarding the file.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parsePdf } from "./pdf.mjs";
import { shutdownOcr } from "./ocr.mjs";
import { ingestFile } from "./index.mjs";

const file = (f) =>
  readFileSync(new URL("./fixtures/files/" + f, import.meta.url));
// mixed.pdf: digital.pdf p1, scanned.pdf p1, digital.pdf p2 (pypdf merge).
const MIXED = file("mixed.pdf");

test.after(() => shutdownOcr());

test("text pages are handed over before the scanned page is OCR'd", async () => {
  const order = [];
  let partial = null;
  const final = await parsePdf(MIXED, {
    onEvent: (e) => order.push(e.k),
    onPartial: (p) => {
      order.push("PARTIAL");
      partial = p;
    },
  });
  assert.ok(partial, "partial result delivered");
  assert.ok(
    order.indexOf("PARTIAL") < order.indexOf("ocr-start"),
    `partial precedes OCR: ${order.join(",")}`,
  );
  assert.equal(partial.pages[1].textSource, "none");
  assert.equal(partial.pages[1].ocrPending, true);
  assert.ok(
    partial.warnings.some((w) => w.code === "ocr_pending" && w.page === 2),
  );
  assert.ok(partial.blocks.every((b) => b.method !== "ocr"));
  // The final result is the full reading; its text-layer blocks are the
  // same ones the partial result carried.
  assert.equal(final.pages[1].textSource, "ocr");
  assert.equal(final.pages[1].ocrPending, undefined);
  assert.ok(final.warnings.every((w) => w.code !== "ocr_pending"));
  assert.deepEqual(
    final.blocks.filter((b) => b.method !== "ocr"),
    partial.blocks,
  );
});

test("a PDF without scans (or without text) gets no partial result", async () => {
  let calls = 0;
  await parsePdf(file("digital.pdf"), { onPartial: () => calls++ });
  await parsePdf(file("scanned.pdf"), { onPartial: () => calls++ });
  assert.equal(calls, 0);
});

test("progress events carry page numbers and counts, never document text", async () => {
  const events = [];
  const r = await parsePdf(MIXED, { onEvent: (e) => events.push(e) });
  const kinds = new Set(events.map((e) => e.k));
  for (const k of ["open", "text", "scan", "ocr-start", "ocr", "ocr-done"])
    assert.ok(kinds.has(k), `has ${k}`);
  const words = new Set(
    r.blocks
      .flatMap((b) => (b.text ?? "").split(/\W+/))
      .filter((w) => w.length > 3),
  );
  for (const e of events)
    for (const [key, v] of Object.entries(e)) {
      if (key === "k") continue;
      assert.equal(
        typeof v,
        typeof v === "boolean" ? "boolean" : "number",
        `${e.k}.${key} is not text`,
      );
    }
  assert.ok(words.size > 5);
  const pct = events.filter((e) => e.k === "ocr").map((e) => e.p);
  assert.deepEqual(
    pct,
    [...pct].sort((a, b) => a - b),
    "OCR percentage only rises",
  );
});

test("ingestFile reports the partial result and the events through the worker", async () => {
  const events = [];
  let partial = null;
  const r = await ingestFile(MIXED, "mixed.pdf", {
    onEvent: (e) => events.push(e.k),
    onPartial: (p) => (partial = p),
  });
  assert.equal(r.ok, true);
  assert.equal(r.status, "ready");
  assert.equal(partial.status, "ready");
  assert.equal(partial.doc.stats.ocrPages, 0);
  assert.equal(r.doc.stats.ocrPages, 1);
  assert.ok(events.includes("ocr-done"));
});

test("an OCR overrun keeps the text pages, marks the scan unread and holds for review", async () => {
  // Time out after the text pages arrived and before OCR finished. The
  // window is measured on this machine first, then retried a few times,
  // because the partial result must exist for the salvage to apply.
  let r;
  for (
    let attempt = 0;
    attempt < 4 && r?.status !== "needs_review";
    attempt++
  ) {
    const t0 = Date.now();
    let partialAt = null;
    const probe = await ingestFile(MIXED, "mixed.pdf", {
      onPartial: () => (partialAt = Date.now() - t0),
    });
    const total = Date.now() - t0;
    assert.equal(probe.ok, true);
    const timeoutMs = Math.round(partialAt + (total - partialAt) / 3);
    const events = [];
    r = await ingestFile(MIXED, "mixed.pdf", {
      timeoutMs,
      onEvent: (e) => events.push(e.k),
    });
    if (r.ok && r.status === "needs_review")
      assert.ok(events.includes("salvaged"));
  }
  assert.equal(r.ok, true, "the file is kept, not discarded");
  assert.equal(r.status, "needs_review");
  const unread = r.doc.warnings.find((w) => w.code === "no_text_layer");
  assert.equal(unread?.page, 2);
  assert.match(
    unread.message,
    /scanned image .* not read\. The other pages were\./,
  );
  assert.ok(r.review.some((m) => /Page 2/.test(m)));
  assert.ok(r.doc.warnings.every((w) => w.code !== "ocr_pending"));
  assert.ok(r.doc.text.length > 100, "text pages are present");
});

test("a timeout before any page was read still fails cleanly", async () => {
  const r = await ingestFile(MIXED, "mixed.pdf", { timeoutMs: 1 });
  assert.equal(r.ok, false);
  assert.equal(r.code, "timeout");
});

test("files read in parallel take turns at OCR, never OCR at the same time", async () => {
  const t0 = Date.now();
  const spans = [[], []];
  const waited = [false, false];
  const run = (i) =>
    ingestFile(MIXED, `mixed-${i}.pdf`, {
      onEvent: (e) => {
        if (e.k === "ocr-wait") waited[i] = true;
        if (e.k === "ocr-start") spans[i].push(Date.now() - t0);
        if (e.k === "ocr-done") spans[i].push(Date.now() - t0);
      },
    });
  const [a, b] = await Promise.all([run(0), run(1)]);
  assert.equal(a.ok && b.ok, true);
  assert.deepEqual(waited, [true, true], "both asked for the OCR turn");
  const [[s0, e0], [s1, e1]] = spans;
  assert.ok(
    e0 <= s1 || e1 <= s0,
    `OCR intervals overlap: ${spans.join(" | ")}`,
  );
});
