// Hybrid retrieval benchmark (Phase 3). Same corpus, questions and metrics as
// retrieval-bench.mjs, but retrieval runs the SHIPPING hybrid path: dense
// re-ranking via dense.mjs (bge-small-en-v1.5, local, no paid API) fused with
// BM25 inside retrieveFromRows (mode "hybrid", RRF, fail-closed to keyword).
// Baseline expectations in retrieval-bench.mjs are unchanged; this writes a
// separate results file.
//
//   VM_DENSE_CACHE=.cache/models node evaluation/retrieval-bench-hybrid.mjs
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { execSync } from "node:child_process";
import { importBundle, retrieveFromRows } from "../dist/engine.mjs";
import {
  DENSE_MODEL_ID,
  denseAvailableFor,
  embedQueryReady,
  warmDense,
} from "../src/dense.mjs";
import { buildCorpus } from "./retrieval-bench.mjs";

const spec = JSON.parse(
  readFileSync(new URL("./retrieval-questions.json", import.meta.url), "utf8"),
);

const docs = await buildCorpus();
const sessions = [
  docs.filter((d) => d.title.endsWith(".md") && /^\d\d_/.test(d.title)),
  docs.filter((d) => !/^\d\d_/.test(d.title)),
].map((set) => importBundle(set));
for (const b of sessions) await warmDense(b.rows);
const bundleFor = (item) =>
  sessions.find((b) =>
    b.sources.some((s) => item.need.every((n) => s.text.includes(n))),
  ) ?? sessions[0];

async function retrieve(q, k, bundle) {
  const queryVector = await embedQueryReady(q);
  const r = retrieveFromRows({
    query: q,
    queryVector,
    mode: queryVector ? "hybrid" : "keyword",
    topK: k,
    embeddingModel: DENSE_MODEL_ID,
    rows: bundle.rows,
    storage: {
      backend: "ephemeral",
      durable: false,
      denseAvailable: denseAvailableFor(bundle),
      warning: null,
    },
    corpusScope: { kind: "corpus", corpusId: bundle.scope },
  });
  if (process.env.BENCH_DEBUG)
    console.error(
      `  [debug] mode=${r.actualMode} chunks=${r.chunks.length} skip=${r.stages?.dense?.skippedReason ?? "none"} q=${q.slice(0, 40)}`,
    );
  return r.chunks.map((c) => ({ title: c.title, text: c.text }));
}

const rows = [];
const t0 = performance.now();
const scoreRecall = async (item) => {
  const top = await retrieve(item.q, 5, bundleFor(item));
  const has = (chunk, s) => chunk.text.includes(s);
  const recallAt = (k) =>
    item.need.every((s) => top.slice(0, k).some((c) => has(c, s)));
  const first = top.findIndex((c) => has(c, item.need[0]));
  return {
    q: item.q,
    paraphrase: !!item.p,
    r1: recallAt(1),
    r3: recallAt(3),
    r5: recallAt(5),
    rr: first < 0 ? 0 : 1 / (first + 1),
    top: top.slice(0, 3).map((c) => c.title),
  };
};
for (const item of spec.questions) {
  const top = await retrieve(item.q, 5, bundleFor(item));
  const has = (chunk, s) => chunk.text.includes(s);
  const recallAt = (k) =>
    item.need.every((s) => top.slice(0, k).some((c) => has(c, s)));
  const first = top.findIndex((c) => has(c, item.need[0]));
  rows.push({
    q: item.q,
    paraphrase: !!item.p,
    r1: recallAt(1),
    r3: recallAt(3),
    r5: recallAt(5),
    rr: first < 0 ? 0 : 1 / (first + 1),
    top: top.slice(0, 3).map((c) => c.title),
  });
}
const hardnegRows = [];
for (const item of spec.hardneg ?? []) hardnegRows.push(await scoreRecall(item));

// Abstention: correct behavior is the shipping evidence gate clearing the
// whole pack (classifyEvidence "insufficient" -> zero gated chunks).
const abstainRows = [];
for (const item of spec.abstain ?? []) {
  const top = await retrieve(item.q, 5, sessions[item.s ?? 0]);
  abstainRows.push({
    q: item.q,
    why: item.why,
    abstained: top.length === 0,
    served: top.slice(0, 3).map((c) => c.title),
  });
}
const abstainAccuracy =
  abstainRows.length === 0
    ? null
    : Math.round(
        (abstainRows.filter((r) => r.abstained).length / abstainRows.length) *
          1000,
      ) / 1000;

const nQ =
  spec.questions.length +
  (spec.hardneg?.length ?? 0) +
  (spec.abstain?.length ?? 0);
const ms = Math.round(((performance.now() - t0) / nQ) * 10) / 10;
const agg = (set) => {
  const n = set.length || 1;
  const avg = (f) =>
    Math.round((set.reduce((a, r) => a + f(r), 0) / n) * 1000) / 1000;
  return {
    n: set.length,
    recall1: avg((r) => +r.r1),
    recall3: avg((r) => +r.r3),
    recall5: avg((r) => +r.r5),
    mrr: avg((r) => r.rr),
  };
};
const res = {
  all: agg(rows),
  literal: agg(rows.filter((r) => !r.paraphrase)),
  paraphrase: agg(rows.filter((r) => r.paraphrase)),
  hardneg: agg(hardnegRows),
  abstain: { n: abstainRows.length, accuracy: abstainAccuracy },
};
let sha = "unknown";
try {
  sha = execSync("git rev-parse --short HEAD").toString().trim();
} catch {}
const line = (name, a) =>
  `${name.padEnd(11)} n=${String(a.n).padStart(2)}  R@1 ${a.recall1.toFixed(2)}  R@3 ${a.recall3.toFixed(2)}  R@5 ${a.recall5.toFixed(2)}  MRR ${a.mrr.toFixed(2)}`;
console.log(
  `\nHybrid (BM25 + ${DENSE_MODEL_ID}, RRF), ${docs.length} documents, ${sessions.flatMap((b) => b.rows).length} chunks, ${ms} ms/query`,
);
console.log(line("all", res.all));
console.log(line("literal", res.literal));
console.log(line("paraphrase", res.paraphrase));
console.log(line("hardneg", res.hardneg));
console.log(
  `abstain     n=${String(res.abstain.n).padStart(2)}  gate-correct ${(res.abstain.accuracy ?? 0).toFixed(2)}`,
);
for (const r of abstainRows.filter((r) => !r.abstained))
  console.log(`  FALSE-CONFIDENCE: ${r.q} -> served ${r.served.join(", ")}`);
mkdirSync(new URL("./results/", import.meta.url), { recursive: true });
const file = `retrieval-hybrid-${new Date().toISOString().slice(0, 10)}-${sha}.json`;
writeFileSync(
  new URL("./results/" + file, import.meta.url),
  JSON.stringify(
    { sha, date: new Date().toISOString(), retriever: `hybrid RRF: BM25 + ${DENSE_MODEL_ID} (local, q8)`, documents: docs.length, chunks: sessions.flatMap((b) => b.rows).length, msPerQuery: ms, ...res, rows, hardnegRows, abstainRows },
    null,
    2,
  ),
);
console.log("wrote evaluation/results/" + file);
