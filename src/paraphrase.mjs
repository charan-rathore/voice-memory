// Paraphrase-aware lookup: find the one sentence a reworded question is
// about, and speak it verbatim with its citation, only when the evidence
// is unambiguous. It runs after the engine abstains, so it can add answers
// but never changes one the engine already gives.
//
// Built from published practice, without a language model in the path:
//  - Small units, big context ("sentence window" / small-to-big): every
//    sentence or table row is its own retrieval unit, so a paraphrase is
//    compared with one claim, not a whole page.
//  - Contextual units (Anthropic, "Contextual Retrieval", 2024): each unit is
//    embedded and indexed with a deterministic prefix naming its document,
//    type and date, so "the client's email" can find the email's sentence.
//  - Hybrid ranking with reciprocal-rank fusion (Cormack, Clarke & Büttcher,
//    SIGIR 2009; k = 60), weighted 0.8 semantic / 0.2 lexical as in
//    Anthropic's contextual-embeddings cookbook.
//  - The BGE query instruction ("Represent this sentence for searching
//    relevant passages: ", bge-small-en-v1.5 model card) was measured both
//    ways: with it the gate served a wrong passage on held-out, without it
//    none, so queries are embedded plain (QUERY_PREFIX).
//  - A calibrated gate: serve only when the top unit's cosine clears an
//    absolute floor AND beats the best unit of any other document by a
//    margin. Both thresholds are tuned on the development split of
//    evaluation/paraphrase-questions.json and reported on held-out.
import { sentencesOf, cite, docLabelOf } from "./spoken-routes.mjs";
import { extractClaims, resolveClaims } from "../dist/engine.mjs";
import { embedTextsReady } from "./dense.mjs";
import { bridgeToEnglish } from "./vernacular.mjs";
import { layExpand } from "./lay-terms.mjs";

export const QUERY_INSTRUCTION =
  "Represent this sentence for searching relevant passages: ";
// Measured both ways (see above): queries are embedded plain.
export const QUERY_PREFIX = "";
// Tuned on the development split only (evaluation/paraphrase-bench.mjs).
export const GATE = { minCosine: 0.72, minMargin: 0.02, agree: 0.5 };
const RRF_K = 60;
const W_SEMANTIC = 0.8;
const W_LEXICAL = 0.2;

// ------------------------------------------------------------ units
const STOP = new Set(
  "a an the and or but if so of in on at to for from by with as is are was were be been do does did has have had will would can could should what which who when where why how this that these those it its i me my we our you your they their there not no any all some about into than just also only please tell say said".split(
    " ",
  ),
);
const tokens = (s) =>
  (
    String(s)
      .toLowerCase()
      .match(/[a-z0-9$][a-z0-9$,./%-]*/g) ?? []
  )
    .map((t) => t.replace(/[.,/-]+$/, ""))
    .filter((t) => t && !STOP.has(t))
    .map((t) =>
      t.length > 4 && !/\d/.test(t)
        ? t.replace(/(ations?|ing|ed|es|s)$/, "")
        : t,
    );

