// The cross-encoder stage must fail closed: off by default, null (keep the
// fused ranking) when the model is not resident, and a gate that never opens
// until a rule has been calibrated on the outside benchmark.
import test from "node:test";
import assert from "node:assert/strict";
import {
  crossScores,
  rerankUnits,
  rerankGate,
  RERANK_GATE,
  rerankEnabled,
} from "../src/rerank.mjs";

test("reranker is off by default and returns null when not resident", async () => {
  assert.equal(rerankEnabled(), process.env.VM_RERANK === "on");
  assert.equal(await crossScores("q", ["a sentence"]), null);
  const ranked = [{ unit: { text: "a" }, cosine: 0.8 }];
  assert.equal(await rerankUnits("q", ranked), null);
});

test("an uncalibrated gate never opens", () => {
  if (RERANK_GATE !== null) return; // calibrated: covered by the rule test
  const rr = [
    { ce: 0.99, fusedRank: 1 },
    { ce: 0.01, fusedRank: 2 },
  ];
  assert.equal(rerankGate(rr), null);
});

test("a rule needs both confidence and a clear lead", () => {
  const rule = { minProb: 0.7, minMargin: 0.3, maxFusedRank: 5 };
  const ok = rerankGate(
    [
      { ce: 0.92, fusedRank: 2 },
      { ce: 0.4, fusedRank: 1 },
    ],
    rule,
  );
  assert.ok(ok);
  assert.equal(+ok.margin.toFixed(2), 0.52);
  // confident but no lead: two sentences look equally right
  assert.equal(
    rerankGate(
      [
        { ce: 0.92, fusedRank: 1 },
        { ce: 0.8, fusedRank: 2 },
      ],
      rule,
    ),
    null,
  );
  // a lead but not confident
  assert.equal(
    rerankGate(
      [
        { ce: 0.5, fusedRank: 1 },
        { ce: 0.05, fusedRank: 2 },
      ],
      rule,
    ),
    null,
  );
  // the fused ranking had it far down: not trusted
  assert.equal(
    rerankGate(
      [
        { ce: 0.95, fusedRank: 14 },
        { ce: 0.1, fusedRank: 1 },
      ],
      rule,
    ),
    null,
  );
  assert.equal(rerankGate([], rule), null);
});
