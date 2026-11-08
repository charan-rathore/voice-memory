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
 *   citations: any[], relatedEvidence?: any[], from: "lead"|"evidence"|"none"}}
 */
export function finalAnswer(shown) {
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