function contextOf(src) {
  const type = (src.text.match(/Type:\s*([^.\n]+)/i) ?? [])[1]?.trim();
  const date = (src.text.match(/Date:\s*(\d{4}-\d{2}-\d{2})/i) ?? [])[1];
  const heading = (src.text.match(/^#\s*(.+)$/m) ?? [])[1]?.trim();
  return [heading || docLabelOf(src), type, date].filter(Boolean).join(", ");
}

const INDEX = new WeakMap();
/** Sentence-level units with their document context, cached per bundle. */
export function unitsOf(bundle) {
  let idx = INDEX.get(bundle);
  if (idx) return idx;
  const units = [];
  for (const src of bundle?.sources ?? []) {
    const ctx = contextOf(src);
    for (const sent of sentencesOf(src)) {
      // headings and fragments are not claims ("IMPRESSION", "CONTRAST"),
      // but short findings are ("Moderate hiatal hernia.")
      const n = sent.text.split(/\s+/).length;
      if (n < 2 || (n < 4 && !/[a-z]/.test(sent.text))) continue;
      units.push({
        src,
        sent,
        text: `${ctx}: ${sent.text}`,
        terms: tokens(`${ctx} ${sent.text}`),
      });
    }
  }
  // BM25 statistics over the contextual units
  const df = new Map();
  for (const u of units)
    for (const t of new Set(u.terms)) df.set(t, (df.get(t) ?? 0) + 1);
  const avg =
    units.reduce((n, u) => n + u.terms.length, 0) / (units.length || 1);
  idx = { units, df, avg, vectors: null, warming: null };
  INDEX.set(bundle, idx);
  return idx;
}

/** Embed the units once the dense model is resident. Safe to call often. */
export function warmUnits(bundle) {
  const idx = unitsOf(bundle);
  if (idx.vectors || idx.warming) return idx.warming ?? Promise.resolve(true);
  idx.warming = embedTextsReady(idx.units.map((u) => u.text)).then((v) => {
    idx.warming = null;
    if (v) idx.vectors = v;
    return !!v;
  });
  return idx.warming;
}

function bm25(idx, q) {
  const N = idx.units.length,
    k1 = 1.2,
    b = 0.75;
  // lay words also search for the clinical words reports use (lay-terms.mjs)
  const own = new Set(tokens(q));
  const extra = new Set(
    tokens(layExpand(q).join(" ")).filter((t) => !own.has(t)),
  );
  const qt = [...own, ...extra];
  return idx.units.map((u) => {
    let s = 0;
    for (const t of qt) {
      // a clinical word the question's lay word stands for is the specific
      // evidence; weight it above the lay context words ("lungs")
      const w = extra.has(t) ? 1.5 : 1;
      const f = u.terms.filter((x) => x === t).length;
      if (!f) continue;
      const n = idx.df.get(t) ?? 0;
      const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
      s +=
        w *
        idf *
        ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * u.terms.length) / idx.avg)));
    }
    return s;
  });
}
const dot = (a, b) => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
};
const ranks = (scores) => {
  const order = scores.map((s, i) => [s, i]).sort((x, y) => y[0] - x[0]);
  const r = new Array(scores.length);
  order.forEach(([, i], k) => (r[i] = k + 1));
  return r;
};

/**
 * Ranked units for a question with every signal exposed (for the bench and
 * for the gate). `queryVector` must be embedded with QUERY_PREFIX.
 */
export function rankUnits(question, bundle, queryVector) {
  const idx = unitsOf(bundle);
  if (!idx.vectors || !queryVector) return [];
  const cos = idx.vectors.map((v) => dot(v, queryVector));
  const lex = bm25(idx, question);
  const rc = ranks(cos),
    rl = ranks(lex);
  return idx.units
    .map((u, i) => ({
      unit: u,
      cosine: cos[i],
      lexical: lex[i],
      fused:
        W_SEMANTIC / (RRF_K + rc[i]) +
        (lex[i] > 0 ? W_LEXICAL / (RRF_K + rl[i]) : 0),
    }))
    .sort((a, b) => b.fused - a.fused);
}

/**
 * Apply the gate to a ranking: the top unit must clear the cosine floor and
 * lead the best unit from any OTHER document by the margin (two documents
 * saying similar things is exactly when a paraphrase is ambiguous).
 */
