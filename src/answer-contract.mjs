// One authoritative answer per question.
//
// The engine produces two things for a question: a structured `lead` (the
// verified sentence the screen shows and the voice call speaks) and the raw
// retrieval result underneath it. The public response used to expose both
// as peers, so an agent reading `answer` could get "unresolved" while the
// lead correctly said "50 ng/mL, corrected from 5". This module decides, in
// one place, what the answer IS: the lead when there is one, otherwise the
// cited passage, otherwise an honest abstention. Everything a person or an
// agent sees - typed text, spoken sentence, chart caption - derives from it.

// What kind of answer each verdict is. Anything not listed is "answered".
const KIND = {
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

const RETRIEVED = /Relevant source excerpts\n\n([\s\S]*?)\n\[Source 1\]/;

export const ABSTAIN_TEXT =
  "That isn't covered in these documents, so I can't answer it from them. Ask me about anything they contain: results, dates, changes, amounts or who signed what.";

/** @typedef {"answered"|"clarify"|"refused"|"abstained"|"social"|"quoted"} FinalKind */

/**
 * The single answer for a resolved question.
 * @param {{lead?: any, evidence?: any[]}} shown
 * @returns {{text: string, verdict: string, kind: FinalKind,
 *   citations: any[], from: "lead"|"evidence"|"none"}}
 */
export function finalAnswer(shown) {
  const lead = shown?.lead ?? null;
  if (lead?.text) {
    const verdict = lead.verdict ?? "UNKNOWN";
    return {
      text: lead.text,
      verdict,
      kind: KIND[verdict] ?? "answered",
      citations: lead.citations ?? [],
      from: "lead",
    };
  }
  const ev = (shown?.evidence ?? []).filter((c) => c?.quote);
  if (ev.length) {
    // A citation quote can span a whole uploaded document; the retrieved
    // passage names the lines the answer actually rests on, so prefer it.
    const retrieved = RETRIEVED.exec(shown?.answer ?? "")?.[1]?.trim();
    const q = String(retrieved || ev[0].quote)
      .replace(/\s+/g, " ")
      .trim();
    const more = ev.length - 1;
    return {
      text: `From the document: “${q.length > 280 ? q.slice(0, 279) + "…" : q}”${more ? ` (and ${more} more cited passage${more > 1 ? "s" : ""})` : ""}`,
      verdict: "QUOTED",
      kind: "quoted",
      citations: ev,
      from: "evidence",
    };
  }
  return {
    text: ABSTAIN_TEXT,
    verdict: "UNKNOWN",
    kind: "abstained",
    citations: [],
    from: "none",
  };
}
