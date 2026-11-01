// Retrieval benchmark (Phase 3 baseline). Measures the keyword (BM25) stage
// the answer path starts from, on Northstar plus the ingestion fixtures.
// Metrics: Recall@1/@3/@5 (all needed spans inside the top-k chunks), MRR
// (rank of the first chunk holding the first needed span), and citation
// precision@3 (share of top-3 chunks that hold a needed span).
//
//   node evaluation/retrieval-bench.mjs           # table + results file
//
// Dense / hybrid candidates are NOT run here: this environment cannot
// download embedding models. The harness takes any `retrieve(q, k)` so a
// candidate can be added and compared on identical questions.
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { execSync } from "node:child_process";
import { importBundle, retrieveChunks } from "../dist/engine.mjs";
import { ingestFile } from "../ingest/index.mjs";

const spec = JSON.parse(
  readFileSync(new URL("./retrieval-questions.json", import.meta.url), "utf8"),
);

export async function buildCorpus() {
  const md = new URL("../examples/corpus-md/", import.meta.url);
  const docs = readdirSync(md)
    .filter((f) => f.endsWith(".md"))
    .sort()
    .map((f) => ({ title: f, text: readFileSync(new URL(f, md), "utf8") }));
  for (const f of spec.corpus.ingested) {
    const r = await ingestFile(
      readFileSync(new URL("../ingest/fixtures/files/" + f, import.meta.url)),
      f,
    );
    if (!r.ok) throw Error(`${f}: ${r.message}`);
    docs.push({ title: f, text: r.doc.text });
  }
  return docs;
}

export function score(questions, retrieve) {
  const rows = questions.map((item) => {
    const top = retrieve(item.q, 5);
    const has = (chunk, s) => chunk.text.includes(s);
    const recallAt = (k) =>
      item.need.every((s) => top.slice(0, k).some((c) => has(c, s)));
    const first = top.findIndex((c) => has(c, item.need[0]));
    const top3 = top.slice(0, 3);
    return {
      q: item.q,
      paraphrase: !!item.p,
      r1: recallAt(1),
      r3: recallAt(3),
      r5: recallAt(5),
      rr: first < 0 ? 0 : 1 / (first + 1),
      p3: top3.length
        ? top3.filter((c) => item.need.some((s) => has(c, s))).length /
          top3.length
        : 0,
      top: top.slice(0, 3).map((c) => c.title),
    };
  });
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
      precision3: avg((r) => r.p3),
    };
  };
  return {
    rows,
    all: agg(rows),
    literal: agg(rows.filter((r) => !r.paraphrase)),
    paraphrase: agg(rows.filter((r) => r.paraphrase)),
  };
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const docs = await buildCorpus();
  // Sessions hold at most 10 documents, so the corpus runs as two sessions
  // (Northstar, ingested files); each question goes to the session that
  // contains its answer, as it would for a real user.
  const sessions = [
    docs.filter((d) => d.title.endsWith(".md") && /^\d\d_/.test(d.title)),
    docs.filter((d) => !/^\d\d_/.test(d.title)),
  ].map((set) => importBundle(set));
  const bundleFor = (item) =>
    sessions.find((b) =>
      b.sources.some((s) => item.need.every((n) => s.text.includes(n))),
    ) ?? sessions[0];
  const route = new Map(
    spec.questions.map((item) => [item.q, bundleFor(item)]),
  );
  const bundle = { rows: sessions.flatMap((b) => b.rows) };
  const t0 = performance.now();
  const res = score(spec.questions, (q, k) =>
    retrieveChunks(q, route.get(q), k),
  );
  const ms =
    Math.round(((performance.now() - t0) / spec.questions.length) * 10) / 10;
  let sha = "unknown";
  let dirty = false;
  try {
    sha = execSync("git rev-parse --short HEAD").toString().trim();
    dirty = execSync("git status --porcelain").toString().trim().length > 0;
  } catch {}
  for (const r of res.rows)
    if (!r.r3)
      console.log(
        `miss@3 ${r.paraphrase ? "(paraphrase) " : ""}${r.q}\n        top: ${r.top.join(" | ")}`,
      );
  const line = (name, a) =>
    `${name.padEnd(11)} n=${String(a.n).padStart(2)}  R@1 ${a.recall1.toFixed(2)}  R@3 ${a.recall3.toFixed(2)}  R@5 ${a.recall5.toFixed(2)}  MRR ${a.mrr.toFixed(2)}  P@3 ${a.precision3.toFixed(2)}`;
  console.log(
    "\nBM25 keyword baseline, " +
      docs.length +
      " documents, " +
      bundle.rows.length +
      " chunks, " +
      ms +
      " ms/query",
  );
  console.log(line("all", res.all));
  console.log(line("literal", res.literal));
  console.log(line("paraphrase", res.paraphrase));
  const out = {
    sha,
    dirtyWorkingTree: dirty,
    date: new Date().toISOString(),
    questionsVersion: spec.version,
    retriever: "bm25-keyword (IntelliRAG retrieve-core)",
    documents: docs.length,
    chunks: bundle.rows.length,
    msPerQuery: ms,
    ...res,
  };
  mkdirSync(new URL("./results/", import.meta.url), { recursive: true });
  writeFileSync(
    new URL(
      `./results/retrieval-${out.date.slice(0, 10)}-${sha}.json`,
      import.meta.url,
    ),
    JSON.stringify(out, null, 2),
  );
}
