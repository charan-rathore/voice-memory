// Scanned lab reports: what a scan can and cannot vouch for.
//
// evaluation/scans/mixed-quality.pdf (fictional, built by build.py/build.mjs)
// has a digital page 1, a clean 300-dpi scan on page 2 and a tilted,
// blurred, low-contrast phone photo on page 3. Before this change, page 2's
// header was merged into its first row, Ferritin and HbA1c were lost, the
// tilted page lost its ranges, and the blurred page's TSH 6.8 was answered
// as "68" (OCR word confidence 94%).
//
// OCR engines differ between this machine and CI, so the real-document test
// asserts invariants; the exact rules have deterministic unit tests below.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ingestFile } from "../ingest/index.mjs";
import { extractReport, markUnreadable } from "./observations.mjs";
import { clinicalAnswer } from "./answer.mjs";
import { ocrFixName, canonOf, position } from "./explain.mjs";

const PDF = readFileSync(
  new URL("../evaluation/scans/mixed-quality.pdf", import.meta.url),
);
let cached;
async function report() {
  if (cached) return cached;
  const r = await ingestFile(PDF, "mixed-quality.pdf");
  assert.equal(r.ok, true, r.message);
  cached = {
    r,
    rep: { title: "mixed-quality.pdf", sourceId: "m", ...extractReport(r.doc) },
  };
  return cached;
}
const find = (rep, canon) => rep.observations.find((o) => o.canon === canon);

test("every printed test is found, on its page, with its method", async () => {
  const { rep } = await report();
  for (const [canon, page] of [
    ["creatinine", 1],
    ["urea", 1],
    ["ldl", 1],
    ["hemoglobin", 2],
    ["ferritin", 2],
    ["tsh", 3],
    ["hba1c", 3],
  ]) {
    const o = find(rep, canon);
    assert.ok(o, `${canon} found`);
    assert.equal(o.source.page, page, `${canon} page`);
    assert.equal(
      o.source.method === "ocr" || o.source.confidence != null,
      page > 1,
      `${canon}: scanned pages carry OCR provenance, the digital page none`,
    );
  }
});

test("the digital page and the clean scan read exactly as printed", async () => {
  const { rep } = await report();
  const want = {
    creatinine: ["1.1", "mg/dL", "0.7-1.3"],
    urea: ["31", "mg/dL", "7-20"],
    ldl: ["162", "mg/dL", "0-100"],
    hemoglobin: ["11.4", "g/dL", "12.0-15.5"],
    ferritin: ["18", "ng/mL", "15-150"],
  };
  for (const [canon, [raw, unit, range]] of Object.entries(want)) {
    const o = find(rep, canon);
    assert.equal(o.raw, raw, `${canon} value`);
    assert.equal(o.unit, unit, `${canon} unit`);
    assert.equal(o.range, range, `${canon} range (header row never merged in)`);
    assert.equal(o.unreadable, undefined, `${canon} readable`);
  }
});

test("a blurred value is read right or called unclear, never misstated", async () => {
  const { rep } = await report();
  const tsh = find(rep, "tsh");
  if (tsh.raw === "6.8")
    assert.ok(!tsh.unreadable || tsh.unreadable.reason === "confidence");
  else {
    assert.ok(tsh.unreadable, `TSH read as ${tsh.raw} must be marked unclear`);
    assert.equal(position(tsh), "unknown", "never judged against the range");
  }
  const a = clinicalAnswer("What is the TSH?", [rep]).spoken;
  assert.doesNotMatch(a, /Your TSH result is 68\b/);
  if (tsh.unreadable)
    assert.match(a, /Page 3 prints TSH, but the scan is too unclear/);
  const s = clinicalAnswer("What are the abnormal results?", [rep]).spoken;
  assert.doesNotMatch(s, /TSH 68 /, "the summary never lists a misread value");
});

test("OCR warnings name the page they are about", async () => {
  const { r } = await report();
  for (const w of r.doc.warnings.filter((w) => /^ocr_/.test(w.code)))
    assert.ok(Number.isInteger(w.page), `${w.code} names its page`);
  assert.ok(
    !r.doc.warnings.some(
      (w) => w.code === "ocr_low_confidence" && w.page === 1,
    ),
    "the digital page is never called a weak scan",
  );
});

// ---- deterministic rules ----------------------------------------------

const ocr = (o) => ({
  qual: null,
  comparator: null,
  source: { method: "ocr", page: 3, confidence: 90 },
  ...o,
});

test("a reference range never supplies an alternate decimal to a high-confidence reading", () => {
  const [a, b, c, d] = markUnreadable([
    ocr({
      test: "TSH",
      raw: "68",
      value: 68,
      unit: "mIU/L",
      ref: { lowN: 0.4, highN: 4 },
    }),
    ocr({
      test: "TSH",
      raw: "6.8",
      value: 6.8,
      unit: "mIU/L",
      ref: { lowN: 0.4, highN: 4 },
    }),
    ocr({
      test: "Urea",
      raw: "31",
      value: 31,
      unit: "mg/dL",
      ref: { lowN: 7, highN: 20 },
    }),
    // the same reading from a digital page is the lab's own text: trusted
    {
      ...ocr({
        test: "TSH",
        raw: "68",
        value: 68,
        unit: "mIU/L",
        ref: { lowN: 0.4, highN: 4 },
      }),
      source: { method: "pdf-text", page: 1, confidence: null },
    },
  ]);
  assert.equal(
    a.unreadable,
    undefined,
    "range plausibility is not source-reading evidence",
  );
  assert.equal(b.unreadable, undefined);
  assert.equal(
    c.unreadable,
    undefined,
    "high but plausible is a result, not a misread",
  );
  assert.equal(d.unreadable, undefined);
});

test("unit check: a unit no lab prints marks the row unclear", () => {
  const rows = markUnreadable(
    [
      "miv/t",
      "ng/mb",
      "mIU/L",
      "µmol/L",
      "10*3/uL",
      "%",
      "g/dL",
      "mL/min/1.73 m2",
    ].map((unit) => ocr({ test: "X", raw: "5", value: 5, unit, ref: null })),
  );
  assert.deepEqual(
    rows.map((o) => o.unreadable?.reason ?? null),
    ["unit", "unit", null, null, null, null, null, null],
  );
});

test("OCR letter/digit confusions are fixed only inside known test names", () => {
  assert.equal(ocrFixName("HbAlc"), "HbA1c");
  assert.equal(canonOf("HbAlc"), "hba1c");
  assert.equal(ocrFixName("Vitamin Bl2"), "Vitamin B12");
  for (const plain of ["Iron", "Total Bilirubin", "Calcium", "Ferritin"])
    assert.equal(ocrFixName(plain), plain, `${plain} unchanged`);
});
