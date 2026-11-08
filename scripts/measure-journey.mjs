// The upload-to-answer journey, measured through the same public API the
// website uses: create a workspace, upload real documents, watch every
// status change, then ask questions whose answers are known and check them.
//
//   node scripts/measure-journey.mjs                 # starts a local server
//   VM_BASE=https://host node scripts/measure-journey.mjs   # any deployment
//   node scripts/measure-journey.mjs --json          # raw results only
//
// Two runs: one file at a time, then all files in one burst (parallel).
// Prints, per file: accepted, first answerable, ready (ms from upload start),
// pages, OCR pages and per-page warnings; then each question's latency and
// whether the answer contains the fact printed in the report.
import { spawn } from "node:child_process";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";

const LOCAL = !process.env.VM_BASE;
const BASE = process.env.VM_BASE || "http://127.0.0.1:4517";
const JSON_ONLY = process.argv.includes("--json");
const root = new URL("../", import.meta.url);
const file = (p) => readFileSync(new URL(p, root));

// Real documents in the repository (a workspace holds up to 5), each with a question whose answer is a
// fact printed in that document (checked against the extracted text, below).
const DOCS = [
  {
    path: "clinical/fixtures/files/a-2026-09.pdf",
    ask: "What was SYN-0001's creatinine in September?",
    expect: /1\.2/,
  },
  {
    path: "clinical/fixtures/files/a-2026-10-prelim.pdf",
    ask: null,
  },
  {
    path: "clinical/fixtures/files/a-2026-10-amended.pdf",
    ask: "What is SYN-0001's ferritin?",
    expect: /\b50\b/,
  },
  {
    path: "clinical/fixtures/files/c-2026-10.pdf",
    ask: "What is the TSH for SYN-0003?",
    expect: /\d/,
  },
  {
    // three pages: digital, clean scan, blurred tilted scan (fictional)
    path: "evaluation/scans/mixed-quality.pdf",
    ask: "What is Hemoglobin for SYN-0007?",
    expect: /11\.4/,
  },
];
const AFTER = [
  {
    ask: "Has SYN-0001's creatinine gone up since September?",
    expect: /unit|compar/i,
  },
  { ask: "What are the abnormal results?", expect: /outside|above|below/i },
  { ask: "What should I ask my doctor?", expect: /not a diagnosis/i },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function api(path, init) {
  const r = await fetch(BASE + "/api/public" + path, init);
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(Error(body.error || r.status), { body });
  return body;
}
async function upload(ws, d) {
  return api(`/workspace/${ws}/upload`, {
    method: "POST",
    headers: {
      "content-type": "application/octet-stream",
      "x-file-name": encodeURIComponent(d.path.split("/").pop()),
    },
    // A trailing PDF comment changes the bytes, not the content: every run
    // reads the file fresh instead of hitting the server's parse cache.
    body: d.path.endsWith(".pdf")
      ? Buffer.concat([
          file(d.path),
          Buffer.from(`\n%nonce ${Math.random()}\n`),
        ])
      : file(d.path),
  });
}
async function ask(ws, question) {
  const t = performance.now();
  const a = await api("/ask", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ case: ws, question }),
  });
  return { ms: Math.round(performance.now() - t), a };
}

