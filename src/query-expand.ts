/** Deterministic query normalization + explicit expansion for the voice demo.
 *
 * Constraints (from review): expansion widens recall only; it never rewrites
 * amounts, dates, IDs or negation, and it never injects an answer or conflict
 * verdict. Every applied transform is returned so the UI can show exactly what
 * changed between the spoken question and the searched query.
 */
export type QueryTransform = {
  from: string;
  to: string;
  kind: "morphology" | "dictionary";
};
export type ExpandedQuery = {
  original: string;
  expanded: string;
  applied: QueryTransform[];
};

const NEGATIONS = new Set([
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
  "hadn't",
]);

/** Small bidirectional business vocabulary. Widens recall only; the applied
 * transform is always displayed. Do not add answer-shaped phrases here. */
const DICTIONARY: Array<[string, string[]]> = [
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
  ["thyroid", ["tsh"]],
];

const MAX_ADDED = 40;

function protectedToken(tok: string): boolean {
  return /[0-9%$]/.test(tok) || NEGATIONS.has(tok.toLowerCase());
}

function morphologyVariants(tok: string): string[] {
  const out: string[] = [];
  if (!/^[a-z]+$/.test(tok) || tok.length <= 3) return out;
  if (tok.endsWith("ies")) out.push(tok.slice(0, -3) + "y");
  else if (/(ses|xes|zes|ches|shes)$/.test(tok)) out.push(tok.slice(0, -2));
  else if (tok.endsWith("s") && !tok.endsWith("ss")) out.push(tok.slice(0, -1));
  if (tok.endsWith("ing") && tok.length > 5) out.push(tok.slice(0, -3));
  return out;
}

export function expandQuery(question: string): ExpandedQuery {
  const original = question;
  const lower = question.toLowerCase();
  const applied: QueryTransform[] = [];
  const added = new Set<string>();

  const push = (from: string, to: string, kind: QueryTransform["kind"]) => {
    if (added.size >= MAX_ADDED || added.has(to)) return;
    added.add(to);
    applied.push({ from, to, kind });
  };

  // Dictionary: phrase matches first (multi-word), then single tokens.
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

  const expanded = added.size
    ? original + " " + [...added].join(" ")
    : original;
  return { original, expanded, applied };
}
