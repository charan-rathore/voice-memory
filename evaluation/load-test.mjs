// Load test: the same mixed traffic against the server with the answer cache
// off (VM_CACHE_MAX=0) and on. Northstar corpus, 12 distinct questions asked
// repeatedly by many concurrent clients, as a busy demo would see.
//
//   node evaluation/load-test.mjs [requests=1500] [concurrency=50]
import { readFileSync, readdirSync } from "node:fs";

const N = Number(process.argv[2] ?? 1500);
const C = Number(process.argv[3] ?? 50);
const QUESTIONS = [
  "Was the $42,000 revision finalized?",
  "But wasn't it $48,000 earlier?",
  "Why did the fee change?",
  "Was the 40/60 split approved?",
  "So finance rejected it?",
  "Which regions are in the first phase?",
  "What deadline does the client want to keep?",
  "Is 22 November a client-approved deadline?",
  "Is data access from Northstar late?",
  "Who has to sign off the revised terms?",
  "What payment structure did the steering committee discuss?",
  "Is there a signed commercial agreement?",
];
const md = new URL("../corpus-md/", import.meta.url);
const DOCS = readdirSync(md)
  .filter((f) => f.endsWith(".md"))
  .sort()
  .map((f) => ({ title: f, text: readFileSync(new URL(f, md), "utf8") }));

async function run(cacheMax) {
  process.env.VM_CACHE_MAX = String(cacheMax);
  const { createLocalServer } = await import("../server.mjs?run=" + cacheMax);
  const server = createLocalServer({ port: 0 });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const s = await fetch(base + "/api/session");
  const cookie = s.headers.get("set-cookie").split(";")[0];
  const { csrf } = await s.json();
  const h = {
    cookie,
    origin: base,
    "x-csrf-token": csrf,
    "content-type": "application/json",
  };
  await fetch(base + "/api/import", {
    method: "POST",
    headers: h,
    body: JSON.stringify({ documents: DOCS }),
  });
  const lat = [];
  let next = 0;
  let errors = 0;
  const t0 = performance.now();
  await Promise.all(
    Array.from({ length: C }, async () => {
      while (next < N) {
        const i = next++;
        const t = performance.now();
        const r = await fetch(base + "/api/query", {
          method: "POST",
          headers: h,
          body: JSON.stringify({
            question: QUESTIONS[i % QUESTIONS.length],
            context: null,
          }),
        });
        await r.text();
        if (!r.ok) errors++;
        lat.push(performance.now() - t);
      }
    }),
  );
  const secs = (performance.now() - t0) / 1000;
  const health = await fetch(base + "/healthz").then((r) => r.json());
  await new Promise((r) => server.close(r));
  lat.sort((a, b) => a - b);
  const pct = (p) =>
    Math.round(lat[Math.min(lat.length - 1, Math.floor(p * lat.length))]);
  return {
    cache: cacheMax > 0 ? "on" : "off",
    requests: N,
    concurrency: C,
    rps: Math.round(N / secs),
    p50: pct(0.5),
    p95: pct(0.95),
    p99: pct(0.99),
    errors,
    ...health.cache,
  };
}

const off = await run(0);
const on = await run(1000);
for (const r of [off, on])
  console.log(
    `cache ${r.cache.padEnd(3)}  ${String(r.rps).padStart(5)} req/s  p50 ${r.p50} ms  p95 ${r.p95} ms  p99 ${r.p99} ms  errors ${r.errors}  hits ${r.hits} misses ${r.misses}`,
  );
console.log(
  `speed-up: ${(on.rps / off.rps).toFixed(1)}x throughput, p95 ${off.p95} -> ${on.p95} ms`,
);
