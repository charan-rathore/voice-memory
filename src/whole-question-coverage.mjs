// Whole-question coverage provenance: does the answer cover the WHOLE
// question, and how do we know?
//
// This module does not parse language. It never splits a question, never
// guesses slots and never infers coverage from wording (coordinating words,
// question marks, length). It only reads the provenance that other,
// separately qualified modules already recorded:
//
//   certified-operation     a source-bound schema operation (exact fields,
//                           events, clinical requirements, owner/test
//                           matrices) recorded per-requirement outcomes.
//   qualified-decomposition the source-exact blind model reconstruction
//                           qualified the decomposition and the document
//                           reader returned per-requirement outcomes that
//                           passed exact-span validation and the audit.
//   opaque-plan             the question was kept whole and verbatim; no
//                           decomposition was qualified. Whether the answer
//                           covers every part was NOT checked.
//
// NOT claimed here:
// - That a certified or qualified outcome is semantically correct. The model
//   audit is fallible; certificates prove only their defined operations.
// - Which part of an opaque question went unanswered. Without a qualified
//   decomposition that remainder is unknowable, so it is never named.
// - That an "unverified" answer is wrong. It may well be complete; the point
//   is that completeness was not established, and we say so.

const freeze = (x) => {
  if (x && typeof x === "object") {
    Object.values(x).forEach(freeze);
    Object.freeze(x);
  }
  return x;
};

// Final kinds (answer-contract.mjs) that assert facts to the asker. Only
// these can over-claim completeness; clarifications, refusals, abstentions
// and social turns assert no answer to the question.
const ASSERTING = new Set(["answered", "partial", "quoted"]);

export class CoverageInputError extends Error {
  constructor(message) {
    super(message);
    this.name = "CoverageInputError";
  }
}

const NOTICE = {
  en: "I haven't verified that this covers every part of the question.",
  hi: "मैंने यह नहीं जाँचा है कि इससे सवाल के हर हिस्से का जवाब मिलता है।",
  hinglish:
    "Maine check nahi kiya ki isse sawaal ke har hisse ka jawab milta hai.",
};

/** The one disclosure sentence for unverified whole-question coverage. */
export function coverageNotice(lang = "en") {
  return NOTICE[lang] ?? NOTICE.en;
}

const certifiedFromRequirementCoverage = (rc, plan) => {
  const complete = rc.complete === true;
  return {
    state: complete ? "established" : "incomplete",
    complete,
    source: rc.source ?? "certified-operation",
    scope: rc.scope ?? null,
    reason: complete
      ? "Every requirement of a qualified request has a source-bound outcome."
      : "A qualified request has at least one requirement without an established answer.",
    questionPlanKey: rc.questionPlanKey ?? null,
    requirements: (rc.outcomes ?? []).map((o) => ({
      requirementId: o.requirementId ?? null,
      text: typeof o.text === "string" ? o.text : null,
      status: o.status ?? null,
    })),
  };
};

/**
 * Decide whole-question coverage for one resolved answer.
 * @param {{questionPlan?: any, requirementCoverage?: any, admission?: any}} shown
 * @param {"answered"|"partial"|"quoted"|"clarify"|"refused"|"abstained"|"social"} kind
 *   the final kind from answer-contract.mjs
 */
