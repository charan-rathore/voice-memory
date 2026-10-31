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
import {
  OPEN_ITEMS_RE,
  openItems,
  documentLookup,
  documentedReason,
  rejectionLookup,
  subjectNegative,
  unboundSubject,
  subjectSentence,
  docLabelOf,
  cite,
  sentencesOf,
} from "./spoken-routes.mjs";
import { normalizeSpoken } from "./spoken-normalize.mjs";

const FIELD_CANONICAL = {
  fee: "What is the fee?",
  paymentSplit: "What is the payment split?",
  deadline: "What is the deadline?",
  signoffWho: "Who signs off?",
  signoffTiming: "When is sign-off expected?",
  launchApproval: "Is the launch approved?",
  scope: "What is the scope?",
  reporting: "What reporting was agreed?",
  signedAgreement: "Is there a signed agreement?",
};

const INTENTS = [
  ["SUMMARY", /\b(overall|where do we stand|recap|summar)\b/i],
  ["WHY", /\bwhy\b|\breason\b/i],
  ["MUTATE", /\b(mark|update|record|edit|approve it|set the|make it)\b/i],
  ["REJECTED", /\b(reject\w*|turned down|refused|declined)\b/i],
  [
    "SOURCE",
    /\bwhich (document|doc|file|source)|says that|supports? that|where does it say/i,
  ],
  [
    "HISTORY",
    /\b(earlier|before|original(?:ly)?|remember|used to|previous|wasn'?t it|weren'?t it)\b/i,
  ],
  [
    "FINALIZED",
    /\b(finali[sz]ed?|final|agreed?|signed|locked|confirmed?|approv\w*|authori[sz]\w*|definitely|for sure|done deal)\b/i,
  ],
  ["LATEST", /\b(latest|current|now|today|split|fee|amount|status)\b/i],
];

const ALL_FIELDS = Object.keys(FIELD_CANONICAL);

const NUM_WORDS = {
  0: "zero",
  1: "one",
  2: "two",
  3: "three",
  4: "four",
  5: "five",
  6: "six",
  7: "seven",
  8: "eight",
  9: "nine",
  10: "ten",
  11: "eleven",
  12: "twelve",
  13: "thirteen",
  14: "fourteen",
  15: "fifteen",
  16: "sixteen",
  17: "seventeen",
  18: "eighteen",
  19: "nineteen",
  20: "twenty",
  30: "thirty",
  40: "forty",
  50: "fifty",
  60: "sixty",
  70: "seventy",
  80: "eighty",
  90: "ninety",
};
function spellNumber(n) {
  n = Math.round(Number(n));
  if (!Number.isFinite(n) || n < 0) return String(n);
  if (NUM_WORDS[n]) return NUM_WORDS[n];
  if (n < 100)
    return NUM_WORDS[Math.floor(n / 10) * 10] + "-" + NUM_WORDS[n % 10];
  if (n < 1000) {
    const rest = n % 100;
    return (
      NUM_WORDS[Math.floor(n / 100)] +
      " hundred" +
      (rest ? " " + spellNumber(rest) : "")
    );
  }
  if (n < 1000000) {
    const th = Math.floor(n / 1000),
      rest = n % 1000;
    return (
      spellNumber(th) + " thousand" + (rest ? " " + spellNumber(rest) : "")
    );
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

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];
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
    .replace(/\bv\d+\b/g, "")
    .replace(/\s{2,}/g, " ")
    .trim()
    .toLowerCase();
  const date = speakDate(claim.docDate);
  // A code-like title ("v2", "doc") is a filename read-aloud, not a source
  // description; fall back to the document's date.
  const speakable =
    base.replace(/[^a-z]/g, "").length >= 4 && /[aeyiou]/.test(base)
      ? base
      : null;
  if (!speakable) return `the document${date ? ` from ${date}` : ""}`;
  return `the ${speakable}${date ? ` from ${date}` : ""}`;
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
  for (const c of claims) {
    if (!c.value) continue;
    const parts = c.value.toLowerCase().split(/\s+/);
    const prefix = parts.slice(0, 2).join(" ");
    // A single common word ("Security") shared by question and value is not
    // evidence the question is about that field: require two words or a
    // number ("two depots", "$42,000").
    if (parts.length < 2 && !/\d/.test(prefix)) continue;
    if (prefix.length >= 6 && q.toLowerCase().includes(prefix)) return c.field;
  }
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
  const anaphora =
    /\b(that|it|this|the earlier one|the amount|number|which one|which number)\b/i.test(
      q,
    );
  if (anaphora && prevField) return prevField;
  return null;
}

