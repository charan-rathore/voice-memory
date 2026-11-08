// Transcript repair against the documents' own vocabulary (the custom
// dictionary idea from dictation apps such as OpenWhispr).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ingestFile } from "../ingest/index.mjs";
import { extractReport } from "../clinical/observations.mjs";
import {
  vocabularyOf,
  repairRecordTerms,
  dictionaryOf,
} from "../src/transcript-fix.mjs";

let vocab;
async function v() {
  if (vocab) return vocab;
  const reps = [];
  for (const f of ["a-2026-09.pdf", "a-2026-10-amended.pdf", "c-2026-10.pdf"]) {
    const bytes = readFileSync(
      new URL("../clinical/fixtures/files/" + f, import.meta.url),
    );
    const r = await ingestFile(bytes, f);
    reps.push({ title: f, ...extractReport(r.doc) });
  }
  return (vocab = vocabularyOf(reps));
}

test("names a recogniser mangles are repaired from the reports", async () => {
  const cases = [
    ["what is my creating in level", "what is my Creatinine level"],
    ["is the tea s h normal", "is the TSH normal"],
    ["what about h b a one c", "what about HbA1c"],
    ["show s y n zero zero zero one ferriting", "show SYN-0001 Ferritin"],
    ["kya mera ferriting badha", "kya mera Ferritin badha"],
    ["what is syn double zero zero three tsh", "what is SYN-0003 tsh"],
    [
      "what is the creati nine for SYN 0001",
      "what is the Creatinine for SYN-0001",
    ],
  ];
  for (const [heard, want] of cases)
    assert.equal(repairRecordTerms(heard, await v()).text, want, heard);
});

test("every repair is reported, so the screen can show what was understood", async () => {
  const r = repairRecordTerms("is the tea s h normal", await v());
  assert.deepEqual(r.fixes, [{ heard: "tea s h", as: "TSH" }]);
});

test("numbers, ordinary words and correct terms are never rewritten", async () => {
  for (const q of [
    "has hemoglobin changed",
    "what is the creating report",
    "i am treating it",
    "what is the 42 value",
    "is it in range",
  ]) {
    const r = repairRecordTerms(q, await v());
    assert.equal(r.text, q, q);
    assert.deepEqual(r.fixes, [], q);
  }
});

test("a patient id is repaired only to an id in the reports, digit for digit", async () => {
  // SYN-0009 is in no report: left exactly as heard, never "corrected"
  // to SYN-0001 or SYN-0003 (that would read someone else's results).
  const q = "what is s y n zero zero zero nine";
  assert.equal(repairRecordTerms(q, await v()).text, q);
});

test("the same vocabulary exports as a dictation dictionary", async () => {
  const lines = dictionaryOf(await v()).split("\n");
  for (const t of [
    "SYN-0001",
    "SYN-0003",
    "Creatinine",
    "TSH",
    "HbA1c",
    "Ferritin",
  ])
    assert.ok(lines.includes(t), t);
  assert.equal(new Set(lines).size, lines.length, "no duplicates");
});
