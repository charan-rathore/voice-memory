import test from "node:test";
import assert from "node:assert/strict";
import {
  createDecomposition,
  createDocumentQuestionPlan,
} from "../src/question-decomposition.mjs";
import { documentScope } from "../src/document-scope.mjs";
import { validateDocumentResponse } from "../src/document-response.mjs";
const question = "Was the launch approved, and who paid the deposit?";
const split = question.indexOf(", and ");
const scope = documentScope({
  corpusId: "synthetic-development",
  generation: 2,
});
const decomposition = createDecomposition({
  question,
  provenance: "explicit-development-interface-fixture",
  segments: [
    { kind: "requirement", start: 0, end: split },
    { kind: "glue", start: split, end: split + 6 },
    { kind: "requirement", start: split + 6, end: question.length },
  ],
});
const requestPlan = createDocumentQuestionPlan({ decomposition, scope });
const response = () => ({
  question,
  questionPlanKey: requestPlan.key,
  scopeKey: scope.key,
  requirements: requestPlan.requirements.map((r) => ({
    ...r,
    status: "not_established",
    claims: [],
  })),
});
test("lossless original spans include glue and unknown regions, not guessed semantic parsing", () => {
  assert.equal(decomposition.rawSpans.map((s) => s.raw).join(""), question);
  assert.equal(decomposition.requirements.length, 2);
  const opaque = createDecomposition({ question });
  assert.equal(opaque.state, "opaque");
  assert.equal(opaque.coverageEstablished, false);
  assert.throws(
    () =>
      createDecomposition({
        question,
        segments: [{ kind: "requirement", start: 0, end: 5 }],
      }),
    /lost/,
  );
  assert.throws(
    () =>
      createDecomposition({
        question,
        segments: [{ kind: "requirement", start: 1, end: question.length }],
      }),
    /contiguous/,
  );
});
test("provider cannot omit the payer requirement, duplicate approval or replace original text", () => {
  assert.equal(
    validateDocumentResponse(response(), { requestPlan, scope }).requirements
      .length,
    2,
  );
  for (const mutate of [
    (r) => r.requirements.pop(),
    (r) => (r.requirements[1] = r.requirements[0]),
    (r) => (r.requirements[1].text = "A different question"),
    (r) => (r.questionPlanKey = "forged"),
    (r) => (r.requirements[1].owners = ["wrong-owner"]),
    (r) => (r.requirements[1].status = "approved"),
  ]) {
    const r = response();
    mutate(r);
    assert.throws(() => validateDocumentResponse(r, { requestPlan, scope }));
  }
});
test("scope generation participates in plan identity and uncertainty cannot contain affirmative claims", () => {
  const second = createDocumentQuestionPlan({
    decomposition,
    scope: documentScope({ corpusId: "synthetic-development", generation: 3 }),
  });
  assert.notEqual(second.key, requestPlan.key);
  const r = response();
  r.requirements[1].claims = [{ statement: "someone paid" }];
  assert.throws(
    () => validateDocumentResponse(r, { requestPlan, scope }),
    /uncertain/,
  );
});
