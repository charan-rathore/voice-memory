// Paired perf qualification: fixed identical workloads against two engine trees.
// Usage:
//   node evaluation/perf-paired.mjs --dir <tree> --mode lib|http --out <file.json>
//   node evaluation/perf-paired.mjs --compare <baseline.json> <candidate.json>
// No invented thresholds: reports observed distributions and correctness diffs.
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { execSync, spawn } from "node:child_process";
import path from "node:path";

const args = process.argv.slice(2);
const opt = (k) => {
  const i = args.indexOf(k);
  return i >= 0 ? args[i + 1] : null;
};

const QUESTIONS = [
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
  "What areas does the pilot cover initially?",
  "Do we have an agreed status-update cadence?",
  "What does security ticket SEC-999999 approve?",
  "What is pending for the pilot launch security review?",
];
const UNSAFE = new Set(QUESTIONS.slice(8, 11)); // must stay refused
const EXTRA3 = [
  {
    title: "M1_Meridian_Proposal.md",
    text: "# Meridian Analytics Pilot Proposal\nDate: 2026-09-05\nAuthor: Priya Sharma\n\n1. The Meridian pilot scope is four regions (East, West, North, South) across retail stores.\n2. The proposed engagement fee is $90,000.\n",
  },
  {
    title: "M2_Meridian_Kickoff.md",
    text: "# Meridian Kickoff Notes\nDate: 2026-09-20\nAuthor: Priya Sharma\n\n1. Meridian confirmed the pilot covers four regions (East, West, North, South) for the first phase.\n2. Weekly reporting for Meridian is still under discussion.\n",
  },
  {
    title: "M3_Meridian_Update.md",
    text: "# Meridian Weekly Update\nDate: 2026-10-05\nAuthor: Priya Sharma\n\n1. Meridian data access is one week late.\n2. The Meridian fee remains $90,000, not yet approved.\n",
  },
];

function corpora(dir) {
  const full = readdirSync(path.join(dir, "corpus-md"))
    .filter((f) => f.endsWith(".md"))
    .map((f) => ({
      title: f,
      text: readFileSync(path.join(dir, "corpus-md", f), "utf8"),
    }));
  let pad = full[full.length - 1].text;
  const filler =
    "Status note: integration and data mapping work continues on plan.\n";
  while (pad.length < 55000) pad += filler;
  return {
    small1: [full[0]],
    full7: full,
    ten10: [...full, ...EXTRA3],
    large55k: [{ title: full[full.length - 1].title, text: pad }],
  };
}

const pct = (a, p) => a[Math.floor(p * (a.length - 1))];
const summarize = (lat) => {
  const s = [...lat].sort((x, y) => x - y);
  return {
    n: s.length,
    p50: +pct(s, 0.5).toFixed(2),
    p95: +pct(s, 0.95).toFixed(2),
    max: +s[s.length - 1].toFixed(2),
  };
};

async function runLib(dir) {
  const { importBundle, answer } = await import(
    path.resolve(dir, "dist/engine.mjs")
  );
  const out = {};
  for (const [name, docs] of Object.entries(corpora(dir))) {
    const b = importBundle(docs);
    const lat = [],
      sig = {};
    for (let r = 0; r < 30; r++)
      for (const q of QUESTIONS) {
        const t0 = performance.now();
        const res = answer(q, b);
        lat.push(performance.now() - t0);
        if (r === 0)
          sig[q] =
            `${res.refused ? "REFUSED" : "ANSWERED"}|${res.evidenceStatus}|${res.partial ? "partial" : "full"}`;
      }
    out[name] = { latency: summarize(lat), signatures: sig };
  }
  return out;
}

