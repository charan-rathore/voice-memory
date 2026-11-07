import test from "node:test";
import assert from "node:assert/strict";
import * as canon from "./canonical.mjs";
import { parseBuffer, PIPELINE_VERSION } from "./parse.mjs";
import { replaceWithText, libraryOf } from "../src/library.mjs";
test("legacy canonical docs remain explicitly unavailable, never upgraded by inspection", () => {
  const d = {
    schema: "vm.document/1",
    text: "Patient ID: 0001",
    elements: [{ id: "e1", indexed: true, start: 0, end: 16 }],
  };
  const before = JSON.stringify(d);
  const c = canon.sourceLineCapability(d);
  assert.equal(c.schema, "vm.source-lines/1");
  assert.equal(c.state, "unavailable");
  assert.equal(c.authority, false);
  assert.equal(JSON.stringify(d), before);
});
test("mixed mapped and missing blocks declare partial coverage without complete authority", () => {
  const d = canon.buildDocument({
    blocks: [
      {
        type: "paragraph",
        text: "Exact line",
        page: 1,
        method: "pdf-text",
        sourceLines: [{ rawText: "Exact line" }],
      },
      {
        type: "paragraph",
        text: "No line metadata",
        page: 1,
        method: "pdf-text",
      },
    ],
    kind: "pdf",
    mime: "application/pdf",
    filename: "test.pdf",
    bytes: Buffer.from("x"),
    parser: {},
    pages: [{ number: 1 }],
  });
  const c = d.sourceLineMetadata;
  assert.equal(c.state, "partial");
  assert.equal(c.indexedBlocks, 2);
  assert.equal(c.capturedIndexedBlocks, 1);
  assert.equal(c.mappedLines, 1);
  assert.equal(c.authority, false);
});
test("pipeline/cache namespace changes together and text replacement is current", async () => {
  assert.notEqual(PIPELINE_VERSION, "vm-ingest/runtime-2");
  const v = await import("./version.mjs");
  assert.equal(v.PIPELINE_VERSION, PIPELINE_VERSION);
  const bytes = Buffer.from("Same bytes must not share old cache namespace.");
  assert.notEqual(
    v.parseCacheKey(bytes, "test.txt", "vm-ingest/runtime-2"),
    v.parseCacheKey(bytes, "test.txt"),
  );
  assert.notEqual(
    v.parseCacheKey(bytes, "test.txt"),
    v.parseCacheKey(bytes, "test.pdf"),
  );
  const r = await parseBuffer(bytes, "test.txt");
  assert.equal(r.doc.parser.pipeline, PIPELINE_VERSION);
  const s = {};
  replaceWithText(s, [{ title: "test.txt", text: bytes.toString() }]);
  assert.equal(libraryOf(s)[0].doc.parser.pipeline, PIPELINE_VERSION);
  assert.equal(libraryOf(s)[0].doc.sourceLineMetadata.state, "unavailable");
});

test("old restored snapshots retain absent capability and old pipeline, rather than false upgrade", async () => {
  const { restoreInto } = await import("../memory/store.mjs");
  const doc = {
    schema: "vm.document/1",
    text: "old text",
    parser: { pipeline: "vm-ingest/runtime-2" },
    elements: [{ id: "e1", indexed: true, start: 0, end: 8 }],
  };
  const s = {};
  assert.ok(
    restoreInto(s, {
      v: 1,
      library: [{ doc, original: Buffer.from("old text").toString("base64") }],
    }),
  );
  assert.equal(s.library[0].doc.sourceLineMetadata, undefined);
  assert.equal(s.library[0].doc.parser.pipeline, "vm-ingest/runtime-2");
  assert.equal(
    canon.sourceLineCapability(s.library[0].doc).state,
    "unavailable",
  );
});

test("document view surfaces explicit legacy absence without changing stored doc", async () => {
  const { documentView } = await import("../src/library.mjs");
  const d = {
    text: "old",
    elements: [],
    parser: { pipeline: "vm-ingest/runtime-2" },
  };
  const v = documentView({ id: "old", doc: d, status: "ready" });
  assert.equal(v.sourceLineMetadata.state, "unavailable");
  assert.equal(d.sourceLineMetadata, undefined);
});

test("real mixed PDF partial and final results both retain optional capability, not completeness", async () => {
  const { readFileSync } = await import("node:fs");
  const { shutdownOcr } = await import("./ocr.mjs");
  const partials = [];
  try {
    const r = await parseBuffer(
      readFileSync(new URL("./fixtures/files/mixed.pdf", import.meta.url)),
      "mixed.pdf",
      { onPartial: (p) => partials.push(p) },
    );
    assert.ok(partials.length);
    for (const p of [...partials, r]) {
      assert.equal(p.doc.parser.pipeline, PIPELINE_VERSION);
      assert.equal(p.doc.sourceLineMetadata.schema, "vm.source-lines/1");
      assert.equal(p.doc.sourceLineMetadata.state, "partial");
      assert.equal(p.doc.sourceLineMetadata.authority, false);
    }
    assert.ok(partials[0].doc.pages.some((p) => p.ocrPending));
    assert.ok(!r.doc.pages.some((p) => p.ocrPending));
  } finally {
    await shutdownOcr();
  }
});

test("real parser cache keeps metadata and isolates clones across sessions", async () => {
  const { readFileSync } = await import("node:fs");
  const L = await import("../src/library.mjs");
  const bytes = readFileSync(
    new URL("./fixtures/files/digital.pdf", import.meta.url),
  );
  const settle = async (s, name) => {
    const e = L.addUpload(s, bytes, name, () => {});
    for (
      let i = 0;
      i < 200 && !["ready", "needs_review", "failed"].includes(e.status);
      i++
    )
      await new Promise((r) => setTimeout(r, 30));
    assert.equal(e.status, "ready");
    return e;
  };
  const a = await settle({}, "contract-a.pdf");
  const hits = L.parseCacheStats.hits;
  const b = await settle({}, "contract-b.pdf");
  assert.equal(L.parseCacheStats.hits, hits + 1);
  assert.deepEqual(b.doc.sourceLineMetadata, a.doc.sourceLineMetadata);
  assert.equal(b.doc.parser.pipeline, PIPELINE_VERSION);
  const raw = b.doc.elements[0].sourceLines[0].rawText;
  a.doc.elements[0].sourceLines[0].rawText = "mutated synthetic owner";
  assert.equal(b.doc.elements[0].sourceLines[0].rawText, raw);
});
