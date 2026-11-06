import { terms } from "./spoken-extract.mjs";
// spoken.mjs - deterministic spoken renderer for the voice path.
// The engine (answer/extractClaims/resolveClaims) stays the authority on
// facts; this module only routes intent, resolves the subject, reads the
// resolved claim graph, and fills fixed templates. It never invents facts:
// the guard rejects any rendered sentence whose numbers or approval wording
// are not backed by a cited claim.
import {
  answer,
  identifierRequest,
  extractClaims,
  resolveClaims,
  questionFields,
  authorityOf,
} from "../dist/engine.mjs";
import {
  OPEN_ITEMS_RE,
  openItems,
  documentLookup,
  documentedReason,
  rejectionLookup,
  subjectNegative,
  pendingFor,
  unboundSubject,
  subjectSentence,
  docLabelOf,
  cite,
  sentencesOf,
} from "./spoken-routes.mjs";
import { normalizeSpoken } from "./spoken-normalize.mjs";
import { parseAsOf, bundleAsOf } from "../memory/memory.mjs";

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
  [
    "MUTATE",
    // Imperative use only: "update the record", "mark it approved". Noun
    // compounds like "status update" or reads like "the October 2 update"
    // are questions, not change requests.
    /\b(?:mark|update|record|edit)\s+(?:the|this|that|it|them|those|our|my|a|an)\b|^(?:mark|update|record|edit)\b|\bapprove it\b|\bset the\b|\bmake it\b/i,
  ],
  ["REJECTED", /\b(reject\w*|turned down|refused|declined)\b/i],
  [
    "SOURCE",
    /\bwhich (document|doc|file|source)|says that|supports? that|where does it say/i,
  ],
  [
    "HISTORY",
    /\b(earlier|before|original(?:ly)?|remember|used to|previous|wasn'?t it|weren'?t it|supersed\w*|replaced|(?:first|initial(?:ly)?) (?:proposed|proposal|quoted?|offer(?:ed)?|fee|price|figure))\b/i,
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
  // "Who signs off (on the fee)?" asks for the approver, not the amount.
  if (
    /\bwho\b[^?.]{0,40}\bsign(?:s|ing)?[\s-]*off\b/i.test(q) &&
    claims.some((c) => c.field === "signoffWho")
  )
    return "signoffWho";
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
  if (
    /\b(proposal|offer)\b/i.test(q) &&
    /\b(original|first|initial|earlier|previous)\b/i.test(q) &&
    claims.some((c) => c.field === "fee")
  )
    return "fee";
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
  if (
    /open decision|not resolved|no vote or agreement|does not constitute|does not establish|has not accepted/i.test(
      line,
    )
  )
    return "unresolved";
  if (
    /\bnot\b[^.;]{0,25}\b(approved|accepted|agreed|signed)\b|\bno\b[^.;]{0,40}\b(approved|agreement|exists|signed|recorded|authorized)\b/i.test(
      line,
    )
  )
    return "unresolved";
  if (
    /internal (delivery )?target|\binternal(?:ly)?(?:\s+[a-z-]+){0,2}\s+target\b/i.test(
      line,
    )
  )
    return "internal-target";
  if (
    /\bapprov(?:e|es|ed)\b|confirmed|\baccept(?:s|ed)?\b|\bagreed\b|authorized/i.test(
      line,
    )
  )
    return "approved";
  if (/asks|requested|retain/i.test(line)) return "requested";
  if (/proposed|floated|suggested|draft\b/i.test(line)) return "proposed";
  return "discussed";
}

