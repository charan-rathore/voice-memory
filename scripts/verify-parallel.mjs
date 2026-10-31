// Parallel verified feedback. The serial `npm run verify` stops at the
// first failing stage and takes ~50s warm at 8e17f97; this runs the
// independent stages concurrently so feedback approaches the slowest
// stage. Same stages, same checks - nothing weakened. Benches stay out of
// the push gate (perf measurements, not correctness checks).
//   node scripts/verify-parallel.mjs         full check set
//   node scripts/verify-parallel.mjs --fast  pre-push core (~10s)
import { spawn } from "node:child_process";

// Lanes run in parallel; stages inside a lane run sequentially. The
// "ports" lane exists because server.test.mjs (boundaries) and
// browser-check/notes-check (browser) bind the SAME fixed loopback ports
// 4317/4318 - running those two stages concurrently collides with
// EADDRINUSE. (Cleanup candidate: ephemeral ports in those tests.)
const LANES = [
  [["format", "format:check"]],
  [["typecheck", "typecheck"]],
  [["unit", "test"]],
  [
    ["boundaries", "test:boundaries"],
    ["browser", "test:browser"],
  ],
  [["evaluation", "test:evaluation"]],
  [["ingest", "test:ingest"]],
  [["clinical", "test:clinical"]],
  [["vault", "test:vault"]],
  [["graph", "test:graph"]],
];
const FAST = ["format", "typecheck", "unit", "boundaries", "evaluation"];
const fast = process.argv.includes("--fast");
const lanes = LANES.map((lane) =>
  lane.filter(([name]) => !fast || FAST.includes(name)),
).filter((lane) => lane.length);

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
// Build first: test stages import dist/, and a broken build must not let
// them pass against a stale committed bundle.
const t0 = Date.now();
await new Promise((ok, bad) => {
  const b = spawn(npm, ["run", "build"], { stdio: "inherit" });
  b.on("exit", (c) => (c === 0 ? ok() : bad(Error("build failed"))));
}).catch((e) => {
  console.error(e.message);
  process.exit(1);
});

const runOne = ([name, script]) =>
  new Promise((resolve) => {
    const t = Date.now();
    const p = spawn(npm, ["run", script], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (out += d));
    p.on("exit", (code) =>
      resolve({ name, script, code: code ?? 1, ms: Date.now() - t, out }),
    );
  });
const runs = lanes.map(async (lane) => {
  const out = [];
  for (const stage of lane) out.push(await runOne(stage));
  return out;
});
const results = (await Promise.all(runs)).flat();
let failed = 0;
for (const r of results) {
  const ok = r.code === 0;
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"} ${r.name} (${(r.ms / 1000).toFixed(1)}s)`);
  if (!ok) console.log(r.out.replace(/^/gm, "  | "));
}
console.log(
  `${results.length - failed}/${results.length} stages green in ${((Date.now() - t0) / 1000).toFixed(1)}s`,
);
process.exit(failed ? 1 : 0);
