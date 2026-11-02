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
const run = (file) => {
  const out = execFileSync(
    process.execPath,
    ["evaluation/semantic/run.mjs", root, "gate", file],
    {
      cwd: root,
      env: { ...process.env, VM_EVAL_JSON: "stdout", VM_GEMINI: "off" },
      encoding: "utf8",
      maxBuffer: 1 << 24,
    },
  );
  return JSON.parse(out.split("@@SUMMARY@@")[1]);
};

test("vernacular development set: every case, no critical failure", () => {
  const s = run("vernacular.json");
  assert.deepEqual(s.criticalFailures, []);
  assert.equal(
    s.answerableCorrect.k,
    s.answerableCorrect.n,
    JSON.stringify(s.failures, null, 1),
  );
  assert.equal(s.abstentionCorrect.k, s.abstentionCorrect.n);
  assert.equal(s.falseAcceptance.k, 0);
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
