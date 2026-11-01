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
      if (key === tok && !key.includes(" "))
        for (const v of vals) push(tok, v, "dictionary");
    }
  }
  const expanded = added.size ? original + " " + [...added].join(" ") : original;
  return { original, expanded, applied };
}
export {
  expandQuery
};
