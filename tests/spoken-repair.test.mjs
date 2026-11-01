// Recogniser damage seen on real Bolna calls must still reach the engine.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  repairPatientIds,
  repairTestNames,
  isFragment,
  voiceQuestions,
} from "../src/spoken-repair.mjs";

const vocab = new Map([
  ["ferritin", "Ferritin"],
  ["creatinine", "Creatinine"],
  ["hemoglobin", "Hemoglobin"],
  ["tsh", "TSH"],
  ["urea", "Urea"],
]);
const ids = ["SYN-0001", "SYN-0003"];

test("patient ids as spoken", () => {
  assert.match(repairPatientIds("syn zero zero one result", ids), /SYN-0001/);
  assert.match(
    repairPatientIds("what is the s y n zero zero zero one ferritin", ids),
    /SYN-0001/,
  );
  assert.match(
    repairPatientIds("same zero zero one's ferritin", ids),
    /SYN-0001/,
  );
  assert.equal(
    repairPatientIds("the fee was forty two thousand", ids),
    "the fee was forty two thousand",
  );
});

test("misheard test names, without touching ordinary words", () => {
  assert.match(repairTestNames("sparitine result", vocab), /Ferritin/);
  assert.match(repairTestNames("SYN-0001's fareitine", vocab), /Ferritin/);
  assert.match(
    repairTestNames("creatinin since september", vocab),
    /Creatinine/,
  );
  for (const s of [
    "dollar forty two thousand revision finalized",
    "certain things about the fee",
    "the protein shake",
  ])
    assert.equal(repairTestNames(s, vocab), s);
});

test("split-word mishearings rejoin: 'ferrite in' -> Ferritin", () => {
  assert.match(repairTestNames("what is my ferrite in level", vocab), /my Ferritin level/);
  assert.match(repairTestNames("hemo globin low", vocab), /Hemoglobin low/);
  for (const s of ["the protein in my diet", "what is in the report"])
    assert.equal(repairTestNames(s, vocab), s);
});

test("fragments are recognised; full questions are not", () => {
  assert.ok(isFragment("tell me more about"));
  assert.ok(isFragment("can you tell me the what is the"));
  assert.ok(!isFragment("What did Zephyrine approve?"));
  assert.ok(!isFragment("Was it $55,000?"));
});

test("a follow-up joins the caller's own previous utterance", () => {
  const reports = [
    {
      meta: { patient: { id: "SYN-0001" } },
      observations: [{ test: "Ferritin", key: "ferritin" }],
    },
  ];
  const qs = voiceQuestions(
    [
      { role: "user", content: "syn zero zero one sparitine result" },
      { role: "assistant", content: "x" },
      { role: "user", content: "can you tell me more about it" },
    ],
    { reports, ids, aliasesFor: () => [], text: String },
  );
  assert.ok(
    qs.some((q) => /SYN-0001 Ferritin result can you tell me more/.test(q)),
  );
});