const NEGATIVE_RE =
  /\bno signed\b|\bnot recorded\b|\bdoes not exist\b|\bnot authorized\b|\bnever signed\b|\bnot been signed\b|\bno\b[^.;]{0,40}\b(?:approved|agreement|exists|signed|recorded|authorized)\b|\bnot\b[^.;]{0,25}\bapproved\b/i;
const REJECT_RE = /\brejected|turned down|declined|refused/i;

const FIELD_CUES = {
  fee: /\bfee\b|\$|amount|price|cost/i,
  paymentSplit: /split|upfront|instal|percent|%/i,
  deadline: /deadline|date|november|december|january|february|pilot date/i,
  signoffWho: /sign-?off|signing|approver|finance/i,
  signoffTiming: /sign-?off|signing|timing|when/i,
  launchApproval: /launch|production|authori[sz]/i,
  scope: /scope|region|depot|area|phase/i,
  reporting: /report|cadence|weekly|daily|fortnight|monthly|status update/i,
};

const MONTH_RE =
  "(?:January|February|March|April|May|June|July|August|September|October|November|December)";
const SUPPLEMENT_PATTERNS = [
  // Cue and value must share ONE sentence: a stray "target practice" or
  // "weekly sales report" line must not mint a deadline or reporting claim.
  {
    field: "deadline",
    cue: /\b(deadline|readiness|delivery target|due date)\b/i,
    re: new RegExp("\\b(\\d{1,2} " + MONTH_RE + "(?: \\d{4})?)\\b", "g"),
  },
  {
    field: "scope",
    cue: /\b(scope|regions?|depots?|areas?|sites?)\b/i,
    re: /\b((?:two|three|four|five|six|seven|\d+) (?:regions?|depots?|areas?|sites?|phases?)(?:\s*\([^)]*\))?)/gi,
  },
  {
    field: "reporting",
    cue: /\breport(?:ing|s)?\b/i,
    re: /\b(weekly|fortnightly|monthly|biweekly|daily)\b/gi,
  },
];

function statusOfLine(line) {
  if (/open decision|not resolved/i.test(line)) return "unresolved";
  if (
    /\bnot\b[^.;]{0,25}\bapproved\b|\bno\b[^.;]{0,40}\b(approved|agreement|exists|signed|recorded|authorized)\b/i.test(
      line,
    )
  )
    return "unresolved";
  if (/internal (delivery )?target/i.test(line)) return "internal-target";
  if (/confirmed|approved/i.test(line)) return "approved";
  if (/asks|requested|retain/i.test(line)) return "requested";
  if (/proposed/i.test(line)) return "proposed";
  return "discussed";
}

// extractClaims (shared core) plus gap-filling line scans. Deduped on
// field+title+normalized value; shared-core claims always win.
function mergedClaims(bundle, fields) {
  const base = extractClaims(bundle, fields);
  const seen = new Set(
    base.map(
      (c) =>
        `${c.field}|${c.title}|${String(c.value).toLowerCase().replace(/\s+/g, "")}`,
    ),
  );
  // resolveClaims (shared core) expects engagement parties and supersede
  // markers on every claim; derive both so line-scan claims behave alike.
  const entities =
    base.find((c) => c.scopeEntities?.length)?.scopeEntities ?? [];
  const extra = [];
  const wanted = new Set(fields);
  for (const src of bundle?.sources ?? []) {
    const srcDate =
      (String(src.text ?? "").match(/Date:\s*(\d{4}-\d{2}-\d{2})/) ?? [])[1] ??
      null;
    const lines = String(src.text ?? "").split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      for (const sentence of line.split(/(?<=[.!?])\s+/)) {
        const sent = sentence.replace(/^\s*\d+\.\s*/, "").trim();
        if (!sent) continue;
        for (const p of SUPPLEMENT_PATTERNS) {
          if (!wanted.has(p.field) || !p.cue.test(sent)) continue;
          p.re.lastIndex = 0;
          let matches = [...sent.matchAll(p.re)];
          // A change sentence ("narrow from three regions to two regions")
          // records the OUTCOME only: the pre-change value is history, not
          // a competing current claim.
          if (
            matches.length > 1 &&
            /\bfrom\b.{0,60}\bto\b|narrow|reduce|shrink/i.test(sent)
          )
            matches = matches.slice(-1);
          for (const m of matches) {
            const value = m[1]
              .replace(/\s+\(/, "(")
              .replace(/\s+/g, " ")
              .trim();
            const key = `${p.field}|${src.title}|${value.toLowerCase().replace(/\s+/g, "")}`;
            if (seen.has(key)) continue;
            seen.add(key);
            extra.push({
              field: p.field,
              value,
              quote: sent,
              title: src.title,
              docDate: srcDate,
              firstLine: i + 1,
              lastLine: i + 1,
              status: statusOfLine(sent),
              hash: null,
              scopeEntities: entities,
              supersedes: /narrow|revis|supersed|instead of|retain/i.test(sent),
            });
          }
        }
      }
    }
  }
  return [...base, ...extra];
}

