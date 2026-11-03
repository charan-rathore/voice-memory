// A report laid out like a large Indian chain lab's (tab-separated rows,
// "Bio. Ref. Interval", eGFR with a two-slash unit, a ratio row printed
// without unit or range). Values are synthetic. Each expectation failed on
// PR #49's first head: eGFR not read, a ratio answered as creatinine, a
// "when was this done" answered with a value, a distance-from-limit question
// answered without the distance, a unit trap missed, a condition repaired
// into a test name.
import test from "node:test";
import assert from "node:assert/strict";
import { ingestFile } from "../ingest/index.mjs";
import { extractReport } from "../clinical/observations.mjs";
import { clinicalAnswer, findTest } from "../clinical/answer.mjs";
import { aliasesFor } from "../clinical/explain.mjs";
import {
  labVocabulary,
  repairTestNames,
  selfRepair,
} from "../src/spoken-repair.mjs";
import { adviceKind } from "../src/vernacular.mjs";

const TEXT = [
  "Chain Diagnostics - Reference Lab (synthetic)",
  "Name : SAMPLE PATIENT    Age : 52 Years    Gender : Male",
  "Collected : 14/3/2025 9:10:00AM    Reported : 14/3/2025 6:00:00PM    Report Status : Final",
  "",
  "Test Name    Results    Units    Bio. Ref. Interval",
  "",
  "KIDNEY PANEL, SERUM",
  "Creatinine    1.02    mg/dL    0.67 - 1.17",
  "GFR Estimated    82    mL/min/1.73m2    >59",
  "Urea    31.00    mg/dL    17.00 - 43.00",
  "BUN/Creatinine Ratio    15",
  "Chloride    104.00    mEq/L    101.00 - 109.00",
  "LIPID PROFILE",
  "Cholesterol, Total    231.40    mg/dL    <200.00",
  "LDL Cholesterol, Calculated    148.60    mg/dL    <100.00",
  "HDL Cholesterol    44.10    mg/dL    >40.00",
  "THYROID PROFILE",
  "T3, Total    0.71    ng/mL    0.60 - 1.81",
  "TSH    7.80    µIU/mL    0.35 - 5.50",
  "",
].join("\n");

let reports;
test.before(async () => {
  const r = await ingestFile(Buffer.from(TEXT), "chain-lab.txt");
  reports = [{ title: "chain", sourceId: "s", ...extractReport(r.doc) }];
});

test("eGFR with a two-slash unit is read and found by its spoken names", () => {
  const g = reports[0].observations.find((o) => /GFR/.test(o.test));
  assert.ok(g, "eGFR row extracted");
  assert.equal(g.unit, "mL/min/1.73m2");
  for (const q of [
    "What is the GFR?",
    "egfr kitna hai",
    "what's his estimated GFR",
  ])
    assert.match(findTest(q, reports)?.test ?? "", /GFR/, q);
});

test("a named ratio is never answered with the test inside it", () => {
  const a = clinicalAnswer("What is the BUN creatinine ratio?", reports);
  assert.doesNotMatch(a?.spoken ?? "", /Creatinine result is 1\.02/);
});

test("'when was this test done' gives the report's dates, not a value", () => {
  const a = clinicalAnswer("When was this test done?", reports);
  assert.equal(a.intent, "DATES");
  assert.match(a.spoken, /collected 14 March 2025/);
});

test("distance from the limit is answered first", () => {
  const a = clinicalAnswer("How far above the limit is the LDL?", reports);
  assert.match(
    a.spoken,
    /^It's 48\.60 mg\/dL above the lab's upper limit of 100\.00\./,
  );
  const b = clinicalAnswer("How much below the range is the T3?", reports);
  assert.match(b.spoken, /^It isn't outside the lab's range/);
});

test("milli-units is a unit the lab did not print", () => {
  const a = clinicalAnswer(
    "What is the TSH in milli units per litre?",
    reports,
  );
  assert.equal(a.intent, "UNITS");
  assert.match(a.spoken, /7\.80 µIU\/mL, as the lab printed it/);
});

test("a condition is not repaired into a test; an absent test is not repaired into a present one", () => {
  const vocab = labVocabulary(reports, aliasesFor);
  for (const q of ["Does he have hypothyroidism?", "What is his faratin?"])
    assert.equal(repairTestNames(q, vocab) ?? q, q, q);
  assert.match(
    repairTestNames("what is the creatnine", vocab) ?? "",
    /Creatinine/i,
  );
});

test("spoken self-corrections keep only what the caller settled on", () => {
  assert.equal(
    selfRepair("What is the triglycer, sorry, the HDL?"),
    "What is the HDL?",
  );
  assert.equal(
    selfRepair("How high is the LDL, actually, the VLDL?"),
    "How high is the VLDL?",
  );
  assert.equal(
    selfRepair("kya cholesterol, nahi nahi, sugar kitna hai"),
    "sugar kitna hai",
  );
  const plain = "I am sorry to bother you, what is the TSH?";
  assert.equal(selfRepair(plain), plain);
});

test("third-person treatment and diagnosis questions are recognised", () => {
  assert.equal(adviceKind("Should he start statins?"), "treatment");
  for (const q of [
    "Does he have hypothyroidism?",
    "Is my dad diabetic?",
    "kya unko thyroid ki bimari hai",
  ])
    assert.equal(adviceKind(q), "diagnosis", q);
  assert.equal(adviceKind("What is his TSH?"), null);
});
