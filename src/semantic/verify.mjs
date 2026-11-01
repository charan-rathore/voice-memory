// Layer 4 (semantic verification) and layer 6 (final response audit).
//
// A citation proves where words came from, not that the answer is right. So a
// model-proposed claim is accepted only when ALL of these hold:
//   - its quote, with placeholders restored, is a literal span of the original
//     passage (and therefore of the source document);
//   - every number and unit in its statement appears in that quote;
//   - its status words don't upgrade the quote ("proposed" never becomes
//     "approved", "preliminary" never becomes "final");
//   - its polarity matches (a negated quote can't back an affirmed statement);
//   - it names no subject other than the passage's own.
// The audit then checks the whole answer against the question's intent.

const NUM_RE = /(?<![\w.-])\$?\d[\d,]*(?:\.\d+)?%?/g;
const UNIT_RE =
  /\b(?:mg\/dl|g\/dl|ng\/ml|pg\/ml|µmol\/l|umol\/l|μmol\/l|mmol\/l|miu\/l|µiu\/ml|uiu\/ml|iu\/l|u\/l|mm\/hr|fl|pg|cells\/cumm|lakhs?\/cumm|10\^3\/µl)\b/gi;
const NEG_RE =
  /\b(not|no|never|none|without|neither|nor|isn't|wasn't|aren't|weren't|doesn't|didn't|hasn't|haven't|cannot|can't|nahi|nahin|na)\b|नहीं|न\b/i;
const WEAK_STATUS =
  /\b(propos\w*|pending|draft|discuss\w*|prelim\w*|provisional|tentative|under review|subject to|awaiting|open|suggest\w*|consider\w*|target)\b/i;
const STRONG_STATUS =
  /\b(approv\w*|agreed|sign(ed)?|final(i[sz]ed)?|confirm\w*|decided|accepted|binding|settled)\b/i;
const SUBJECT_RE = /\b(SYN-\d{3,}|\[ID\d+\])/g;

const numbersIn = (s) =>
  (String(s ?? "").match(NUM_RE) ?? []).map((n) =>
    n.replace(/[$,%]/g, "").replace(/\.0+$/, ""),
  );
const unitsIn = (s) =>
  (String(s ?? "").match(UNIT_RE) ?? []).map((u) =>
    u.toLowerCase().replace(/[μu]mol/, "µmol"),
  );
const squash = (s) =>
  String(s ?? "")
    .replace(/\s+/g, " ")
    .trim();

/**
 * @param {{statement:string, passage:number, quote:string, polarity?:string, subject?:string}[]} claims
 * @param {{text:string, restore:(s:string)=>string, evidence:{sourceId,title,hash,start,end,quote}, subject?:string}[]} passages
 * @returns {{accepted: {statement:string, evidence:object}[], rejected: {claim:object, reason:string}[]}}
 */
export function verifyClaims(claims, passages) {
  const accepted = [];
  const rejected = [];
  for (const c of Array.isArray(claims) ? claims : []) {
    const p = passages[c?.passage];
    if (!p) {
      rejected.push({ claim: c, reason: "no_passage" });
      continue;
    }
    const statement = squash(p.restore(c.statement));
    const quote = squash(p.restore(c.quote));
    if (quote.length < 4) {
      rejected.push({ claim: c, reason: "empty_quote" });
      continue;
    }
    // Literal span: find the quote in the original passage, tolerating only
    // whitespace differences, and map back to exact source offsets.
    const src = p.evidence.quote;
    const pattern = quote
      .split(" ")
      .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join("\\s+");
    const m = new RegExp(pattern).exec(src);
    if (!m) {
      rejected.push({ claim: c, reason: "quote_not_in_source" });
      continue;
    }
    const exact = m[0];
    // Every number and unit stated must be printed in the quoted words.
    const qn = new Set(numbersIn(exact));
    const missingNum = numbersIn(statement).filter((n) => !qn.has(n));
    if (missingNum.length) {
      rejected.push({
        claim: c,
        reason: `value_not_in_quote:${missingNum[0]}`,
      });
      continue;
    }
    const qu = new Set(unitsIn(exact));
    const missingUnit = unitsIn(statement).filter((u) => !qu.has(u));
    if (missingUnit.length) {
      rejected.push({
        claim: c,
        reason: `unit_not_in_quote:${missingUnit[0]}`,
      });
      continue;
    }
    // Status may not be upgraded: a proposal stays a proposal.
    // A status the statement asserts (approved, signed, final...) must be
    // printed in the quoted words themselves.
    if (STRONG_STATUS.test(statement) && !STRONG_STATUS.test(exact)) {
      rejected.push({ claim: c, reason: "status_upgraded" });
      continue;
    }
    // Polarity: "no effusion" cannot back "there is an effusion".
    const quoteNeg = NEG_RE.test(exact);
    const stmtNeg = NEG_RE.test(statement) || c.polarity === "negated";
    if (quoteNeg !== stmtNeg && !WEAK_STATUS.test(statement)) {
      rejected.push({ claim: c, reason: "polarity_mismatch" });
      continue;
    }
    // Subject: a claim may only name the passage's own subject.
    const named = [...new Set(statement.match(SUBJECT_RE) ?? [])];
    if (p.subject && named.some((s) => s !== p.subject)) {
      rejected.push({ claim: c, reason: "subject_mismatch" });
      continue;
    }
    const start = p.evidence.start + m.index;
    accepted.push({
      statement,
      evidence: {
        ...p.evidence,
        start,
        end: start + exact.length,
        quote: exact,
      },
    });
  }
  return { accepted, rejected };
}

const CAUSAL =
  /\b(because|reason|due to|caused|since|as a result|ties? (it|this) to|so that|transcription|error|don't say why|doesn't say why|don't record|doesn't record|not recorded|no reason|kyunki|kaaran|wajah)\b|क्योंकि|कारण|वजह/i;
const DATE_NUM =
  /\b\d{1,2}\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|january|february|march|april|june|july|august|september|october|november|december|जनवरी|फ़रवरी|मार्च|अप्रैल|मई|जून|जुलाई|अगस्त|सितंबर|अक्टूबर|नवंबर|दिसंबर)\w*\s*,?\s*\d{4}\b|\b\d{4}-\d{2}-\d{2}\b|\b(?:19|20)\d{2}\b|\b1 in 20\b|\b20 में से 1\b|\b20 mein se 1\b/gi;
