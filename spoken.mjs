// spoken.mjs - deterministic spoken renderer for the voice path.
// The engine (answer/extractClaims/resolveClaims) stays the authority on
// facts; this module only routes intent, resolves the subject, reads the
// resolved claim graph, and fills fixed templates. It never invents facts:
// the guard rejects any rendered sentence whose numbers or approval wording
// are not backed by a cited claim.
import {
  answer,
  extractClaims,
  resolveClaims,
  questionFields,
} from "./dist/engine.mjs";

const FIELD_CANONICAL = {
  fee: "What is the fee?",
  paymentSplit: "What is the payment split?",
  deadline: "What is the deadline?",
  signoffWho: "Who signs off?",
  signoffTiming: "When is sign-off expected?",
  launchApproval: "Is the launch approved?",
  scope: "What is the scope?",
};

const INTENTS = [
  ["WHY", /\bwhy\b|\breason\b/i],
  ["MUTATE", /\b(mark|update|record|edit|approve it|set the|make it)\b/i],
  ["REJECTED", /\b(reject\w*|turned down|refused|declined)\b/i],
  ["SOURCE", /\bwhich (document|doc|file|source)|says that|supports? that|where does it say/i],
  ["HISTORY", /\b(earlier|before|original(?:ly)?|remember|used to|previous|wasn'?t it|weren'?t it)\b/i],
  ["FINALIZED", /\b(finali[sz]ed?|final|agreed|signed|locked|confirmed?|definitely|for sure|done deal)\b/i],
  ["LATEST", /\b(latest|current|now|today|split|fee|amount|status)\b/i],
];

const ALL_FIELDS = Object.keys(FIELD_CANONICAL);

const NUM_WORDS = {
  0: "zero", 1: "one", 2: "two", 3: "three", 4: "four", 5: "five",
  6: "six", 7: "seven", 8: "eight", 9: "nine", 10: "ten", 11: "eleven",
  12: "twelve", 13: "thirteen", 14: "fourteen", 15: "fifteen",
  16: "sixteen", 17: "seventeen", 18: "eighteen", 19: "nineteen",
  20: "twenty", 30: "thirty", 40: "forty", 50: "fifty", 60: "sixty",
  70: "seventy", 80: "eighty", 90: "ninety",
};
function spellNumber(n) {
  n = Math.round(Number(n));
  if (!Number.isFinite(n) || n < 0) return String(n);
  if (NUM_WORDS[n]) return NUM_WORDS[n];
  if (n < 100)
    return NUM_WORDS[Math.floor(n / 10) * 10] + "-" + NUM_WORDS[n % 10];
  if (n < 1000) {
    const rest = n % 100;
    return NUM_WORDS[Math.floor(n / 100)] + " hundred" + (rest ? " " + spellNumber(rest) : "");
  }
  if (n < 1000000) {
    const th = Math.floor(n / 1000), rest = n % 1000;
    return spellNumber(th) + " thousand" + (rest ? " " + spellNumber(rest) : "");
  }
  return n.toLocaleString("en-US");
}
// "42,000" / "$42,000" -> "forty-two thousand dollars"; bare "40/60" stays digits.
function speakAmount(raw, { dollars = false } = {}) {
  const m = String(raw).replace(/[$€£₹]\s?/, "");
  if (m.includes("/")) return m; // splits are read as digits by TTS acceptably
  const n = Number(m.replace(/,/g, ""));
  if (!Number.isFinite(n)) return String(raw);
  return spellNumber(n) + (dollars ? " dollars" : "");
}

const MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];
function speakDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || "");
  if (!m) return iso || "";
  return `${MONTHS[Number(m[2]) - 1]} ${Number(m[3])}`;
}
// "03_Commercial_Revision.md" -> "the commercial revision memo"
function docLabel(claim) {
  const base = (claim.title || "")
    .replace(/\.md$/i, "")
    .replace(/^\d+_/, "")
    .replace(/_/g, " ")
    .toLowerCase();
  const date = speakDate(claim.docDate);
  return `the ${base}${date ? ` from ${date}` : ""}`;
}

function routeIntent(q) {
  for (const [name, re] of INTENTS) if (re.test(q)) return name;
  return "OTHER";
}

