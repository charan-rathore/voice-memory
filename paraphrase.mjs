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
//  - Query instruction for BGE models ("Represent this sentence for
//    searching relevant passages: "), from the bge-small-en-v1.5 model card;
//    passages are embedded without it.
//  - A calibrated gate: serve only when the top unit's cosine clears an
//    absolute floor AND beats the best unit of any other document by a
//    margin. Both thresholds are tuned on the development split of
//    evaluation/paraphrase-questions.json and reported on held-out.
import { sentencesOf, cite, docLabelOf } from "./spoken-routes.mjs";
import { embedTextsReady } from "./dense.mjs";

export const QUERY_INSTRUCTION =
  "Represent this sentence for searching relevant passages: ";
// Tuned on the development split only (evaluation/paraphrase-bench.mjs).
export const GATE = { minCosine: 0.72, minMargin: 0.02 };
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
      if (sent.text.split(/\s+/).length < 4) continue;
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
  const qt = tokens(q);
  return idx.units.map((u) => {
    let s = 0;
    for (const t of qt) {
      const f = u.terms.filter((x) => x === t).length;
      if (!f) continue;
      const n = idx.df.get(t) ?? 0;
      const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
      s +=
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
 * for the gate). `queryVector` must be embedded with QUERY_INSTRUCTION.
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
export function gate(ranked, { minCosine, minMargin } = GATE) {
  const top = ranked[0];
  if (!top || top.cosine < minCosine) return null;
  const rival = ranked.find((r) => r.unit.src !== top.unit.src);
  const margin = top.cosine - (rival?.cosine ?? 0);
  return margin >= minMargin ? { ...top, margin } : null;
}

/**
 * The verbatim sentence a reworded question asks about, with a validated
 * citation, or null. Needs the dense model resident; never waits for it.
 */
export async function paraphraseLookup(
  question,
  bundle,
  { thresholds = GATE } = {},
) {
  const idx = unitsOf(bundle);
  if (!idx.vectors) {
    warmUnits(bundle);
    return null;
  }
  const [qv] = (await embedTextsReady([QUERY_INSTRUCTION + question])) ?? [];
  if (!qv) return null;
  const hit = gate(rankUnits(question, bundle, qv), thresholds);
  if (!hit) return null;
  const { src, sent } = hit.unit;
  const label = docLabelOf(src);
  return {
    spoken: `${label[0].toUpperCase()}${label.slice(1)} says: ${sent.text}`,
    citation: cite(src, sent),
    cosine: hit.cosine,
    margin: hit.margin,
  };
}
