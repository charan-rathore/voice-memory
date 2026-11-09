import test from "node:test";
import assert from "node:assert/strict";
import {
  documentScope,
  evidencePermission,
  validateDocumentPlan,
  inspectReasoningDraft,
} from "../src/document-scope.mjs";
const scope = documentScope({
  corpusId: "c",
  generation: 1,
  owners: ["A"],
  requested: ["Alice", "Carol"],
  missing: ["Carol"],
});
const records = [
  { id: "ra", sourceId: "s", start: 0, end: 10, owner: "A" },
  { id: "rb", sourceId: "s", start: 10, end: 20, owner: "B" },
  { id: "ru", sourceId: "s", start: 20, end: 30, owner: null },
];
const requirements = [
  { id: "alice", text: "Alice's discharge", owners: ["A"] },
  { id: "carol", text: "Carol's discharge", owners: ["Carol"] },
];
const evidence = (start, end) => ({
  sourceId: "s",
  start,
  end,
  quote: "x".repeat(end - start),
});
test("typed scope is immutable, distinguishes corpus generation, owners, missing entities and chronology", () => {
  assert.ok(Object.isFrozen(scope));
  assert.ok(Object.isFrozen(scope.owners));
  assert.equal(scope.state, "partial");
  for (const change of [
    { generation: 2 },
    { owners: ["B"] },
    { missing: [] },
    { temporal: { asOf: "2026-11-08" } },
  ])
    assert.notEqual(
      documentScope({
        corpusId: "c",
        generation: 1,
        owners: ["A"],
        requested: ["Alice", "Carol"],
        missing: ["Carol"],
        ...change,
      }).key,
      scope.key,
    );
});
test("scope admits only full containing owner evidence, not overlap or unknown-owner material", () => {
  assert.equal(
    evidencePermission(scope, evidence(0, 5), records).allowed,
    true,
  );
  for (const [start, end, reason] of [
    [9, 11, "no_containing_record"],
    [11, 14, "outside_scope"],
    [20, 24, "unknown_owner"],
  ])
    assert.equal(
      evidencePermission(scope, evidence(start, end), records).reason,
      reason,
    );
  assert.equal(
    evidencePermission(
      documentScope({ corpusId: "c", generation: 1, ambiguous: true }),
      evidence(0, 5),
      records,
    ).allowed,
    false,
  );
});
test("planner cannot erase a requested entity, change owners, duplicate requirements or reinterpret question", () => {
  const good = { scopeKey: scope.key, question: "both?", requirements };
  assert.equal(
    validateDocumentPlan(good, { scope, question: "both?", requirements })
      .requirements.length,
    2,
  );
  for (const bad of [
    { ...good, requirements: requirements.slice(0, 1) },
    { ...good, requirements: [requirements[0], requirements[0]] },
    { ...good, question: "Alice only?" },
    {
      ...good,
      requirements: [{ ...requirements[0], owners: ["B"] }, requirements[1]],
    },
  ])
    assert.throws(() =>
      validateDocumentPlan(bad, { scope, question: "both?", requirements }),
    );
});
test("draft completeness cannot be faked by one cited answer, and citations do not prove entailment", () => {
  const sources = [{ id: "s", text: "x".repeat(30) }];
  const draft = {
    scopeKey: scope.key,
    outcomes: [
      {
        requirementId: "alice",
        status: "answered",
        claims: [
          {
            kind: "synthesis",
            text: "She was cured",
            citations: [evidence(0, 5)],
          },
        ],
      },
    ],
  };
  const result = inspectReasoningDraft(draft, {
    scope,
    requirements,
    sources,
    records,
  });
  assert.equal(result.complete, false);
  assert.deepEqual(result.missing, ["carol"]);
  assert.equal(result.userReady, false);
  assert.equal(
    result.outcomes[0].claims[0].verification,
    "requires_entailment_check",
  );
  draft.outcomes.push({
    requirementId: "carol",
    status: "not_established",
    reason: "No record for Carol",
  });
  assert.equal(
    inspectReasoningDraft(draft, { scope, requirements, sources, records })
      .complete,
    true,
  );
  draft.outcomes[0].claims[0].citations = [evidence(11, 14)];
  assert.throws(
    () =>
      inspectReasoningDraft(draft, { scope, requirements, sources, records }),
    /outside_scope/,
  );
});
