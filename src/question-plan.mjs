// Caller-owned request identity. This module does not claim to understand
// arbitrary language: protected text is lossless; semantic slots stay unknown
// unless a separately validated resolver supplies them.
import { createHash } from "node:crypto";
const digest = (x) =>
  createHash("sha256").update(JSON.stringify(x)).digest("hex");
function freeze(value) {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

export function questionPlan({
  originalQuestion,
  selectedOwners = [],
  sourceGeneration = null,
  previousPlan = null,
  normalizationCandidates = [],
}) {
  if (typeof originalQuestion !== "string" || !originalQuestion.trim())
    throw Error("The original question is required.");
  if (
    !Array.isArray(selectedOwners) ||
    selectedOwners.some((x) => typeof x !== "string" || !x)
  )
    throw Error("Selected owners must be explicit source-bound identifiers.");
  // Until a validated language parser exists, never guess compound boundaries
  // or silently inherit an actor/measure from a free-form previous answer.
  const requirement = {
    id: `r-${digest([originalQuestion, selectedOwners, sourceGeneration]).slice(0, 16)}`,
    text: originalQuestion,
    owners: [...selectedOwners],
    protectedText: originalQuestion,
    slots: {
      actor: null,
      recipient: null,
      status: null,
      condition: null,
      relation: null,
      action: null,
      object: null,
      polarity: null,
      time: null,
      version: null,
      expectedAnswerType: null,
    },
    semanticState: "unresolved",
  };
  const value = {
    version: 1,
    originalQuestion,
    requirements: [requirement],
    sourceGeneration,
    coverageEstablished: false,
    semanticQualification: "unresolved",
    unresolvedRemainder: originalQuestion,
    requirementSource: "opaque-lossless",
    selectedOwnersVerified: false,
    previousPlanKey:
      previousPlan?.sourceGeneration === sourceGeneration &&
      sourceGeneration !== null
        ? (previousPlan.key ?? null)
        : null,
    normalizationCandidates: structuredClone(normalizationCandidates),
    segmentation: "opaque-lossless-not-semantic-qualification",
  };
  return freeze({ ...value, key: digest(value) });
}

// A retrieval transform is a candidate, never a replacement for the plan.
// Without validated protected slots, only the exact original can serve as a
// question rewrite. This intentionally does not approve lexical paraphrases.
export function preservesQuestionPlan(candidate, plan) {
  return typeof candidate === "string" && candidate === plan.originalQuestion;
}

export function validateRequirementOutcomes(outcomes, plan) {
  if (!Array.isArray(outcomes))
    throw Error("Requirement outcomes are required.");
  const expected = new Map(plan.requirements.map((r) => [r.id, r]));
  const seen = new Set();
  for (const outcome of outcomes) {
    if (
      !expected.has(outcome?.requirementId) ||
      seen.has(outcome.requirementId)
    )
      throw Error("Unknown or repeated requirement outcome.");
    seen.add(outcome.requirementId);
    if (!["answered", "not_established", "clarify"].includes(outcome.status))
      throw Error("Unknown requirement outcome status.");
    if (outcome.status === "answered" && !outcome.claims?.length)
      throw Error("An answered requirement needs admitted claims.");
    if (outcome.status !== "answered" && outcome.claims?.length)
      throw Error("An uncertain requirement cannot assert claims.");
  }
  if (seen.size !== expected.size)
    throw Error("A required outcome is missing.");
  // This proves structural coverage only. The caller must separately prove
  // claim-to-requirement relevance, completeness and evidence entailment.
  return freeze(structuredClone(outcomes));
}
