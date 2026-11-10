// Caller-owned request identity. This module does not claim to understand
// arbitrary language: protected text is lossless; semantic slots stay unknown
// unless a separately validated resolver supplies them.
import { createHash } from "node:crypto";
import { requestOf } from "./semantic/intent.mjs";
const digest = (x) =>
  createHash("sha256").update(JSON.stringify(x)).digest("hex");
function freeze(value) {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

const EMPTY_SLOTS = {
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
};

// Slots a closed grammar read from the caller's own words (intent.mjs
// requestOf). Anything the grammar did not consume stays null: unknown is
// never filled with a guess.
function slotsOf(frame) {
  const r = frame?.relation ?? null;
  return {
    ...EMPTY_SLOTS,
    actor: r?.actor ?? null,
    relation: r?.family ?? null,
    action: r ? (r.ask === "actor" ? "identify-actor" : "confirm-actor") : null,
    object: r?.object ?? null,
    polarity: frame?.negated || r?.negated ? "negated" : null,
    version: frame?.version ?? null,
    status: frame?.statusAsked ?? null,
    expectedAnswerType: r ? r.ask : null,
  };
}
const recognised = (frame) =>
  !!(frame?.relation || frame?.negated || frame?.version || frame?.statusAsked);

/**
 * The caller-owned plan for one request, typed or spoken.
 *
 * `originalQuestion` is kept byte for byte and frozen: a repaired
 * transcript, a history-joined retrieval candidate or a model rewrite is
 * recorded under `normalizationCandidates` and never replaces it.
 *
 * Additive fields (all derived here from the original wording, or passed
 * by the server - never taken from a request body):
 *   request    the closed-grammar frame: relation, polarity, version,
 *              amounts (semantic/intent.mjs requestOf)
 *   scope      { key, version } the document scope and immutable source
 *              version this plan was made against
 *   followUp   the conversation contract's reading when this turn refers
 *              to an earlier one: { referencedTurnId, subject, correction }
 */
export function questionPlan({
  originalQuestion,
  selectedOwners = [],
  sourceGeneration = null,
  previousPlan = null,
  normalizationCandidates = [],
  scope = null,
  followUp = null,
}) {
  if (typeof originalQuestion !== "string" || !originalQuestion.trim())
    throw Error("The original question is required.");
  if (
    !Array.isArray(selectedOwners) ||
    selectedOwners.some((x) => typeof x !== "string" || !x)
  )
    throw Error("Selected owners must be explicit source-bound identifiers.");
  const frame = requestOf(originalQuestion);
  // The question is kept whole: compound boundaries are never guessed from
  // wording. A requested relationship is recorded only when the closed
  // grammar consumed the entire question as one clause.
  const requirement = {
    id: `r-${digest([originalQuestion, selectedOwners, sourceGeneration]).slice(0, 16)}`,
    text: originalQuestion,
    owners: [...selectedOwners],
    protectedText: originalQuestion,
    slots: slotsOf(frame),
    semanticState: recognised(frame) ? "closed-grammar-request" : "unresolved",
  };
  const requirements = [requirement];
  const value = {
    version: 1,
    originalQuestion,
    requirements,
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
    request: {
      relation: frame.relation
        ? {
            family: frame.relation.family,
            ask: frame.relation.ask,
            actor: frame.relation.actor ?? null,
            object: frame.relation.object,
            terms: [...frame.relation.terms],
            negated: frame.relation.negated === true,
          }
        : null,
      polar: frame.polar,
      negated: frame.negated,
      version: frame.version,
      statusAsked: frame.statusAsked,
      amounts: [...frame.amounts],
    },
    scope:
      scope && typeof scope === "object"
        ? { key: scope.key ?? null, version: scope.version ?? null }
        : null,
    followUp:
      followUp && typeof followUp === "object"
        ? {
            referencedTurnId: followUp.referencedTurnId ?? null,
            subject: followUp.subject ?? null,
            correction: followUp.correction === true,
          }
        : null,
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
