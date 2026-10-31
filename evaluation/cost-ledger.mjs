// Cost per answered question, from what this repository can MEASURE plus
// published prices. Every number is labelled measured / published / derived.
//
//   node evaluation/cost-ledger.mjs [--write]
import { writeFileSync } from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { SETS, loadBundle, speak } from "./spoken-eval.mjs";
import { createVoiceAdapter } from "../voice-adapter.mjs";
import { readFileSync } from "node:fs";

const here = path.dirname(new URL(import.meta.url).pathname);
const CAP = "spokeneval" + "0".repeat(56);
const qs = [];
for (const set of SETS) {
  const gold = JSON.parse(readFileSync(set.gold, "utf8"));
  qs.push(...gold.cases.map((c) => ({ dir: set.dir, q: c.q })));
}
// Warm, then measure CPU time per answered turn through the voice endpoint.
const bundles = new Map();
const words = [];
let cpu = 0;
let n = 0;
for (let round = 0; round < 3; round++)
  for (const { dir, q } of qs) {
    if (!bundles.has(dir)) bundles.set(dir, loadBundle(dir));
    const v = createVoiceAdapter({
      ttlMs: 60000,
      hardExpiresAtMs: Date.now() + 3600e3,
    });
    v.bind(bundles.get(dir), CAP);
    const c0 = process.cpuUsage();
    const r = await speak(v, [q]);
    const d = process.cpuUsage(c0);
    if (round > 0) {
      cpu += (d.user + d.system) / 1000;
      n++;
      words.push(r.text.split(/\s+/).filter(Boolean).length);
    }
  }
const cpuMsPerAnswer = cpu / n;
const meanWords = words.reduce((a, b) => a + b, 0) / words.length;
const ttsSeconds = (meanWords / 150) * 60; // 150 spoken words per minute
const BOLNA_USD_PER_MIN = 0.06; // published pay-as-you-go starting rate
const ledger = {
  sha: execSync("git rev-parse --short HEAD").toString().trim(),
  date: new Date().toISOString(),
  measured: {
    questions: n,
    engineCpuMsPerAnswer: +cpuMsPerAnswer.toFixed(2),
    meanSpokenWords: +meanWords.toFixed(1),
    rssMb: Math.round(process.memoryUsage().rss / 1048576),
    note: "This machine, keyword retrieval (voice path), cache cold per request. Not the Render instance.",
  },
  published: {
    bolnaPayAsYouGoUsdPerMinute: BOLNA_USD_PER_MIN,
    bolnaIncludes:
      "STT + LLM + TTS on bundled models; telephony and a per-minute platform fee are extra and not stated on the pricing page (bolna.ai/pricing, read 2026-10-31).",
    customLlmNote:
      "Voice Memory is a custom LLM endpoint: Bolna's docs bill a custom LLM by tokens generated; whether a self-hosted endpoint is billed is not stated.",
  },
  derived: {
    engineCpuSecondsPer1000Answers: +((cpuMsPerAnswer * 1000) / 1000).toFixed(
      1,
    ),
    spokenSecondsPerAnswer: +ttsSeconds.toFixed(1),
    voiceUsdPerAnswerLowerBound: +(
      (ttsSeconds / 60) *
      BOLNA_USD_PER_MIN
    ).toFixed(4),
    voiceUsdPerTwoMinuteCallLowerBound: +(2 * BOLNA_USD_PER_MIN).toFixed(2),
    note: "Lower bounds: billed minutes include listening and silence, plus telephony and platform fees not published. The engine itself makes no paid API calls. A real call's bill is the only verification; none has been made.",
  },
};
console.log(JSON.stringify(ledger, null, 1));
if (process.argv.includes("--write")) {
  const f = path.join(
    here,
    "results",
    `cost-ledger-${ledger.date.slice(0, 10)}-${ledger.sha}.json`,
  );
  writeFileSync(f, JSON.stringify(ledger, null, 1));
  console.log("wrote", path.relative(path.join(here, ".."), f));
}
