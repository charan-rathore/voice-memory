// paraphrase.mjs without the model: units carry their document context and
// exact offsets, fusion favours meaning over words, and the gate refuses
// low-confidence and two-document ties. The model-backed numbers live in
// evaluation/paraphrase-bench.mjs (CI, bench workflow).
import { test } from "node:test";
import assert from "node:assert/strict";
import { importBundle } from "./dist/engine.mjs";
import {
  unitsOf,
  rankUnits,
  gate,
  GATE,
  paraphraseLookup,
} from "./paraphrase.mjs";

const bundle = importBundle([
  {
    title: "01_Proposal.md",
    text: "# Pilot Proposal\nAuthor: P. Rao. Date: 2026-09-04. Type: proposal.\n1. The fixed engagement fee is $48,000 for three regions.\n2. The pilot deadline is 15 November 2026.",
  },
  {
    title: "02_Email.md",
    text: "# Client Email\nAuthor: R. Kapoor. Date: 2026-10-06. Type: email extract.\n1. The client asks to keep the original deadline for the pilot.",
  },
]);

test("units are single sentences with their document's context and exact offsets", () => {
  const { units } = unitsOf(bundle);
  assert.equal(units.length, 3);
  for (const u of units) {
    assert.equal(u.src.text.slice(u.sent.start, u.sent.end), u.sent.text);
    assert.match(
      u.text,
      /^(Pilot Proposal, proposal, 2026-09-04|Client Email, email extract, 2026-10-06): /,
    );
  }
});

// fake unit vectors: one-hot per unit, so the query picks a unit exactly
const withVectors = (vecs) => {
  const idx = unitsOf(bundle);
  idx.vectors = vecs.map((v) => Float32Array.from(v));
  return idx;
};

test("with no shared words the ranking follows meaning", () => {
  withVectors([
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ]);
  // a paraphrase shares no words with the deadline sentence
  const r = rankUnits(
    "when must it be ready",
    bundle,
    Float32Array.from([0, 0.9, 0.1]),
  );
  assert.match(r[0].unit.sent.text, /deadline is 15 November/);
});

test("the gate refuses low confidence and cross-document ties", () => {
  const top = (cos, rival) => [
    { unit: { src: "a" }, cosine: cos },
    { unit: { src: "a" }, cosine: cos - 0.001 },
    { unit: { src: "b" }, cosine: rival },
  ];
  assert.equal(gate(top(GATE.minCosine - 0.01, 0.1)), null, "below the floor");
  assert.ok(gate(top(0.9, 0.5)), "clear winner");
  assert.equal(
    gate(top(0.9, 0.9 - 0.001), { minCosine: 0.6, minMargin: 0.02 }),
    null,
    "another document says nearly the same",
  );
  assert.equal(gate([]), null);
});

test("without the model resident it abstains instead of waiting", async () => {
  const fresh = importBundle([
    {
      title: "x.md",
      text: "One sentence about the pilot fee, which is forty eight thousand dollars.",
    },
  ]);
  assert.equal(await paraphraseLookup("how much does it cost", fresh), null);
});