// Value comparison key: punctuation/conjunction-insensitive so "two depots
// (East, Central)" and "two depots (East and Central)" are one value.
function canonValue(v) {
  return String(v ?? "")
    .toLowerCase()
    .replace(/\band\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// A negative claim counts for this field only when its own quote names the
// field's subject (never bleed a deadline negative into a fee verdict).
function scopedNegative(field, claims, question, bundle = null) {
  const cue = FIELD_CUES[field];
  const asksSigning = /\bsigned|agreement|countersign|executed\b/i.test(
    question,
  );
  // The negative and the field's subject must share ONE sentence: "The
  // launch is not approved. Security sign-off remains pending." holds no
  // negative about sign-off.
  const sentenceRelevant = (p) =>
    NEGATIVE_RE.test(p) &&
    ((cue && cue.test(p)) ||
      (asksSigning && /signed|agreement|countersign/i.test(p)));
  const relevant = (quote) =>
    String(quote ?? "")
      .split(/(?<=[.!?])\s+/)
      .some(sentenceRelevant);
  const inClaims =
    claims.find((c) => c.field === field && relevant(c.quote)) ??
    claims.find((c) => relevant(c.quote));
  if (inClaims) return inClaims;
  // The shared extractor can skip amount-free negative statements; scan the
  // source lines directly so an explicit "no ..." sentence still grounds a
  // NO-RECORD verdict with a real citation.
  if (bundle?.sources) {
    for (const src of bundle.sources) {
      const srcDate =
        (String(src.text ?? "").match(/Date:\s*(\d{4}-\d{2}-\d{2})/) ??
          [])[1] ?? null;
      const lines = String(src.text ?? "").split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].replace(/^\s*\d+\.\s*/, "").trim();
        if (!line) continue;
        // A line can hold several sentences with different subjects; cite the
        // sentence that actually carries this field's negative.
        for (const sentence of line.split(/(?<=[.!?])\s+/)) {
          if (relevant(sentence)) {
            return {
              field,
              value: null,
              quote: sentence.trim(),
              title: src.title,
              docDate: src.docDate ?? src.date ?? null,
              firstLine: i + 1,
              lastLine: i + 1,
              status: "unresolved",
            };
          }
        }
      }
    }
  }
  return null;
}

function namesSpecificValue(question, actives) {
  return actives.some((c) => {
    if (!c.value) return false;
    const v = c.value.toLowerCase();
    const q = question.toLowerCase();
    if (q.includes(v)) return true;
    const prefix = v.split(/\s+/).slice(0, 2).join(" ");
    return prefix.length >= 6 && q.includes(prefix);
  });
}

function verdictFor(field, resolved, claims, question, intent, bundle) {
  const { active, approved } = resolved;
  const approvedClaims = approved.get(field) ?? [];
  if (approvedClaims.length) return "CONFIRMED";
  const actives = active.get(field) ?? [];
  const neg = scopedNegative(field, claims, question, bundle);
  if (!actives.length) return neg ? "NO-RECORD" : "UNKNOWN";
  // A "did X approve <specific value>?" question with an explicit scoped
  // negative on record is a denial of that value, not an open decision.
  if (intent === "FINALIZED" && neg && namesSpecificValue(question, actives))
    return "NO-RECORD";
  const values = new Set(actives.map((c) => canonValue(c.value)));
  if (values.size > 1) return "OPEN";
  const current = actives[0];
  // Amount-bearing claims stay grounded PROPOSED; an explicit field-scoped
  // negative upgrades to NO-RECORD only for non-amount fields or signing
  // questions (never a flat "no" on an amount).
  if (
    neg &&
    (field !== "fee" || /\bsigned|agreement|countersign\b/i.test(question))
  )
    return "NO-RECORD";
  if (current.status === "approved") return "CONFIRMED";
  if (REJECT_RE.test(current.quote)) return "REJECTED-EXPLICIT";
  if (field === "scope") return "CONFIRMED";
  return "PROPOSED";
}

