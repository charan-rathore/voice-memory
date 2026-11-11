// What is the person actually asking? A deterministic, multilingual intent
// reader (English, Hindi in Devanagari, romanized Hinglish) that runs before
// any answer is chosen. It never answers anything itself: it tells the router
// which kind of answer would *answer the question*, so a "why" is never met
// with a value and a "what is X" is never met with somebody's result.
//
// Intents
//   WHY         why / reason / kyun / क्यों            -> an explanation, or "the record doesn't say why"
//   TERM        what is X / what does X mean / X kya hota hai -> a definition (general knowledge, labelled)
//   COMPARE     changed / since / higher than before    -> a comparison across reports
//   SUMMARY     summarize / overview / anything abnormal -> a whole-report summary
//   MISSING     a measurement reports like these never hold (blood pressure, pulse...) -> "not in these reports"
//   LOOKUP      the default: a value, a status, a fact
//
// `confidence` is "high" when one cue family decides it, "low" when cues
// conflict or nothing matched; the router only spends a model call on "low".

const WHY_RE =
  /\b(why|how come|what(?:'s| is) the reason|reason (?:for|why|behind)|cause of|explain why|kyu|kyun|kyon|kyoon|kis wajah|kis karan|kaaran|karan kya|wajah)\b|क्यों|क्यूं|कारण|वजह/i;
// "what is X" / "what does X mean" / "define X" / "X kya hai" / "X क्या होता है"
const TERM_RE =
  /^\s*(?:(?:please\s+)?(?:can you\s+)?(?:tell me\s+)?)?(?:what(?:'s| is| are)\s+(?:an?\s+|the\s+)?|what does\s+|what do\s+|define\s+|meaning of\s+|explain\s+(?:what\s+)?(?:an?\s+)?)(.{2,60}?)(?:\s+(?:mean|means|stand for|measure|measures|test|do))?\s*\??\s*$/i;
const TERM_HI_RE =
  /^\s*(.{2,50}?)\s+(?:kya|kya hota|kya hoti|kya hai|kya hota hai|kya hoti hai|kya matlab|ka matlab|ka matlab kya hai|kise kehte hain|क्या है|क्या होता है|क्या होती है|का मतलब|किसे कहते हैं)(?:[\s?।.!]|$).*$/i;
import { canonOf } from "../../clinical/explain.mjs";
// Definitional phrasings: these ask what a word means whatever the word is.
const DEFINITIONAL =
  /^\s*(?:what does .+ (?:mean|stand for|measure)|define\b|meaning of\b|what(?:'s| is) (?:an?)\s|explain what (?:an?\s)?)|\b(?:kya hota|kya hoti|ka matlab|kise kehte)|क्या होता|क्या होती|का मतलब|किसे कहते/i;
// Words that make "what is X" about a person's value, not about the term.
const VALUE_CUES =
  /\b(my|mine|our|his|her|their|patient|result|results|value|values|level|levels|reading|number|score|count|report|reports|latest|current|today|now|this|these|syn-?\d+|mera|meri|mere|uska|uski|unka|aapka|kitna|kitni|kitne)\b|(?<![a-z])\d|मेरा|मेरी|उसका|कितना|कितनी/i;
const COMPARE_RE =
  /\b(chang\w*|increas\w*|decreas\w*|went (up|down)|go(ne)? (up|down)|higher|lower|ris(e|en)|rose|f[ae]ll|fallen|drop\w*|compar\w*|trend\w*|since|previous|last time|before|improv\w*|wors\w*|better|badl\w*|badh\w*|ghat\w*|pichhl\w*|pehle|tulna)\b|बदल|बढ़|घट|पिछल|पहले|तुलना/i;
const SUMMARY_RE =
  /\b(summar\w*|overview|overall|in short|anything (abnormal|wrong|unusual|serious)|what does (this|the) (report|document)s? (say|suggest|show|mean)|explain (this|the|my) (report|results?)|kya keh rahi|kya bata rahi|saar|saransh)\b|सार|सारांश/i;
// Measurements a lab printout or a contract does not carry. Asked about by
// name, the honest answer is that the record does not hold it.
export const ABSENT_MEASURES = [
  [
    "blood pressure",
    [
      "blood pressure",
      "bp reading",
      "bp",
      "systolic",
      "diastolic",
      "बीपी",
      "ब्लड प्रेशर",
    ],
  ],
  ["pulse", ["pulse", "heart rate", "heartbeat", "nabz", "धड़कन"]],
  ["weight", ["weight", "body weight", "vajan", "wajan", "वज़न", "वजन"]],
  ["height", ["height", "lambai", "लंबाई"]],
  ["BMI", ["bmi", "body mass index"]],
  ["temperature", ["temperature", "fever", "bukhar", "बुखार"]],
  ["oxygen saturation", ["oxygen saturation", "spo2", "oxygen level"]],
  ["symptoms", ["symptom", "symptoms", "lakshan", "लक्षण"]],
  ["diagnosis", ["diagnosis", "diagnosed", "disease name", "bimari ka naam"]],
  [
    "medicine dose",
    ["dose", "dosage", "prescription", "medicine to take", "dawai kitni"],
  ],
];

const words = (s) =>
  ` ${String(s)
    .toLowerCase()
    .replace(/[^a-z0-9ऀ-ॿ]+/g, " ")
    .trim()} `;

/** The absent measurement a question names, if any (word-bounded). */
export function absentMeasure(question) {
  const q = words(question);
  for (const [label, forms] of ABSENT_MEASURES)
    for (const f of forms) if (q.includes(words(f))) return label;
  return null;
}

/** The term a TERM question asks about ("what is a retainer" -> "retainer"). */
export function termOf(question) {
  const q = String(question ?? "").trim();
  // "what is the fee?" asks for this record's value; "what is a fee?" or
  // "what is ferritin?" asks what the word means.
  if (/\bwhat(?:'s| is| are)\s+the\b/i.test(q)) return null;
  const m = TERM_RE.exec(q) ?? TERM_HI_RE.exec(q);
  if (!m) return null;
  const t = m[1]
    .replace(/[?.!]+$/, "")
    .replace(/^(?:the|a|an)\s+/i, "")
    .replace(/\s+(?:is|are|means?|stands for)$/i, "")
    .trim();
  if (t.length < 2 || t.split(/\s+/).length > 4) return null;
  // "what is X?" is a definition question only when X is a known term (a
  // lab test in the vetted glossary) or the phrasing is definitional;
  // "what's still open?" is a question about the record.
  return DEFINITIONAL.test(q) || canonOf(t) ? t : null;
}

/**
 * @param {string} question
 * @returns {{intent: "WHY"|"TERM"|"COMPARE"|"SUMMARY"|"MISSING"|"LOOKUP", confidence: "high"|"low", term?: string, measure?: string, cues: string[]}}
 */
export function classifyIntent(question) {
  const q = String(question ?? "");
  const cues = [];
  if (WHY_RE.test(q)) cues.push("why");
  const term = termOf(q);
  const valueCue = VALUE_CUES.test(q);
  if (term && !valueCue) cues.push("term");
  if (COMPARE_RE.test(q)) cues.push("compare");
  if (SUMMARY_RE.test(q)) cues.push("summary");
  const measure = absentMeasure(q);
  if (measure) cues.push("missing");

  // "why" decides: the question wants a reason whatever else it mentions.
  if (cues.includes("why"))
    return { intent: "WHY", confidence: "high", cues, measure };
  if (cues.includes("missing"))
    return { intent: "MISSING", confidence: "high", cues, measure };
  if (cues.includes("term"))
    return {
      intent: "TERM",
      confidence: cues.length === 1 ? "high" : "low",
      term,
      cues,
    };
  if (cues.includes("summary"))
    return { intent: "SUMMARY", confidence: "high", cues };
  if (cues.includes("compare"))
    return { intent: "COMPARE", confidence: "high", cues };
  // Nothing matched: a plain lookup, but say so honestly. Very short
  // fragments ("and creatinine?") are follow-ups the context resolves.
  return {
    intent: "LOOKUP",
    confidence: q.trim().split(/\s+/).length <= 2 || valueCue ? "high" : "low",
    cues,
  };
}

// ------------------------------------------------------------ request frame
// What the question REQUIRES of an answer, beyond its intent: a requested
// relationship ("who pays X", "did A approve X"), its polarity, a version
// qualifier ("first proposed", "latest") and the amounts it names. A closed,
// anchored grammar over ONE clause: a question it does not fully consume
// (a compound, a condition, a follow-up) gets no relation, never a guessed
// one, and is never split here. Nothing here answers
// anything; the final admission (answer-admission.mjs) reads these slots to
// check that the admitted text addresses the request that was made.

/** Relation families: every surface form the grammar accepts. */
export const RELATIONS = {
  pay: {
    verb: "pays?|paid|paying",
    participle: "paid|payable",
    role: "payer",
    noun: "pay",
    event: "payment",
  },
  approve: {
    verb: "approves?|approved|approving|authori[sz]e[sd]?|sign(?:s|ed)? off|signs? off",
    participle: "approved|authori[sz]ed|signed off",
    role: "approver",
    noun: "approve",
    event: "approval",
  },
  sign: {
    verb: "signs?|signed|signing|countersigns?|countersigned",
    participle: "signed|countersigned",
    role: "signatory|signer",
    noun: "sign",
    event: "signature",
  },
  own: {
    verb: "owns?|owned|owning",
    participle: "owned",
    role: "owner",
    noun: "own",
    event: "ownership",
  },
  propose: {
    verb: "proposes?|proposed|proposing",
    participle: "proposed",
    role: "proposer",
    noun: "propose",
    event: "proposal",
  },
  request: {
    verb: "asks?|asked|requests?|requested",
    participle: "requested",
    role: "requester",
    noun: "request",
    event: "request",
  },
};
const familyOf = (form) => {
  const f = String(form).toLowerCase();
  for (const [family, r] of Object.entries(RELATIONS))
    if (new RegExp(`^(?:${r.verb}|${r.participle}|${r.role})$`, "i").test(f))
      return family;
  return null;
};
const ANY = (key) =>
  Object.values(RELATIONS)
    .map((r) => r[key])
    .join("|");
const VERB = ANY("verb");
const PARTICIPLE = ANY("participle");
const ROLE = ANY("role");
const AUX = "does|did|do|has|have|had|will|is|are|was|were";
// A named party: capitalised words, or a role the documents use for a side.
const PARTY =
  "(?:[A-Z][\\w.&'’-]*(?:\\s+(?:[A-Z][\\w.&'’-]*|of|and|&))*|the\\s+(?:client|customer|vendor|supplier|contractor|tenant|landlord|buyer|seller|company|committee|board|bank|insurer|employer|lender|borrower)(?:'s\\s+\\w+(?:\\s+\\w+)?)?|(?:client\\s+)?finance)";
const VERSION_WORD =
  /^(?:revised|original|latest|current|first|initial|earliest|new|newest|final|agreed|proposed|signed|approved|previous|earlier|updated)$/;
const FRAME_STOP = new Set(
  "a an the this that these those its their our my your his her of for to in on at by with from and or own any all per".split(
    " ",
  ),
);
const stemOf = (t) =>
  t.length > 3 && !/\d/.test(t)
    ? t.replace(/(?:ies)$/, "y").replace(/(?:es|s)$/, "")
    : t;
/** Content tokens of a noun phrase, stemmed; numbers and ids kept verbatim. */
export function objectTerms(phrase) {
  return (
    String(phrase ?? "")
      .toLowerCase()
      .match(/\$?\d[\d,]*(?:\.\d+)?%?|[a-z][a-z0-9'’-]*/g) ?? []
  )
    .map((t) => t.replace(/['’]s$/, ""))
    .filter((t) => t && !FRAME_STOP.has(t) && !VERSION_WORD.test(t))
    .map(stemOf);
}
const cleanObject = (s) =>
  String(s ?? "")
    .trim()
    .replace(/[?.!]+$/, "")
    .replace(/^(?:for|on|off on)\s+/i, "")
    .trim();

function relationOf(q) {
  let m;
  // "Who pays the retainer?", "Which party approved the fee?"
  m = new RegExp(
    `^(?:who|which (?:party|company|person|team|side|organi[sz]ation))\\s+(?:has\\s+|have\\s+|had\\s+|will\\s+|is\\s+|actually\\s+|finally\\s+)?(${VERB})\\s+(.+?)\\??$`,
    "i",
  ).exec(q);
  if (m && cleanObject(m[2]))
    return {
      family: familyOf(m[1]),
      ask: "actor",
      actor: null,
      object: cleanObject(m[2]),
    };
  // "Who is the payer of the retainer?", "Who is the owner of X?"
  m = new RegExp(
    `^who\\s+(?:is|are|was|were)\\s+the\\s+(${ROLE})s?\\s+(?:of|for|on)\\s+(.+?)\\??$`,
    "i",
  ).exec(q);
  if (m)
    return {
      family: familyOf(m[1]),
      ask: "actor",
      actor: null,
      object: cleanObject(m[2]),
    };
  // "Who was the fee approved by?", "By whom was the agreement signed?"
  m =
    new RegExp(
      `^who\\s+(?:is|are|was|were|has|have)\\s+(.+?)\\s+(?:been\\s+)?(${PARTICIPLE})\\s+by\\??$`,
      "i",
    ).exec(q) ??
    new RegExp(
      `^by whom\\s+(?:is|are|was|were|has|have)\\s+(.+?)\\s+(?:been\\s+)?(${PARTICIPLE})\\??$`,
      "i",
    ).exec(q);
  if (m)
    return {
      family: familyOf(m[2]),
      ask: "actor",
      actor: null,
      object: cleanObject(m[1]),
    };
  // "Was the fee approved by Calder Foods?"
  m = new RegExp(
    `^(?:${AUX})\\s+(.+?)\\s+(?:been\\s+)?(not\\s+)?(${PARTICIPLE})\\s+by\\s+(${PARTY})\\??$`,
  ).exec(q[0].toLowerCase() + q.slice(1));
  if (m)
    return {
      family: familyOf(m[3]),
      ask: "polar",
      actor: m[4].trim(),
      object: cleanObject(m[1]),
      negated: !!m[2],
    };
  // "Does Harbor Logistics pay the retainer?", "Did the client sign the agreement?"
  m = new RegExp(
    `^(?:${AUX})\\s+(${PARTY})\\s+(not\\s+)?(?:also\\s+)?(pay|approve|authori[sz]e|sign off|sign|countersign|own|propose|ask|request|${VERB})\\s+(.+?)\\??$`,
  ).exec(q[0].toLowerCase() + q.slice(1));
  if (m && cleanObject(m[4])) {
    const base = {
      pay: "pay",
      approve: "approve",
      authorise: "approve",
      authorize: "approve",
      "sign off": "approve",
      sign: "sign",
      countersign: "sign",
      own: "own",
      propose: "propose",
      ask: "request",
      request: "request",
    };
    return {
      family: base[m[3].toLowerCase()] ?? familyOf(m[3]),
      ask: "polar",
      actor: m[1].trim(),
      object: cleanObject(m[4]),
      negated: !!m[2],
    };
  }
  return null;
}

const NOT_A_PARTY =
  /^(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|january|february|march|april|may|june|july|august|september|october|november|december|today|tomorrow|yesterday|then|now|q[1-4])\b/i;

const POLAR_START = new RegExp(
  `^(?:${AUX}|isn't|wasn't|aren't|weren't|hasn't|haven't|didn't|doesn't|don't|won't|can|could|should)\\b`,
  "i",
);
const NEGATION =
  /\b(?:not|never|no longer|isn't|wasn't|aren't|weren't|hasn't|haven't|didn't|doesn't|don't|won't|un(?:signed|approved|paid|confirmed))\b/i;
/**
 * The request frame of one question, read from its exact wording.
 * @returns {{relation: null | {family: string, ask: "actor"|"polar", actor: string|null, object: string, terms: string[], negated?: boolean},
 *   polar: boolean, negated: boolean,
 *   version: null | "first" | "previous" | "latest",
 *   statusAsked: null | "proposed" | "approved",
 *   amounts: string[]}}
 */
export function requestOf(question) {
  const q = String(question ?? "")
    .trim()
    .replace(/\s+/g, " ");
  let relation = relationOf(q);
  // "approved by Friday" names a time, not a party: no relation is claimed.
  if (relation?.actor && NOT_A_PARTY.test(relation.actor)) relation = null;
  // The grammar consumes ONE clause. An object that carries a conjunction,
  // a second question or a condition is a compound request: it stays
  // opaque (whole-question-coverage.mjs), and no relation is claimed.
  if (
    relation &&
    /[;?:]|,(?!\d{3})|\b(?:and|or|but|nor|if|unless|whether|when|while|after|before|because|who|whom|what|where|why|how|which)\b/i.test(
      relation.object,
    )
  )
    relation = null;
  if (relation) relation.terms = objectTerms(relation.object);
  const polar = POLAR_START.test(q);
  const version = /\b(?:first|original(?:ly)?|initial(?:ly)?|earliest)\b/i.test(
    q,
  )
    ? "first"
    : /\b(?:previous(?:ly)?|earlier|before (?:that|it|the (?:change|revision|amendment|correction)))\b/i.test(
          q,
        )
      ? "previous"
      : /\b(?:latest|current(?:ly)?|newest|most recent|now)\b/i.test(q)
        ? "latest"
        : null;
  const statusAsked = /\b(?:propos\w*|offer(?:ed)?|quoted?)\b/i.test(q)
    ? "proposed"
    : /\b(?:approved|agreed|signed|final(?:i[sz]ed)?|confirmed)\b/i.test(q)
      ? "approved"
      : null;
  return {
    relation: relation?.family ? relation : null,
    polar,
    negated: polar && NEGATION.test(q),
    version,
    statusAsked,
    amounts:
      q.match(
        /\$\s?\d[\d,]*(?:\.\d+)?|\b\d[\d,]*(?:\.\d+)?\s?(?:%|percent)/g,
      ) ?? [],
  };
}
