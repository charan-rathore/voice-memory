// A/B harness regression: Voice Memory (B) must never leak across callers or
// make an unsupported claim, and must remove repeated context; the held-out
// set must stay frozen. Developer-authored: regression, not accuracy.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { runAB } from "../scripts/ab-eval.mjs";

test("held-out set is frozen", () => {
  const readme = readFileSync(
    new URL("../evaluation/ab/README.md", import.meta.url),
    "utf8",
  );
  const want = /SHA-256: `([0-9a-f]{64})`/.exec(readme)[1];
  const got = createHash("sha256")
    .update(
      readFileSync(new URL("../evaluation/ab/heldout.mjs", import.meta.url)),
    )
    .digest("hex");
  assert.equal(
    got,
    want,
    "evaluation/ab/heldout.mjs changed after it was frozen",
  );
});

for (const set of ["dev", "heldout"])
  test(
    `A/B ${set}: B removes repeated context with zero leakage and zero unsupported claims`,
    { timeout: 120_000 },
    async () => {
      const r = await runAB(set);
      const { A, B } = r.totals;
      assert.equal(B.isolationFailures, 0);
      assert.equal(B.unsupportedClaims, 0);
      assert.equal(A.unsupportedClaims, 0);
      assert.equal(B.failedExpectations, 0);
      assert.equal(B.safeClarifications, B.clarifyExpected);
      assert.equal(B.recallCorrect, B.recallChecks);
      assert.equal(B.repeatedContext, 0);
      assert.ok(
        A.repeatedContext > 0,
        "the arm without memory needs repeated context",
      );
    },
  );
