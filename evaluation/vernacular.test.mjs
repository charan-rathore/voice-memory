// Regression gate for the vernacular eval sets (evaluation/semantic/
// vernacular*.json): English, Hindi and Hinglish asks, recogniser noise and
// advice the assistant must decline. Fails on any critical failure (stale
// value, unit comparison, patient mix-up, false acceptance), on any lost
// development case, and if the frozen held-out set drops below its first
// recorded run (20/22). See docs/COMPANION.md for what these numbers are
// and are not.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const run = (file, selectedCases = {}) => {
  const out = execFileSync(
    process.execPath,
    ["evaluation/semantic/run.mjs", root, "gate", file],
    {
      cwd: root,
      env: {
        ...process.env,
        VM_EVAL_JSON: "stdout",
        VM_GEMINI: "off",
        VM_EVAL_SELECTED_CASES: JSON.stringify(selectedCases),
      },
      encoding: "utf8",
      maxBuffer: 1 << 24,
    },
  );
  return JSON.parse(out.split("@@SUMMARY@@")[1]);
};

test("vernacular development: original unselected failures are explicit; selected-context positives remain independent", () => {
  // The frozen corpus used only-test-owner as an implicit identity for
  // these three questions. Do not restore that unsafe default or edit its
  // expected values. Record the unselected outcome separately, then require
  // every original positive assertion under explicit selected context.
  const s = run("vernacular.json");
  const ids = ["v04", "v24", "v25"];
  assert.deepEqual(s.criticalFailures, []);
  assert.deepEqual(s.failures.map((f) => f.id).sort(), ids);
  for (const f of s.failures) {
    assert.equal(f.verdict, "AMBIGUOUS_PATIENT", f.q);
    assert.match(f.said, /SYN-0001/, f.q);
    assert.match(f.said, /SYN-0003/, f.q);
    assert.deepEqual(f.bad, []);
  }
  assert.equal(s.falseAcceptance.k, 0);
  const selected = Object.fromEntries(ids.map((id) => [id, "SYN-0001"]));
  const p = run("vernacular.json", selected);
  assert.deepEqual(p.selectedCases, selected);
  assert.deepEqual(p.criticalFailures, []);
  assert.equal(
    p.answerableCorrect.k,
    p.answerableCorrect.n,
    JSON.stringify(p.failures, null, 1),
  );
  assert.equal(p.abstentionCorrect.k, p.abstentionCorrect.n);
  assert.equal(p.falseAcceptance.k, 0);
});

test("vernacular held-out set: no critical failure, not below its first run", () => {
  const s = run("vernacular-heldout.json");
  assert.deepEqual(s.criticalFailures, []);
  assert.ok(
    s.answerableCorrect.k >= 20,
    `held-out answerable ${s.answerableCorrect.k}/${s.answerableCorrect.n}: ${JSON.stringify(s.failures, null, 1)}`,
  );
  assert.equal(s.falseAcceptance.k, 0);
});