export function wholeQuestionCoverage(shown, kind) {
  if (!shown || typeof shown !== "object")
    throw new CoverageInputError("A resolved answer is required.");
  if (typeof kind !== "string")
    throw new CoverageInputError("The final answer kind is required.");
  const plan = shown.questionPlan ?? null;
  // Request identity (original wording, opaque plan key, generation) lives
  // in the sibling `questionPlan`, never here: coverage is a property of the
  // computed answer, so two wordings that share a cached answer share it.
  const base = {};
  if (!ASSERTING.has(kind))
    return freeze({
      ...base,
      state: "not_applicable",
      complete: false,
      source: "no-answer-asserted",
      reason: `A ${kind} response asserts no answer, so it cannot over-claim coverage.`,
      requirements: [],
      unaddressedPartsNamed: false,
    });
  if (
    shown.requirementCoverage &&
    typeof shown.requirementCoverage === "object"
  )
    return freeze({
      ...base,
      ...certifiedFromRequirementCoverage(shown.requirementCoverage, plan),
      unaddressedPartsNamed: true,
    });
  // A schema operation that owns its own qualified plan (exact fields,
  // events, clinical requirements) and recorded an admission outcome.
  if (
    plan?.coverageEstablished === true &&
    plan.requirementSource !== "opaque-lossless" &&
    Array.isArray(plan.requirements) &&
    plan.requirements.length
  ) {
    // An absent admission never certifies completeness: fail closed to
    // unverified rather than inferring coverage from an answered kind.
    if (typeof shown.admission?.complete !== "boolean")
      return freeze({
        ...base,
        state: "unverified",
        complete: false,
        source: "certified-operation",
        scope: null,
        reason:
          "A certified source operation recorded no admission outcome, so whether it covered its plan is not certified.",
        questionPlanKey: plan.key ?? null,
        requirements: plan.requirements.map((r) => ({
          requirementId: r.id ?? null,
          text: typeof r.text === "string" ? r.text : null,
          status: null,
        })),
        unaddressedPartsNamed: true,
      });
    const complete = shown.admission.complete;
    return freeze({
      ...base,
      state: complete ? "established" : "incomplete",
      complete,
      source: "certified-operation",
      scope: null,
      reason: complete
        ? "A certified source operation covered every requirement of its own qualified plan."
        : "A certified source operation did not establish every requirement of its plan.",
      questionPlanKey: plan.key ?? null,
      requirements: plan.requirements.map((r) => ({
        requirementId: r.id ?? null,
        text: typeof r.text === "string" ? r.text : null,
        status: null,
      })),
      unaddressedPartsNamed: true,
    });
  }
  return freeze({
    ...base,
    state: "unverified",
    complete: false,
    source: "opaque-plan",
    reason:
      "The question was kept whole and verbatim. No decomposition was qualified, so whether this answer covers every part of it was not checked.",
    semanticQualification: plan?.semanticQualification ?? "unresolved",
    requirements: [],
    // Deliberately false: without a qualified decomposition the unaddressed
    // remainder of an opaque question cannot be known, so it is never named.
    unaddressedPartsNamed: false,
  });
}

/**
 * Per-requirement coverage from a qualified document reading. Returns null
 * unless the reading carries BOTH the plan qualification and per-requirement
 * outcomes; in that case the caller keeps opaque-plan provenance.
 */
export function documentRequirementCoverage(documentLead) {
  const plan = documentLead?.requestPlan;
  if (
    documentLead?.origin !== "document-model-audited" ||
    plan?.coverageEstablished !== true ||
    !Array.isArray(plan.requirements) ||
    !plan.requirements.length ||
    !Array.isArray(documentLead.outcomes)
  )
    return null;
  const byId = new Map(documentLead.outcomes.map((o) => [o.requirementId, o]));
  const outcomes = [];
  for (const r of plan.requirements) {
    const o = byId.get(r.id);
    if (!o || !["answered", "not_established", "clarify"].includes(o.status))
      return null;
    outcomes.push({ requirementId: r.id, text: r.text, status: o.status });
  }
  if (byId.size !== outcomes.length) return null;
  const count = outcomes.filter((o) => o.status === "answered").length;
  return freeze({
    questionPlanKey: plan.key,
    source: "qualified-decomposition",
    complete: count === outcomes.length,
    status:
      count === outcomes.length ? "covered" : count ? "partial" : "unresolved",
    scope: "source-exact-decomposition-with-model-audit",
    semanticAdmissionVerified: false,
    outcomes,
    limitations: [
      "Requirements are exact spans of the original question. Model reading and audit are fallible; spans and quotes are verified exactly.",
    ],
  });
}

/** Unestablished requirements, verbatim, for a qualified decomposition only. */
export function unestablishedNotice(requirementCoverage) {
  if (requirementCoverage?.source !== "qualified-decomposition") return null;
  const missing = (requirementCoverage.outcomes ?? []).filter(
    (o) => o.status !== "answered" && typeof o.text === "string",
  );
  if (!missing.length) return null;
  return `Not established from these documents: ${missing
    .map((o) => `“${o.text.trim()}”`)
    .join("; ")}.`;
}

/**
 * Reconcile one resolved answer with its coverage before anyone sees it.
 * Mutates and returns `shown`: attaches `wholeQuestion`, and when coverage
 * is unverified appends the disclosure to the lead text so every consumer
 * (typed, voice, agents) carries the same words. Idempotent.
 */
export function reconcileWholeQuestion(shown, kind, lang = "en") {
  const coverage = wholeQuestionCoverage(shown, kind);
  shown.wholeQuestion = coverage;
  if (coverage.state === "unverified" && shown.lead?.text) {
    const notice = coverageNotice(lang);
    if (!shown.lead.text.includes(notice))
      shown.lead.text = `${shown.lead.text.trim()} ${notice}`;
    shown.lead.coverageNotice = notice;
  }
  return shown;
}
