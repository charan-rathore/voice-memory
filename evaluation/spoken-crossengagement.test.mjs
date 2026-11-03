// Cross-engagement safety (radar review of 2c75391): distinct customers and
// subjects inside one entity-less document must never collapse into each
// other, and a subject-less question must never match an arbitrary record.
import test from "node:test";
import assert from "node:assert/strict";
import { importBundle, extractClaims, resolveClaims } from "../dist/engine.mjs";
import { mergedClaims, spokenTurn } from "../src/spoken.mjs";

const doc = (text) => ({ title: "memo.pdf", text });
const run = (text, question) => {
  const b = importBundle([doc(text)]);
  return { b, merged: mergedClaims(b, ["fee", "retention"]) };
};
const ask = (b, q) => spokenTurn(q, b, b.fields ?? [], {}).spoken;

test("distinct named customers compete; one side never supersedes the other", () => {
  const b = importBundle([
    doc(
      "JAN 10 2026 - CALL\nThe Alpha migration fee is USD 20,000.\n\nFEB 10 2026 - CALL\nThe revised Beta migration fee is USD 30,000.\n",
    ),
  ]);
  const active = (
    resolveClaims(extractClaims(b, ["fee"])).active.get("fee") ?? []
  ).map((c) => c.value);
  assert.deepEqual(active.sort(), ["USD 20,000", "USD 30,000"]);
});

test("a question naming a customer answers from that customer's record", () => {
  const { b } = run(
    "The Alpha migration fee is USD 20,000 proposed on January 10. The revised Beta migration fee is USD 30,000 proposed on February 10.",
    "fee",
  );
  const a = ask(b, "What is the Alpha migration fee?");
  assert.match(a, /20,000/);
  assert.doesNotMatch(a, /30,000/);
});

test("two customers' approved fees are an open conflict, not a silent pick", () => {
  const { b } = run(
    "Customer A approved the USD 20,000 fee on January 10. Customer B approved the revised USD 30,000 fee on February 10.",
    "fee",
  );
  const a = ask(b, "What is the fee?");
  assert.match(a, /still open|20,000.*30,000/s);
  assert.doesNotMatch(a, /^Yes\./);
});

test("a subject-less rejection question matches no arbitrary record", () => {
  const { b } = run(
    "The 90-day retention suggestion is rejected on September 1. The fee of USD 54,000 is approved internally on September 10.",
    "retention",
  );
  const a = ask(b, "Was it rejected?");
  assert.doesNotMatch(a, /^(Yes|No)\. /);
});
