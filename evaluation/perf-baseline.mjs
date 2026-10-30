// Representative perf qualification, version-bound to the dist it runs against.
// 11 metric probes x 30 iterations on the fictional corpus; reports p50/p95/max
// for answer() latency. Run: node evaluation/perf-baseline.mjs
import { readFileSync, readdirSync } from "node:fs";
import { execSync } from "node:child_process";
import { importBundle, answer } from "../dist/engine.mjs";
const docs = readdirSync("corpus-md")
  .filter((f) => f.endsWith(".md"))
  .map((f) => ({ title: f, text: readFileSync("corpus-md/" + f, "utf8") }));
const probes = [
  "Which regions are in scope for the first phase?",
  "Is weekly progress reporting confirmed?",
  "How late is the client's data access as of the October 2 update?",
  "Who asked to narrow the pilot to two regions?",
  "What fee did we finally agree to?",
  "Can I confirm the 50/50 payment split to the client?",
  "Is the pilot deadline November 15 or November 22?",
  "Is production launch authorized?",
  "What is Northstar's annual revenue?",
  "Who won the cricket world cup?",
  "What is the client's marketing budget for Q4?",
];
const b = importBundle(docs);
const sha = execSync("sha256sum dist/engine.mjs").toString().slice(0, 8);
const lat = [];
for (let i = 0; i < 30; i++)
  for (const q of probes) {
    const t0 = performance.now();
    answer(q, b);
    lat.push(performance.now() - t0);
  }
lat.sort((a, b2) => a - b2);
const q = (p) => lat[Math.floor(p * (lat.length - 1))].toFixed(1);
console.log(
  `dist=${sha} n=${lat.length} p50=${q(0.5)}ms p95=${q(0.95)}ms max=${lat[lat.length - 1].toFixed(1)}ms`,
);
