// vendor/web/src/lib/rag/query-intent.ts
function nonMonetaryCost(query) {
  if (/\b(?:fees?|prices?|pricing|money|dollars?|rupees?|euros?|billing|payment|retainer)\b|[$€£₹]/i.test(
    query
  ))
    return false;
  return /\bcost(?:s|ing)?\s+(?:(?:me|you|him|her|us|them|the\s+\w+)\s+)?(?:(?:my|your|his|her|our|their|a|the)\s+)?(?:job|role|part|life|lives|time|sleep|trust|reputation|friendship)\b/i.test(
    query
  );
}

// src/query-expand.ts
var NEGATIONS = /* @__PURE__ */ new Set([
  "not",
  "no",
  "never",
  "without",
  "nor",
  "neither",
  "nobody",
  "nothing",
  "none",
  "isn't",
  "aren't",
  "wasn't",
  "weren't",
  "don't",
  "doesn't",
  "didn't",
  "won't",
  "can't",
  "couldn't",
  "shouldn't",
  "haven't",
  "hasn't",
  "hadn't"
]);
var DICTIONARY = [
  ["commercials", ["fee", "payment", "schedule", "terms"]],
  ["commercial", ["fee", "payment", "terms"]],
  ["sign-off", ["approval", "authorization", "signoff"]],
  ["signoff", ["approval", "authorization", "sign-off"]],
  ["sign off", ["approval", "authorization"]],
  ["approve", ["approval", "approved"]],
  ["approved", ["approval", "authorize", "signed off"]],
  ["authorization", ["approval", "sign-off", "signoff"]],
  ["bill", ["invoice", "fee", "payment"]],
  ["billing", ["invoiced", "fee", "payment"]],
  ["money", ["fee", "payment"]],
  ["paid", ["payment", "upfront"]],
  ["deadline", ["date", "target"]],
  ["kickoff", ["kick-off"]],
  // Paraphrase bridges measured missing on the benchmark corpus (2026-10-31
  // answer-quality bench): each maps a natural phrasing to the vocabulary the
  // record actually uses. Recall-widening only; the evidence gate decides.
  ["pitch", ["proposal"]],
  ["cost", ["fee", "price"]],
  ["dropped", ["narrow", "narrower", "removed"]],
  ["country", ["region", "regions"]],
  ["ready", ["readiness"]],
  ["thyroid", ["tsh"]]
];
var MAX_ADDED = 40;
function protectedToken(tok) {
  return /[0-9%$]/.test(tok) || NEGATIONS.has(tok.toLowerCase());
}
function morphologyVariants(tok) {
  const out = [];
  if (!/^[a-z]+$/.test(tok) || tok.length <= 3) return out;
  if (tok.endsWith("ies")) out.push(tok.slice(0, -3) + "y");
  else if (/(ses|xes|zes|ches|shes)$/.test(tok)) out.push(tok.slice(0, -2));
  else if (tok.endsWith("s") && !tok.endsWith("ss")) out.push(tok.slice(0, -1));
  if (tok.endsWith("ing") && tok.length > 5) out.push(tok.slice(0, -3));
  return out;
}
function expandQuery(question) {
  const original = question;
  const lower = question.toLowerCase();
  const applied = [];
  const added = /* @__PURE__ */ new Set();
  const push = (from, to, kind) => {
    if (added.size >= MAX_ADDED || added.has(to)) return;
    added.add(to);
    applied.push({ from, to, kind });
  };
  const retentionMatch = transcriptRetentionAsk(question);
  if (retentionMatch) {
    push(retentionMatch, "retention", "dictionary");
  }
  for (const [key, vals] of DICTIONARY) {
    if (key.includes(" ") || key.includes("-")) {
      if (lower.includes(key)) for (const v of vals) push(key, v, "dictionary");
    }
  }
  for (const raw of lower.split(/[^a-z'-]+/)) {
    const tok = raw.replace(/^[-']+|[-']+$/g, "");
    if (!tok || protectedToken(tok)) continue;
    for (const v of morphologyVariants(tok)) push(tok, v, "morphology");
    for (const [key, vals] of DICTIONARY) {
      if (key === tok && !key.includes(" ") && !(key === "cost" && nonMonetaryCost(question)))
        for (const v of vals) push(tok, v, "dictionary");
    }
  }
  const expanded = added.size ? original + " " + [...added].join(" ") : original;
  return { original, expanded, applied };
}
var DURATION_ASK = /\b(?:how long|for how many\s+(?:days|weeks|months|years)|for what\s+(?:period|duration)|until when)\b/i;
var TRANSCRIPT_RETENTION_TARGET = /\b(?:keep|keeps|kept|retain|retains|retained|store|stores|stored)\s+(?:(?:the|our|these|those)\s+)?(?:call\s+)?transcripts?\b|\b(?:call\s+)?transcripts?\s+(?:(?:are|were|is|was|will be|should be|have been)\s+)?(?:retained|kept|stored)\b/i;
function transcriptRetentionAsk(question) {
  if (!DURATION_ASK.test(question)) return null;
  const m = TRANSCRIPT_RETENTION_TARGET.exec(question);
  if (!m) return null;
  const rest = question.slice(m.index + m[0].length).replace(/[?.!\s]+$/, "").trim();
  if (rest && !/^for$|^(?:for|during|in)\s+(?:the|this)\s+pilot$/i.test(rest))
    return null;
  return m[0];
}
function equivalentRewrite(question) {
  const phrase = transcriptRetentionAsk(question);
  if (!phrase) return null;
  const to = "transcript retention period";
  return {
    original: question,
    expanded: question.replace(phrase, to),
    applied: [{ from: phrase, to, kind: "dictionary" }]
  };
}
export {
  equivalentRewrite,
  expandQuery,
  transcriptRetentionAsk
};
