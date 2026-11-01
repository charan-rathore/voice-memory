// Voice test vault. Replays Bolna-shaped calls against the REAL server process
// over HTTP, exactly as Bolna's custom-LLM relay does (system prompt, growing
// user/assistant history, stream:true, fixed bearer), plus barge-in, overlap,
// concurrency and expiry, and lab turns in three languages.
//
// It simulates the Bolna side only: no microphone, recogniser, TTS or phone
// network. Recogniser behaviour is approximated by per-turn spelling variants.
// Real-call numbers come from the workspace's "Measure this call" panel.
//
//   node evaluation/vault/run.mjs            check expectations + golden diff
//   node evaluation/vault/run.mjs --update   rewrite golden recordings
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import path from "node:path";

const here = path.dirname(new URL(import.meta.url).pathname);
const root = path.join(here, "../..");
const S = JSON.parse(readFileSync(path.join(here, "scenarios.json"), "utf8"));
const PORT = 4300 + Math.floor(Math.random() * 400);
const CAP = "vault" + "1".repeat(59);
const BASE = `http://127.0.0.1:${PORT}`;
const UPDATE = process.argv.includes("--update");
const failures = [];
const fail = (m) => failures.push(m);

async function boot(extraEnv = {}) {
  const child = spawn(process.execPath, ["server.mjs"], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(PORT),
      VM_DENSE: "off",
      VM_DEMO_BUNDLE: "northstar",
      VM_VOICE_CAPABILITY: CAP,
      VM_VOICE_HARD_EXPIRES_AT: new Date(Date.now() + 3600e3).toISOString(),
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout.on("data", (d) => (log += d));
  child.stderr.on("data", (d) => (log += d));
  for (let i = 0; i < 100; i++) {
    if (/ready/i.test(log)) return child;
    await new Promise((r) => setTimeout(r, 100));
  }
  child.kill();
  throw Error("server did not start:\n" + log);
}

function bolnaBody(history) {
  return {
    model: "voice-memory-local",
    stream: true,
    temperature: 0.2,
    max_tokens: 150,
    messages: [{ role: "system", content: S.system }, ...history],
  };
}

async function turn(history, { signal } = {}) {
  const t0 = performance.now();
  const res = await fetch(BASE + "/v1/chat/completions", {
    method: "POST",
    headers: {
      authorization: "Bearer " + CAP,
      "content-type": "application/json",
    },
    body: JSON.stringify(bolnaBody(history)),
    signal,
  });
  if (res.status !== 200)
    return { status: res.status, text: "", ms: performance.now() - t0 };
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let raw = "";
  let firstByteMs = null;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (firstByteMs === null) firstByteMs = performance.now() - t0;
    raw += dec.decode(value, { stream: true });
  }
  const text = [...raw.matchAll(/^data: (.*)$/gm)]
    .map((m) => m[1])
    .filter((d) => d !== "[DONE]")
    .map((d) => JSON.parse(d).choices[0].delta.content ?? "")
    .join("");
  return {
    status: 200,
    text,
    firstByteMs,
    ms: performance.now() - t0,
    done: /data: \[DONE\]/.test(raw),
  };
}

function check(where, text, t) {
  const low = text.toLowerCase();
  for (const h of t.has ?? [])
    if (!low.includes(h.toLowerCase()))
      fail(`${where}: missing "${h}" in "${text}"`);
  for (const n of t.not ?? [])
    if (low.includes(n.toLowerCase()))
      fail(`${where}: contains "${n}" in "${text}"`);
  if (text.split(/\s+/).length > 45)
    fail(`${where}: ${text.split(/\s+/).length} words`);
  if (/\.md\b|_/.test(text)) fail(`${where}: reads a filename`);
}