const words = (s) => s.split(/\s+/).filter(Boolean).length;

function render({
  intent,
  verdict,
  field,
  current,
  history,
  citations,
  claims,
  question,
}) {
  const disp = (v) => (v ? v.replace(/(\S)\(/, "$1 (") : v);
  const value = current ? disp(current.value) : null;
  const label = current ? docLabel(current) : null;
  const earlier = history.length ? history[history.length - 1] : null;
  const earlierVal = earlier ? disp(earlier.value) : null;
  const neg =
    verdict === "NO-RECORD" ? scopedNegative(field, citations, question) : null;
  const lowerFirst = (t) => (t ? t[0].toLowerCase() + t.slice(1) : t);
  if (verdict === "NO-RECORD" && neg) {
    // A cited line can hold several sentences; speak only the sentence that
    // carries this field's negative.
    const asksSigning = /\bsigned|agreement|countersign|executed\b/i.test(
      question,
    );
    const cue = FIELD_CUES[field];
    const sentence =
      neg.quote
        .split(/(?<=[.!?])\s+/)
        .find(
          (p) =>
            NEGATIVE_RE.test(p) &&
            ((cue && cue.test(p)) ||
              (asksSigning && /signed|agreement|countersign/i.test(p))),
        ) ?? neg.quote;
    return `No. Per ${docLabel(neg)}: ${lowerFirst(trimQuote(sentence, 110))}`;
  }
  if (intent === "MUTATE")
    return `I cannot change the records by voice. ${value ? `${cap(value)} stays` : "It stays"} a proposal until a signed approval is added to the documents.`;

  if (field === "signedAgreement") {
    if (verdict === "CONFIRMED" && current)
      return `Yes. ${cap(docLabel(current))} says: ${trimQuote(current.quote.replace(/^\s*\d+\.\s*/, ""), 120)}`;
  }
  if (field === "signoffWho" && current && verdict !== "CONFIRMED")
    return `The terms need ${current.value} sign-off, and that sign-off is not recorded yet.`;
  if (field === "scope" && current)
    return `The current working scope is ${value}.`;
  if (field === "reporting" && current) {
    const cadence = (current.quote + " " + (current.value ?? "")).match(
      /\b(weekly|daily|fortnightly|monthly|biweekly|twice weekly)\b/i,
    )?.[1];
    if (!cadence)
      return `${cap(docLabel(current))} records the reporting arrangement.`;
    return verdict === "CONFIRMED"
      ? `The client agreed to ${cadence.toLowerCase()} progress reporting, per ${docLabel(current)}.`
      : `The record proposes ${cadence.toLowerCase()} progress reporting, per ${docLabel(current)}; confirmation is not recorded.`;
  }

  switch (`${intent}:${verdict}`) {
    case "FINALIZED:PROPOSED":
    case "LATEST:PROPOSED":
      return `${cap(value ?? "It")} is the latest proposal, and it is not approved.`;
    case "FINALIZED:CONFIRMED":
    case "LATEST:CONFIRMED":
      return `Yes. ${cap(label)} records the approval${value ? ` of ${value}` : ""}.`;
    case "FINALIZED:OPEN":
    case "LATEST:OPEN":
      return `That is still open: ${dedupeValues(citations.map((c) => c.value)).join(" versus ")} are both on record, and it is not approved.`;
    case "HISTORY:PROPOSED":
    case "HISTORY:OPEN":
      return earlier
        ? `Yes, the earlier record was ${earlierVal}. It was superseded by ${value ?? "the current proposal"}, which is still not approved.`
        : `${cap(value ?? "The current record")} is the only record, and it is not approved.`;
    case "HISTORY:CONFIRMED":
      return earlier
        ? `The earlier record was ${earlierVal}; the current approved record is ${value}.`
        : `${cap(value ?? "The current record")} is approved.`;
    case "WHY:PROPOSED":
    case "WHY:OPEN":
    case "WHY:CONFIRMED": {
      // Reasons usually span two records: the change and what motivated it.
      // Cite the current claim, plus the nearest claim from another field
      // whose quote shares a content word with it (e.g. the scope narrowing
      // behind a fee revision).
      const currentWords = new Set(
        (current?.quote ?? "").toLowerCase().match(/[a-z]{5,}/g) ?? [],
      );
      const candidates = claims
        .filter(
          (c) =>
            c.field !== field &&
            c !== current &&
            c.quote !== current?.quote &&
            (c.quote.toLowerCase().match(/[a-z]{5,}/g) ?? []).some((w) =>
              currentWords.has(w),
            ),
        )
        .map((c) => ({
          c,
          shared: (c.quote.toLowerCase().match(/[a-z]{5,}/g) ?? []).filter(
            (w) => currentWords.has(w),
          ).length,
        }))
        .sort(
          (a, b) =>
            (b.c.field === "scope" ? 1 : 0) - (a.c.field === "scope" ? 1 : 0) ||
            b.shared - a.shared,
        );
      const motivator = candidates[0]?.c ?? null;
      if (motivator && current)
        return `${cap(trimQuote(motivator.quote, 90))} Following that, ${docLabel(current)} revised the ${field === "fee" ? "fee" : field} to ${value}.`;
      return current?.quote
        ? `${cap(label)} says: ${trimQuote(current.quote)}`
        : `The records show a change, but I cannot verify the reason from these documents.`;
    }
    case "SOURCE:PROPOSED":
    case "SOURCE:NO-RECORD":
    case "SOURCE:OPEN":
    case "SOURCE:CONFIRMED":
      return citations.length
        ? `${cap(docLabel(citations[0]))} says: ${trimQuote(citations[0].quote, 110)}${citations.length > 1 ? ` It is also recorded in ${docLabel(citations[1])}.` : ""}`
        : `I cannot point to a document for that.`;
    case "REJECTED:PROPOSED":
    case "REJECTED:UNKNOWN":
      return `No record shows a rejection. Approval is pending, which is not the same thing.`;
    case "REJECTED:REJECTED-EXPLICIT":
      return `Yes. ${cap(label)} records the rejection.`;
    default:
      if (verdict === "UNKNOWN") return `I don't see that in these documents.`;
      if (verdict === "OPEN")
        return `That is still open: ${dedupeValues(citations.map((c) => c.value)).join(" versus ")} are both on record.`;
      if (verdict === "PROPOSED" && value)
        return `${cap(value)} is the current proposal; approval is not recorded.`;
      if (verdict === "CONFIRMED" && value)
        return `${cap(value)} is approved, per ${label}.`;
      return null;
  }
}

// Collapse values contained verbatim in a longer sibling ("15 November" vs
// "15 November 2026"): the longer form is the fuller record.
function dedupeValues(values) {
  const byCanon = new Map();
  for (const v of values.filter(Boolean)) {
    const k = canonValue(v);
    if (!byCanon.has(k) || v.length > byCanon.get(k).length) byCanon.set(k, v);
  }
  const uniq = [...byCanon.values()];
  return uniq.filter(
    (v) => !uniq.some((o) => o !== v && canonValue(o).includes(canonValue(v))),
  );
}

const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
function trimQuote(q, max = 140) {
  const t = q
    .trim()
    .replace(/^\d+\.\s*/, "")
    .replace(/\s+/g, " ");
  const cut =
    t.length > max ? t.slice(0, max - 3).replace(/\s\S*$/, "") + "..." : t;
  return /[.!?]$/.test(cut) ? cut : cut + ".";
}

// Guard: the rendered sentence may only contain numbers/dates present in the
// cited claims, approval wording only on CONFIRMED, rejection wording only on
// REJECTED-EXPLICIT, and at most 40 words.
function guard(spoken, citations, verdict) {
  if (!spoken) return false;
  if (words(spoken) > 40) return false;
  const citedText = citations
    .map((c) => `${c.quote} ${c.value} ${c.docDate}`)
    .join(" ");
  const norm = (d) => String(parseInt(d.replace(/,/g, ""), 10));
  const citedDigits = new Set(
    (citedText.match(/\b\d[\d,]*\b/g) || []).map(norm),
  );
  for (const d of spoken.match(/\b\d[\d,]*\b/g) || []) {
    if (!citedDigits.has(norm(d))) return false;
  }
  if (/\b(approved|final|signed|agreed|confirmed)\b/i.test(spoken)) {
    if (
      verdict !== "CONFIRMED" &&
      verdict !== "NO-RECORD" &&
      !/\bnot approved|no approval|not final|isn't approved|not recorded|stays? a proposal|still not approved|is not final|neither is approved\b/i.test(
        spoken,
      )
    )
      return false;
  }
  if (
    /\brejected\b/i.test(spoken) &&
    verdict !== "REJECTED-EXPLICIT" &&
    !/no record shows a rejection/i.test(spoken)
  )
    return false;
  if (/\.md\b|_/.test(spoken)) return false;
  return true;
}

