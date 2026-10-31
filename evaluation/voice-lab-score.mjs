// Score a real-call measurement downloaded from the workspace's "Measure this
// call" panel and record it under evaluation/results/. Re-scores from the raw
// timestamps, so the stored numbers never depend on the browser's arithmetic.
//   node evaluation/voice-lab-score.mjs path/to/voicelab-*.json [--write]
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { clockOffset, scoreCall } from "../public/voicelab-score.mjs";

const file = process.argv[2];
if (!file) {
  console.error(
    "usage: node evaluation/voice-lab-score.mjs <voicelab.json> [--write]",
  );
  process.exit(2);
}
const rep = JSON.parse(readFileSync(file, "utf8"));
if (rep.kind !== "voice-memory.voicelab/1")
  throw Error("Not a voicelab measurement.");
const r = rep.raw;
const score = scoreCall({
  script: r.script,
  speechEnds: r.speechEnds,
  agentAudioStarts: r.agentAudioStarts,
  turns: r.turns,
  clock: clockOffset(r.clockSamples),
});
console.log(
  `turns ${score.turns}, clock error ±${score.clockErrorMs?.toFixed(0)} ms`,
);
console.log(
  `speech->answer p50 ${score.speechToAnswerMs.p50} ms, p95 ${score.speechToAnswerMs.p95} ms (n=${score.speechToAnswerMs.n})`,
);
console.log(
  `mean WER ${score.meanWer}; turns with critical-entity errors: ${score.turnsWithEntityErrors}`,
);
for (const row of score.rows)
  console.log(
    `  ${row.i + 1}. said "${row.script}" | heard "${row.transcript}" | ${JSON.stringify(row.ms)}${row.entityErrors?.length ? " | " + row.entityErrors.join(", ") : ""}`,
  );
if (process.argv.includes("--write")) {
  const out = path.join(
    path.dirname(new URL(import.meta.url).pathname),
    "results",
    `voicelab-${rep.measuredAt.slice(0, 19).replace(/[:T]/g, "-")}.json`,
  );
  writeFileSync(
    out,
    JSON.stringify(
      {
        measuredAt: rep.measuredAt,
        userAgent: rep.userAgent,
        interruptions: rep.interruptions,
        score,
      },
      null,
      1,
    ),
  );
  console.log("wrote", out);
}