/** Upload `docs` (all at once when parallel), poll until every one settles. */
async function journey(docs, parallel) {
  const { id: ws } = await api("/workspace", { method: "POST" });
  const t0 = performance.now();
  const since = () => Math.round(performance.now() - t0);
  const rows = new Map(docs.map((d) => [d.path.split("/").pop(), { doc: d }]));
  const send = async (d) => {
    await upload(ws, d);
    rows.get(d.path.split("/").pop()).accepted = since();
  };
  if (parallel) await Promise.all(docs.map(send));
  const seen = new Map();
  const poll = async (only) => {
    for (;;) {
      const st = await api(`/workspace/${ws}`);
      for (const e of st.documents) {
        const row = rows.get(e.title) ?? rows.get(e.filename);
        if (!row) continue;
        const key = row.doc.path;
        if (seen.get(key) !== e.status) {
          seen.set(key, e.status);
          (row.states ??= []).push([e.status, since()]);
        }
        if (e.answerable && row.answerable == null) row.answerable = since();
        if (
          /^(ready|needs_review|failed)$/.test(e.status) &&
          row.done == null
        ) {
          row.done = since();
          row.status = e.status;
          row.pages = e.pages;
          row.progress = e.progress ?? null;
          row.review = e.review ?? [];
        }
      }
      const pending = [...rows.values()].filter(
        (r) => (!only || r.doc === only) && r.done == null,
      );
      if (!pending.length) return;
      if (since() > 180000) throw Error("timed out waiting for documents");
      await sleep(50);
    }
  };
  if (parallel) await poll();
  else
    for (const d of docs) {
      await send(d);
      await poll(d);
    }
  const total = since();
  const answers = [];
  for (const d of [...docs, ...AFTER])
    if (d.ask) {
      const { ms, a } = await ask(ws, d.ask);
      const text = a.final?.text ?? a.lead?.text ?? "";
      answers.push({
        question: d.ask,
        ms,
        kind: a.final?.kind,
        correct: d.expect.test(text),
        text: text.slice(0, 160),
      });
    }
  const run = { parallel, total, files: [...rows.values()], answers };
  if (parallel) {
    run.determinism = await determinism(ws);
    run.voice = await voiceTurns(ws);
  }
  return run;
}

// The same question, asked many times, must give the same words: a chat
// model sampling a fresh answer can flip a verdict between asks.
async function determinism(ws, times = LOCAL ? 20 : 3) {
  const qs = [...DOCS, ...AFTER].filter((d) => d.ask).map((d) => d.ask);
  const out = [];
  for (const q of qs) {
    const texts = new Set();
    for (let i = 0; i < times; i++) {
      const { a } = await ask(ws, q);
      texts.add(JSON.stringify([a.final?.kind, a.final?.text]));
    }
    out.push({ question: q, asks: times, distinct: texts.size });
  }
  return out;
}

// The phone path: Bolna calls an OpenAI-compatible chat endpoint with
// what speech-to-text heard. Measures time to the first spoken token and
// to the end, and shows the record-term repair on misheard words.
async function voiceTurns(ws) {
  const key = await api("/llm/key", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ case: ws }),
  }).catch((e) => ({ error: e.message }));
  if (!key.apiKey) return { skipped: key.error ?? "no key" };
  const heard = [
    "what was SYN-0001's creatinine in september",
    "what was S Y N 0001 creating in in september", // misheard
    "SYN-0007 ka hemoglobin kitna hai",
    "what is the hemo globin for SYN 0007", // misheard
  ];
  const turns = [];
  for (const h of heard) {
    const t = performance.now();
    const r = await fetch(
      key.baseUrl.replace(/^https?:\/\/[^/]+/, BASE) + "/chat/completions",
      {
        method: "POST",
        headers: {
          authorization: "Bearer " + key.apiKey,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          stream: true,
          messages: [{ role: "user", content: h }],
        }),
      },
    );
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let first = null,
      raw = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = dec.decode(value, { stream: true });
      if (first == null && /"content":"[^"]/.test(chunk))
        first = performance.now() - t;
      raw += chunk;
    }
    const said = [...raw.matchAll(/"content":"((?:[^"\\]|\\.)*)"/g)]
      .map((m) => JSON.parse(`"${m[1]}"`))
      .join("");
    turns.push({
      heard: h,
      status: r.status,
      firstTokenMs: first == null ? null : Math.round(first),
      totalMs: Math.round(performance.now() - t),
      said: said.slice(0, 160),
    });
  }
  return { turns };
}