// Resolve the subject field: engine's questionFields, widened around the
// core (amounts and "revision" route to the field whose claims carry them),
// then inheritance from the previous turn on the same grant.
function resolveField(q, claims, prevField) {
  const direct = questionFields(q);
  if (direct.length) return direct[0];
  const amounts = q.match(/[$€£₹]\s?[\d,]+|\b\d{1,3}(?:,\d{3})+\b/g) || [];
  for (const a of amounts) {
    const digits = a.replace(/[^\d]/g, "");
    const hit = claims.find((c) => c.value.replace(/[^\d]/g, "") === digits);
    if (hit) return hit.field;
  }
  if (/\b(revision|revised|amount|price|quote|total)\b/i.test(q)) {
    if (claims.some((c) => c.field === "fee")) return "fee";
  }
  if (/\b(split|upfront|instal|percent|%)\b/i.test(q)) {
    if (claims.some((c) => c.field === "paymentSplit")) return "paymentSplit";
  }
  const anaphora = /\b(that|it|this|the earlier one|the amount)\b/i.test(q);
  if (anaphora && prevField) return prevField;
  return null;
}

const NEGATIVE_RE = /\bno signed\b|\bnot recorded\b|\bdoes not exist\b|\bnot authorized\b|\bnever signed\b|\bnot been signed\b/i;
const REJECT_RE = /\brejected|turned down|declined|refused/i;

function verdictFor(field, resolved) {
  const { active, approved } = resolved;
  const approvedClaims = approved.get(field) ?? [];
  if (approvedClaims.length) return "CONFIRMED";
  const actives = active.get(field) ?? [];
  if (!actives.length) return "UNKNOWN";
  const values = new Set(actives.map((c) => c.value));
  if (values.size > 1) return "OPEN";
  const current = actives[0];
  // NO-RECORD only on field-scoped explicit negative evidence (never bled
  // across fields; amounts stay PROPOSED unless the negative names them).
  if (
    (field === "launchApproval" || field === "signoffWho" || field === "signoffTiming") &&
    NEGATIVE_RE.test(current.quote)
  )
    return "NO-RECORD";
  if (current.status === "approved") return "CONFIRMED";
  if (REJECT_RE.test(current.quote)) return "REJECTED-EXPLICIT";
  return "PROPOSED";
}

const words = (s) => s.split(/\s+/).filter(Boolean).length;

function render({ intent, verdict, field, current, history, citations }) {
  const value = current ? current.value : null;
  const spokenValue = value
    ? speakAmount(value, { dollars: /^\$|^\d{1,3}(,\d{3})+$/.test(value) && field === "fee" })
    : null;
  const label = current ? docLabel(current) : null;
  const earlier = history.length ? history[history.length - 1] : null;
  const earlierVal = earlier
    ? speakAmount(earlier.value, { dollars: field === "fee" })
    : null;
  switch (`${intent}:${verdict}`) {
    case "FINALIZED:PROPOSED":
    case "LATEST:PROPOSED":
      return `${cap(value ? `${spokenValue} is the latest proposal` : "It is still a proposal")}, and no approval is recorded.`;
    case "FINALIZED:NO-RECORD":
      return `No. ${cap(label)} states no signed approval exists, so it is not final.`;
    case "FINALIZED:CONFIRMED":
      return `Yes. ${cap(label)} records the approval${spokenValue ? ` of ${spokenValue}` : ""}.`;
    case "FINALIZED:OPEN":
      return `It is not final, and the records disagree: ${[...new Set(citations.map((c) => c.value))].join(" versus ")} are both on record.`;
    case "HISTORY:PROPOSED":
    case "HISTORY:OPEN":
      return earlier
        ? `Yes, the earlier record was ${earlierVal}. It was superseded by ${spokenValue ?? "the current proposal"}, which is still not approved.`
        : `${cap(spokenValue ?? "The current record")} is the only record, and it is not approved.`;
    case "HISTORY:CONFIRMED":
      return earlier
        ? `The earlier record was ${earlierVal}; the current approved record is ${spokenValue}.`
        : `${cap(spokenValue ?? "The current record")} is approved.`;
    case "WHY:PROPOSED":
    case "WHY:OPEN":
    case "WHY:CONFIRMED":
      return current?.quote
        ? `${cap(label)} says: ${trimQuote(current.quote)}`
        : `The documents do not give a reason I can verify.`;
    case "SOURCE:PROPOSED":
    case "SOURCE:NO-RECORD":
    case "SOURCE:OPEN":
    case "SOURCE:CONFIRMED":
      return citations.length
        ? `${cap(citations.map((c) => docLabel(c)).slice(0, 2).join(" and "))} ${citations.length > 1 ? "say" : "says"}: ${trimQuote(citations[0].quote)}`
        : `I cannot point to a document for that.`;
    case "REJECTED:PROPOSED":
    case "REJECTED:UNKNOWN":
      return `No record shows a rejection. Approval is pending, which is not the same thing.`;
    case "REJECTED:REJECTED-EXPLICIT":
      return `Yes. ${cap(label)} records the rejection.`;
    case "MUTATE:PROPOSED":
    case "MUTATE:UNKNOWN":
    case "MUTATE:OPEN":
    case "MUTATE:CONFIRMED":
    case "MUTATE:NO-RECORD":
      return `I cannot change the records by voice. ${spokenValue ? `${cap(spokenValue)} stays` : "It stays"} a proposal until a signed approval is added to the documents.`;
    default:
      if (verdict === "UNKNOWN")
        return `I don't see that in these documents.`;
      if (verdict === "OPEN")
        return `That is still open: ${[...new Set(citations.map((c) => c.value))].join(" versus ")} are both on record.`;
      if (verdict === "PROPOSED" && spokenValue)
        return `${cap(spokenValue)} is the current proposal; approval is not recorded.`;
      if (verdict === "CONFIRMED" && spokenValue)
        return `${cap(spokenValue)} is approved, per ${label}.`;
      if (verdict === "NO-RECORD")
        return `No. ${cap(label ?? "The record")} states no signed approval exists.`;
      return null;
  }
}