export function gate(ranked, { minCosine, minMargin, agree = null } = GATE) {
  const top = ranked[0];
  if (!top) return null;
  const rival = ranked.find((r) => r.unit.src !== top.unit.src);
  const margin = top.cosine - (rival?.cosine ?? 0);
  if (top.cosine >= minCosine && margin >= minMargin) return { ...top, margin };
  // Agreement: two independent signals pick the same sentence. It is the
  // best lexical match (lay words expanded) AND semantically close. Lexical
  // agreement is what the cosine floor alone cannot see for short clinical
  // sentences ("Moderate hiatal hernia.").
  if (agree != null) {
    const maxLex = Math.max(0, ...ranked.map((r) => r.lexical));
    const topCos = Math.max(...ranked.map((r) => r.cosine));
    // among the lexical leaders (near-ties count), the semantically closest
    const lex = ranked
      .filter((r) => maxLex > 0 && r.lexical >= 0.9 * maxLex)
      .sort((a, b) => b.cosine - a.cosine)[0];
    if (lex && lex.cosine >= agree && lex.cosine >= topCos - 0.08) {
      const other = ranked.find((r) => r.unit.src !== lex.unit.src);
      const margin = lex.cosine - (other?.cosine ?? 0);
      // The margin rule is not optional: agreement between two signals about
      // the SAME document cannot settle ambiguity BETWEEN documents. A
      // lexical leader with a cross-document rival within the margin is a
      // guess, and a guess must not be spoken as the answer.
      if (margin < minMargin) return null;
      return {
        ...lex,
        margin,
        agreed: true,
      };
    }
  }
  return null;
}

/**
 * The verbatim sentence a reworded question asks about, with a validated
 * citation, or null. Needs the dense model resident; never waits for it.
 */
// Promotion of a retrieved sentence into a spoken answer is UNPROVEN
// (independent review 2026-11-02: weak-status answers to strong-action
// questions, stale conflicting values, preliminary results promoted over
// corrections). It stays OFF in production: both public call sites go
// through promotedAnswer, which abstains unless a developer explicitly
// opts in for gate work. paraphraseLookup itself is preserved, tested,
// and reachable only through that opt-in.
export const paraphrasePromoteEnabled = () =>
  process.env.VM_PARAPHRASE_PROMOTE === "1";

export async function promotedAnswer(question, bundle) {
  if (!paraphrasePromoteEnabled()) return null;
  return paraphraseLookup(question, bundle);
}

export async function paraphraseLookup(
  question,
  bundle,
  { thresholds = GATE } = {},
) {
  const idx = unitsOf(bundle);
  if (!idx.vectors) {
    // A fresh upload: embed its sentences now if the model is resident
    // (a few hundred short units take about a second), else stay out.
    const ready = await Promise.race([
      warmUnits(bundle),
      new Promise((r) => setTimeout(() => r(false), 4000)),
    ]);
    if (!ready || !idx.vectors) return null;
  }
  // Hindi / Hinglish asks also search the English words for their terms.
  const bridge = bridgeToEnglish(question);
  const searched = bridge ? `${question} ${bridge}` : question;
  const [qv] = (await embedTextsReady([QUERY_PREFIX + searched])) ?? [];
  if (!qv) return null;
  const hit = gate(
    rankUnits(searched, bundle, qv).filter(
      (r) => !replacedSource(bundle, r.unit.src),
    ),
    thresholds,
  );
  if (!hit) return null;
  const { src, sent } = hit.unit;
  // Answerability, not just relevance. Two fail-closed checks stand between
  // a top-ranked sentence and the speaker, because retrieval scores cannot
  // see either one:
  // 1. A strong-action question ("did the doctor prescribe...?") is never
  //    answered by a weak-status sentence ("...was discussed pending
  //    review"). Discussion is not a decision; speaking it as the answer
  //    upgrades the record.
  if (Q_STRONG_ACTION.test(question) && SENT_WEAK_STATUS.test(sent.text))
    return null;
  // 2. A sentence stating a value the bundle itself cannot stand behind is
  //    never spoken: either the amendment chain superseded it while a newer
  //    active value exists, or the field has several unresolved active
  //    values and the sentence presents one side of the conflict as fact.
  //    "The report says the fee is $42,000" is false in effect when the
  //    current record says $48,000 - or when the record cannot say which.
  if (statesUnresolvedValue(bundle, sent.text)) return null;
  const label = bundle.sources.length === 1 ? "the report" : docLabelOf(src);
  return {
    spoken: `${label[0].toUpperCase()}${label.slice(1)} says: ${sent.text}`,
    citation: cite(src, sent),
    cosine: hit.cosine,
    margin: hit.margin,
  };
}

