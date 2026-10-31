// Spoken-answer evaluation through the REAL voice endpoint (the SSE contract
// Bolna calls), on a development set and a frozen held-out corpus.
//
// Two numbers per case, reported separately:
//   retrieval  - did the engine's evidence (cited + review passages) include a
//                gold supporting document? (cases with no gold docs excluded)
//   answer     - is the spoken sentence correct: every `has` phrase present,
//                no `not` phrase, <= 45 words, no filenames, no crash.
// Retrieval can be right while the answer is wrong (and vice versa: a correct
// abstention needs no retrieval), so one number never stands in for the other.
//
// Usage: node evaluation/spoken-eval.mjs [--write] [--json]
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { importBundle, answer } from "../dist/engine.mjs";
import { createVoiceAdapter } from "../voice-adapter.mjs";

const here = path.dirname(new URL(import.meta.url).pathname);
const root = path.join(here, "..");

export const SETS = [
  {
    name: "northstar-dev",
    heldOut: false,
    dir: path.join(root, "corpus-md"),
    gold: path.join(here, "fixtures/northstar-spoken.json"),
  },
  {
    name: "harbor",
    heldOut: false, // held-out at 584254d (3/15); its failures then informed fixes
    dir: path.join(here, "fixtures/heldout-harbor"),
    gold: path.join(here, "fixtures/heldout-harbor/gold.json"),
  },
  {
    name: "lumen",
    heldOut: false, // held-out at e6227d3: first run 12/14 (results/spoken-eval-*-d4c05ad.json); then fixed
    dir: path.join(here, "fixtures/heldout-lumen"),
    gold: path.join(here, "fixtures/heldout-lumen/gold.json"),
  },
];

const CAP = "spokeneval" + "0".repeat(56);

export function loadBundle(dir) {
  return importBundle(
    readdirSync(dir)
      .filter((f) => f.endsWith(".md"))
      .sort()
      .map((f) => ({
        title: f,
        text: readFileSync(path.join(dir, f), "utf8"),
      })),
  );
}

export async function speak(voice, history) {
  const res = await voice.handle(
    new Request("http://eval/v1/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer " + CAP,
      },
      body: JSON.stringify({
        model: "voice-memory-local",
        stream: true,
        messages: history.map((content, i) => ({
          role: i % 2 ? "assistant" : "user",
          content,
        })),
      }),
    }),
  );
  if (res.status !== 200) return { status: res.status, text: "" };
  const raw = await res.text();
  const text = [...raw.matchAll(/"content":"((?:[^"\\]|\\.)*)"/g)]
    .map((m) => JSON.parse('"' + m[1] + '"'))
    .join("");
  return { status: 200, text };
}

const words = (s) => s.split(/\s+/).filter(Boolean).length;
const low = (s) => s.toLowerCase();

export function judge(c, text) {
  const fails = [];
  for (const h of c.has)
    if (!low(text).includes(low(h))) fails.push(`missing "${h}"`);
  for (const n of c.not)
    if (low(text).includes(low(n))) fails.push(`contains "${n}"`);
  if (words(text) > 45) fails.push(`${words(text)} words`);
  if (/\.md\b|_/.test(text)) fails.push("reads a filename");
  if (!text.trim()) fails.push("empty");
  return fails;
}

export async function runSet(set) {
  const gold = JSON.parse(readFileSync(set.gold, "utf8"));
  const bundle = loadBundle(set.dir);
  const rows = [];
  for (const c of gold.cases) {
    // Fresh grant per case: no follow-up state leaks between cases.
    const voice = createVoiceAdapter({
      ttlMs: 60000,
      hardExpiresAtMs: Date.now() + 3600000,
    });
    voice.bind(bundle, CAP);
    const t0 = performance.now();
    let out;
    try {
      out = await speak(voice, Array.isArray(c.q) ? c.q : [c.q]);
    } catch (e) {
      out = { status: "throw", text: "", error: e.message };
    }
    const ms = performance.now() - t0;
    const fails =
      out.status === 200
        ? judge(c, out.text)
        : [`status ${out.status} ${out.error ?? ""}`];
    let retrieved = null;
    if (c.docs.length) {
      let r;
      try {
        r = answer(Array.isArray(c.q) ? c.q.at(-1) : c.q, bundle);
      } catch {
        r = { evidence: [], reviewEvidence: [] };
      }
      const titles = [...(r.evidence ?? []), ...(r.reviewEvidence ?? [])].map(
        (e) => e.title,
      );
      retrieved = c.docs.some((d) => titles.some((t) => t.startsWith(d)));
    }
    rows.push({
      id: c.id,
      q: c.q,
      cls: c.cls,
      spoken: out.text,
      pass: !fails.length,
      fails,
      retrieved,
      ms: +ms.toFixed(1),
    });
  }
  const withDocs = rows.filter((r) => r.retrieved !== null);
  return {
    set: set.name,
    heldOut: set.heldOut,
    n: rows.length,
    answerCorrect: rows.filter((r) => r.pass).length,
    retrievalRecall: {
      hit: withDocs.filter((r) => r.retrieved).length,
      n: withDocs.length,
    },
    p50ms: pct(
      rows.map((r) => r.ms),
      0.5,
    ),
    p95ms: pct(
      rows.map((r) => r.ms),
      0.95,
    ),
    rows,
  };
}

function pct(xs, p) {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : null;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const sha = (() => {
    try {
      return execSync("git rev-parse --short HEAD", { cwd: root })
        .toString()
        .trim();
    } catch {
      return "unknown";
    }
  })();
  const results = [];
  for (const set of SETS) results.push(await runSet(set));
  for (const r of results) {
    console.log(
      `${r.set}${r.heldOut ? " (held-out)" : ""}: answer ${r.answerCorrect}/${r.n}, retrieval recall ${r.retrievalRecall.hit}/${r.retrievalRecall.n}, engine p50 ${r.p50ms} ms p95 ${r.p95ms} ms`,
    );
    for (const row of r.rows.filter((x) => !x.pass))
      console.log(
        `  FAIL ${row.id} "${row.q}" -> "${row.spoken}" [${row.fails.join("; ")}]`,
      );
  }
  if (process.argv.includes("--write")) {
    mkdirSync(path.join(here, "results"), { recursive: true });
    const file = path.join(
      here,
      "results",
      `spoken-eval-${new Date().toISOString().slice(0, 10)}-${sha}.json`,
    );
    writeFileSync(
      file,
      JSON.stringify(
        {
          sha,
          date: new Date().toISOString(),
          note: "Engine-only timing (no ASR/TTS/network). Keyword retrieval path, as the voice adapter uses.",
          results,
        },
        null,
        1,
      ),
    );
    console.log("wrote", path.relative(root, file));
  }
}