const VALUE_VERDICTS = new Set([
  "LATEST",
  "SINGLE",
  "COMPARED",
  "PROPOSED",
  "APPROVED",
  "AGREED",
  "NUMBER",
  "VALUE",
]);

/**
 * Final response audit.
 * @param {{intent:string, measure?:string|null}} intent
 * @param {{text:string, verdict:string, citations?:any[], background?:{text:string}|null}|null} lead
 * @returns {{ok: boolean, reason?: string}}
 */
export function auditLead(intent, lead) {
  if (!lead?.text) return { ok: true };
  const text = String(lead.text);
  // A "why" must be met with a reason, or an honest "not recorded" -
  // never with a bare value in its place.
  if (
    intent.intent === "WHY" &&
    VALUE_VERDICTS.has(lead.verdict) &&
    !CAUSAL.test(text)
  )
    return { ok: false, reason: "why_answered_with_value" };
  // A measurement the record can't hold must not be answered with other values.
  if (
    intent.intent === "MISSING" &&
    !["NOT_IN_REPORT", "UNKNOWN", "NO-RECORD"].includes(lead.verdict)
  )
    return { ok: false, reason: "missing_answered_with_other_values" };
  // Model-worded answers: every number must be printed in a cited span or in
  // the labelled general background (dates and "1 in 20" are phrasing).
  // Deterministic answers compute counts ("3 of 6 outside the range") from
  // typed rows, so this check is for text a model wrote.
  if (lead.origin !== "model") return { ok: true };
  const cited = (lead.citations ?? []).map((c) => c.quote ?? "").join(" \n ");
  const allowed = new Set([
    ...numbersIn(cited),
    ...numbersIn(lead.background?.text ?? ""),
  ]);
  const stated = numbersIn(text.replace(DATE_NUM, " "));
  const unsupported = stated.filter((n) => !allowed.has(n));
  if (unsupported.length && (lead.citations ?? []).length)
    return { ok: false, reason: `unsupported_number:${unsupported[0]}` };
  return { ok: true };
}