const Q_STRONG_ACTION =
  /\b(prescrib\w*|approv\w*|sign(?:ed|ed off)?|final(?:i[sz]ed)?|confirm\w*|decided|agreed|started?|taking|recommend\w*|order(?:ed)?|discharg\w*)\b/i;
const SENT_WEAK_STATUS =
  /\b(propos\w*|pending|draft|discuss\w*|prelim\w*|provisional|tentative|under review|subject to|awaiting|suggest\w*|consider\w*|talked about|plan(?:s|ned|ning)? (?:is|to|was|were))\b/i;

const CLAIM_FIELDS = [
  "fee",
  "paymentSplit",
  "deadline",
  "scope",
  "signoffWho",
  "signedAgreement",
  "launchApproval",
  "reporting",
];

/** True when the sentence states a value the bundle cannot stand behind. */
export function statesUnresolvedValue(bundle, sentence) {
  let claims;
  try {
    claims = extractClaims(bundle, CLAIM_FIELDS).filter((c) => c.value);
  } catch {
    return false; // claims machinery unavailable: no basis to refuse here
  }
  if (!claims.length) return false;
  const resolved = resolveClaims(claims);
  const norm = (v) =>
    String(v)
      .toLowerCase()
      .replace(/([.,;:!?])(?=\s|$)/g, " ")
      .replace(/[^a-z0-9$,%/-]+/g, " ")
      .trim();
  const hay = ` ${norm(sentence)} `;
  // Digit signatures survive formatting variants: "$42,000", "42000" and
  // "$42k" all reduce to the token 42000. Signatures require a single
  // 4+-digit run so years, ordinals and comma fragments never false-match.
  const digitNorm = (v) =>
    String(v)
      .toLowerCase()
      .replace(/(\d+(?:\.\d+)?)k\b/g, (_, n) => String(Number(n) * 1000))
      .replace(/(?<=\d),(?=\d)/g, "");
  const digitSig = (v) => {
    const m = digitNorm(v).match(/\d{4,}/g);
    return m && m.length === 1 ? m[0] : null;
  };
  const hayDigits = new Set(digitNorm(sentence).match(/\d+/g) ?? []);
  const says = (v) => {
    const needle = norm(v);
    if (!!needle && hay.includes(` ${needle} `)) return true;
    const sig = digitSig(v);
    return !!sig && hayDigits.has(sig);
  };
  // Superseded while a newer active value exists.
  for (const c of resolved.superseded) {
    if ((resolved.active.get(c.field) ?? []).length > 0 && says(c.value))
      return true;
  }
  // One side of an unresolved conflict presented as the fact.
  for (const [field, list] of resolved.active) {
    const distinct = new Set(list.map((c) => norm(c.value)));
    if (distinct.size > 1 && list.some((c) => says(c.value))) return true;
  }
  return false;
}

// ------------------------------------------------------------ discovery
/** Keyword-only ranking of the same units (BM25, lay terms expanded). */
export function rankUnitsLexical(question, bundle) {
  const idx = unitsOf(bundle);
  const lex = bm25(idx, question);
  return idx.units
    .map((u, i) => ({ unit: u, cosine: 0, lexical: lex[i], fused: lex[i] }))
    .sort((a, b) => b.fused - a.fused);
}

