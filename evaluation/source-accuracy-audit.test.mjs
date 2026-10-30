import test from "node:test";
import assert from "node:assert/strict";
import { importBundle, answer } from "../dist/engine.mjs";
import { NORTHSTAR_DOCS } from "../corpus-northstar.mjs";

// Audit cases from review: expansion must never create false authority, stale
// single-source positives must be labeled partial, and "not recorded" in one
// log supports that record only - not global absence.
const bundle = importBundle(NORTHSTAR_DOCS);

test("'agreed' is not expanded into authority terms (approved/confirmed)", () => {
  const r = answer("What were the agreed commercials?", bundle);
  const applied = r.queryTransform?.applied ?? [];
  assert.ok(!applied.some((a) => a.from === "agreed"));
});

test("agreement question over unsigned corpus is not a clean positive", () => {
  const r = answer("What were the agreed commercials?", bundle);
  // Corpus truth: nothing signed; 40/60 proposed vs 50/50 discussed; finance
  // approval outstanding. A clean settled-looking positive would mislead.
  assert.ok(
    r.evidenceStatus !== "positive" || r.partial === true,
    `expected non-positive or partial, got ${r.evidenceStatus} partial=${r.partial}`,
  );
});

test("stale-fee answer is claim-composed: current proposed value + superseded history, no stale excerpt", () => {
  const r = answer(
    "What is the engagement fee and how is it invoiced?",
    bundle,
  );
  assert.equal(r.partial, true);
  assert.match(r.answer, /Record status:/);
  assert.match(r.answer, /\$42,000/);
  assert.match(r.answer, /\$48,000/);
  assert.match(r.answer, /superseded/i);
  assert.match(r.answer, /approval is not established by this check/);
  // No raw excerpt may reassert the stale fee as current.
  assert.ok(!r.answer.includes("fee of $48,000"));
  assert.ok(!r.answer.includes("Relevant source excerpts"));
});

test("'not recorded' supports that record only, answer scoped to evidence", () => {
  const r = answer("Who approved the production launch?", bundle);
  const text = r.answer + " " + r.evidence.map((e) => e.quote).join(" ");
  assert.match(text, /not recorded/i);
  assert.ok(r.evidence.every((e) => e.title === "07_Internal_Action_Log.md"));
});

test("conflicted questions stay unresolved, never pick a side", () => {
  for (const q of [
    "What payment terms did we finally agree to?",
    "When is the pilot deadline?",
  ]) {
    const r = answer(q, bundle);
    assert.equal(r.supported, false, q);
    assert.equal(r.unresolved, true, q);
  }
});
test("billing/money/commercials paraphrases reach claim logic, not excerpt-only answers", () => {
  // Before the questionFields widening, these paraphrases bypassed claim
  // analysis entirely: "How will we bill them?" returned raw kickoff excerpts
  // with no record status, and "What did the steering group decide about
  // money?" was a bare refusal.
  for (const q of [
    "How will we bill them?",
    "What are the commercials?",
    "What did the steering group decide about money?",
  ]) {
    const r = answer(q, bundle);
    assert.equal(r.unresolved, true, q);
    assert.match(r.answer, /Competing records/, q);
    assert.match(r.answer, /50\/50 \(04_Steering_Committee_Notes\.md/, q);
    assert.ok(!r.answer.includes("Relevant source excerpts"), q);
  }
});
