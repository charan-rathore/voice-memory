// Offline replay of actual saved provider content. The final audit is scripted,
// not a new model result. This tests safe partial-answer behavior and provenance.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { importBundle } from "../dist/engine.mjs";
import { readDocumentQuestion } from "../src/semantic/document.mjs";
import { understandDocumentQuestion } from "../src/semantic/question-understanding.mjs";
const fixture = JSON.parse(
  readFileSync(
    new URL(
      "./fixtures/document-disagreement/saved-gemini-disagreement.json",
      import.meta.url,
    ),
  ),
);
const text = readFileSync(
  new URL(
    "./fixtures/document-disagreement/constitution-transcript.txt",
    import.meta.url,
  ),
  "utf8",
);
async function replay({
  rejectAudit = false,
  omitCoverage = false,
  changeOwner = false,
} = {}) {
  const bundle = importBundle(
    [{ title: "Constitution - public source replay", text }],
    { scope: "offline-frozen-disagreement" },
  );
  let auditInput = null;
  const rebind = (original, requestPlan, docs) => {
    const value = structuredClone(original);
    value.questionPlanKey = requestPlan.key;
    value.scopeKey = requestPlan.scopeKey;
    for (const r of value.requirements)
      for (const c of r.claims ?? [])
        for (const ref of c.evidence ?? [])
          ref.sourceId = docs[ref.document].sourceId;
    if (changeOwner) value.requirements[0].owners = ["unverified-new-owner"];
    return value;
  };
  const gemini = {
    enabled: () => true,
    questionRequirements: async () => structuredClone(fixture.interpretation),
    documentRead: async (p, d) => rebind(fixture.primary, p, d),
    documentCoverage: async (p, d) => rebind(fixture.blind, p, d),
    documentAudit: async (p, plan, statements, opts) => {
      auditInput = { plan, statements, opts };
      const coverageItems = opts.independentPlan.requirements.flatMap((r) =>
        r.status === "answered"
          ? r.claims.map((_, i) => ({
              requirementId: r.id,
              claimIndex: i,
              accept: true,
            }))
          : [{ requirementId: r.id, claimIndex: null, accept: true }],
      );
      if (omitCoverage) coverageItems.pop();
      return {
        question: p.originalQuestion,
        questionPlanKey: p.key,
        scopeKey: p.scopeKey,
        complete: !rejectAudit,
        relevant: true,
        supported: true,
        items: statements.map((s, index) => ({
          index,
          requirementId: s.requirementId,
          accept: true,
        })),
        coverageItems,
      };
    },
  };
  const decomposition = await understandDocumentQuestion({
    question: fixture.question,
    gemini,
  });
  const answer = await readDocumentQuestion({
    question: fixture.question,
    bundle,
    gemini,
    consent: true,
    decomposition,
  });
  return { answer, auditInput, bundle };
}

test("frozen actual status disagreement preserves agreed bill rules but does not assert budget absence", async () => {
  const { answer, auditInput, bundle } = await replay();
  assert.equal(answer.verdict, "PARTIAL_DOCUMENT");
  assert.deepEqual(
    answer.outcomes.map((r) => r.status),
    ["answered", "answered", "clarify"],
  );
  assert.match(answer.text, /two-thirds/);
  assert.match(answer.text, /ten days \(Sundays excepted\)/);
  assert.match(answer.text, /adjournment/);
  assert.match(answer.text, /reading checks disagreed/);
  assert.doesNotMatch(answer.text, /text does not mention|provide any figure/);
  assert.ok(
    answer.citations.every(
      (c) => c.quote === bundle.sources[0].text.slice(c.start, c.end),
    ),
  );
  assert.ok(
    answer.citations.every((c) => !c.quote.includes("No Money shall be drawn")),
    "generic appropriations quote cannot evidence a current-budget absence",
  );
  assert.equal(auditInput.opts.primaryPlan.requirements[2].status, "answered");
  assert.equal(
    auditInput.opts.independentPlan.requirements[2].status,
    "not_established",
  );
  assert.deepEqual(
    auditInput.opts.disputes.map((d) => d.requirementId),
    [fixture.primary.requirements[2].id],
  );
  assert.ok(
    auditInput.statements
      .filter((s) => s.requirementId === fixture.primary.requirements[2].id)
      .every((s) => s.status === "clarify" && !s.evidence.length),
  );
});

test("partial output still requires final audit, every coverage judgment, and unchanged owner binding", async () => {
  for (const options of [
    { rejectAudit: true },
    { omitCoverage: true },
    { changeOwner: true },
  ])
    assert.equal((await replay(options)).answer, null);
});
