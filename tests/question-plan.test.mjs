import { verifyClaims } from "../src/semantic/verify.mjs";
import { safeRewrite } from "../src/semantic/route.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import {
  questionPlan,
  preservesQuestionPlan,
  validateRequirementOutcomes,
} from "../src/question-plan.mjs";

test("the caller's full question and explicit scope are immutable, including opaque compound language", () => {
  const originalQuestion =
    "Did Nimbus pay $1,500, and did Priya approve the commercial scope?";
  const plan = questionPlan({
    originalQuestion,
    selectedOwners: ["source-bound-owner"],
    sourceGeneration: 7,
  });
  assert.equal(plan.originalQuestion, originalQuestion);
  assert.equal(plan.requirements[0].text, originalQuestion);
  assert.equal(plan.requirements[0].semanticState, "unresolved");
  assert.throws(() => {
    plan.requirements[0].text = "Who approved?";
  }, TypeError);
  assert.throws(() => {
    plan.requirements[0].owners.push("intruder");
  }, TypeError);
  assert.equal(
    questionPlan({
      originalQuestion,
      selectedOwners: ["source-bound-owner"],
      sourceGeneration: 7,
    }).key,
    plan.key,
  );
  assert.notEqual(
    questionPlan({
      originalQuestion,
      selectedOwners: ["source-bound-owner"],
      sourceGeneration: 8,
    }).key,
    plan.key,
  );
});
test("opaque plans do not bless payer, action, approver or paraphrase rewrites", () => {
  for (const [originalQuestion, candidate] of [
    ["Did Nimbus pay $1,500?", "Did Arjun pay $1,500?"],
    ["Did Priya approve the scope?", "Did Kamal approve the scope?"],
    ["Did Priya approve the scope?", "Did Priya sign the scope?"],
    ["Who approved?", "Who authorized?"],
  ]) {
    const plan = questionPlan({ originalQuestion });
    assert.equal(preservesQuestionPlan(candidate, plan), false);
    assert.equal(safeRewrite(candidate, originalQuestion), false);
    assert.equal(preservesQuestionPlan(originalQuestion, plan), true);
  }
});
test("structural outcome coverage cannot add, duplicate or omit caller requirements", () => {
  const plan = questionPlan({ originalQuestion: "What is recorded?" }),
    requirementId = plan.requirements[0].id;
  const outcome = {
    requirementId,
    status: "not_established",
    reason: "Not yet proven",
  };
  assert.throws(() => validateRequirementOutcomes([], plan), /missing/);
  assert.throws(
    () => validateRequirementOutcomes([outcome, outcome], plan),
    /repeated/,
  );
  assert.throws(
    () =>
      validateRequirementOutcomes(
        [{ ...outcome, requirementId: "model-added" }],
        plan,
      ),
    /Unknown/,
  );
  assert.throws(
    () =>
      validateRequirementOutcomes([{ ...outcome, status: "answered" }], plan),
    /admitted claims/,
  );
  assert.equal(
    validateRequirementOutcomes([outcome], plan)[0].status,
    "not_established",
  );
});

test("same number and literal quote cannot self-certify payer or action entailment", () => {
  const quote = "Arjun owes $1,500.";
  const passage = {
    text: quote,
    restore: (s) => s,
    evidence: {
      sourceId: "s1",
      title: "Synthetic",
      hash: "h",
      start: 0,
      end: quote.length,
      quote,
    },
  };
  const result = verifyClaims(
    ["Nimbus owes $1,500.", "Arjun paid $1,500.", quote].map((statement) => ({
      statement,
      passage: 0,
      quote,
      verified: true,
    })),
    [passage],
  );
  assert.equal(result.accepted.length, 0);
  assert.ok(
    result.rejected.every((r) => r.reason === "relation_entailment_unverified"),
  );
});
