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
  embedTextsReady,
} from "../dense.mjs";
import {
  unitsOf,
  warmUnits,
  rankUnits,
  gate,
  GATE,
  QUERY_INSTRUCTION,
} from "../paraphrase.mjs";

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
await warmUnits(bundle);
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
  // sentence-level contextual units (paraphrase.mjs), with and without
  // the BGE query instruction
  const unit = {};
  for (const [name, prefix] of [
    ["instructed", QUERY_INSTRUCTION],
    ["plain", ""],
  ]) {
    const [qv] = (await embedTextsReady([prefix + item.q])) ?? [];
    const ranked = qv ? rankUnits(item.q, bundle, qv) : [];
    const top = ranked[0];
    const rival = top ? ranked.find((r) => r.unit.src !== top.unit.src) : null;
    unit[name] = top
      ? {
          title: top.unit.src.title,
          hit: item.need ? contains(top.unit.sent.text, item.need) : false,
          hit3: item.need
            ? ranked
                .slice(0, 3)
                .some((r) => contains(r.unit.sent.text, item.need))
            : false,
          cosine: Math.round(top.cosine * 10000) / 10000,
          margin:
            Math.round((top.cosine - (rival?.cosine ?? 0)) * 10000) / 10000,
        }
      : null;
  }
  rows.push({
    q: item.q,
    kind: item.kind,
    split: item.split,
    keyword: served(kw),
    hybrid: served(hy),
    evidence: hy.evidence,
    dense,
    unit,
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
// ------------------------------------------------------------ the gate
// Rescue = serve the top unit when the shipped hybrid served nothing and the
// unit clears (minCosine, minMargin). Chosen on DEVELOPMENT only: the most
// correct rescues with zero wrong passages and zero accepted unanswerables;
// ties go to the stricter gate. Then reported on held-out.
const rescue = (set, mode, t) => {
  let right = 0,
    wrong = 0,
    falseAccept = 0;
  for (const r of set) {
    const u = r.unit[mode];
    if (r.hybrid.length || !u) continue;
    const pass = u.cosine >= t.minCosine && u.margin >= t.minMargin;
    if (!pass) continue;
    if (r.kind === "abstain") falseAccept++;
    else if (u.hit) right++;
    else wrong++;
  }
  return { right, wrong, falseAccept };
};
const combined = (set, mode, t) => {
  const ans = set.filter((r) => r.kind === "answer");
  const ok = ans.filter((r) =>
    r.hybrid.length
      ? r.hybrid[0].hit
      : r.unit[mode] &&
        r.unit[mode].cosine >= t.minCosine &&
        r.unit[mode].margin >= t.minMargin &&
        r.unit[mode].hit,
  ).length;
  return Math.round((ok / (ans.length || 1)) * 1000) / 1000;
};
const dev = rows.filter((r) => r.split === "development");
const held = rows.filter((r) => r.split === "heldout");
const tuning = {};
for (const mode of ["instructed", "plain"]) {
  let best = null;
  for (let c = 0.5; c <= 0.95; c += 0.005)
    for (const m of [0, 0.005, 0.01, 0.015, 0.02, 0.03, 0.04, 0.06, 0.08]) {
      const t = { minCosine: Math.round(c * 1000) / 1000, minMargin: m };
      const r = rescue(dev, mode, t);
      if (r.wrong || r.falseAccept) continue;
      if (
        !best ||
        r.right > best.dev.right ||
        (r.right === best.dev.right && t.minCosine > best.t.minCosine)
      )
        best = { t, dev: r };
    }
  tuning[mode] = best && {
    chosenOnDevelopment: best.t,
    development: {
      ...best.dev,
      recall1WithRescue: combined(dev, mode, best.t),
    },
    heldout: {
      ...rescue(held, mode, best.t),
      recall1WithRescue: combined(held, mode, best.t),
    },
  };
}
const shipped = {
  gate: GATE,
  development: {
    ...rescue(dev, "plain", GATE),
    recall1WithRescue: combined(dev, "plain", GATE),
  },
  heldout: {
    ...rescue(held, "plain", GATE),
    recall1WithRescue: combined(held, "plain", GATE),
  },
};
const unitRecall = (set, mode, key) => {
  const ans = set.filter((r) => r.kind === "answer");
  return (
    Math.round(
      (ans.filter((r) => r.unit[mode]?.[key]).length / (ans.length || 1)) *
        1000,
    ) / 1000
  );
};
for (const [split, set] of [
  ["development", dev],
  ["heldout", held],
])
  summary[split].units = {
    instructed: {
      recall1: unitRecall(set, "instructed", "hit"),
      recall3: unitRecall(set, "instructed", "hit3"),
    },
    plain: {
      recall1: unitRecall(set, "plain", "hit"),
      recall3: unitRecall(set, "plain", "hit3"),
    },
  };
summary.tuning = tuning;
summary.shipped = shipped;
summary.units = unitsOf(bundle).units.length;

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