// Field carried by earlier user messages in the same request thread (the
// adapter also keeps grant.lastField across requests).
export function historyField(bundle, messages) {
  if (!bundle?.sources?.length || !Array.isArray(messages)) return null;
  const claims = mergedClaims(bundle, ALL_FIELDS);
  for (const m of [...messages].reverse()) {
    if (m?.role !== "user" || typeof m.content !== "string") continue;
    const f = resolveField(m.content, claims, null);
    if (f) return f;
  }
  return null;
}

// "Where do we stand overall?": one grounded clause per field on record,
// never an invented single verdict.
function summarize(claims) {
  const fields = [
    ["fee", "the fee"],
    ["paymentSplit", "the payment split"],
    ["deadline", "the deadline"],
    ["scope", "the scope"],
  ];
  const clauses = [];
  for (const [field, label] of fields) {
    const resolved = resolveClaims(claims.filter((c) => c.field === field));
    const actives = resolved.active.get(field) ?? [];
    if (!actives.length) continue;
    const approved = resolved.approved.get(field) ?? [];
    const values = dedupeValues(actives.map((c) => c.value));
    if (approved.length)
      clauses.push(`${label} is confirmed at ${approved[0].value}`);
    else if (values.length > 1)
      clauses.push(`${label} is open between ${values.join(" and ")}`);
    else if (field === "scope") clauses.push(`${label} is ${values[0]}`);
    else clauses.push(`${label} is ${values[0]}, still a proposal`);
  }
  if (!clauses.length) return null;
  const spoken = cap(clauses.join("; ")) + ".";
  return words(spoken) <= 40 ? spoken : null;
}

