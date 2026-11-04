// What an indexed document became, in numbers, for the reading view's
// "how it becomes numbers" panels. Every figure is computed from the live
// bundle with the index's own rules: the tokenizer is the index's
// (rag-tokens.mjs), and term weights use the BM25 formula and parameters of
// vendor/web/src/lib/rag/bm25.ts (k1 = 1.5, b = 0.75, the same title + text
// each passage is indexed as). Nothing here is decorative.
//
// The digest goes only to the visitor's own workspace status (their own
// document), never to logs or other sessions.
import { tokenize, stemToken, QUERY_STOPWORDS } from "./rag-tokens.mjs";
import { recordGraph } from "./record-graph.mjs";
import { reportMeta } from "../clinical/observations.mjs";

// contentTokens (the index's), keeping one printed form per stem so the view
// can show "discharged" where the index holds "discharge".
const surface = new Map();
function contentTokens(text) {
  const out = [];
  for (const w of tokenize(text)) {
    if (w.length <= 1 || QUERY_STOPWORDS.has(w)) continue;
    const st = stemToken(w);
    if (!surface.has(st)) surface.set(st, w);
    out.push(st);
  }
  return out;
}
const shown = (t) => surface.get(t) ?? t;

const K1 = 1.5;
const B = 0.75;
const r3 = (x) => Math.round(x * 1000) / 1000;

function bm25Stats(rows) {
  const docs = rows.map((r) => {
    const toks = contentTokens(`${r.title}\n${r.chunk.text}`);
    const tf = new Map();
    for (const t of toks) tf.set(t, (tf.get(t) ?? 0) + 1);
    return { row: r, len: toks.length, tf };
  });
  const df = new Map();
  for (const d of docs)
    for (const t of d.tf.keys()) df.set(t, (df.get(t) ?? 0) + 1);
  const n = docs.length;
  const avg = n ? docs.reduce((a, d) => a + d.len, 0) / n : 0;
  const idf = (t) => Math.log(1 + (n - df.get(t) + 0.5) / (df.get(t) + 0.5));
  // A term's BM25 contribution in a passage when the query is that term.
  const weight = (d, t) => {
    const f = d.tf.get(t);
    return idf(t) * ((f * (K1 + 1)) / (f + K1 * (1 - B + (B * d.len) / avg)));
  };
  return { docs, df, n, avg, idf, weight };
}

