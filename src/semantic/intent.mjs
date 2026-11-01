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
