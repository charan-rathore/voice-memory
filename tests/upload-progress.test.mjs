// Upload progress record regressions (the "Watch it read" view's data):
//  - every status log event carries the SAME timestamp as its entry in
//    `timings` (two Date.now() calls can straddle a millisecond; the
//    reading view replays the log only up to the final timing and would
//    cut the terminal event, freezing mid-read on a settled document)
//  - a parse-cache hit re-stamps page states WITH their OCR facts, so the
//    view never renders "undefined%".
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createLocalServer } from "../src/server.mjs";

process.env.VM_COUNTERS_ALLOW_FILE = "on";

const MIXED = readFileSync(
  new URL("../ingest/fixtures/files/mixed.pdf", import.meta.url),
);

const srv = createLocalServer({ port: 0 });
let base;
before(async () => {
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${srv.address().port}`;
});
after(() => new Promise((r) => srv.close(r)));

async function upload(ws, name) {
  const r = await fetch(`${base}/api/public/workspace/${ws.id}/upload`, {
    method: "POST",
    headers: {
      "x-file-name": name,
      "content-type": "application/octet-stream",
    },
    body: MIXED,
  });
  assert.equal(r.status, 202);
  return (await r.json()).document;
}

async function settle(ws, want) {
  for (let i = 0; i < 400; i++) {
    const st = await (
      await fetch(`${base}/api/public/workspace/${ws.id}`)
    ).json();
    const d = st.documents.find((x) => x.id === want);
    if (d && ["ready", "needs_review", "failed"].includes(d.status)) return d;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("upload did not settle");
}

test("status log events and timings share one clock reading", async () => {
  const ws = await (
    await fetch(base + "/api/public/workspace", { method: "POST" })
  ).json();
  const first = await upload(ws, "mixed.pdf");
  await settle(ws, first.id);

  // Adversarial clock: every Date.now() call advances a millisecond, so any
  // pair of readings that must be equal lands on different values.
  const realNow = Date.now;
  let t = realNow();
  Date.now = () => (t += 1);
  let second;
  try {
    second = await upload(ws, "mixed-again.pdf");
    second = await settle(ws, second.id);
  } finally {
    Date.now = realNow;
  }
  const byStatus = new Map(
    second.progress.log
      .filter((e) => e.k === "status")
      .map((e) => [e.status, e.t]),
  );
  for (const [status, at] of Object.entries(second.timings))
    assert.equal(
      byStatus.get(status),
      at,
      `log event for "${status}" must carry timings.${status}`,
    );
});

test("a cached re-reading re-stamps OCR page facts (no undefined confidence)", async () => {
  const ws = await (
    await fetch(base + "/api/public/workspace", { method: "POST" })
  ).json();
  const first = await upload(ws, "mixed.pdf");
  const settled1 = await settle(ws, first.id);
  const scanned = settled1.progress.pages.find((p) => p.state === "ocr-done");
  assert.ok(scanned, "fixture has an OCR'd page");

  const second = await upload(ws, "mixed-again.pdf");
  const settled2 = await settle(ws, second.id);
  assert.ok(
    settled2.progress.log.some((e) => e.k === "cache"),
    "second upload reused the cached parse",
  );
  const p2 = settled2.progress.pages.find((p) => p.state === "ocr-done");
  assert.ok(p2, "cached re-reading keeps the OCR page state");
  assert.equal(
    typeof p2.confidence,
    "number",
    "confidence carried, not undefined",
  );
  assert.equal(p2.confidence, scanned.confidence);
  assert.equal(typeof p2.uncertain, "number");
});
