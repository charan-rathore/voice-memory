// Answer-quality benchmark (mandate Part 10 D). Distinct from the retrieval
// benchmark: retrieval recall measures whether the right chunk ranks; THIS
// bench measures whether the final user-facing answer carries the needed
// fact. Every question is accounted for in exactly one category:
//   OK                 retrieval hit @3 AND needed fact in the final answer
//                      (includes competing-status answers that show both
//                      records - useful, and never confused with hallucination)
//   OVER-REFUSAL       retrieval hit @3 but the needed fact is missing from
//                      the final answer (handoff/claims-layer defect)
//   RECOVERED          needed chunk absent at top 3 (retrieval defect) but
//                      the final answer still carries the needed fact through
//                      a disclosed answer-layer recovery (expansion bridge).
//                      Counted separately from OK so raw retrieval recall and
//                      answer-layer rescue are never conflated.
//   RETRIEVAL-MISS     needed chunk absent at top 3 and no positive answer
//                      carries the needed fact.
//   FALSE-POSITIVE     retrieval miss that still answers positive WITHOUT the
//                      needed fact - the worst outcome.
//
//   VM_DENSE_CACHE=.cache/models node evaluation/answer-quality-bench.mjs
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { execSync } from "node:child_process";
import { importBundle, retrieveFromRows, answer } from "../dist/engine.mjs";
import {
  DENSE_MODEL_ID,
  denseAvailableFor,
  embedQueryReady,
  warmDense,
} from "../dense.mjs";
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

const rows = [];
for (const item of spec.questions) {
  const bundle = bundleFor(item);
  const queryVector = await embedQueryReady(item.q);
  const r = retrieveFromRows({
    query: item.q,
    queryVector,
    mode: queryVector ? "hybrid" : "keyword",
    topK: 5,
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
  const top = r.chunks.map((c) => ({ title: c.title, text: c.text }));
  const r3 = item.need.every((s) => top.slice(0, 3).some((c) => c.text.includes(s)));
  const a = answer(item.q, bundle, {
    queryVector,
    model: DENSE_MODEL_ID,
    available: denseAvailableFor(bundle),
  });
  const atext = `${a.verdict ?? ""} ${a.answer ?? ""} ${(a.evidence ?? [])
    .map((e) => e.quote ?? "")
    .join(" ")}`;
  const needInAnswer = item.need.every((s) => atext.includes(s));
  const falsePositive = !r3 && a.evidenceStatus === "positive" && !needInAnswer;
  const cause = !r3
    ? falsePositive
      ? "FALSE-POSITIVE"
      : a.evidenceStatus === "positive" && needInAnswer
        ? "RECOVERED"
        : "RETRIEVAL-MISS"
    : needInAnswer
      ? "OK"
      : "OVER-REFUSAL";
  rows.push({
    q: item.q,
    paraphrase: !!item.p,
    r3,
    evidenceStatus: a.evidenceStatus,
    needInAnswer,
    cause,
    top: top[0]?.title ?? null,
  });
}

const tally = (list) => ({
  n: list.length,
  ok: list.filter((r) => r.cause === "OK").length,
  overRefusal: list.filter((r) => r.cause === "OVER-REFUSAL").length,
  recovered: list.filter((r) => r.cause === "RECOVERED").length,
  retrievalMiss: list.filter((r) => r.cause === "RETRIEVAL-MISS").length,
  falsePositive: list.filter((r) => r.cause === "FALSE-POSITIVE").length,
});
const summary = {
  all: tally(rows),
  literal: tally(rows.filter((r) => !r.paraphrase)),
  paraphrase: tally(rows.filter((r) => r.paraphrase)),
};
const line = (name, t) =>
  `${name.padEnd(11)} n=${String(t.n).padStart(2)}  OK ${t.ok}  recovered ${t.recovered}  over-refusal ${t.overRefusal}  retrieval-miss ${t.retrievalMiss}  false-positive ${t.falsePositive}`;
console.log("\nAnswer-quality bench (shipping hybrid path + answer layer)");
console.log(line("all", summary.all));
console.log(line("literal", summary.literal));
console.log(line("paraphrase", summary.paraphrase));
for (const r of rows.filter((r) => r.cause !== "OK"))
  console.log(`  ${r.cause}: ${r.q}${r.cause === "OK" ? "" : ` (top: ${r.top ?? "none"})`}`);

const sha = execSync("git rev-parse --short HEAD").toString().trim();
mkdirSync(new URL("./results/", import.meta.url), { recursive: true });
const file = `answer-quality-2026-10-31-${sha}.json`;
writeFileSync(
  new URL(`./results/${file}`, import.meta.url),
  JSON.stringify({ sha, date: new Date().toISOString(), summary, rows }, null, 2),
);
console.log("wrote evaluation/results/" + file);
