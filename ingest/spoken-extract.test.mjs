import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { importBundle, answer } from "../dist/engine.mjs";
import { ingestFile } from "./index.mjs";
import { extractiveSpoken, isQuestion } from "../spoken-extract.mjs";
import { spokenTurn } from "../spoken.mjs";

const fx = (f) =>
  readFileSync(new URL("./fixtures/files/" + f, import.meta.url));
async function bundleOf(file, title) {
  const r = await ingestFile(fx(file), title);
  assert.equal(r.ok, true);
  return importBundle([{ title, text: r.doc.text }]);
}
const say = (q, b) => extractiveSpoken(q, answer(q, b), b)?.spoken ?? null;

test("a lab row is spoken with its headers and the comparator as a word", async () => {
  const b = await bundleOf("lab-table.pdf", "lab-report.pdf");
  const s = say("What was the TSH result?", b);
  assert.ok(s, "a grounded row is spoken");
  assert.match(
    s,
    /^TSH: result less than 0\.05, unit mIU\/L, reference range 0\.40-4\.00, flag L\./,
  );
  assert.match(s, /That's from lab report\./);
  assert.doesNotMatch(s, /\|/, "no table syntax read aloud");
});

test("adjacent-row values never swap: creatinine 1.2 vs urea 12", async () => {
  const b = await bundleOf("lab-table.pdf", "lab-report.pdf");
  assert.match(
    say("What was the creatinine result?", b),
    /^Creatinine: result 1\.2, unit mg\/dL/,
  );
  assert.match(
    say("What was the urea result?", b),
    /^Urea: result 12, unit mg\/dL/,
  );
});

test("commands are never answered with a quote", async () => {
  const b = await bundleOf("lab-table.pdf", "lab-report.pdf");
  assert.equal(isQuestion("Mark the TSH result as normal."), false);
  assert.equal(say("Mark the TSH result as normal.", b), null);
});

test("an unrelated question gets no quote", async () => {
  const b = await bundleOf("digital.pdf", "site-visit.pdf");
  assert.equal(say("What is the capital of France?", b), null);
});

test("a plain sentence is spoken verbatim with a short source tail", async () => {
  const b = await bundleOf("digital.pdf", "site-visit.pdf");
  assert.equal(
    say("Who will confirm the leveller delivery date?", b),
    "Facilities lead Anika Rao will confirm the leveller delivery date by 29 August 2026. That's from site visit.",
  );
});

test("deliberate abstentions in the claim renderer carry no override reason", async () => {
  const b = await bundleOf("digital.pdf", "site-visit.pdf");
  const named = spokenTurn("What did Zephyrine approve?", b);
  assert.equal(named.verdict, "UNKNOWN");
  assert.equal(named.reason, undefined, "unknown entity stays an abstention");
});