// Main entry: one voice turn. Returns { spoken, verdict, field, intent,
// citations } or null when the caller should use its existing generic path.
const PROPER_STOP = new Set(
  (
    "What When Where Which Who Whose Why How Was Were Is Are Did Does Do Has Have Had The This That These Those " +
    "But Okay Ok So And Or If Then Can Could Would Should Will Shall May Any Much Many Now Today Yesterday Tomorrow " +
    "January February March April May June July August September October November December " +
    "Monday Tuesday Wednesday Thursday Friday Saturday Sunday"
  ).split(" "),
);

// A capitalized name the documents never mention (wrong client, invented
// party): abstain rather than answer from the records we do hold.
function unknownNamedEntity(question, bundle) {
  const hay = bundle.sources
    .map((s) => `${s.title} ${s.text}`)
    .join(" ")
    .toLowerCase();
  for (const t of question.match(/\b[A-Z][a-z]{2,}\b/g) ?? []) {
    if (PROPER_STOP.has(t)) continue;
    if (!hay.includes(t.toLowerCase())) return t;
  }
  return null;
}

const pack = (c) => ({
  title: c.title,
  docDate: c.docDate,
  quote: c.quote,
  firstLine: c.firstLine,
  lastLine: c.lastLine,
  hash: c.hash,
  sourceId: c.sourceId,
  start: c.start,
  end: c.end,
  status: c.status,
});

// Canonical value key for "did they approve $42,000?" style questions.
function askedValueKey(question, field) {
  if (field === "fee") {
    const a = question.match(/[$€£₹]\s?[\d,]+|\b\d{1,3}(?:,\d{3})+\b/);
    return a ? a[0].replace(/[^\d]/g, "") : null;
  }
  if (field === "deadline") {
    const d = question.match(
      /\b(\d{1,2})\s+(January|February|March|April|May|June|July|August|September|October|November|December)\b/i,
    );
    return d ? `${Number(d[1])} ${d[2].toLowerCase()}` : null;
  }
  if (field === "paymentSplit") {
    const p = question.match(/\b(\d{1,2})\s*\/\s*(\d{1,2})\b/);
    return p ? `${p[1]}/${p[2]}` : null;
  }
  return null;
}
function valueKeyOf(c, field) {
  if (field === "fee") return String(c.value).replace(/[^\d]/g, "");
  if (field === "deadline") {
    const d = String(c.value).match(/(\d{1,2})\s+([A-Za-z]+)/);
    return d ? `${Number(d[1])} ${d[2].toLowerCase()}` : null;
  }
  return String(c.value).replace(/\s/g, "");
}