async function runHttp(dir) {
  const port = 4300 + Math.floor(Math.random() * 200);
  const child = spawn("node", ["server.mjs"], {
    cwd: dir,
    env: { ...process.env, PORT: String(port), VM_BIND_HOST: "127.0.0.1" },
    stdio: "ignore",
  });
  const base = `http://127.0.0.1:${port}`;
  try {
    let cookie = "",
      csrf = "";
    for (let i = 0; i < 50; i++) {
      try {
        const r = await fetch(base + "/api/session");
        cookie = (r.headers.get("set-cookie") || "").split(";")[0];
        csrf = (await r.json()).csrf;
        if (csrf) break;
      } catch {
        await new Promise((r2) => setTimeout(r2, 100));
      }
    }
    if (!csrf) throw Error("server did not start");
    const H = {
      "content-type": "application/json",
      cookie,
      "x-csrf-token": csrf,
      origin: base,
    };
    const docs = corpora(dir).full7;
    const t0 = performance.now();
    const imp = await fetch(base + "/api/import", {
      method: "POST",
      headers: H,
      body: JSON.stringify({ documents: docs }),
    });
    if (!imp.ok) throw Error("import failed " + imp.status);
    const importMs = performance.now() - t0;
    const lat = [],
      draftLat = [],
      sig = {};
    for (let r = 0; r < 10; r++)
      for (const q of QUESTIONS) {
        const t1 = performance.now();
        const res = await fetch(base + "/api/query", {
          method: "POST",
          headers: H,
          body: JSON.stringify({ question: q }),
        });
        const body = await res.json();
        lat.push(performance.now() - t1);
        if (r === 0) {
          sig[q] =
            `${body.refused ? "REFUSED" : "ANSWERED"}|${body.evidenceStatus}|${body.partial ? "partial" : "full"}`;
          if (!body.refused) {
            const t2 = performance.now();
            await fetch(base + "/api/draft", {
              method: "POST",
              headers: H,
              body: "{}",
            });
            draftLat.push(performance.now() - t2);
          }
        }
      }
    return {
      http_full7: {
        importMs: +importMs.toFixed(1),
        query: summarize(lat),
        draftFirstRound: summarize(draftLat),
        signatures: sig,
      },
    };
  } finally {
    child.kill();
  }
}

if (opt("--compare")) {
  const A = JSON.parse(
    readFileSync(args[args.indexOf("--compare") + 1], "utf8"),
  );
  const B = JSON.parse(
    readFileSync(args[args.indexOf("--compare") + 2], "utf8"),
  );
  console.log(`baseline=${A.sha} candidate=${B.sha}`);
  for (const mode of ["lib", "http"]) {
    if (!A.results[mode] || !B.results[mode]) continue;
    for (const [variant, av] of Object.entries(A.results[mode])) {
      const bv = B.results[mode][variant];
      if (!bv) continue;
      const al = av.latency || av.query,
        bl = bv.latency || bv.query;
      console.log(
        `${mode}/${variant}: p50 ${al.p50}->${bl.p50}ms p95 ${al.p95}->${bl.p95}ms max ${al.max}->${bl.max}ms`,
      );
      let regress = 0,
        improved = 0,
        unsafe = 0;
      for (const q of QUESTIONS) {
        const s1 = av.signatures[q],
          s2 = bv.signatures[q];
        if (UNSAFE.has(q) && !s2.startsWith("REFUSED")) unsafe++;
        if (s1.startsWith("ANSWERED") && s2.startsWith("REFUSED")) {
          regress++;
          console.log(`  REGRESSION: "${q}" answered->refused`);
        }
        if (s1.startsWith("REFUSED") && s2.startsWith("ANSWERED")) {
          improved++;
          console.log(`  changed-refusal->answer: "${q}" (${s2})`);
        }
      }
      console.log(
        `  signatures: ${regress} regressions, ${improved} refusal->answer changes, ${unsafe} unsafe-answers`,
      );
    }
  }
  process.exit(0);
}

const dir = opt("--dir"),
  mode = opt("--mode"),
  outFile = opt("--out");
const sha = execSync("sha256sum dist/engine.mjs", { cwd: dir })
  .toString()
  .slice(0, 8);
const result = { sha, mode, results: {} };
if (mode === "lib") result.results.lib = await runLib(dir);
else result.results.http = await runHttp(dir);
writeFileSync(outFile, JSON.stringify(result, null, 1));
console.log(`${mode} ${sha} -> ${outFile}`);
