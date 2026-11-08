import test from "node:test";
import assert from "node:assert/strict";
import { markUnreadable, extractReport } from "./observations.mjs";
import { explainOne, position } from "./explain.mjs";
import { ingestFile } from "../ingest/index.mjs";
import { readFileSync } from "node:fs";
const row = (extra) => ({
  test: "TSH",
  canon: "tsh",
  raw: "180",
  value: 180,
  unit: "mIU/L",
  unitRaw: "mIU/L",
  range: "0.4-4",
  ref: { lowN: 0.4, highN: 4 },
  source: { method: "ocr", page: 1, confidence: 99 },
  ...extra,
});
test("a reference range cannot invent a decimal or establish unreadability", () => {
  const [o] = markUnreadable([row({})]);
  assert.equal(o.unreadable, undefined);
  assert.equal(o.raw, "180");
  assert.doesNotMatch(explainOne(o, "2026-10-12", "en"), /may really be|1\.8/);
});
test("weak OCR with a corrupted range is withheld before stating a numeric result", () => {
  const [o] = markUnreadable([
    row({
      test: "HbA1c",
      canon: "hba1c",
      raw: "59",
      value: 59,
      unit: "%",
      range: "4.056",
      ref: null,
      source: { method: "ocr", page: 3, confidence: 25 },
    }),
  ]);
  assert.ok(o.unreadable);
  assert.equal(position(o), "unknown");
  assert.doesNotMatch(explainOne(o, "2026-10-12", "en"), /result is 59/);
});
test("every numeric gold row on the mixed scan is exact or explicitly withheld, not confidently misstated", async () => {
  const r = await ingestFile(
    readFileSync(
      new URL("../evaluation/scans/mixed-quality.pdf", import.meta.url),
    ),
    "mixed-quality.pdf",
  );
  assert.ok(r.ok);
  const rep = extractReport(r.doc);
  const gold = JSON.parse(
    readFileSync(new URL("../evaluation/scans/gold.json", import.meta.url)),
  );
  for (const p of Object.values(gold.pages))
    for (const [name, raw] of p.rows) {
      const o = rep.observations.find(
        (x) => x.test.toLowerCase() === name.toLowerCase(),
      );
      assert.ok(o, `${name} must not silently disappear`);
      assert.ok(
        o.raw === raw || o.unreadable,
        `${name} ${o.raw} differs from printed ${raw} without withholding`,
      );
    }
});

test("unreadable lookup is labelled unclear, never a confirmed latest value", async () => {
  const { clinicalAnswer } = await import("./answer.mjs");
  const r = {
    meta: { patient: { id: "RX-1" }, collected: "2026-11-05", status: "final" },
    observations: [
      {
        test: "HbA1c",
        canon: "hba1c",
        key: "hba1c",
        raw: "59",
        value: 59,
        unit: "%",
        unreadable: { reason: "confidence", page: 3 },
        source: {},
      },
    ],
  };
  const a = clinicalAnswer("What is HbA1c for RX-1?", [r]);
  assert.equal(a.verdict, "UNCLEAR");
});