// A question about ONE specific value ("is the $12,800 retainer approved?",
// "is go-live moved to 3 November?") is answered about that value: its own
// explicit rejection, its own approval, or "proposed, not approved" next to
// the approved value. Never "yes" because some OTHER value was approved.
function valueVerdict(question, field, fieldClaims, resolved, intent) {
  if (!["FINALIZED", "LATEST", "REJECTED", "OTHER", "HISTORY"].includes(intent))
    return null;
  const key = askedValueKey(question, field);
  if (!key) return null;
  const mine = fieldClaims.filter((c) => valueKeyOf(c, field) === key);
  if (!mine.length) return null;
  const approved = resolved.approved.get(field) ?? [];
  const approvedOther = approved.filter((c) => valueKeyOf(c, field) !== key);
  const rejection = mine.find((c) =>
    /\brejected|turned down|declined\b/i.test(c.quote),
  );
  const shown = (c) => String(c.value).replace(/(\S)\(/, "$1 (");
  if (rejection) {
    const tail = approvedOther.length
      ? ` The ${field === "fee" ? "figure" : "date"} in force remains ${shown(approvedOther[0])}.`
      : "";
    return {
      verdict: "REJECTED-EXPLICIT",
      spoken: `No. Per ${docLabel(rejection)}: ${trimQuote(rejection.quote.replace(/^\s*\d+\.\s*/, ""), 100)}${tail}`,
      citations: [rejection, ...approvedOther.slice(0, 1)],
    };
  }
  if (mine.some((c) => c.status === "approved")) return null; // normal CONFIRMED path
  if (approvedOther.length) {
    const p = mine[0];
    return {
      verdict: "PROPOSED",
      spoken: `No. ${shown(p)} was ${p.status === "requested" ? "requested" : "proposed"}, not approved; the approved ${field === "deadline" ? "date" : "figure"} is ${shown(approvedOther[0])}, per ${docLabel(approvedOther[0])}.`,
      citations: [p, approvedOther[0]],
    };
  }
  return null;
}

export function spokenTurn(rawQuestion, bundle, prevField = null) {
  if (!bundle?.sources?.length) return null;
  // Speech notation -> document notation (numbers, ordinals, fillers).
  const question = normalizeSpoken(rawQuestion);
  const intent = routeIntent(question);
  // Question shapes the field graph cannot answer, each from verbatim,
  // span-validated sentences (spoken-routes.mjs).
  if (intent !== "MUTATE" && OPEN_ITEMS_RE.test(question)) {
    const open = openItems(bundle);
    if (open) return open;
  }
  if (intent !== "MUTATE") {
    const doc = documentLookup(question, bundle);
    if (doc) return doc;
  }
  if (intent === "REJECTED") {
    const rj = rejectionLookup(question, bundle);
    if (rj) return rj;
  }
  const claims = mergedClaims(bundle, ALL_FIELDS);
  if (unknownNamedEntity(question, bundle))
    return {
      spoken: "I don't see that in these documents.",
      verdict: "UNKNOWN",
      field: null,
      intent,
      citations: [],
    };
  // An explicit amount with no matching claim: never answer with a
  // different figure as if it were the one asked about.
  const askedAmounts =
    question.match(/[$€£₹]\s?[\d,]+|\b\d{1,3}(?:,\d{3})+\b/g) ?? [];
  if (askedAmounts.length) {
    const match = askedAmounts.some((a) =>
      claims.some(
        (c) =>
          c.value && c.value.replace(/[^\d]/g, "") === a.replace(/[^\d]/g, ""),
      ),
    );
    if (!match)
      return {
        spoken: `I don't see ${askedAmounts[0]} in these documents.`,
        verdict: "UNKNOWN",
        field: null,
        intent,
        citations: [],
      };
  }
  if (intent === "SUMMARY") {
    const spoken = summarize(claims);
    if (spoken)
      return {
        spoken,
        verdict: "OPEN",
        field: null,
        intent,
        citations: claims.map((c) => ({
          title: c.title,
          docDate: c.docDate,
          quote: c.quote,
          firstLine: c.firstLine,
          lastLine: c.lastLine,
          hash: c.hash,
        })),
      };
  }
  const field =
    resolveField(question, claims, null) ??
    (prevField ? resolveField(question, claims, prevField) : null);
  if (!field) {
    return {
      spoken: "I don't see that in these documents.",
      verdict: "UNKNOWN",
      field: null,
      intent,
      citations: [],
      // Not a deliberate abstention (unknown entity / unknown amount above):
      // the claim graph simply has no field for this question. The adapter
      // may replace it with a verbatim, engine-validated quote.
      reason: "no_field",
    };
  }
  const fieldClaims = claims.filter((c) => c.field === field);
  // Subject binding: "how much is the Dock E training change?" names a
  // subject no fee claim mentions; the fee figures must not answer it.
  // Only when the question names neither the field itself nor a value: a
  // question that says "fee" or "$48,000" IS about the field.
  const namesField =
    /\b(fee|retainer|price|rate|deadline|go-live|date|split|payment|schedule)\b|[$€£₹]\s?\d|\b\d{1,3}(?:,\d{3})+\b|\b\d{1,2}\s+[A-Z][a-z]+\b|\b\d{1,2}\/\d{1,2}\b/i.test(
      question,
    );
  // An explicit "no price was agreed" for the subject the caller named
  // outranks every figure: "how much do the SMS reminders cost?" must not be
  // answered with the contract fee.
  if (
    field === "fee" &&
    intent !== "MUTATE" &&
    /^\s*(?:how much|what)\b/i.test(question)
  ) {
    const subj = subjectNegative(question, bundle);
    if (subj) return subj;
  }
  const asksValue = /^\s*(?:how much|what(?:'s| is| are| was)?|which)\b/i.test(
    question,
  );
  if (
    !namesField &&
    asksValue &&
    ["LATEST", "OTHER"].includes(intent) &&
    ["fee", "deadline", "paymentSplit"].includes(field) &&
    intent !== "MUTATE"
  ) {
    const unbound = unboundSubject(question, fieldClaims, bundle);
    if (unbound) {
      const sub = subjectSentence(unbound, bundle);
      if (sub) return sub;
    }
  }
  const resolved = resolveClaims(fieldClaims);
  if (intent !== "MUTATE") {
    const vv = valueVerdict(question, field, fieldClaims, resolved, intent);
    if (
      vv &&
      guard(
        vv.spoken,
        vv.citations,
        vv.verdict === "REJECTED-EXPLICIT" ? "REJECTED-EXPLICIT" : "NO-RECORD",
      )
    )
      return {
        spoken: vv.spoken,
        verdict: vv.verdict,
        field,
        intent,
        citations: vv.citations.map(pack),
      };
  }
  const verdict = verdictFor(field, resolved, claims, question, intent, bundle);
  const actives = resolved.active.get(field) ?? [];
  const current =
    verdict === "CONFIRMED"
      ? ((resolved.approved.get(field) ?? [])[0] ?? actives[0] ?? null)
      : (actives[0] ?? null);
  const supersededForField = resolved.superseded.filter(
    (c) => c.field === field,
  );
  const citations = [
    ...actives,
    ...supersededForField,
    ...(resolved.approved.get(field) ?? []),
  ];
  if (verdict === "NO-RECORD") {
    const negC = scopedNegative(field, claims, question, bundle);
    if (negC && !citations.includes(negC)) citations.push(negC);
  }
  // Engine stays in the loop: the canonical field question must not refuse,
  // or we abstain rather than speak from claims alone.
  // A field with no canonical question used to throw here ("is there a
  // signed contract" crashed the live call); fall back to the question.
  const engineResult = answer(FIELD_CANONICAL[field] ?? question, bundle);
  // Engine refused the canonical field question and the claim graph has no
  // structured answer either: defer to the caller's existing engine-answer
  // path, which carries the engine's own honest wording.
  if (engineResult.refused && (verdict === "UNKNOWN" || !current)) return null;
  if (intent === "WHY") {
    const why = documentedReason(current, bundle);
    const spokenWhy =
      why?.spoken ??
      "The records show the change, but they don't state a reason for it.";
    return {
      spoken: spokenWhy,
      verdict: why ? "QUOTED" : "UNKNOWN",
      field,
      intent,
      citations: (why?.citations ?? []).map(pack),
    };
  }
  let spoken = render({
    intent,
    verdict,
    field,
    current,
    history: supersededForField,
    citations,
    claims,
    question,
  });
  if (!guard(spoken, citations, verdict)) {
    spoken = current
      ? `${cap(docLabel(current))} records ${current.value}, with no approval recorded.`
      : "I can't verify that from these documents.";
    if (!guard(spoken, citations, verdict))
      spoken = "I can't verify that from these documents.";
  }
  return {
    spoken,
    verdict,
    field,
    intent,
    citations: citations.map(pack),
  };
}