const rec = { calls: {}, perf: {} };
const firstBytes = [];
const child = await boot();
try {
  // 1. Scripted calls, every recogniser variant of every turn, history grows.
  for (const call of S.calls) {
    for (
      let v = 0;
      v <= Math.max(0, ...call.turns.map((t) => t.variants?.length ?? 0));
      v++
    ) {
      const history = [];
      const out = [];
      for (const [i, t] of call.turns.entries()) {
        const say = v === 0 ? t.say : (t.variants?.[v - 1] ?? t.say);
        history.push({ role: "user", content: say });
        const r = await turn(history);
        if (r.status !== 200 || !r.done)
          fail(`${call.id}#${i} v${v}: status ${r.status}`);
        firstBytes.push(r.firstByteMs);
        check(`${call.id}#${i} v${v} "${say}"`, r.text, t);
        history.push({ role: "assistant", content: r.text });
        out.push({ say, spoken: r.text });
      }
      rec.calls[`${call.id}/v${v}`] = out;
    }
  }

  // 2. Barge-in: the caller interrupts while the first answer is in flight.
  //    Bolna cancels that request and sends the next turn with a truncated
  //    assistant message. The new turn must answer normally.
  {
    const ac = new AbortController();
    const p = turn(
      [{ role: "user", content: "What fee did we finally agree on?" }],
      { signal: ac.signal },
    ).catch((e) => ({ aborted: e.name }));
    ac.abort();
    await p;
    const r = await turn([
      { role: "user", content: "What fee did we finally agree on?" },
      { role: "assistant", content: "$42,000 is the lat" },
      { role: "user", content: "sorry, what's the payment split?" },
    ]);
    if (r.status !== 200) fail(`barge-in: status ${r.status}`);
    check("barge-in", r.text, { has: ["40/60", "50/50"] });
    rec.bargeIn = r.text;
  }

  // 3. Overlap on one call: an older turn still running when a newer one
  //    arrives must never be spoken AFTER the newer one as current.
  {
    const a = turn([{ role: "user", content: "What's the deadline?" }]);
    const b = turn([
      { role: "user", content: "What's the deadline?" },
      { role: "assistant", content: "" },
      { role: "user", content: "How many regions are we covering?" },
    ]);
    const [ra, rb] = await Promise.all([a, b]);
    if (![200, 409].includes(ra.status))
      fail(`overlap: older turn status ${ra.status}`);
    check("overlap newer", rb.text, { has: ["two regions"] });
  }

  // 4. Twenty concurrent calls, mixed questions: each answer must equal the
  //    answer the same question gets alone (no cross-call bleed).
  {
    const qs = S.calls.flatMap((c) => c.turns.map((t) => t.say)).slice(0, 10);
    const solo = new Map();
    for (const q of qs)
      solo.set(q, (await turn([{ role: "user", content: q }])).text);
    const t0 = performance.now();
    const all = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        turn([{ role: "user", content: qs[i % qs.length] }]),
      ),
    );
    const wall = performance.now() - t0;
    all.forEach((r, i) => {
      const q = qs[i % qs.length];
      if (r.text !== solo.get(q))
        fail(
          `concurrency: "${q}" -> "${r.text}" differs from solo "${solo.get(q)}"`,
        );
    });
    const lat = all.map((r) => r.ms).sort((x, y) => x - y);
    rec.perf.concurrent20 = {
      wallMs: Math.round(wall),
      p50: Math.round(lat[10]),
      p95: Math.round(lat[18]),
    };
  }

  // 5. Wrong bearer -> 401, never an answer.
  {
    const res = await fetch(BASE + "/v1/chat/completions", {
      method: "POST",
      headers: {
        authorization: "Bearer " + "x".repeat(64),
        "content-type": "application/json",
      },
      body: JSON.stringify(bolnaBody([{ role: "user", content: "What fee?" }])),
    });
    if (res.status !== 401) fail(`wrong bearer: ${res.status}`);
  }
} finally {
  child.kill();
}

// 6. Expired credential: a server booted past its hard expiry must refuse.
{
  let expired;
  try {
    expired = await boot({
      VM_VOICE_HARD_EXPIRES_AT: new Date(Date.now() - 1000).toISOString(),
    });
    const r = await turn([{ role: "user", content: "What fee did we agree?" }]);
    if (r.status === 200) fail("expired bearer answered");
  } catch (e) {
    // Refusing to boot with an expired pinned credential is also fail-closed.
    rec.expiredBoot = "refused to start";
  } finally {
    expired?.kill();
  }
}