// CPU seconds the server spent (Linux /proc): production time on a host
// with a fraction of a CPU is roughly cpu / fraction (Render free: 0.1).
const cpuOf = (pid) => {
  try {
    const f = readFileSync(`/proc/${pid}/stat`, "utf8")
      .split(") ")[1]
      .split(" ");
    return (Number(f[11]) + Number(f[12])) / 100;
  } catch {
    return null;
  }
};
let server;
async function start() {
  server = spawn(process.execPath, ["scripts/site-dev.mjs"], {
    cwd: new URL(".", root),
    // the per-visitor question limit would stop the repeat-ask check
    env: {
      ...process.env,
      SITE_PORT: "4517",
      VM_PUBLIC_ASK_PER_MIN: "100000",
      VM_BYO_VOICE: "on",
    },
    stdio: "ignore",
  });
  for (let i = 0; i < 300; i++) {
    const ok = await fetch(BASE + "/api/public/cases")
      .then((r) => r.ok)
      .catch(() => false);
    if (ok) break;
    await sleep(100);
  }
  // let the built-in demo documents finish reading before measuring
  await sleep(1500);
}
async function measured(parallel) {
  if (LOCAL) await start();
  const cpu0 = LOCAL ? cpuOf(server.pid) : null;
  try {
    const run = await journey(DOCS, parallel);
    const cpu1 = LOCAL ? cpuOf(server.pid) : null;
    run.serverCpuSeconds =
      cpu0 != null && cpu1 != null ? +(cpu1 - cpu0).toFixed(2) : null;
    return run;
  } finally {
    if (LOCAL) server.kill();
  }
}
let out;
{
  const one = await measured(false);
  const burst = await measured(true);
  out = {
    base: LOCAL ? "local" : BASE,
    sha: execSync("git rev-parse --short HEAD").toString().trim(),
    at: new Date().toISOString(),
    node: process.version,
    runs: [one, burst],
  };
}
if (JSON_ONLY) console.log(JSON.stringify(out, null, 2));
else {
  for (const run of out.runs) {
    console.log(
      `\n${run.parallel ? "ALL AT ONCE" : "ONE AT A TIME"}: ${run.files.length} files settled in ${run.total} ms` +
        (run.serverCpuSeconds != null
          ? `; server CPU ${run.serverCpuSeconds} s (about ${Math.round(run.serverCpuSeconds * 10)} s on a 0.1-CPU host)`
          : ""),
    );
    for (const f of run.files) {
      const pg = f.progress?.pages ?? [];
      const ocr = pg.filter((p) => /ocr/.test(p.state ?? ""));
      const warn = pg
        .filter((p) => p.confidence != null && p.confidence < 80)
        .map((p) => `p${p.n} ${p.confidence}%`);
      console.log(
        `  ${f.doc.path.split("/").pop().padEnd(26)} accepted ${String(f.accepted).padStart(6)}  answerable ${String(f.answerable ?? "-").padStart(6)}  ready ${String(f.done).padStart(6)} ms  ${f.status}  pages ${f.pages ?? "-"}  ocr ${ocr.length}${warn.length ? "  low: " + warn.join(", ") : ""}`,
      );
    }
    for (const d of run.determinism ?? [])
      console.log(
        `  ${d.distinct === 1 ? "same" : "DIFF"} x${d.asks}  ${d.question}`,
      );
    for (const v of run.voice?.turns ?? [])
      console.log(
        `  voice ${v.status} first word ${v.firstTokenMs} ms, done ${v.totalMs} ms  "${v.heard}" -> ${v.said.slice(0, 80)}`,
      );
    if (run.voice?.skipped)
      console.log(`  voice skipped: ${run.voice.skipped}`);
    for (const a of run.answers)
      console.log(
        `  ${a.correct ? "ok  " : "MISS"} ${String(a.ms).padStart(5)} ms  ${a.question}  -> ${a.text.slice(0, 90)}`,
      );
  }
  mkdirSync(new URL("evaluation/results/", root), { recursive: true });
  const at = out.at.slice(0, 10);
  writeFileSync(
    new URL(`evaluation/results/journey-${at}-${out.sha}.json`, root),
    JSON.stringify(out, null, 2) + "\n",
  );
}