const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
function trimQuote(q) {
  const t = q.trim().replace(/\s+/g, " ");
  const cut = t.length > 140 ? t.slice(0, 137).replace(/\s\S*$/, "") + "..." : t;
  return /[.!?]$/.test(cut) ? cut : cut + ".";
}

// Guard: the rendered sentence may only contain numbers/dates present in the
// cited claims, approval wording only on CONFIRMED, rejection wording only on
// REJECTED-EXPLICIT, and at most 40 words.
function guard(spoken, citations, verdict) {
  if (!spoken) return false;
  if (words(spoken) > 40) return false;
  const citedText = citations.map((c) => `${c.quote} ${c.value} ${c.docDate}`).join(" ");
  const citedDigits = new Set((citedText.match(/\d[\d,]*/g) || []).map((d) => d.replace(/,/g, "")));
  for (const d of spoken.match(/\d[\d,]*/g) || []) {
    if (!citedDigits.has(d.replace(/,/g, ""))) return false;
  }
  if (/\b(approved|final|signed|agreed|confirmed)\b/i.test(spoken)) {
    if (verdict !== "CONFIRMED" && !/\bnot approved|no approval|not final|isn't approved|not recorded|stays? a proposal|still not approved|is not final\b/i.test(spoken))
      return false;
  }
  if (/\brejected\b/i.test(spoken) && verdict !== "REJECTED-EXPLICIT" && !/no record shows a rejection/i.test(spoken))
    return false;
  if (/\.md\b|_/.test(spoken)) return false;
  return true;
}

// Main entry: one voice turn. Returns { spoken, verdict, field, intent,
// citations } or null when the caller should use its existing generic path.
export function spokenTurn(question, bundle, prevField = null) {
  if (!bundle?.sources?.length) return null;
  const intent = routeIntent(question);
  const claims = extractClaims(bundle, ALL_FIELDS);
  const followup = intent === "HISTORY" || intent === "SOURCE" || intent === "REJECTED" || intent === "MUTATE";
  const field = resolveField(question, claims, followup ? prevField : null);
  if (!field) {
    return {
      spoken: "I don't see that in these documents.",
      verdict: "UNKNOWN",
      field: null,
      intent,
      citations: [],
    };
  }
  const fieldClaims = claims.filter((c) => c.field === field);
  const resolved = resolveClaims(fieldClaims);
  const verdict = verdictFor(field, resolved);
  const actives = resolved.active.get(field) ?? [];
  const current = actives[0] ?? null;
  const supersededForField = resolved.superseded.filter((c) => c.field === field);
  const citations = [...actives, ...supersededForField, ...(resolved.approved.get(field) ?? [])];
  // Engine stays in the loop: the canonical field question must not refuse,
  // or we abstain rather than speak from claims alone.
  const engineResult = answer(FIELD_CANONICAL[field], bundle);
  if (engineResult.refused && verdict !== "UNKNOWN") {
    return {
      spoken: "I can't verify that from these documents.",
      verdict: "UNKNOWN",
      field,
      intent,
      citations: [],
    };
  }
  let spoken = render({ intent, verdict, field, current, history: supersededForField, citations });
  if (!guard(spoken, citations, verdict)) {
    spoken = current
      ? `${cap(docLabel(current))} records ${current.value}, with no approval recorded.`
      : "I can't verify that from these documents.";
    if (!guard(spoken, citations, verdict))
      spoken = "I can't verify that from these documents.";
  }
  return { spoken, verdict, field, intent, citations: citations.map((c) => ({ title: c.title, docDate: c.docDate, quote: c.quote, firstLine: c.firstLine, lastLine: c.lastLine, hash: c.hash })) };
}
