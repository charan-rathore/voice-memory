// Unit contract for whole-question coverage provenance. No language parsing:
// every case below varies only recorded provenance, never question wording.
import test from "node:test";
import assert from "node:assert/strict";
import {
  CoverageInputError,
  coverageNotice,
  documentRequirementCoverage,
  reconcileWholeQuestion,
  unestablishedNotice,
  wholeQuestionCoverage,
} from "../src/whole-question-coverage.mjs";
import { questionPlan } from "../src/question-plan.mjs";
import { finalAnswer } from "../src/answer-contract.mjs";
import { publicAnswer } from "../src/public-api.mjs";

const opaque = (q) =>
  questionPlan({ originalQuestion: q, sourceGeneration: 1 });
const quoted = (text) => ({
  text,
  verdict: "QUOTED",
  citations: [{ title: "policy.txt", quote: text }],
});

test("opaque plan + asserting answer = unverified, and the remainder is never named", () => {
  for (const q of [
    "Who owns the security review, and what is the retention window?",
    "What is the retention window?",
  ]) {
    const c = wholeQuestionCoverage(
      { questionPlan: opaque(q), lead: quoted("x") },
      "answered",
    );
    assert.equal(c.state, "unverified");
    assert.equal(c.complete, false);
    assert.equal(c.source, "opaque-plan");
    assert.equal(c.unaddressedPartsNamed, false);
    assert.deepEqual(c.requirements, []);
    assert.equal(
      c.originalQuestion,
      undefined,
      "request identity stays in questionPlan",
    );
  }
});

test("coverage never depends on question wording (no heuristic splitting)", () => {
  const a = wholeQuestionCoverage(
    { questionPlan: opaque("A and B?") },
    "answered",
  );
  const b = wholeQuestionCoverage({ questionPlan: opaque("A?") }, "answered");
  assert.deepEqual(a, b, "identical provenance, independent of wording");
});

test("clarify, refusal, abstention and social turns assert nothing", () => {
  for (const kind of ["clarify", "refused", "abstained", "social"]) {
    const c = wholeQuestionCoverage({ questionPlan: opaque("q") }, kind);
    assert.equal(c.state, "not_applicable", kind);
    assert.equal(c.complete, false);
  }
});

test("certified requirementCoverage keeps its established per-requirement outcomes", () => {
  const rc = {
    questionPlanKey: "k",
    complete: true,
    status: "covered",
    scope: "owner-test-coverage-only",
    outcomes: [{ requirementId: "r1", status: "answered" }],
  };
  const c = wholeQuestionCoverage(
    { questionPlan: opaque("q"), requirementCoverage: rc },
    "answered",
  );
  assert.equal(c.state, "established");
  assert.equal(c.complete, true);
  const partial = wholeQuestionCoverage(
    { requirementCoverage: { ...rc, complete: false, status: "partial" } },
    "partial",
  );
  assert.equal(partial.state, "incomplete");
  assert.equal(partial.complete, false);
});

test("a certified schema plan uses its admission, not the answer's tone", () => {
  const plan = {
    key: "p",
    originalQuestion: "q",
    coverageEstablished: true,
    requirementSource: "source-field-certificate",
    requirements: [{ id: "r1", text: "q" }],
  };
  assert.equal(
    wholeQuestionCoverage(
      { questionPlan: plan, admission: { complete: true } },
      "answered",
    ).state,
    "established",
  );
  assert.equal(
    wholeQuestionCoverage(
      { questionPlan: plan, admission: { complete: false } },
      "answered",
    ).state,
    "incomplete",
  );
  // An opaque plan cannot borrow certification by claiming coverage.
  const forged = { ...opaque("q"), coverageEstablished: true };
  assert.equal(
    wholeQuestionCoverage({ questionPlan: forged }, "answered").state,
    "unverified",
  );
  // An absent admission never certifies completeness (fail closed):
  // missing, null and malformed admission records are all unverified,
  // even when the answer kind is "answered".
  for (const admission of [undefined, null, {}, { complete: "yes" }]) {
    const c = wholeQuestionCoverage(
      { questionPlan: plan, admission },
      "answered",
    );
    assert.equal(c.state, "unverified", JSON.stringify(admission));
    assert.equal(c.complete, false);
    assert.equal(c.source, "certified-operation");
  }
});

test("qualified document coverage requires BOTH plan qualification and per-requirement outcomes", () => {
  const requestPlan = {
    key: "dp",
    coverageEstablished: true,
    requirements: [
      { id: "a", text: "Who owns it," },
      { id: "b", text: "and what is the window?" },
    ],
  };
  const good = {
    origin: "document-model-audited",
    requestPlan,
    outcomes: [
      { requirementId: "a", status: "answered" },
      { requirementId: "b", status: "not_established" },
    ],
  };
  const rc = documentRequirementCoverage(good);
  assert.equal(rc.complete, false);
  assert.equal(rc.source, "qualified-decomposition");
  assert.equal(
    unestablishedNotice(rc),
    "Not established from these documents: “and what is the window?”.",
  );
  // Missing qualification, missing outcome, unknown outcome, wrong origin.
  for (const bad of [
    { ...good, requestPlan: { ...requestPlan, coverageEstablished: false } },
    { ...good, outcomes: good.outcomes.slice(0, 1) },
    {
      ...good,
      outcomes: [...good.outcomes, { requirementId: "z", status: "answered" }],
    },
    {
      ...good,
      outcomes: [{ requirementId: "a", status: "maybe" }, good.outcomes[1]],
    },
    { ...good, origin: "document-unqualified-question" },
    null,
  ])
    assert.equal(documentRequirementCoverage(bad), null);
  // Opaque or certified coverage never names parts through this helper.
  assert.equal(
    unestablishedNotice({ source: "certified-operation", outcomes: [] }),
    null,
  );
});

test("reconcile appends one localized disclosure, idempotently, and the contract carries it", () => {
  const shown = {
    question: "Who owns the security review, and what is the retention window?",
    questionPlan: opaque(
      "Who owns the security review, and what is the retention window?",
    ),
    lead: quoted("Maya owns the security review."),
  };
  reconcileWholeQuestion(shown, finalAnswer(shown).kind, "en");
  reconcileWholeQuestion(shown, finalAnswer(shown).kind, "en");
  const notice = coverageNotice("en");
  assert.equal(shown.lead.text.split(notice).length, 2, "appended once");
  const p = publicAnswer(shown);
  assert.equal(p.status, "answered", "existing status value is unchanged");
  assert.equal(p.final.complete, false);
  assert.equal(p.final.coverage.state, "unverified");
  assert.equal(p.wholeQuestion.unaddressedPartsNamed, false);
  assert.equal(p.answer, p.final.text, "legacy field agrees");
  assert.ok(p.final.text.endsWith(notice));
  assert.notEqual(coverageNotice("hi"), notice);
  assert.notEqual(coverageNotice("hinglish"), notice);
});

test("typed failures, not crashes, on malformed input", () => {
  assert.throws(
    () => wholeQuestionCoverage(null, "answered"),
    CoverageInputError,
  );
  assert.throws(() => wholeQuestionCoverage({}, undefined), CoverageInputError);
});
