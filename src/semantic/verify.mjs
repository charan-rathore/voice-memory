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
export function verifyClaims(claims, passages, { verifyRelation = null } = {}) {
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
    // Polarity is unconditional: a weak-status word ("pending", "proposed")
    // in the statement cannot launder a flipped negation.
    if (quoteNeg !== stmtNeg) {
      rejected.push({ claim: c, reason: "polarity_mismatch" });
      continue;
    }
    // Subject: a claim may only name the passage's own subject.
    const named = [...new Set(statement.match(SUBJECT_RE) ?? [])];
    if (p.subject && named.some((s) => s !== p.subject)) {
      rejected.push({ claim: c, reason: "subject_mismatch" });
      continue;
    }
    // Lexical checks above establish source integrity, not entailment.
    // Only an independent server-owned relation verifier can admit a claim.
    // A provider's own subject/polarity/verified fields are never authority.
    let relation = null;
    try {
      relation = verifyRelation?.({
        statement,
        quote: exact,
        claim: c,
        passage: p,
      });
    } catch {
      relation = null;
    }
    if (relation?.ok !== true) {
      rejected.push({ claim: c, reason: "relation_entailment_unverified" });
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

// ------------------------------------------------------------ relations
// Does a source sentence STATE the relationship a question asks about?
// Sharing words with the question is not support: "40% payable upfront"
// says nothing about who pays, and "Site: Leeds depot" says nothing about
// who owns it. A sentence supports a relation only when a form of the
// relation's verb is asserted (not negated, not pending) with a named
// agent, and the sentence (or its document heading) is about the object
// that was asked for.
import { RELATIONS, objectTerms } from "./intent.mjs";

const AGENT =
  "(?:[A-Z][\\w.&'’-]*(?:\\s+(?:[A-Z][\\w.&'’-]*|of|and|&))*|[Tt]he\\s+(?:client|customer|vendor|supplier|contractor|tenant|landlord|buyer|seller|company|committee|board|bank|insurer|employer|lender|borrower)(?:'s\\s+\\w+(?:\\s+\\w+)?)?|(?:[Cc]lient\\s+)?[Ff]inance)";
const NOT_AGENT =
  /^(?:The|A|An|It|Its|This|That|These|Those|There|They|Their|He|His|She|Her|We|Our|You|Your|I|My|Who|Which|What|If|When|Once|Until|Unless|No|None|Nobody|Neither|Any|Each|Every|Both|All|Following|After|Before|Per|Subject|Pending|Revised|Original|Proposed|Signed|Approved|Agreed|Final|Draft|Not|Also|And|Or|But|As|Is|Was|Has|Have|Had|Will|Date|Type|Author|Note|Amount|Total)$/;
const ROLE_PARTY =
  /^the\s+(?:client|customer|vendor|supplier|contractor|tenant|landlord|buyer|seller|company|committee|board|bank|insurer|employer|lender|borrower)\b/i;
// A sentence opener or an adjective is not a party; "The committee" is.
const notParty = (agent) =>
  NOT_AGENT.test(String(agent).split(/\s+/)[0]) && !ROLE_PARTY.test(agent);
const NEGATED_NEAR =
  /\b(?:not|never|no|none|without|neither|nor|yet to|to be|unless|until|pending|awaiting|subject to|if|whether|should|must|needs?|requires?)\b[^.;:]{0,60}$/i;

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const has = (hay, term) =>
  /^\$?\d/.test(term)
    ? new RegExp(
        `(?<![\\d$])${escapeRe(term.replace(/^\$/, ""))}(?![\\d])`,
      ).test(
        hay.replace(/,(?=\d{3})/g, "").replace(/\$/g, "") +
          " " +
          hay.replace(/\$/g, ""),
      ) || hay.includes(term)
    : new RegExp(
        `(?<![a-z0-9])${escapeRe(term)}(?:e?s)?(?![a-z0-9])`,
        "i",
      ).test(hay);

/**
 * The agent a sentence asserts for a relation family, or null.
 * @param {string} family key of RELATIONS
 * @param {string} sentence one source sentence, verbatim
 * @returns {null | {agent: string, form: "active"|"passive"}}
 */
export function assertedAgent(family, sentence) {
  const r = RELATIONS[family];
  if (!r) return null;
  const s = String(sentence ?? "");
  // The agent itself is matched case-sensitively: a name is capitalised.
  const agentAt = new RegExp(`^(${AGENT})`);
  // "The budget was approved by the board". A bare label ("Approved by:
  // Priya Nair", "Approver: ...") is a recorded field, not an assertion
  // that the event happened: the field route reports those as observations
  // and they are never taken as support here.
  const m = new RegExp(
    `\\b(?:is|are|was|were|been|be)\\s+(?:\\w+\\s+)?(?:${r.participle})\\s+by\\s+`,
    "i",
  ).exec(s);
  if (m && !NEGATED_NEAR.test(s.slice(0, m.index + 1))) {
    const a = agentAt.exec(s.slice(m.index + m[0].length));
    if (a && !notParty(a[1])) return { agent: a[1].trim(), form: "passive" };
  }
  // "Calder Foods pays the retainer", "Northstar has approved the scope"
  const active = new RegExp(
    `(${AGENT})\\s+(?:(?:has|have|had|will|shall)\\s+)?(?:${r.verb})\\b`,
    "g",
  );
  for (let a; (a = active.exec(s)); ) {
    const agent = a[1].trim();
    if (notParty(agent)) continue;
    // a negation or condition governing the clause voids the assertion
    const before =
      s
        .slice(0, a.index)
        .split(/[.;:]\s+/)
        .pop() ?? "";
    if (NEGATED_NEAR.test(before)) continue;
    return { agent, form: "active" };
  }
  return null;
}

/** Any form of the family at all (asserted or not): "payable", "approval". */
export function mentionsRelation(family, text) {
  const r = RELATIONS[family];
  if (!r) return false;
  return new RegExp(
    `\\b(?:${r.verb}|${r.participle}|${r.role}|${r.event}s?|${r.noun}\\w*)\\b`,
    "i",
  ).test(String(text ?? ""));
}

/** A relation the text denies or leaves pending: "not approved", "no signed agreement". */
export function deniesRelation(family, text) {
  const r = RELATIONS[family];
  if (!r) return false;
  const forms = `(?:${r.verb}|${r.participle}|${r.event}|${r.noun}\\w*)`;
  return new RegExp(
    `\\b(?:not|never|no|without|pending|awaiting)\\b[^.;]{0,40}\\b${forms}\\b|\\b${forms}\\b[^.;]{0,30}\\b(?:is|are|was|were|remains?)\\s+(?:not|pending|outstanding)\\b|\\b${forms}\\b\\s+(?:is|are|was|were)\\s+not\\b`,
    "i",
  ).test(String(text ?? ""));
}

/**
 * Check candidate sentences against a requested relation.
 * @param {{family: string, terms: string[], object?: string}} relation from requestOf()
 * @param {{text: string, context?: string}[]} candidates source sentences (verbatim) with their document heading/type
 * @returns {{supported: {index: number, agent: string, form: string}[], related: number[]}}
 *   `supported`: the sentence asserts the relation with an agent AND binds
 *   every object term. `related`: it mentions the relation or the object
 *   but does not establish the requested claim.
 */
export function relationSupport(relation, candidates) {
  const terms = relation?.terms?.length
    ? relation.terms
    : objectTerms(relation?.object ?? "");
  const supported = [];
  const related = [];
  (candidates ?? []).forEach((c, index) => {
    const text = String(c?.text ?? "");
    const scope = `${text}\n${c?.context ?? ""}`;
    const bound = terms.length > 0 && terms.every((t) => has(scope, t));
    const inSentence = terms.filter((t) => has(text, t)).length;
    const a = assertedAgent(relation.family, text);
    if (a && bound) supported.push({ index, agent: a.agent, form: a.form });
    else if (
      (a && inSentence > 0) ||
      (mentionsRelation(relation.family, text) && inSentence > 0) ||
      (terms.length > 0 && terms.every((t) => has(text, t)))
    )
      related.push(index);
  });
  return { supported, related };
}