// Discovery gate. The promotion gate's margin is measured against the best
// unit of ANOTHER document, which never exists in a single uploaded file:
// on the outside benchmark (one meeting or one contract per bundle) that
// gate showed a line for 86% of absent clauses. Discovery instead needs:
//  - the top unit's cosine above a floor,
//  - a lead over the next-best unit of any document (not just another one),
//  - agreement: the same unit ranks in the keyword top `lexTop`.
// Thresholds are chosen on the development half of the outside benchmark
// (QMSum + CUAD, evaluation/outside-bench.mjs --calibrate) as the most lines
// shown with at least 90% right and at most 10% shown when the answer is
// absent, and reported on the held-out half.
export const DISCOVERY = { minCosine: 0.7, minMargin: 0.03, lexTop: 3 };
export function discoveryGate(
  ranked,
  { minCosine, minMargin, lexTop } = DISCOVERY,
) {
  const top = ranked[0];
  if (!top) return null;
  const rival = ranked
    .filter((r) => r !== top)
    .reduce((m, r) => Math.max(m, r.cosine), -1);
  const margin = top.cosine - rival;
  if (top.cosine < minCosine || margin < minMargin) return null;
  if (lexTop) {
    const lexRank =
      top.lexical > 0
        ? 1 + ranked.filter((r) => r.lexical > top.lexical).length
        : Infinity;
    if (lexRank > lexTop) return null;
  }
  return { ...top, margin };
}

const PRELIM_DOC = /\b(prelim\w*|provisional|draft)\b/i;
const CORRECTING_DOC =
  /\b(amend\w*|correct\w*|revis\w*|supersed\w*|final report)\b/i;
/**
 * A document the record itself has replaced: it is marked preliminary or
 * draft in its header while another document in the bundle amends, corrects
 * or revises. Its sentences are never offered, even as a pointer.
 */
export function replacedSource(bundle, src) {
  const head = (s) => String(s.text).slice(0, 400) + " " + (s.title ?? "");
  if (!PRELIM_DOC.test(head(src))) return false;
  return (bundle?.sources ?? []).some(
    (o) => o !== src && CORRECTING_DOC.test(head(o)),
  );
}

/**
 * Discovery, not an answer. After the engine abstains, the single sentence a
 * reworded question most plausibly points at, so a person can open it and
 * judge for themselves. It is labelled "closest line, not an answer" by every
 * caller and never spoken as the reply. Same calibrated gate as promotion,
 * plus the same refusals: no weak-status line for a strong-action question,
 * no superseded or conflicting value, and no line from a document the record
 * has replaced (a preliminary report beside its amendment).
 */
// Off by default. On the outside benchmark (2026-11-02) no discovery rule
// reached 90% right with <= 10% shown when the answer is absent; the
// single-file gate measured 65% right on meetings and 82% on contracts when
// shown. A pointer that is wrong a third of the time is not shown to
// visitors; VM_CLOSEST_LINE=on enables it for gate work and pilots.
export const closestLineEnabled = () => process.env.VM_CLOSEST_LINE === "on";

export async function closestLine(
  question,
  bundle,
  { thresholds = DISCOVERY, force = false } = {},
) {
  if (!force && !closestLineEnabled()) return null;
  const idx = unitsOf(bundle);
  if (!idx.vectors) {
    const ready = await Promise.race([
      warmUnits(bundle),
      new Promise((r) => setTimeout(() => r(false), 2500)),
    ]);
    if (!ready || !idx.vectors) return null;
  }
  const bridge = bridgeToEnglish(question);
  const searched = bridge ? `${question} ${bridge}` : question;
  const [qv] = (await embedTextsReady([QUERY_PREFIX + searched])) ?? [];
  if (!qv) return null;
  const ranked = rankUnits(searched, bundle, qv).filter(
    (r) => !replacedSource(bundle, r.unit.src),
  );
  const hit = discoveryGate(ranked, thresholds);
  if (!hit) return null;
  const { src, sent } = hit.unit;
  if (Q_STRONG_ACTION.test(question) && SENT_WEAK_STATUS.test(sent.text))
    return null;
  if (statesUnresolvedValue(bundle, sent.text)) return null;
  return {
    line: sent.text,
    document: docLabelOf(src),
    citation: cite(src, sent),
    cosine: +hit.cosine.toFixed(3),
    margin: +hit.margin.toFixed(3),
  };
}