// 7. Lab turns in English, Hindi and Hinglish (in-process: lab PDFs).
{
  const { ingestFile } = await import("../../ingest/index.mjs");
  const { importBundle } = await import("../../dist/engine.mjs");
  const { extractReport } = await import("../../clinical/observations.mjs");
  const { clinicalReportsFor } = await import("../../clinical/answer.mjs");
  const { createVoiceAdapter } = await import("../../src/voice-adapter.mjs");
  const dir = path.join(root, "clinical/fixtures/files");
  const entries = [];
  for (const f of readdirSync(dir)
    .filter((f) => /^[ac]-.*\.pdf$/.test(f))
    .sort()) {
    const r = await ingestFile(readFileSync(path.join(dir, f)), f);
    if (r.ok) entries.push({ title: f, doc: r.doc });
  }
  const bundle = importBundle(
    entries.map((e) => ({ title: e.title, text: e.doc.text })),
  );
  bundle.clinical = clinicalReportsFor(bundle, entries, extractReport);
  const v = createVoiceAdapter({
    ttlMs: 60000,
    hardExpiresAtMs: Date.now() + 3600e3,
  });
  v.bind(bundle, CAP);
  for (const L of S.lab) {
    const res = await v.handle(
      new Request("http://x/v1/chat/completions", {
        method: "POST",
        headers: {
          authorization: "Bearer " + CAP,
          "content-type": "application/json",
        },
        body: JSON.stringify(bolnaBody([{ role: "user", content: L.q }])),
      }),
    );
    const raw = await res.text();
    const text = [...raw.matchAll(/"content":"((?:[^"\\]|\\.)*)"/g)]
      .map((m) => JSON.parse('"' + m[1] + '"'))
      .join("");
    if (res.status !== 200 || !text) fail(`${L.id}: no answer`);
    if (L.script === "devanagari" && !/[ऀ-ॿ]/.test(text))
      fail(`${L.id}: asked in Hindi, answered in "${text}"`);
    if (L.lang === "en" && /[ऀ-ॿ]/.test(text))
      fail(`${L.id}: asked in English, answered in Hindi`);
    if (
      /\b(cancer|disease|dangerous|emergency|worry)\b|कैंसर|खतरनाक|बीमारी है/i.test(
        text,
      )
    )
      fail(`${L.id}: alarming wording "${text}"`);
    for (const h of L.has ?? [])
      if (!text.toLowerCase().includes(h))
        fail(`${L.id}: missing ${h} in "${text}"`);
    rec.calls[L.id] = [{ say: L.q, spoken: text }];
  }
}

const fb = firstBytes.filter(Number.isFinite).sort((a, b) => a - b);
rec.perf.firstByteMs = {
  n: fb.length,
  p50: Math.round(fb[Math.floor(fb.length / 2)]),
  p95: Math.round(fb[Math.floor(fb.length * 0.95)]),
};

// Golden recordings: what was spoken, turn by turn. A change is reported so a
// reviewer sees every wording change; --update accepts it.
const golden = path.join(here, "recordings", "golden.json");
if (UPDATE || !existsSync(golden))
  writeFileSync(golden, JSON.stringify(rec.calls, null, 1) + "\n");
else {
  const old = JSON.parse(readFileSync(golden, "utf8"));
  for (const [k, turns] of Object.entries(rec.calls))
    turns.forEach((t, i) => {
      const was = old[k]?.[i]?.spoken;
      if (was !== undefined && was !== t.spoken)
        fail(
          `golden drift ${k}#${i}: "${was}" -> "${t.spoken}" (run with --update to accept)`,
        );
    });
}
console.log(
  `vault: ${Object.keys(rec.calls).length} conversations, first byte p50 ${rec.perf.firstByteMs.p50} ms p95 ${rec.perf.firstByteMs.p95} ms (local HTTP, engine only), 20 concurrent calls p95 ${rec.perf.concurrent20?.p95} ms`,
);
if (failures.length) {
  console.log(failures.map((f) => "  FAIL " + f).join("\n"));
  process.exit(1);
}
console.log("vault: all checks passed");
