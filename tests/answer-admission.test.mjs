import test from "node:test";
import assert from "node:assert/strict";
import { questionPlan } from "../src/question-plan.mjs";
import { admitAnswer } from "../src/answer-admission.mjs";
function fixture({ qualified = true } = {}) {
  const original = questionPlan({
    originalQuestion: "What is the source-bound balance?",
    sourceGeneration: 2,
  });
  const plan = qualified
    ? {
        ...original,
        coverageEstablished: true,
        semanticQualification: "test-trusted-operation",
      }
    : original;
  const id = plan.requirements[0].id;
  const claim = {
    text: "Arjun owes $1,500.",
    citations: [
      { sourceId: "s", start: 0, end: 18, quote: "Arjun owes $1,500." },
    ],
    certificate: { ok: true },
  };
  const draft = {
    questionPlanKey: plan.key,
    sourceGeneration: 2,
    outcomes: [{ requirementId: id, status: "answered", claims: [claim] }],
  };
  const verifyEvidence = ({ claim, bundle }) => ({
    ok: bundle.sources[0].text.slice(0, 18) === claim.citations[0].quote,
  });
  // This narrow test verifier reconstructs one explicitly fixed operation.
  // It is not a natural-language entailment model or production parser.
  const verifyDeterministic = ({ plan, requirement, claim, bundle }) => ({
    ok: claim.text === bundle.sources[0].text,
    questionPlanKey: plan.key,
    requirementId: requirement.id,
    sourceGeneration: plan.sourceGeneration,
  });
  return {
    plan,
    draft,
    bundle: { sources: [{ id: "s", text: "Arjun owes $1,500." }] },
    verifyEvidence,
    verifyDeterministic,
  };
}
test("a producer cannot certify its own claim with a valid quote or ok field", async () => {
  const f = fixture();
  const out = await admitAnswer({ ...f, verifyDeterministic: null });
  assert.equal(out.userReady, false);
  assert.equal(out.status, "unresolved");
});
test("a narrow independently reconstructed operation can be admitted but role/action swaps cannot", async () => {
  for (const statement of [
    "Arjun owes $1,500.",
    "Nimbus owes $1,500.",
    "Arjun paid $1,500.",
  ]) {
    const f = fixture();
    f.draft.outcomes[0].claims[0].text = statement;
    const out = await admitAnswer(f);
    assert.equal(out.userReady, statement === "Arjun owes $1,500.");
  }
});
test("opaque question coverage, wrong generation and omitted requirements fail closed", async () => {
  const f = fixture({ qualified: false });
  assert.equal((await admitAnswer(f)).reason, "interpretation_unresolved");
  const g = fixture();
  g.draft.sourceGeneration = 3;
  assert.equal((await admitAnswer(g)).reason, "stale_or_wrong_request");
  const h = fixture();
  h.draft.outcomes = [];
  assert.equal((await admitAnswer(h)).reason, "invalid_requirement_coverage");
});
test("verifier outage cannot become a false source-absence assertion", async () => {
  const f = fixture();
  f.verifyDeterministic = () => {
    throw Error("unavailable");
  };
  const out = await admitAnswer(f);
  assert.equal(out.status, "unresolved");
  assert.equal(out.userReady, false);
  assert.equal(out.outcomes[0].reason, "claim_not_admitted");
});
