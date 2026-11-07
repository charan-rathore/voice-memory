// Repeated-image regression: a PDF that paints ONE image object on several
// pages (a legitimate pattern from scan tools reusing a page background)
// must OCR every page, not only the first. pdf.js promotes reused image
// objects to commonObjs; reading only page.objs missed them behind a 10s
// per-page timeout and silently dropped those pages to needs_review.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PDFDocument } from "pdf-lib";
import { ingestFile } from "./index.mjs";
import { shutdownOcr } from "./ocr.mjs";

const IMG = readFileSync(new URL("./fixtures/files/printed.jpg", import.meta.url));

async function buildPdf(shared) {
  const doc = await PDFDocument.create();
  const sharedImg = shared ? await doc.embedJpg(IMG) : null;
  for (let p = 0; p < 3; p++) {
    const img = sharedImg ?? (await doc.embedJpg(IMG));
    const page = doc.addPage([612, 792]);
    page.drawImage(img, { x: 36, y: 120, width: 540, height: 640 });
  }
  return Buffer.from(await doc.save());
}

test.after(() => shutdownOcr());

test("one image object painted on several pages: every page is OCR'd", async () => {
  const r = await ingestFile(await buildPdf(true), "shared-image.pdf", {});
  assert.ok(r.ok, `ingest failed: ${r.code ?? ""} ${r.message ?? ""}`);
  assert.equal(r.status, "ready");
  const unread = (r.doc.warnings ?? []).filter((w) => w.code === "no_text_layer");
  assert.deepEqual(unread.map((w) => w.page), [], `pages left unread: ${unread.map((w) => w.page)}`);
  const occurrences = r.doc.text.split("Clinic").length - 1;
  assert.ok(occurrences >= 3, `expected the printed page text on all 3 pages, found ${occurrences}`);
});

test("shared-image and distinct-embed builds produce identical canonical text", async () => {
  const [a, b] = await Promise.all([
    buildPdf(true).then((bytes) => ingestFile(bytes, "shared.pdf", {})),
    buildPdf(false).then((bytes) => ingestFile(bytes, "distinct.pdf", {})),
  ]);
  assert.ok(a.ok && b.ok);
  assert.equal(a.status, b.status);
  assert.equal(a.doc.text, b.doc.text);
});
