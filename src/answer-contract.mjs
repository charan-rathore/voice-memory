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
  "I don't see a supported answer to that in these documents.";

/** @typedef {"answered"|"clarify"|"refused"|"abstained"|"social"|"quoted"|"preview"} FinalKind */

// Words that carry no answer: question words, articles, auxiliaries. Negation
// words are not listed, so a question that uses one needs the shown sentence
// to contain it too.
const STOP = new Set(
  (
    "a an and are as at be been being by can could did do does for from had " +
    "has have how if in into is it its me my of on or our please say says " +
    "tell that the their them then there these they this those to was were " +
    "what when where which who whom whose why will with would your about"
  ).split(" "),
);

/**
 * A light stem: "signing" and "signed" both give "sign"; "approved" and
 * "approval" both give "appro".
 */
export function stemOf(word) {
  if (/^\d+$/.test(word)) return word;
  let s = word;
  for (const suf of ["ment", "ing", "ed", "al", "es", "s", "e"]) {
    if (s.length - suf.length >= 3 && s.endsWith(suf)) {
      s = s.slice(0, -suf.length);
      break;
    }
  }
  return s.length > 5 ? s.slice(0, 5) : s;
}

/** The content stems of a text: no stop words, digits kept. */
export function stemsOf(text) {
  return String(text ?? "")
    .toLowerCase()
    .split(/[^a-z0-9ऀ-ॿ]+/)
    .filter((w) => (w.length >= 2 || /^\d$/.test(w)) && !STOP.has(w))
    .map(stemOf);
}

/** Sentences of a passage, numbering and markdown marks removed. */
export function sentencesOf(text) {
  return String(text ?? "")
    .split(/\n+|(?<=[.!?])\s+(?=\S)/)
    .map((s) => s.replace(/^\s*(?:#+\s*)?(?:\d+[.)]\s+)?/, "").trim())
    .filter((s) => s.length >= 4);
}

/**
 * The first sentence of any passage that carries every content word of the
 * question. Coverage is all-or-nothing: a sentence about "the revised fee"
 * does not answer "is the revised fee approved".
 * @returns {{sentence: string, ev: object}|null}
 */
export function answeringSentence(question, passages) {
  const want = [...new Set(stemsOf(question))];
  if (!want.length) return null;
  for (const p of passages)
    for (const s of sentencesOf(p.text)) {
      const have = new Set(stemsOf(s));
      if (want.every((w) => have.has(w))) return { sentence: s, ev: p.ev };
    }
  return null;
}

// Narrow the citation to the sentence when its exact offsets can be
// computed; otherwise cite the passage as the engine returned it.
function citationsFor(hit, ev) {
  const e = hit.ev;
  const i = e.quote.indexOf(hit.sentence);
  const narrow =
    i >= 0 &&
    Number.isSafeInteger(e.start) &&
    e.end - e.start === e.quote.length;
  const first = narrow
    ? {
        ...e,
        quote: hit.sentence,
        start: e.start + i,
        end: e.start + i + hit.sentence.length,
      }
    : e;
  return [first, ...ev.filter((x) => x !== e)];
}

const clip = (s) => {
  const q = String(s).replace(/\s+/g, " ").trim();
  return q.length > 280 ? q.slice(0, 279) + "…" : q;
};
const moreText = (more) =>
  more ? ` (and ${more} more cited passage${more > 1 ? "s" : ""})` : "";

// Cited passages that do not answer the question: shown as evidence only.
// Nothing is claimed, so the answer is the honest abstention.
function previewOnly(ev, retrieved) {
  return {
    text: ABSTAIN_TEXT,
    verdict: "UNKNOWN",
    kind: "preview",
    citations: [],
    preview: {
      text: `From the document: “${clip(retrieved || ev[0].quote)}”${moreText(
        ev.length - 1,
      )}`,
      citations: ev,
    },
    from: "evidence",
  };
}

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
    const more = ev.length - 1;
    const question = String(shown?.question ?? "").trim();
    if (question) {
      // With the question in hand, the shown sentence must answer it. A
      // passage that merely sits near the question's topic is an evidence
      // preview, never a successful answer.
      const passages = [
        ...(retrieved ? [{ text: retrieved, ev: ev[0] }] : []),
        ...ev.map((e) => ({ text: e.quote, ev: e })),
      ];
      const hit = answeringSentence(question, passages);
      if (!hit) return previewOnly(ev, retrieved);
      const shownText = clip(hit.sentence);
      return {
        text: `From the document: “${shownText}”${moreText(more)}`,
        verdict: "QUOTED",
        kind: "quoted",
        citations: citationsFor(hit, ev),
        from: "evidence",
      };
    }
    const q = clip(retrieved || ev[0].quote);
    return {
      text: `From the document: “${q}”${moreText(more)}`,
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
