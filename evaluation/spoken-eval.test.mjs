// Regression gate for spoken answers through the real voice endpoint on three
// synthetic corpora (Northstar dev set, Harbor, Lumen). See spoken-eval.mjs
// for what was held out when, and evaluation/results/ for first-run scores.
import { test } from "node:test";
import assert from "node:assert/strict";
import { SETS, runSet } from "./spoken-eval.mjs";

for (const set of SETS) {
  test(`spoken answers: ${set.name}`, async () => {
    const r = await runSet(set);
    const fails = r.rows
      .filter((x) => !x.pass)
      .map((x) => `${x.id} "${x.q}" -> "${x.spoken}" [${x.fails.join("; ")}]`);
    assert.deepEqual(fails, [], `${r.answerCorrect}/${r.n} correct`);
  });
}
