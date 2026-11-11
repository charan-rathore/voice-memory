// One authoritative answer per question.
//
// The engine produces two things for a question: a structured `lead` (the
// verified sentence the screen shows and the voice call speaks) and the raw
// retrieval result underneath it. The public response used to expose both
// as peers, so an agent reading `answer` could get "unresolved" while the
// lead correctly said "50 ng/mL, corrected from 5". This module decides, in
// one place, what the answer IS: the lead when there is one, otherwise an honest abstention
// with related evidence kept separate. Everything a person or an
// agent sees - typed text, spoken sentence, chart caption - derives from it.

// What kind of answer each verdict is. Anything not listed is "answered".
const KIND = {
  PARTIAL_FIELDS: "partial",
  PARTIAL_DOCUMENT: "partial",
  SOURCE_OUTLINE: "partial",
  AMBIGUOUS_PATIENT: "clarify",
  AMBIGUOUS: "clarify",
  CLARIFY: "clarify",
  NOT_COMPARABLE: "refused",
  UNBOUND_OWNER: "refused",
  DECLINE_ADVICE: "refused",
  NOT_IN_REPORT: "abstained",
  NOT_IN_DOCUMENTS: "abstained",
  NO_REASON: "abstained",
  UNKNOWN: "abstained",
  HELP: "social",
  HOW_TO: "social",
};

export const ABSTAIN_TEXT =
  "That isn't covered in these documents, so I can't answer it from them. Ask me about anything they contain: results, dates, changes, amounts or who signed what.";

/** @typedef {"answered"|"clarify"|"refused"|"abstained"|"social"|"quoted"|"partial"} FinalKind */

/**
 * The single answer for a resolved question.
 * @param {{lead?: any, evidence?: any[]}} shown
 * @returns {{text: string, verdict: string, kind: FinalKind,
 *   citations: any[], relatedEvidence: any[], from: "lead"|"evidence"|"none",
 *   coverage?: any, complete?: boolean, admittedText: string|null,
 *   answeredRequirements: any[], unresolvedRequirements: any[],
 *   scope: {key: string|null, version: any}|null}}
 *
 * `coverage` and `complete` are additive (whole-question-coverage.mjs). They
 * do not change what `kind` means: an "answered" kind says the lead asserts
 * a source-backed answer; `complete` says whether it was ESTABLISHED to
 * cover the whole question. `complete: false` with coverage state
 * "unverified" means coverage was not checked, not that an answer is wrong.
 */
export function finalAnswer(shown) {
  const core = finalAnswerCore(shown);
  const result = shown?.wholeQuestion
    ? {
        ...core,
        coverage: shown.wholeQuestion,
        complete: shown.wholeQuestion.complete === true,
      }
    : core;
  return { ...result, ...requestView(shown, result) };
}

// Kinds that assert a source-backed fact to the asker.
const ASSERTS = new Set(["answered", "partial", "quoted"]);

/**
 * The canonical, additive request view of one answer. Every consumer
 * (typed UI, voice, source viewer, charts) reads these fields; none of them
 * derives its own.
 *
 *   admittedText            the text admitted as an answer, or null when
 *                           nothing was admitted (clarify, refusal,
 *                           abstention, social)
 *   answeredRequirements    requirements with a supported outcome
 *   unresolvedRequirements  requirements that are unsupported, or need a
 *                           clarification ("unresolved")
 *   relatedEvidence         passages that are relevant but do NOT establish
 *                           the answer; always an array, never mixed into
 *                           `citations`
 *   scope                   { key, version } the document scope and the
 *                           immutable source version the answer was made
 *                           against
 */
function requestView(shown, result) {
  const plan = shown?.questionPlan ?? null;
  const asserts = ASSERTS.has(result.kind);
  // Per-requirement outcomes, from the most specific provenance present:
  // the request admission, else recorded coverage, else the whole question
  // as one requirement whose outcome follows the answer kind.
  let rows = (shown?.requestAdmission?.requirements ?? []).map((r, i) => ({
    requirementId: r.requirementId ?? plan?.requirements?.[i]?.id ?? null,
    text: r.text ?? plan?.requirements?.[i]?.text ?? null,
    outcome: r.outcome,
    reason: r.reason ?? null,
  }));
  if (!rows.length)
    rows = (shown?.wholeQuestion?.requirements ?? [])
      .filter((r) => r.status)
      .map((r) => ({
        requirementId: r.requirementId ?? null,
        text: r.text ?? null,
        outcome:
          r.status === "answered"
            ? "supported"
            : r.status === "clarify"
              ? "unresolved"
              : "unsupported",
        reason: null,
      }));
  if (!rows.length && result.kind !== "social") {
    const first = plan?.requirements?.[0] ?? null;
    rows = [
      {
        requirementId: first?.id ?? null,
        text: plan?.originalQuestion ?? shown?.question ?? null,
        outcome: asserts
          ? "supported"
          : result.kind === "clarify"
            ? "unresolved"
            : "unsupported",
        reason: null,
      },
    ];
  }
  const related = Array.isArray(shown?.relatedEvidence)
    ? shown.relatedEvidence.filter((c) => c?.quote)
    : (result.relatedEvidence ?? []);
  return {
    admittedText: asserts ? result.text : null,
    answeredRequirements: rows.filter((r) => r.outcome === "supported"),
    unresolvedRequirements: rows.filter((r) => r.outcome !== "supported"),
    relatedEvidence: related,
    scope: plan?.scope ?? null,
  };
}

function finalAnswerCore(shown) {
  const lead = shown?.lead ?? null;
  if (lead?.text) {
    const verdict = lead.verdict ?? "UNKNOWN";
    const kind = KIND[verdict] ?? "answered";
    const relatedEvidence =
      kind === "abstained"
        ? (shown?.evidence ?? []).filter((c) => c?.quote)
        : [];
    return {
      text: lead.text,
      verdict,
      kind,
      citations: lead.citations ?? [],
      ...(relatedEvidence.length ? { relatedEvidence } : {}),
      from: "lead",
    };
  }
  const ev = (shown?.evidence ?? []).filter((c) => c?.quote);
  if (ev.length)
    return {
      text: "I found related source passages, but have not established an answer to the full question.",
      verdict: "UNKNOWN",
      kind: "abstained",
      citations: [],
      relatedEvidence: ev,
      from: "evidence",
    };

  return {
    text: ABSTAIN_TEXT,
    verdict: "UNKNOWN",
    kind: "abstained",
    citations: [],
    from: "none",
  };
}