export function digestFor(bundle, sourceIndex, entry, dense = null) {
  const src = bundle.sources[sourceIndex];
  if (!src || !entry?.doc) return null;
  const doc = entry.doc;
  const count = (t) => doc.elements.filter((e) => e.type === t).length;
  const layout = {
    pages: doc.pages?.length ?? null,
    headings: count("heading"),
    paragraphs: count("paragraph"),
    tables: count("table"),
    rows: count("table-row"),
    furniture: count("furniture"),
    ocr: doc.elements.filter((e) => e.method === "ocr").length,
    characters: doc.text.length,
  };
  const recs = bundle.records?.[sourceIndex]?.records ?? [];
  const clinical = (bundle.clinical ?? []).filter((r) => r.sourceId === src.id);
  const labRows = (seg) =>
    clinical
      .filter(
        (r) => (r.segment ?? 1) === seg || (!r.segment && recs.length <= 1),
      )
      .reduce((n, r) => n + r.observations.length, 0);
  const patientOf = (rec) => {
    try {
      return reportMeta(src.text.slice(rec.start, rec.end)).patient?.id ?? null;
    } catch {
      return null;
    }
  };
  const records = recs.map((r) => ({
    n: r.index,
    pages: r.pages,
    title: r.title.slice(0, 60),
    status: r.status,
    authority: r.authority,
    patient: patientOf(r),
    facts: r.facts.length,
    labRows: labRows(r.index),
    // The facts that say something: ones with a concept (a discharge, a
    // balance, a charge) before header fields.
    sample: r.facts
      .filter((f) => !/patient|name|\bid\b|birth/i.test(f.label))
      .sort((a, b) => (b.concept ? 1 : 0) - (a.concept ? 1 : 0))
      .slice(0, 2)
      .map((f) => ({
        label: f.label.slice(0, 40),
        value: f.value.slice(0, 48),
      })),
  }));

  // The keyword index, over the whole bundle (that is what a query searches).
  const st = bm25Stats(bundle.rows);
  const mine = st.docs.filter((d) => d.row.slug === src.id);
  // How a question becomes numbers: a real lookup in this index, for one
  // of the document's own facts (its most authoritative record first).
  const RANKA = { authoritative: 2, unknown: 1, provisional: 0 };
  const probe = recs
    .slice()
    .sort(
      (a, b) => RANKA[b.authority] - RANKA[a.authority] || b.index - a.index,
    )
    .flatMap((r) => r.facts)
    .find((f) => f.concept && contentTokens(f.label).length);
  // No table fact to look up: a lab test this file reports, else its title.
  const probeLabel =
    probe?.label ??
    clinical[0]?.observations?.[0]?.test ??
    recs[0]?.title ??
    null;
  let lookup = null;
  if (probeLabel) {
    const q = [...new Set(contentTokens(probeLabel))].filter((t) =>
      st.df.has(t),
    );
    const scored = st.docs
      .map((d) => ({
        d,
        parts: q.map((t) => (d.tf.has(t) ? r3(st.weight(d, t)) : 0)),
      }))
      .map((x) => ({ ...x, score: r3(x.parts.reduce((a, b) => a + b, 0)) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 4);
    if (q.length)
      lookup = {
        query: probeLabel.slice(0, 60),
        terms: q.map((t) => ({
          t: shown(t),
          df: st.df.get(t),
          idf: r3(st.idf(t)),
        })),
        hits: scored.map((x) => ({
          heading: String(x.d.row.chunk.heading ?? "").slice(0, 50),
          ordinal: x.d.row.chunk.ordinal,
          mine: x.d.row.slug === src.id,
          parts: x.parts,
          score: x.score,
        })),
      };
  }
  // One passage's fingerprint: the passage carrying the most weight.
  // The passage the lookup above ranked first, else the heaviest passage.
  let finger = null;
  const top = lookup?.hits?.[0];
  const pool = top
    ? mine.filter((d) => d.row.chunk.ordinal === top.ordinal)
    : mine;
  for (const d of pool.length ? pool : mine) {
    const ws = [...d.tf.keys()].map((t) => [t, st.weight(d, t)]);
    const total = ws.reduce((a, [, w]) => a + w, 0);
    if (!finger || total > finger.total) finger = { d, ws, total };
  }
  const passage = finger
    ? {
        ordinal: finger.d.row.chunk.ordinal,
        heading: String(finger.d.row.chunk.heading ?? "").slice(0, 60),
        tokens: finger.d.len,
        vector: finger.ws
          .sort((a, b) => b[1] - a[1])
          .slice(0, 14)
          .map(([t, w]) => ({ t: shown(t), w: r3(w) })),
        embedding: (() => {
          try {
            const v = finger.d.row.chunk.embedding
              ? JSON.parse(finger.d.row.chunk.embedding)
              : null;
            return v ? { dims: v.length, head: v.slice(0, 48).map(r3) } : null;
          } catch {
            return null;
          }
        })(),
      }
    : null;
  const embedded = mine.filter((d) => d.row.chunk.embedding).length;

  // The grounded graph, small: records, patients and the edges that carry
  // meaning (corrections, supersessions, identity).
  const g = recordGraph(bundle);
  const keep = new Set();
  // This file only: its records, the values they hold, and the patients
  // they name (a workspace may hold other files).
  const mineNode = (id) => id.includes(src.id);
  const myPatients = new Set(
    g.edges
      .filter((e) => e.kind === "has record" && mineNode(e.to))
      .map((e) => e.from),
  );
  const edges = g.edges.filter(
    (e) =>
      (e.kind === "supersedes" && mineNode(e.from)) ||
      (e.kind === "has record" && mineNode(e.to)) ||
      (e.kind === "same name, different ID" &&
        myPatients.has(e.from) &&
        myPatients.has(e.to)),
  );
  for (const e of edges) keep.add(e.from).add(e.to);
  // The record each kept value was read from, so values are attached.
  for (const e of g.edges)
    if (e.kind === "records" && keep.has(e.to)) {
      edges.push(e);
      keep.add(e.from);
    }
  const byId = new Map(g.nodes.map((n) => [n.id, n]));
  const recOf = new Map(
    g.edges
      .filter((e) => e.kind === "records")
      .map((e) => [e.to, byId.get(e.from)]),
  );
  // In words: which value replaced which, and from what kind of record.
  const replaced = g.edges
    .filter((e) => e.kind === "supersedes" && mineNode(e.from))
    .slice(0, 4)
    .map((e) => ({
      field: String(byId.get(e.from)?.field ?? "").slice(0, 32),
      now: String(byId.get(e.from)?.label ?? "").slice(0, 26),
      was: String(byId.get(e.to)?.label ?? "").slice(0, 26),
      wasStatus: recOf.get(e.to)?.status ?? null,
    }));
  const mini = {
    nodes: [...keep]
      .map((id) => byId.get(id))
      .filter(Boolean)
      .slice(0, 40)
      .map((n) => ({
        id: n.id,
        kind: n.kind,
        label: String(n.label).slice(0, 40),
        status: n.status ?? null,
        authority: n.authority ?? null,
      })),
    edges: edges
      .slice(0, 80)
      .map((e) => ({ from: e.from, to: e.to, kind: e.kind })),
    replaced,
  };
  // A correction is an amended value that differs from the earlier value
  // for the same patient, collection and test; unchanged repeats are not.
  let corrections = 0;
  for (const r of clinical.filter((x) => x.meta?.status === "amended"))
    for (const o of r.observations) {
      const prev = clinical.find(
        (x) =>
          x !== r &&
          x.meta?.status !== "amended" &&
          x.meta?.patient?.id === r.meta?.patient?.id &&
          x.meta?.collected === r.meta?.collected &&
          x.observations.some((p) => p.key === o.key && p.value !== o.value),
      );
      if (prev) corrections++;
    }

  return {
    layout,
    records,
    index: {
      passages: mine.length,
      bundlePassages: st.n,
      vocabulary: new Set(mine.flatMap((d) => [...d.tf.keys()])).size,
      avgTokens: Math.round(st.avg * 10) / 10,
      k1: K1,
      b: B,
    },
    lookup,
    passage,
    dense: {
      state: dense?.disabled
        ? "off"
        : embedded
          ? "on"
          : dense?.ready || dense?.loading
            ? "pending"
            : "off",
      model: dense?.model ?? null,
      embedded,
    },
    graph: {
      records: records.length,
      patients: new Set(records.map((r) => r.patient).filter(Boolean)).size,
      facts: records.reduce((a, r) => a + r.facts, 0),
      labRows: clinical.reduce((a, r) => a + r.observations.length, 0),
      supersedes: g.edges.filter((e) => e.kind === "supersedes").length,
      sameName: g.edges.filter((e) => e.kind === "same name, different ID")
        .length,
      corrections,
      mini,
    },
  };
}

export function attachDigests(bundle, entries, dense = null) {
  bundle.sources.forEach((_, i) => {
    const e = entries[i];
    if (!e) return;
    try {
      e.digest = digestFor(bundle, i, e, dense);
    } catch {
      e.digest = null;
    }
  });
}
