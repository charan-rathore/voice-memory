// Paraphrase retrieval benchmark: does meaning-based search find the right
// passage when the question shares no key words with it, and does the
// evidence gate still refuse questions the record cannot answer?
//
// Runs the shipping retriever (retrieveFromRows) three ways on the Northstar
// corpus: keyword only, hybrid (BM25 + bge-small dense, RRF) as shipped, and
// the dense scores alone. Per question it records the top dense cosine
// scores, so a semantic gate can be tuned on the development split and
// reported on the held-out split (evaluation/paraphrase-questions.json).
//
//   VM_DENSE_CACHE=.cache/models node evaluation/paraphrase-bench.mjs
// Needs the model (~33 MB) from huggingface.co on first run.
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { execSync } from "node:child_process";
import { importBundle, retrieveFromRows } from "../dist/engine.mjs";
import {
  DENSE_MODEL_ID,
  denseAvailableFor,
  embedQueryReady,
  warmDense,
} from "../dense.mjs";

const spec = JSON.parse(
  readFileSync(new URL("./paraphrase-questions.json", import.meta.url), "utf8"),
);
const md = new URL("../corpus-md/", import.meta.url);
const docs = readdirSync(md)
  .filter((f) => f.endsWith(".md"))
  .sort()
  .map((f) => ({ title: f, text: readFileSync(new URL(f, md), "utf8") }));
const bundle = importBundle(docs);
await warmDense(bundle.rows);
const storage = {
  backend: "ephemeral",
  durable: false,
  denseAvailable: denseAvailableFor(bundle),
  warning: null,
};

async function run(q, mode) {
  const queryVector = mode === "keyword" ? null : await embedQueryReady(q);
  const r = retrieveFromRows({
    query: q,
    queryVector,
    mode: queryVector ? mode : "keyword",
    topK: 5,
    embeddingModel: DENSE_MODEL_ID,
    rows: bundle.rows,
    storage,
    corpusScope: { kind: "corpus", corpusId: bundle.scope },
  });
  return r;
}
const contains = (text, need) => need.every((n) => text.includes(n));

const rows = [];
const t0 = performance.now();
const all = [
  ...spec.questions.map((x, i) => ({
    ...x,
    kind: "answer",
    split: i % 2 ? "heldout" : "development",
  })),
  ...spec.abstain.map((x, i) => ({
    ...x,
    kind: "abstain",
    split: i % 2 ? "heldout" : "development",
  })),
];
for (const item of all) {
  const kw = await run(item.q, "keyword");
  const hy = await run(item.q, "hybrid");
  // dense scores per candidate, best first
  const dense = hy.candidates
    .filter((c) => c.scores.dense != null)
    .sort((a, b) => b.scores.dense - a.scores.dense)
    .slice(0, 5)
    .map((c) => ({
      title: c.title,
      cos: Math.round(c.scores.dense * 10000) / 10000,
      hit: item.need ? contains(c.text, item.need) : false,
    }));
  const served = (r) =>
    r.chunks.map((c) => ({
      title: c.title,
      hit: item.need ? contains(c.text, item.need) : false,
    }));
  rows.push({
    q: item.q,
    kind: item.kind,
    split: item.split,
    keyword: served(kw),
    hybrid: served(hy),
    evidence: hy.evidence,
    dense,
  });
}
const ms = Math.round(((performance.now() - t0) / all.length) * 10) / 10;

const recall = (set, key, k) =>
  set.length
    ? Math.round(
        (set.filter((r) => r[key].slice(0, k).some((c) => c.hit)).length /
          set.length) *
          1000,
      ) / 1000
    : null;
const abstained = (set, key) =>
  set.length
    ? Math.round(
        (set.filter((r) => r[key].length === 0).length / set.length) * 1000,
      ) / 1000
    : null;
const summary = {};
for (const split of ["development", "heldout"]) {
  const ans = rows.filter((r) => r.kind === "answer" && r.split === split);
  const abs = rows.filter((r) => r.kind === "abstain" && r.split === split);
  summary[split] = {
    n: ans.length,
    keyword: {
      recall1: recall(ans, "keyword", 1),
      recall3: recall(ans, "keyword", 3),
      abstain: abstained(abs, "keyword"),
    },
    hybrid: {
      recall1: recall(ans, "hybrid", 1),
      recall3: recall(ans, "hybrid", 3),
      abstain: abstained(abs, "hybrid"),
    },
    dense: {
      recall1: recall(ans, "dense", 1),
      recall3: recall(ans, "dense", 3),
    },
    nAbstain: abs.length,
  };
}
let sha = "unknown";
try {
  sha = execSync("git rev-parse --short HEAD").toString().trim();
} catch {}
const out = {
  sha,
  date: new Date().toISOString(),
  model: DENSE_MODEL_ID,
  denseAvailable: storage.denseAvailable,
  msPerQuery: ms,
  summary,
  rows,
};
mkdirSync(new URL("./results/", import.meta.url), { recursive: true });
const file = new URL(
  `./results/paraphrase-${out.date.slice(0, 10)}-${sha}.json`,
  import.meta.url,
);
writeFileSync(file, JSON.stringify(out, null, 2) + "\n");
console.log(
  JSON.stringify(
    { sha, denseAvailable: storage.denseAvailable, msPerQuery: ms, summary },
    null,
    2,
  ),
);
console.log("wrote", file.pathname);