// extractClaims (shared core) plus gap-filling line scans. Deduped on
// field+title+normalized value; shared-core claims always win.
export function mergedClaims(bundle, fields) {
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
      if (!/[a-z]/.test(line)) continue; // ALL-CAPS banner lines mint nothing
      for (const sentence of line.split(/(?<=[.!?])\s+/)) {
        const sent = sentence.replace(/^\s*\d+\.\s*/, "").trim();
        if (!sent) continue;
        // A quoted question records what someone ASKED, never an assertion.
        if (/\?\s*$/.test(sent)) continue;
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
              authority: authorityOf(sent),
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

// Plural-insensitive comparison key ("sites" ~ "site").
function stemCanon(v) {
  return canonValue(v).replace(/\b(\w{3,})s\b/g, "$1");
}

const GENERIC_ID =
  /^(the|this|that|dear|customer|client|caller|user|document|memo|call|transcript|january|february|march|april|may|june|july|august|september|october|november|december)$/i;
// Canonical identity tokens of a question ("customer:a", "alpha").
function questionIds(question) {
  const ids = [];
  for (const m of question.matchAll(/\bcustomer\s+([A-Z])\b/gi))
    ids.push("customer:" + m[1].toLowerCase());
  for (const w of question.match(/\b[A-Z][a-z]{2,}\b/g) ?? [])
    if (!GENERIC_ID.test(w)) ids.push(w.toLowerCase());
  return ids;
}
// Canonical identity tokens on a claim's own sentence, minus value words.
function claimIds(claim) {
  const ids = [];
  const q = claim.quote ?? "";
  for (const m of q.matchAll(/\bcustomer\s+([A-Z])\b/gi))
    ids.push("customer:" + m[1].toLowerCase());
  const valueWords = canonValue(claim.value);
  for (const w of q.match(/\b[A-Z][a-z]{2,}\b/g) ?? []) {
    const lw = w.toLowerCase();
    if (!GENERIC_ID.test(w) && !valueWords.includes(lw)) ids.push(lw);
  }
  return [...new Set(ids)];
}

// Engagement identity label on a claim's own sentence: a letter-labeled
// customer, or a capitalized word bound to the field's subject noun ("the
// ALPHA migration fee"). Speaker names and structural prefixes are not
// engagement identities.
function identityLabel(claim) {
  const q = (claim.quote ?? "").replace(
    /^\s*[A-Z][a-z]{1,20}(?:\s*\([^)]*\))?\s*:\s*/,
    "",
  );
  const m = /\bcustomer\s+([A-Z])\b/i.exec(q);
  if (m) return `Customer ${m[1].toUpperCase()}`;
  const valueWords = canonValue(claim.value);
  const fm = new RegExp(
    "\\b([A-Z][a-z]{2,})\\s+(?:[a-z][a-z-]{3,}\\s+)?(?:fees?|retainer|price|rate|split|scope|retention|target|deadline)\\b",
  ).exec(q);
  if (fm) {
    const w = fm[1];
    if (
      !/^(the|this|that|dear|january|february|march|april|may|june|july|august|september|october|november|december)$/i.test(
        w,
      ) &&
      !valueWords.includes(w.toLowerCase())
    )
      return w;
  }
  return null;
}

// Two distinct approved values are the same fact only when the SOURCE ties
// them: canon containment, or one sentence/quote carrying both wordings.
// East/West vs "TWO SITES" never merge without that evidence.
function equivalenceSupport(claims, bundle) {
  const vals = [...new Set(claims.map((c) => stemCanon(c.value)))];
  if (vals.length < 2) return true;
  const norm = (t) =>
    " " +
    String(t ?? "")
      .toLowerCase()
      .replace(/\band\b/g, " ")
      .replace(/[^a-z0-9]+/g, " ")
      .replace(/\b(\w{3,})s\b/g, "$1") +
    " ";
  let sentences = null;
  const getSentences = () =>
    (sentences ??= (bundle?.sources ?? []).flatMap((src) =>
      String(src.text ?? "")
        .split(/(?<=[.!?])\s+/)
        .map(norm),
    ));
  // Engagement sections: dated blocks ("AUG 19 2026 - STEERING COMMITTEE");
  // a document without date headers is one section.
  const DATE_HEADER =
    /^\s*(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*\s+\d{1,2}\b/i;
  let sections = null;
  const buildSections = () =>
    (bundle?.sources ?? []).flatMap((src) => {
      const out = [];
      let cur = [];
      let headers = 0;
      for (const line of String(src.text ?? "").split("\n")) {
        if (DATE_HEADER.test(line)) {
          if (cur.length) out.push(cur.join("\n"));
          cur = [];
          headers++;
        }
        cur.push(line);
      }
      if (cur.length) out.push(cur.join("\n"));
      // A headerless document has no engagement sections: one decision word
      // cannot prove two unrelated approvals equivalent.
      return headers ? out : [];
    });
  const getSections = () => (sections ??= buildSections());
  const APPROVAL_RE =
    /\b(approves|approved|accepted|signed|agreed|confirmed|ratified|adopted)\b/i;
  const quoteHay = claims.map((c) => norm(c.quote));
  const wordsOf = (v) => v.split(" ").filter(Boolean);
  const hasAll = (hay, v) => wordsOf(v).every((w) => hay.includes(` ${w} `));
  // Contrast/negation in the shared sentence means the wordings are being
  // distinguished, not equated ("East and West, not two sites").
  const CONTRAST =
    /\b(not|no|never|rather than|instead of|versus|vs|but|however|unlike|except|excluding|differs?|distinct)\b/;
  for (let i = 0; i < vals.length; i++)
    for (let j = i + 1; j < vals.length; j++) {
      const a = vals[i];
      const b = vals[j];
      // Distinct concrete amounts/dates are never one fact: no containment
      // and no shared-sentence support ("usd 54" is a word-subset of
      // "usd 54 000" quotes, so substring evidence is meaningless here).
      if (/\d/.test(a) || /\d/.test(b)) return false;
      // Unit compatibility: count-bearing wordings with different head
      // nouns ("four sites" vs "four depots") are never one fact.
      const na = a.split(" ").pop();
      const nb = b.split(" ").pop();
      if (
        na !== nb &&
        /\d|^(one|two|three|four|five|six|seven|eight|nine|ten)\b/.test(
          a + " " + b,
        )
      )
        return false;
      // Containment only merges amount-free wordings.
      if (a.includes(b) || b.includes(a)) continue;
      const quoteOk = quoteHay.some(
        (h) => hasAll(h, a) && hasAll(h, b) && !CONTRAST.test(h),
      );
      const sentenceOk = getSentences().some(
        (h) => hasAll(h, a) && hasAll(h, b) && !CONTRAST.test(h),
      );
      // Evidence chain across one engagement section: both wordings appear
      // with a decision marker and no sentence contrasts THIS pair (a
      // "TWO sites instead of FOUR" contrast is about FOUR, not this pair).
      const sectionOk = getSections().some((sec) => {
        const nsec = norm(sec);
        if (!hasAll(nsec, a) || !hasAll(nsec, b)) return false;
        if (!APPROVAL_RE.test(sec)) return false;
        const sents = sec.split(/(?<=[.!?])\s+/).map(norm);
        return !sents.some(
          (h) => hasAll(h, a) && hasAll(h, b) && CONTRAST.test(h),
        );
      });
      if (!quoteOk && !sentenceOk && !sectionOk) return false;
    }
  return true;
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
      let lineStart = 0;
      for (let i = 0; i < lines.length; i++) {
        const rawLine = lines[i];
        const line = rawLine.replace(/^\s*\d+\.\s*/, "").trim();
        const lineOff =
          lineStart + (rawLine.length ? rawLine.indexOf(line) : 0);
        lineStart += rawLine.length + 1;
        if (!line) continue;
        // A line can hold several sentences with different subjects; cite the
        // sentence that actually carries this field's negative.
        let sentOff = 0;
        for (const sentence of line.split(/(?<=[.!?])\s+/)) {
          const quote = sentence.trim();
          const at = quote ? line.indexOf(quote, sentOff) : -1;
          if (at >= 0) sentOff = at + quote.length;
          if (relevant(sentence)) {
            return {
              field,
              value: null,
              quote,
              title: src.title,
              sourceId: src.id,
              hash: src.hash,
              start: at >= 0 ? lineOff + at : undefined,
              end: at >= 0 ? lineOff + at + quote.length : undefined,
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

// Speech normalization may reorder "December 10" to "10 December" - a named
// value matches in either month-day order.
function valueNamedIn(v, question) {
  const low = String(v).toLowerCase();
  const q = question.toLowerCase();
  if (q.includes(low)) return true;
  const m = low.match(/^(\p{L}+)\s+(\d{1,2})$/u);
  return !!m && q.includes(`${m[2]} ${m[1]}`);
}

function verdictFor(field, resolved, claims, question, intent, bundle) {
  const { active, approved } = resolved;
  const approvedClaims = approved.get(field) ?? [];
  // Two approved values in force (two customers, one document) are an open
  // conflict, never a silent single CONFIRMED answer.
  if (approvedClaims.length) {
    // Identity conflict outranks everything: distinct engagements' approved
    // values are an ambiguity to surface, never mergeable by any chain.
    const apprLabels = new Set(
      approvedClaims.map(identityLabel).filter(Boolean),
    );
    if (apprLabels.size > 1) return "AMBIGUOUS";
    // Status preservation: approved values stay approved. Distinct values
    // in force are an ambiguity to surface (never "not approved"), and
    // distinct free-text wordings merge into one fact only with source
    // equivalence support.
    const avals = [...new Set(approvedClaims.map((c) => stemCanon(c.value)))];
    if (avals.length > 1 && !equivalenceSupport(approvedClaims, bundle))
      return "AMBIGUOUS";
    return "CONFIRMED";
  }
  const actives = active.get(field) ?? [];
  const neg = scopedNegative(field, claims, question, bundle);
  if (!actives.length) return neg ? "NO-RECORD" : "UNKNOWN";
  // Agreement-existence: several recorded negatives ("no signed agreement",
  // "no signed addendum") are one answer, not competing values.
  if (
    field === "signedAgreement" &&
    actives.every((c) => c.status === "unresolved")
  )
    return "NO-RECORD";
  // A "did X approve <specific value>?" question with an explicit scoped
  // negative on record is a denial of that value, not an open decision.
  // But when the question names THE current active value (a single value
  // stands), lead with that record and its disclosed status - an internal
  // target answers "not approved" itself; quoting an older negative would
  // mislead. With several values in force the denial stays.
  const values = new Set(actives.map((c) => canonValue(c.value)));
  const namesCurrent =
    values.size === 1 && actives.some((c) => valueNamedIn(c.value, question));
  if (
    intent === "FINALIZED" &&
    neg &&
    namesSpecificValue(question, actives) &&
    !namesCurrent
  )
    return "NO-RECORD";
  if (values.size > 1) return "OPEN";
  const current = actives[0];
  // Amount-bearing claims stay grounded PROPOSED; an explicit field-scoped
  // negative upgrades to NO-RECORD only for non-amount fields or signing
  // questions (never a flat "no" on an amount).
  // The scoped negative upgrade does not apply when the question names the
  // current value: its own record already discloses the non-approval
  // ("December 10 is the current internal target, not approved"), and
  // leading with an older negative would bury the record asked about.
  if (
    neg &&
    intent === "FINALIZED" &&
    !namesCurrent &&
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
  scope = [],
}) {
  // "Latest" must be true of what is spoken. When the ask itself scoped
  // the resolution (an identity token or descriptor narrowed the claims),
  // the scope is named in the answer, in the record's own casing; without a
  // scoped route there is no scope to name and the wording stays generic.
  const latestProposalPhrase = (value) => {
    // Ground the named scope in the record itself: keep only the asked
    // tokens that appear on the claim's own sentence, in its casing.
    const display = (scope ?? [])
      .map((t) => new RegExp(`\\b${t}\\b`, "i").exec(current?.quote ?? "")?.[0])
      .filter(Boolean);
    if (display.length)
      return `${cap(value)} is the latest ${display.join(" ")} proposal on record, and it is not approved.`;
    return `${cap(value)} is the latest proposal, and it is not approved.`;
  };
  const disp = (v) => (v ? v.replace(/(\S)\(/, "$1 (") : v);
  const value = current ? disp(current.value) : null;
  const label = current ? docLabel(current) : null;
  // "Originally/first proposed" asks for the EARLIEST record; "what was it
  // before" asks for the latest superseded one.
  const earlier = history.length
    ? /\b(original(?:ly)?|first|initial(?:ly)?)\b/i.test(question)
      ? [...history].sort((a, b) =>
          (a.docDate || "").localeCompare(b.docDate || ""),
        )[0]
      : history[history.length - 1]
    : null;
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
  if (
    (field === "signoffWho" || field === "signedAgreement") &&
    /\bwho\b/i.test(question)
  ) {
    // A who-ask is answered by the record's own statement when the record
    // says there IS no named signatory - never by an adjacent
    // signature-requirement line.
    for (const c of citations.length ? citations : (claims ?? [])) {
      const m = (c.quote ?? "").match(
        /[^.\n]*\bno (?:named )?(?:client )?signatory\b[^.\n]*/i,
      );
      if (m)
        return `${cap(m[0].trim().replace(/[.;:,]?$/, ""))} - that is the record, from ${docLabel(c)}.`;
    }
  }
  if (field === "signoffWho" && current && verdict !== "CONFIRMED")
    // "Did finance reject it?" right after "who signs off": the rejection
    // question is answered first; missing approval is not a rejection.
    return intent === "REJECTED"
      ? `No record shows a rejection. The terms need ${current.value} sign-off, and that sign-off is not recorded yet.`
      : `The terms need ${current.value} sign-off, and that sign-off is not recorded yet.`;
  if (
    field === "scope" &&
    current &&
    intent !== "HISTORY" &&
    verdict !== "AMBIGUOUS"
  )
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
    case "LATEST:PROPOSED": {
      // "Is $48,000 the current fee?" names a figure the record replaced:
      // the answer is "No" first, then what stands.
      const named = (
        question.match(/[$€£₹]\s?[\d,]+|\b\d{1,3}(?:,\d{3})+\b/g) ?? []
      ).map((a) => a.replace(/[^\d]/g, ""));
      const cur = (value ?? "").replace(/[^\d]/g, "");
      const yn = /^\s*(is|was|are|has|did|does)\b/i.test(question);
      if (yn && cur && named.length && named.every((n) => n !== cur)) {
        const old =
          earlier && named.includes((earlierVal ?? "").replace(/[^\d]/g, ""))
            ? ` ${earlierVal} was superseded.`
            : "";
        return `No. ${latestProposalPhrase(value)}${old}`;
      }
      if (current?.status === "internal-target")
        return `${cap(value ?? "It")} is the current internal target, not an approved or contractual ${field === "deadline" ? "date" : field === "fee" ? "fee" : field === "paymentSplit" ? "split" : "figure"}.`;
      return value
        ? latestProposalPhrase(value)
        : `It is the latest proposal, and it is not approved.`;
    }
    case "FINALIZED:CONFIRMED":
    case "LATEST:CONFIRMED": {
      // "Yes" belongs to a polar ask; a wh-ask ("what is the latest fee?",
      // "which payment terms?") gets the declarative record, not a "Yes."
      const polar =
        /^\s*(?:is|was|are|were|has|have|had|did|does|do|can|could|should|would|will)\b/i.test(
          question,
        );
      return polar
        ? `Yes. ${cap(label)} records the approval${value ? ` of ${value}` : ""}.`
        : `${cap(label)} records the approval${value ? ` of ${value}` : ""}.`;
    }
    case "FINALIZED:OPEN":
    case "LATEST:OPEN":
      return `That is still open: ${dedupeValues(citations.map((c) => c.value)).join(" versus ")} are both on record, and it is not approved.`;
    case "HISTORY:PROPOSED":
    case "HISTORY:OPEN": {
      if (!earlier)
        return `${cap(value ?? "The current record")} is the only record, and it is not approved.`;
      const rest = `the earlier record was ${earlierVal}. It was superseded by ${value ?? "the current proposal"}, which is still not approved.`;
      // "Yes" only answers a yes/no question, and only when the figure the
      // caller named (if any) IS the earlier record: "Was the original fee
      // $42,000?" is a "No", not "Yes, the earlier record was $48,000".
      const yn =
        /^\s*(was|is|were|did|has|had|didn'?t|wasn'?t|isn'?t)\b/i.test(
          question,
        ) ||
        /,?\s*(right|correct|wasn'?t it|isn'?t it|didn'?t (?:they|it|we))\s*\??\s*$/i.test(
          question,
        );
      const named = (
        question.match(/[$€£₹]\s?[\d,]+|\b\d{1,3}(?:,\d{3})+\b|\b\d{4,}\b/g) ??
        []
      ).map((a) => a.replace(/[^\d]/g, ""));
      const old = (earlierVal ?? "").replace(/[^\d]/g, "");
      if (named.length && old && !named.includes(old)) return `No, ${rest}`;
      return yn ? `Yes, ${rest}` : cap(rest);
    }
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
    case "REJECTED:CONFIRMED":
      return `No record shows a rejection. ${cap(value)} is approved, per ${label}.`;
    case "REJECTED:REJECTED-EXPLICIT":
      return `Yes. ${cap(label)} records the rejection.`;
    default:
      if (verdict === "AMBIGUOUS") {
        const seenAppr = new Set();
        const appr = citations.filter(
          (c) =>
            c.status === "approved" &&
            c.field === field &&
            !seenAppr.has(c) &&
            (seenAppr.add(c), true),
        );
        const vals = dedupeValues(appr.map((c) => disp(c.value)));
        const labels = appr.map(identityLabel);
        const hist = earlier ? `The earlier record was ${earlierVal}. ` : "";
        if (
          labels.length > 1 &&
          labels.every(Boolean) &&
          new Set(labels).size > 1
        )
          return (
            hist +
            `Different engagements have different approved values: ${appr.map((c, i) => `${labels[i]} approved ${disp(c.value)}`).join("; ")}. Which do you mean?`
          );
        if (vals.every((v) => /\d/.test(v)))
          return (
            hist +
            `The approved records conflict: ${vals.join(" versus ")}. I can't pick one without knowing which you mean.`
          );
        return (
          hist +
          `The approved records are ${vals.join(" and ")}; the documents don't say whether those are the same ${field}.`
        );
      }
      if (verdict === "UNKNOWN")
        return `I couldn't establish that from these documents.`;
      if (verdict === "OPEN")
        return `That is still open: ${dedupeValues(citations.map((c) => c.value)).join(" versus ")} are both on record.`;
      if (verdict === "PROPOSED" && value)
        return current?.status === "internal-target"
          ? `${cap(value)} is the current internal target, not an approved or contractual ${field === "deadline" ? "date" : field === "fee" ? "fee" : field === "paymentSplit" ? "split" : "figure"}.`
          : `${cap(value)} is the current proposal; approval is not recorded.`;
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
  // Stable, meaningful order (never import order): dates chronologically,
  // then numbers ascending, then text.
  const MON =
    "january february march april may june july august september october november december".split(
      " ",
    );
  const key = (v) => {
    const d = /(\d{1,2})\s+([A-Za-z]+)(?:\s+(\d{4}))?/.exec(v);
    const mi = d ? MON.indexOf(d[2].toLowerCase()) : -1;
    if (mi >= 0)
      return [0, Number(d[3] ?? 0) * 10000 + mi * 100 + Number(d[1])];
    const n = Number(
      String(v)
        .replace(/[^\d.]/g, "")
        .split(".")[0],
    );
    return Number.isFinite(n) && /\d/.test(v) ? [1, n] : [2, 0];
  };
  return uniq
    .filter(
      (v) =>
        !uniq.some((o) => o !== v && canonValue(o).includes(canonValue(v))),
    )
    .sort((a, b) => {
      const [ka, va] = key(a);
      const [kb, vb] = key(b);
      return ka - kb || va - vb || a.localeCompare(b);
    });
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
      verdict !== "AMBIGUOUS" &&
      !/\bnot approved|not an approved|no approval|not final|isn't approved|not recorded|stays? a proposal|still not approved|is not final|neither is approved\b/i.test(
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
    "Monday Tuesday Wednesday Thursday Friday Saturday Sunday " +
    // spoken openers and recogniser spellings of contractions: a caller
    // saying "Also," or "Wasnt it" has not named an unknown party
    "Also Please Sorry Just Wait Alright Yeah Yes Yep Again Sure Thanks Thank Great Cool Listen Remind Tell Give " +
    "Quick Right Fine Well Hmm Hey Hello Actually Anyway Let Show Repeat Say Check Confirm Explain Last Next Another " +
    "Wasnt Didnt Isnt Doesnt Hasnt Dont Cant Wont Arent Werent Havent Hadnt Couldnt Wouldnt Shouldnt"
  ).split(" "),
);

// A capitalized name the documents never mention (wrong client, invented
// party): abstain rather than answer from the records we do hold.
function unknownNamedEntity(question, bundle) {
  const hay = bundle.sources
    .map((s) => `${s.title} ${s.text}`)
    .join(" ")
    .toLowerCase();
  // A contraction ("Wasn't", "Didn't") is one word, not the name "Wasn".
  for (const m of question.match(/\b[A-Z][a-z]{2,}(?:['’][a-z]+)?/g) ?? []) {
    if (/['’](?:t|re|ve|ll|d|m)$/.test(m)) continue;
    const t = m.replace(/['’]s$/, "");
    if (PROPER_STOP.has(t)) continue;
    if (!hay.includes(t.toLowerCase())) return t;
  }
  return null;
}

const lowerFirstTxt = (t) => (t ? t[0].toLowerCase() + t.slice(1) : t);

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
  // A span widened past the claim's own sentence proves the source, not a
  // pinpoint location - renderers must not present it as a pinpoint quote.
  ...(c.broadCitation ? { broadCitation: true } : {}),
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

const MOD_GENERIC = new Set(
  "the a an our my your their this that which what final finally current latest new old original earlier previous revised agreed proposed approved signed total monthly weekly fixed engagement pilot project overall actual real exact first second last full whole same other client's client".split(
    " ",
  ),
);
function unknownModifier(question, bundle) {
  const m =
    /\b([a-z][a-z-]{3,})\s+(fee|retainer|budget|price|deadline|split|contract|agreement)\b/i.exec(
      question,
    );
  if (!m || MOD_GENERIC.has(m[1].toLowerCase())) return null;
  const corpus = bundle.sources.map((s) => s.text.toLowerCase()).join("\n");
  const stem = m[1].toLowerCase().replace(/(ing|ed|s)$/, "");
  return corpus.includes(stem)
    ? null
    : `${m[1].toLowerCase()} ${m[2].toLowerCase()}`;
}

// Clarify, never alias (invoice family): an invoice/bill question asks
// about a billing DOCUMENT - its amount, number, issue or payment. The
// asked aspect named for the absence statement: number, payment, or the
// invoice itself. Null when the question is not about an invoice/bill.
function invoiceDocumentAsk(question, bundle) {
  // "Bill Lobban" is a person, not an invoice: name uses of people the
  // documents actually contain are stripped before the noun test, in any
  // letter case (voice ASR lowercases proper names). A real bill ("bill
  // of lading", "invoice bill") still matches.
  // Person vs payment noun by GRAMMATICAL INTENT, not letter case (voice
  // ASR and OCR lowercase proper names): a "bill" followed by a verb-like
  // word or a name is a person ("did bill pay?", "bill lobban declare?",
  // "bill's declaration"); a "bill" followed by a billing noun, "of", or
  // nothing is the payment document ("bill amount", "bill of lading",
  // "what is the bill?").
  const BILL_NOUN_TAIL =
    /^(?:of|amount|total|number|no\.?|id|due|payable|balance|invoice|payment|receipt|date|lading|s\s+(?:amount|total|number|due|date)\b)/i;
  let q = question;
  for (const src of bundle?.sources ?? []) {
    const names = new Map();
    for (const m of String(src.text ?? "").matchAll(/\b(Bill\s+[A-Za-z]+)\b/gi))
      names.set(m[1].toLowerCase(), m[1]);
    for (const [low, name] of names) {
      // A titlecase use in either the question or the document is a person.
      if (
        new RegExp(`\\b${name}\\b`).test(q) ||
        /\bBill\s+[A-Z][a-z]+\b/.test(name)
      )
        q = q.replace(new RegExp(`\\b${low}\\b`, "gi"), " ");
    }
  }
  // A possessive ("Bill's declaration", either apostrophe) is always the
  // person; a bare "bill" is the person unless a billing noun follows.
  q = q.replace(/\bbill[’']s\b/gi, " ");
  q = q.replace(/\bbill\b(\s+\S+)?/gi, (m, tail) =>
    !tail || BILL_NOUN_TAIL.test(tail.trim()) ? m : " ",
  );
  if (!/\binvoices?\b|\binvoiced\b|\bbills?\b/i.test(q)) return null;
  if (/\b(?:invoice|bill)s?\s+(?:number|no\.?|id)\b/i.test(question))
    return "an invoice number";
  if (/\b(?:paid|payment|settled|received|cleared)\b/i.test(question))
    return "a payment";
  return "an invoice";
}

// The records hold an invoice document only when text ties invoice/bill to
// an identifier, a billing amount, or a payment event. Invoicing TERMS
// ("invoiced 50% on signing") record a contingency, not an invoice.
function recordsInvoiceDocument(bundle) {
  const text = bundle.sources.map((s) => s.text).join("\n");
  return (
    /\b(?:invoice|bill)\s*(?:#|no\.?|number|id)\s*[:\-]?\s*[\w-]+/i.test(
      text,
    ) ||
    /\b(?:invoice|bill)\b[^.\n]{0,80}\b(?:total|due|payable|amount|balance)\b[^.\n]{0,60}\d/i.test(
      text,
    ) ||
    /\b(?:total|due|payable|balance)\b[^.\n]{0,40}\d[^.\n]{0,60}\b(?:invoice|bill)\b/i.test(
      text,
    ) ||
    /\b(?:invoice|bill)\b[^.\n]{0,60}\b(?:paid|settled|received|cleared)\b/i.test(
      text,
    ) ||
    /\b(?:paid|settled|received|cleared)\b[^.\n]{0,60}\b(?:invoice|bill)\b/i.test(
      text,
    )
  );
}

// Open-ended record lookup ("when did X leave?", "who declared Y?"): when
// the question's content words bind in the documents, the best matching
// verbatim sentence answers with its citation - never a same-name record
// about a different predicate. Words absent from the corpus stay unasked;
// a question whose terms mostly do not bind returns null.
function evidenceLookup(question, bundle, requireDigit = false) {
  const qT = terms(question);
  if (!qT.length) return null;
  const corpus = bundle.sources
    .map((src) => String(src.text ?? "").toLowerCase())
    .join("\n");
  const corpusWords = corpus.split(/\W+/);
  const corpusHit = (t) =>
    new RegExp(`\\b${t}\\b`).test(corpus) ||
    (t.length >= 4 &&
      corpusWords.some(
        (w) =>
          w.length >= 4 &&
          (w.startsWith(t.slice(0, 6)) || t.startsWith(w.slice(0, 6))),
      ));
  const bound = qT.filter(corpusHit);
  if (bound.length < Math.min(2, qT.length) || bound.length * 2 < qT.length)
    return null;
  const sub = subjectSentence(bound, bundle, qT, question, requireDigit, 4);
  if (!sub) return null;
  return { ...sub, spoken: sub.spoken.replace(/(: )\s*[-*•]\s+/u, "$1") };
}

export function spokenTurn(rawQuestion, bundle, prevField = null) {
  if (!bundle?.sources?.length) return null;
  // Speech notation -> document notation (numbers, ordinals, fillers).
  const question = normalizeSpoken(rawQuestion);
  if (identifierRequest(question)) {
    const result = answer(question, bundle);
    return {
      spoken: result.spoken,
      verdict: result.refused ? "UNKNOWN" : "QUOTED",
      field: null,
      intent: "IDENTIFIER",
      citations: result.evidence,
    };
  }

  // Temporal memory: "what was the fee as of 10 September?" is answered from
  // the records dated on/before that day only, and says so.
  const asOf = bundle.asOf ? null : parseAsOf(question, bundle);
  if (asOf && asOf.rest.length > 3) {
    const view = bundleAsOf(bundle, asOf.iso, asOf.inclusive);
    const when = `${asOf.anchor === "before" ? "Before" : "As of"} ${asOf.phrase}`;
    if (!view.sources.length)
      return {
        spoken: `No document in these records is dated ${asOf.anchor === "before" ? "before" : "on or before"} ${asOf.phrase}.`,
        verdict: "UNKNOWN",
        field: null,
        intent: "ASOF",
        citations: [],
      };
    const r = spokenTurn(asOf.rest, view, prevField);
    if (r)
      return {
        ...r,
        asOf: asOf.iso,
        spoken:
          `${when}, ${r.spoken[0].toLowerCase()}${r.spoken.slice(1)}`.replace(
            /^(As of|Before) ([^,]+), \$/,
            "$1 $2, $",
          ),
      };
    return null;
  }
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
      spoken: "I couldn't establish that from these documents.",
      verdict: "UNKNOWN",
      field: null,
      intent,
      citations: [],
    };
  // A modifier on a field noun that the documents never use ("the private
  // retainer", "the marketing budget") names something the records do not
  // contain: abstain instead of answering with the engagement's own figure.
  const unknownMod = unknownModifier(question, bundle);
  if (unknownMod && intent !== "MUTATE") {
    // Clarify, never alias: when the asked-for fee term is absent but the
    // documents do record a fee under another label, say what IS recorded
    // with its own label and status. The caller decides whether that is
    // the fee they meant; the figure is never presented AS the asked-for
    // term. Only the retainer/retention-fee family gets this clarification;
    // other unknown attributes ("marketing budget") stay a bare abstention.
    if (/^(?:retainer|retention) fee$/.test(unknownMod)) {
      const actives =
        resolveClaims(claims.filter((c) => c.field === "fee")).active.get(
          "fee",
        ) ?? [];
      const c = actives.find((x) => x.value && /\bfee\b/i.test(x.quote ?? ""));
      if (c) {
        const label = /\b([a-z][a-z-]*)\s+fees?\b/i.exec(c.quote)?.[1];
        const named = label ? `${label.toLowerCase()} fee` : "fee";
        const article = /^[aeiou]/.test(named) ? "an" : "a";
        return {
          spoken: `I don't see a ${unknownMod} in these documents. They do record ${article} ${named} of ${c.value}, ${c.status === "approved" ? "approved" : "proposed, not approved"}.`,
          verdict: "UNKNOWN",
          field: null,
          intent,
          citations: [c],
        };
      }
    }
    return {
      spoken: `I don't see a ${unknownMod} in these documents.`,
      verdict: "UNKNOWN",
      field: null,
      intent,
      citations: [],
    };
  }
  // Invoice family of clarify-never-alias: when the records hold no
  // invoice document or payment event, say so for the asked aspect. The
  // wording is scoped to these documents - it never asserts that no
  // invoice exists or was paid outside them. A fee recorded under its own
  // label may be named with its status; it is never presented AS an
  // invoice or as a payment.
  const invoiceAsk = invoiceDocumentAsk(question, bundle);
  if (invoiceAsk && intent !== "MUTATE" && !recordsInvoiceDocument(bundle)) {
    const absence = `These documents don't record ${invoiceAsk}.`;
    const feeActives =
      resolveClaims(claims.filter((c) => c.field === "fee")).active.get(
        "fee",
      ) ?? [];
    // Prefer the approved record, else the latest dated one: superseded
    // opening figures stay active honestly but must not lead an answer.
    const feeQuoting = feeActives.filter(
      (x) => x.value && /\bfee\b/i.test(x.quote ?? ""),
    );
    const fc =
      feeQuoting.find((x) => x.status === "approved") ??
      [...feeQuoting].sort((a, b) =>
        (b.docDate || "").localeCompare(a.docDate || ""),
      )[0];
    if (fc) {
      const label = /\b([a-z][a-z-]*)\s+fees?\b/i.exec(fc.quote)?.[1];
      const named = label ? `${label.toLowerCase()} fee` : "fee";
      const article = /^[aeiou]/.test(named) ? "an" : "a";
      const statusTail =
        fc.status === "approved"
          ? /internal/i.test(fc.quote ?? "")
            ? "approved internally; the client has not accepted"
            : "approved"
          : "proposed, not approved";
      return {
        spoken: `${absence} They do record ${article} ${named} of ${fc.value}, ${statusTail}.`,
        verdict: "NO-RECORD",
        field: null,
        intent,
        citations: [fc],
      };
    }
    return {
      spoken: absence,
      verdict: "NO-RECORD",
      field: null,
      intent,
      citations: [],
    };
  }
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
  // A real invoice document on file makes an invoice/bill amount question a
  // fee-field question; the absence guard above owns the no-invoice case.
  // A question naming a recorded value ("Is the December 10 target
  // approved?") is about that value's field - stronger evidence than any
  // keyword guess.
  // Speech normalization may reorder "December 10" to "10 December" - a
  // named value matches in either month-day order.
  const namedValueField =
    claims.find(
      (c) =>
        typeof c.value === "string" &&
        c.value.length >= 6 &&
        /\d|\s/.test(c.value) &&
        valueNamedIn(c.value, question),
    )?.field ?? null;
  const field =
    namedValueField ??
    resolveField(question, claims, null) ??
    (prevField ? resolveField(question, claims, prevField) : null) ??
    (invoiceAsk ? "fee" : null);
  if (!field && intent === "MUTATE")
    return {
      spoken:
        "I cannot change the records by voice. Approvals have to be added to the documents themselves.",
      verdict: "UNKNOWN",
      field: null,
      intent,
      citations: [],
    };
  if (!field && intent === "REJECTED") {
    // No field, no rejection on record: say so, and quote the pending
    // approval that names what the caller asked about, if one exists.
    const pend = pendingFor(question, bundle);
    if (pend) return pend;
  }
  if (!field) {
    // General evidence lookup before abstaining: when the question's
    // content words bind in the documents, the best matching verbatim
    // sentence answers it ("When did Bill Lobban leave?" -> the 11.08am
    // record). Words absent from the corpus stay unasked - a question
    // whose terms mostly do not bind keeps the honest abstention below.
    // Polar decision asks ("was the budget approved?") keep the extractive
    // decision path; this fallback covers open-ended record lookups.
    // Open-ended verbatim lookup is intentionally narrow: time-asks only,
    // where the answering record must carry an actual date/time. Wider
    // semantic binds answered unanswerable questions with unrelated
    // sentences (the CEO-name regression).
    if (
      /\b(?:approved?|rejected?|refused?|signed|agreed|finali[sz]ed|ratified|adopted)\b/i.test(
        question,
      )
    )
      return null;
    // A signatory who-ask: when the record itself says there is no named
    // signatory, that sentence IS the answer - say it verbatim instead of a
    // bare inability, and instead of an adjacent signature requirement.
    if (/\bwho\b/i.test(question) && /\bsign/i.test(question))
      for (const src of bundle.sources)
        for (const snt of sentencesOf(src)) {
          const m = snt.text.match(
            /[^.\n]*\bno (?:named )?(?:client )?signatory\b[^.\n]*/i,
          );
          if (m)
            return {
              spoken: `${m[0].trim().replace(/[.;:,]?$/, "")} - that is what the record says, in ${docLabel({ title: src.title })}.`,
              verdict: "QUOTED",
              field: null,
              intent,
              citations: [
                pack({
                  title: src.title,
                  quote: snt.text.trim(),
                  firstLine: snt.firstLine,
                  lastLine: snt.lastLine,
                  hash: src.hash,
                  sourceId: src.id,
                  start: snt.start,
                  end: snt.end,
                }),
              ],
            };
        }
    // Claim-bearing workspaces answer time-asks from the field graph's own
    // honest wording ("no timing is recorded"); verbatim retrieval is the
    // evidence source of last resort for documents with no claim graph.
    if (
      !claims.length &&
      /\b(?:when|what (?:time|date|day))\b/i.test(question)
    ) {
      const ev = evidenceLookup(question, bundle, true);
      if (ev) return ev;
    }
    return {
      spoken: "I couldn't establish that from these documents.",
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
  let fieldClaims = claims.filter((c) => c.field === field);
  // Month-intent ("What was the revised fee in August?"): answer from the
  // records of that month, year-bound like the engine - the asked year wins,
  // otherwise the latest year on record, disclosed in the answer.
  // Temporal use only: "fee in August", "August 2026" - never the modal
  // "May I ask...". The month must follow a temporal preposition or precede
  // a year.
  const monthM =
    question.match(
      /\b(?:in|of|during|from|for|since|before|after|by)\s+(january|february|march|april|may|june|july|august|september|october|november|december)\b/i,
    ) ??
    question.match(
      /\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+(?:\d{4}|\d{1,2}\b)/i,
    );
  if (monthM && fieldClaims.some((c) => c.docDate)) {
    const MONTHS12 =
      "january|february|march|april|may|june|july|august|september|october|november|december";
    const mi = MONTHS12.split("|").indexOf(monthM[1].toLowerCase());
    const monthNum = String(mi + 1).padStart(2, "0");
    const askYear = question.match(/\b(20\d{2})\b/)?.[1] ?? null;
    const inMonth = fieldClaims.filter(
      (c) =>
        c.docDate?.slice(5, 7) === monthNum &&
        (!askYear || c.docDate.startsWith(askYear)),
    );
    const years = [
      ...new Set(inMonth.map((c) => c.docDate.slice(0, 4))),
    ].sort();
    const yearUsed = askYear ?? years[years.length - 1] ?? null;
    let chosen = inMonth.filter((c) => c.docDate.startsWith(yearUsed));
    // A descriptor in the question ("the revised fee") binds to the records
    // whose own sentence carries it - later same-month changes with other
    // wording stay out.
    if (chosen.length > 1) {
      const dm = /\b([a-z][a-z-]{3,})\s+(?:fees?|retainer|price|rate)\b/i.exec(
        question,
      );
      if (dm && dm[1].toLowerCase() !== "revised") {
        // fall through: generic descriptor binding below covers it
      } else if (/\brevis/i.test(question)) {
        const rev = chosen.filter((c) => /\brevis/i.test(c.quote ?? ""));
        if (rev.length) chosen = rev;
      }
    }
    if (chosen.length) {
      // An approved record answers over a later cautionary mention of the
      // same value; otherwise the latest dated record leads.
      const rank = (c) =>
        c.status === "approved" ? 0 : c.status === "proposed" ? 1 : 2;
      const latest = [...chosen].sort(
        (a, b) =>
          rank(a) - rank(b) || (b.docDate || "").localeCompare(a.docDate || ""),
      )[0];
      const monthName =
        monthM[1][0].toUpperCase() + monthM[1].slice(1).toLowerCase();
      const resolvedNow = resolveClaims(claims);
      const currentApproved =
        (resolvedNow.approved.get(field) ?? []).find(
          (c) => !chosen.includes(c),
        ) ?? null;
      const tail = currentApproved
        ? /internal/i.test(currentApproved.quote ?? "")
          ? ` It was later replaced; the current record is ${currentApproved.value}, approved internally (the client has not accepted).`
          : ` It was later replaced; the current approved record is ${currentApproved.value}.`
        : "";
      const monthSpoken = `In ${monthName}${yearUsed ? " " + yearUsed : ""}, the recorded ${field === "fee" ? "fee" : field} was ${latest.value}, ${latest.status === "approved" ? "approved" : "proposed, not approved"}.${tail}`;
      const monthCites = [
        latest,
        ...(currentApproved ? [currentApproved] : []),
      ];
      // Same invariants as every other return: the guard must accept the
      // wording and citations are packed; otherwise fall through to the
      // standard path.
      if (guard(monthSpoken, monthCites, "QUOTED"))
        return {
          spoken: monthSpoken,
          verdict: "QUOTED",
          field,
          intent: "HISTORY",
          citations: monthCites.map(pack),
        };
    }
  }
  // Descriptor binding: "the retainer", "the retainer fee", "the engagement
  // fee" ask about the figure the documents attach to that descriptor.
  // Answer only from claims whose own sentence uses the descriptor; with no
  // match, fall back to the unfiltered graph (which reports open conflicts
  // instead of forcing one figure).
  // Identity binding: a question naming a specific subject ("the Alpha
  // migration fee", "Customer A") answers from that subject's records
  // only; with no match the unfiltered graph reports the ambiguity. Both
  // sides are canonical identity tokens - a bare "customer"/"client" is
  // generic and binds nothing.
  let scopeWords = [];
  const qIds = questionIds(question);
  if (qIds.length) {
    // Engagement-level names (the documents' own entities) bind by entity,
    // never by quote mention - a superseded opening sentence names the
    // engagement too, and binding to it would resurrect replaced records.
    const entityIds = new Set(
      fieldClaims.flatMap((c) => c.scopeEntities ?? []),
    );
    const entQ = qIds.filter((id) => entityIds.has(id));
    const rest = qIds.filter((id) => !entityIds.has(id));
    let bound = fieldClaims;
    if (entQ.length)
      bound = bound.filter((c) =>
        (c.scopeEntities ?? []).some((e) => entQ.includes(e)),
      );
    if (rest.length)
      bound = bound.filter((c) => claimIds(c).some((id) => rest.includes(id)));
    if (bound.length) {
      // A narrowing IS the grounded scope signal: the asked token
      // discriminates this subject's records from the field's others.
      if (bound.length < fieldClaims.length) scopeWords = [...qIds];
      fieldClaims = bound;
    }
  }
  if (field === "fee") {
    const dm =
      /\b([a-z][a-z-]{3,})\s+(?:fees?|retainer|price|rate)\b/i.exec(question) ??
      /\b(retainer)\b/i.exec(question);
    const desc = dm?.[1]?.toLowerCase();
    const statusWord =
      /^(proposed|revised|original|first|initial|earlier|previous|current|latest|new|old|final|approved|agreed|pending|superseded|updated)$/;
    if (desc && !statusWord.test(desc)) {
      const hit = fieldClaims.filter((c) =>
        new RegExp(`\\b${desc}\\b`, "i").test(c.quote ?? ""),
      );
      // Narrow only when the descriptor picks ONE value. A descriptor that
      // spans figures the unfiltered graph resolves by supersession (the
      // revised engagement fee) must not be flattened into a false conflict.
      if (hit.length && new Set(hit.map((c) => c.value)).size === 1) {
        if (hit.length < fieldClaims.length)
          scopeWords = [...new Set([...scopeWords, desc])];
        fieldClaims = hit;
      }
    }
  }
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
      const sub = subjectSentence(
        unbound,
        bundle,
        terms(question),
        question,
        false,
        4,
      );
      if (sub) return sub;
    }
  }
  // Actor-scoped approval questions ("Did steering approve the fee?"): the
  // verdict comes from claims carrying THAT authority. Another authority's
  // approval of the same field, or the actor's approval of another subject,
  // never answers it.
  const actorM = question.match(
    /\b(steering|committee|board|customer|client|finance|legal)\b/i,
  );
  const yesNoAppr =
    /^(?:did|has|have|was|were|is|are|does|do)\b[^?]*\b(approv|accept|sign|agree|authoriz)/i.test(
      question,
    );
  if (actorM && yesNoAppr && intent !== "MUTATE") {
    const actor = /steering|committee|board/i.test(actorM[1])
      ? "body"
      : /customer|client/i.test(actorM[1])
        ? "client"
        : "internal";
    const actorApproved = fieldClaims.filter(
      (c) =>
        (c.authority ?? "unspecified") === actor && c.status === "approved",
    );
    if (!actorApproved.length) {
      const neg = fieldClaims.find(
        (c) =>
          (c.authority ?? "unspecified") === actor && c.status === "unresolved",
      );
      const agNeg =
        !neg && /sign|agree|accept/i.test(question)
          ? claims.find(
              (c) =>
                c.field === "signedAgreement" &&
                c.status === "unresolved" &&
                (actor !== "client" || /client|customer/i.test(c.quote)),
            )
          : null;
      const actorScope = claims.find(
        (c) =>
          (c.authority ?? "unspecified") === actor &&
          c.status === "approved" &&
          c.field !== field,
      );
      const otherAppr = fieldClaims.find(
        (c) =>
          c.status === "approved" && (c.authority ?? "unspecified") !== actor,
      );
      const negC = neg ?? agNeg ?? null;
      if (negC || actorScope) {
        const parts = ["No."];
        if (negC)
          parts.push(
            `Per ${docLabel(negC)}: ${lowerFirstTxt(trimQuote(negC.quote.replace(/^\s*\d+\.\s*/, ""), 110))}`,
          );
        else
          parts.push(
            `No ${actorM[1].toLowerCase()} approval of that is recorded.`,
          );
        if (actorScope)
          parts.push(
            `${cap(actorM[1].toLowerCase())} approval covers ${actorScope.field === "scope" ? "the scope" : `the ${actorScope.field}`} only.`,
          );
        if (otherAppr)
          parts.push(
            `The recorded approval is ${otherAppr.authority === "internal" ? "internal" : (otherAppr.authority ?? "unspecified")}, per ${docLabel(otherAppr)}.`,
          );
        return {
          spoken: parts.join(" "),
          verdict: "NO-RECORD",
          field,
          intent,
          citations: [negC, actorScope, otherAppr].filter(Boolean).map(pack),
        };
      }
    }
  }
  // signedAgreement: answer the asked instrument (addendum vs agreement/
  // contract) from ITS records, never a neighbor's.
  if (field === "signedAgreement") {
    const noun = /addendum/i.test(question)
      ? /addendum/i
      : /contract|agreement/i.test(question)
        ? /agreement|contract/i
        : null;
    if (noun) {
      const hit = fieldClaims.filter((c) => noun.test(c.quote));
      if (hit.length) fieldClaims = hit;
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
  const approvedSorted = [...(resolved.approved.get(field) ?? [])].sort(
    (a, b) => Number(/\band\b/.test(b.value)) - Number(/\band\b/.test(a.value)),
  );
  const current =
    verdict === "CONFIRMED"
      ? (approvedSorted[0] ?? actives[0] ?? null)
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
  if (engineResult.refused && (verdict === "UNKNOWN" || !current)) {
    // A time ask the field graph cannot place ("when did Bill Lobban
    // leave?") still deserves the verbatim dated record when the
    // question's words bind in the documents - actual retrieval, never a
    // same-name record about another predicate.
    // Only when the resolved field has NO claims in these documents: a
    // mis-bound field (the engine reads "leave" as paymentSplit) must not
    // bury the verbatim dated record. When the field DOES have claims
    // ("finance had not yet signed off"), the field path's own honest
    // wording stands.
    if (
      !claims.some((c) => c.field === field) &&
      /\b(?:when|what (?:time|date|day))\b/i.test(question)
    ) {
      const ev = evidenceLookup(question, bundle, true);
      if (ev) return ev;
    }
    // A bare payment ask ("Did Bill pay?") with no invoice or payment
    // event on record: scoped absence as a non-assertion, no citation.
    if (
      /\b(?:pay|paid|payment|settle[ds]?)\b/i.test(question) &&
      !/\b(?:fees?|retainer|split)\b/i.test(question) &&
      !recordsInvoiceDocument(bundle)
    )
      return {
        spoken: "These documents don't record a payment.",
        verdict: "NO-RECORD",
        field: null,
        intent,
        citations: [],
      };
    return null;
  }
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
    scope: scopeWords,
  });
  // An internal/body approval is not client acceptance: say whose approval
  // it is, and what the client side still owes, whenever the record says so.
  if (
    spoken &&
    verdict === "CONFIRMED" &&
    current &&
    (current.authority === "internal" || current.authority === "body")
  ) {
    const bits = [
      current.authority === "internal"
        ? "approved internally"
        : "approved at committee level",
    ];
    if (
      claims.some(
        (c) =>
          c.field === field &&
          c.authority === "client" &&
          c.status === "unresolved",
      )
    )
      bits.push("the client has not accepted");
    if (
      (field === "fee" || field === "paymentSplit") &&
      claims.some(
        (c) => c.field === "signedAgreement" && c.status === "unresolved",
      )
    )
      bits.push("no signed agreement is on record");
    spoken = spoken.replace(/\s*\.$/, "") + ". " + cap(bits.join("; ")) + ".";
  }
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
