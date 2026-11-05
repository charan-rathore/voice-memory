// Production canary: is the live site answering, and answering the same as
// the build that shipped? Asks the deployed engine (through Vercel, the way a
// visitor does) the hero's questions and compares each answer's sentence,
// verdict and cited quotes with site/snapshot.js. Exit 1 on any difference.
//   node scripts/canary.mjs [https://voice-memory-beige.vercel.app]
// Run on a schedule it doubles as a warm-up ping for the free engine host.
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { versionCheck, waitReady } from "./canary-state.mjs";

const site = (
  process.argv[2] || "https://voice-memory-beige.vercel.app"
).replace(/\/$/, "");
const sandbox = { window: {} };
vm.runInNewContext(
  readFileSync(new URL("../site/snapshot.js", import.meta.url), "utf8"),
  sandbox,
);
vm.runInNewContext(
  // answers moved to the lazy cold-boot chunk; read them from there
  readFileSync(new URL("../site/snapshot-answers.js", import.meta.url), "utf8"),
  sandbox,
);
const snap = sandbox.window.VM_SNAPSHOT;
const snapAnswers = sandbox.window.VM_SNAPSHOT_ANSWERS;
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

// Readiness: waking -> loading -> ready, within a bounded deadline. Each
// probe busts any edge cache so a cold-boot "not loaded" is never replayed.
const ready = await waitReady(
  async () => {
    try {
      const r = await fetch(`${site}/api/public/status?t=${Date.now()}`, {
        signal: AbortSignal.timeout(20000),
        headers: { "cache-control": "no-cache" },
      });
      return { status: r.status, body: r.ok ? await r.json() : null };
    } catch (e) {
      return { error: String(e?.message ?? e) };
    }
  },
  { deadlineMs: Number(process.env.VM_CANARY_DEADLINE_MS || 240000), sleep },
);
console.log(
  `readiness: ${ready.state} after ${ready.ms} ms (${ready.detail}); seen ${ready.seen.join(" > ")}`,
);
if (ready.state !== "ready")
  throw Error(
    ready.state === "loading"
      ? `cases still loading after ${ready.ms} ms: ${ready.detail}`
      : ready.state === "waking"
        ? `engine did not wake within ${ready.ms} ms: ${ready.detail}`
        : `status failed: ${ready.detail}`,
  );
const wake = ready.ms;
// Deployed version: only when an engine URL and an expected commit are given
// (the Render host is not behind the Vercel origin for /healthz).
if (process.env.VM_ENGINE_URL) {
  const h = await fetch(
    `${process.env.VM_ENGINE_URL.replace(/\/$/, "")}/healthz`,
    { signal: AbortSignal.timeout(20000) },
  )
    .then((r) => r.json())
    .catch(() => null);
  const v = versionCheck(h, process.env.VM_EXPECT_COMMIT);
  console.log(`deployed version: ${v.state} (${v.detail})`);
  if (v.state === "mismatch")
    throw Error(`deployed version mismatch: ${v.detail}`);
}
const problems = [];
for (const k of KEYS) {
  const [c, q] = k.split("|");
  const { body, cache } = await get(
    `/api/public/answer?${new URLSearchParams({ case: c, q })}`,
  );
  const want = snapAnswers.answers[k].lead,
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
