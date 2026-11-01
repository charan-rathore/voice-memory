// Production canary: is the live site answering, and answering the same as
// the build that shipped? Asks the deployed engine (through Vercel, the way a
// visitor does) the hero's questions and compares each answer's sentence,
// verdict and cited quotes with site/snapshot.js. Exit 1 on any difference.
//   node scripts/canary.mjs [https://voice-memory-beige.vercel.app]
// Run on a schedule it doubles as a warm-up ping for the free engine host.
import { readFileSync } from "node:fs";
import vm from "node:vm";

const site = (
  process.argv[2] || "https://voice-memory-beige.vercel.app"
).replace(/\/$/, "");
const sandbox = { window: {} };
vm.runInNewContext(
  readFileSync(new URL("../site/snapshot.js", import.meta.url), "utf8"),
  sandbox,
);
const snap = sandbox.window.VM_SNAPSHOT;
const KEYS = [
  "health|What is SYN-0001's ferritin result?",
  "health|Has creatinine gone up since September?",
  "health|What is the TSH?",
  "deal|Was the $42,000 revision finalized?",
];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function get(path, tries = 6) {
  for (let i = 0; ; i++) {
    try {
      const r = await fetch(site + path, {
        signal: AbortSignal.timeout(20000),
      });
      if (r.ok)
        return { body: await r.json(), cache: r.headers.get("x-vercel-cache") };
      if (r.status < 500 && r.status !== 429)
        throw Error(`${path}: HTTP ${r.status}`);
    } catch (e) {
      if (i >= tries - 1) throw e;
    }
    // full-jitter backoff while the free host wakes (about a minute)
    await sleep(Math.random() * Math.min(30000, 2000 * 2 ** i));
  }
}

const t0 = Date.now();
const status = (await get("/api/public/status", 10)).body;
if (!status.cases?.health || !status.cases?.deal)
  throw Error("engine up but cases not loaded");
const wake = Date.now() - t0;
const problems = [];
for (const k of KEYS) {
  const [c, q] = k.split("|");
  const { body, cache } = await get(
    `/api/public/answer?${new URLSearchParams({ case: c, q })}`,
  );
  const want = snap.answers[k].lead,
    got = body.lead;
  const quotes = (l) => (l?.citations ?? []).map((x) => x.quote);
  if (got?.text !== want.text)
    problems.push(
      `${k}: text differs\n  live:  ${got?.text}\n  saved: ${want.text}`,
    );
  if (got?.verdict !== want.verdict)
    problems.push(`${k}: verdict ${got?.verdict} != ${want.verdict}`);
  if (JSON.stringify(quotes(got)) !== JSON.stringify(quotes(want)))
    problems.push(`${k}: cited quotes differ`);
  console.log(`${got?.verdict?.padEnd(18)} cache=${cache ?? "-"}  ${q}`);
}
console.log(`engine reachable after ${wake} ms`);
if (problems.length) {
  console.error(problems.join("\n"));
  process.exit(1);
}
