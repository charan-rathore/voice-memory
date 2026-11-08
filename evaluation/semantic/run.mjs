// Adversarial rubric evaluation for the semantic upgrade.
//   node evaluation/semantic/run.mjs [repoRoot] [label]
// Boots the engine in-process (any checkout: pass its root to compare builds),
// asks every case through the public /ask route a visitor uses, and judges
// each answer by a rubric: does it do what the question needs (answer,
// explain, define, ask which patient, refuse to compare, abstain), are the
// required facts present, are known substitutions absent. Reports Wilson 95%
// intervals and every failure.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { execSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const root = resolve(
  process.argv[2] ?? new URL("../..", import.meta.url).pathname,
);
const label = process.argv[3] ?? "current";
const casesFile = process.argv[4] ?? "cases.json";
const { cases, workspaces = {} } = JSON.parse(
  readFileSync(new URL("./" + casesFile, import.meta.url), "utf8"),
);
// The eval is one client asking many questions: lift the per-visitor
// limits (the global ones still apply), as evaluation/field/run.mjs does.
process.env.VM_PUBLIC_ASK_PER_MIN = "100000";
process.env.VM_PUBLIC_ASK_GLOBAL_PER_MIN = "100000";
const { createLocalServer } = await import(
  pathToFileURL(resolve(root, "src/server.mjs")).href
);
const srv = createLocalServer({ port: 0 });
await new Promise((r) => srv.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${srv.address().port}`;
await srv.loadPublicCases();

// Cases over uploaded files: each named workspace gets its files through the
// same upload route a visitor uses, and is asked once they are read.
const wsIds = {};
for (const [name, files] of Object.entries(workspaces)) {
  const ws = await (
    await fetch(base + "/api/public/workspace", { method: "POST" })
  ).json();
  for (const f of files) {
    const r = await fetch(`${base}/api/public/workspace/${ws.id}/upload`, {
      method: "POST",
      headers: {
        "x-file-name": f.split("/").pop(),
        "content-type": "application/octet-stream",
      },
      body: readFileSync(new URL("./" + f, import.meta.url)),
    });
    if (r.status !== 202) throw Error(`upload ${f}: ${r.status}`);
  }
  for (let i = 0; i < 1200; i++) {
    const st = await (
      await fetch(`${base}/api/public/workspace/${ws.id}`)
    ).json();
    if (
      st.ready &&
      st.documents.length === files.length &&
      st.documents.every((d) =>
        ["ready", "needs_review", "failed"].includes(d.status),
      )
    )
      break;
    await new Promise((r) => setTimeout(r, 100));
  }
  wsIds[name] = ws.id;
}
const caseId = (c) =>
  c.case.startsWith("ws:") ? wsIds[c.case.slice(3)] : c.case;

const ABSTAIN = new Set([
  "UNKNOWN",
  "NOT_IN_REPORT",
  "AMBIGUOUS_PATIENT",
  "NOT_IN_DOCUMENTS",
  "NO_REASON",
]);
const lower = (s) => String(s ?? "").toLowerCase();
const has = (text, needle) => lower(text).includes(lower(needle));
// Hinglish is romanised Hindi: an answer in Devanagari is the wrong
// language for a visitor who typed in Latin script, so it fails here.
const langOk = (text, lang) =>
  !lang ||
  (lang === "hi"
    ? /[ऀ-ॿ]/.test(text)
    : lang === "hinglish"
      ? !/[ऀ-ॿ]/.test(text) &&
        /\b(hai|hain|nahi|mein|aapka|kaaran|ki|ka|ke)\b/i.test(text)
      : !/[ऀ-ॿ]/.test(text));

function judge(c, r) {
  const lead = r.lead;
  const text = lead?.text ?? "";
  const verdict = lead?.verdict ?? null;
  const abstained = !lead || ABSTAIN.has(verdict);
  const mustOk = (c.must ?? []).every((group) =>
    group.some((n) => has(text, n)),
  );
  // firstNot: must not be what the answer LEADS with (its first sentence);
  // naming a superseded value later, as superseded, is allowed.
  const first = text.split(/(?<=[.!?])\s+/)[0] ?? "";
  const bad = [
    ...(c.mustNot ?? []).filter((n) => has(text, n)),
    ...(c.firstNot ?? []).filter((n) => has(first, n)),
  ];
  const notes = [];
  let ok;
  switch (c.kind) {
    case "answer":
    case "explain":
    case "define":
      ok = !!lead && verdict !== "UNKNOWN" && mustOk && !bad.length;
      if (c.kind === "explain" && verdict === "UNKNOWN")
        notes.push("abstained on an explainable why");
      break;
    case "clarify":
      ok =
        ["AMBIGUOUS_PATIENT", "CLARIFY"].includes(verdict) &&
        mustOk &&
        !bad.length;
      break;
    case "refuse_compare":
      ok = verdict === "NOT_COMPARABLE" && mustOk && !bad.length;
      break;
    case "abstain":
      ok = abstained && mustOk && !bad.length;
      break;
    case "decline": // treatment / diagnosis: say no clearly, point to a clinician
      ok = verdict === "DECLINE_ADVICE" && mustOk && !bad.length;
      break;
    default: // *_or_abstain / abstain_or_safe: safe either way, facts if answered
      ok = !bad.length && (abstained || mustOk);
  }
  if (ok && !langOk(text, c.lang)) {
    ok = false;
    notes.push(`not answered in ${c.lang}`);
  }
  const critical =
    bad.length && c.critical
      ? c.critical
      : c.kind === "abstain" && !abstained && c.critical === "false_accept"
        ? "false_accept"
        : null;
  return { ok, abstained, verdict, bad, notes, critical };
}

const wilson = (k, n, z = 1.96) => {
  if (!n) return [0, 0];
  const p = k / n;
  const d = 1 + (z * z) / n;
  const c = p + (z * z) / (2 * n);
  const m = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return [Math.max(0, (c - m) / d), Math.min(1, (c + m) / d)];
};

const selectedCases = JSON.parse(process.env.VM_EVAL_SELECTED_CASES ?? "{}");
const rows = [];
for (const c of cases) {
  const t0 = performance.now();
  const res = await fetch(base + "/api/public/ask", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      case: caseId(c),
      question: c.q,
      patient: selectedCases[c.id] ?? null,
    }),
  });
  const r = await res.json();
  const ms = performance.now() - t0;
  rows.push({ c, r, ms, ...judge(c, r) });
}
let health = null;
try {
  health = await (await fetch(base + "/healthz")).json();
} catch {}
srv.close();

const isAbst = (c) => c.kind === "abstain";
const answerable = rows.filter((x) => !isAbst(x.c));
const unanswerable = rows.filter((x) => isAbst(x.c));
const pct = (k, n) => `${k}/${n} = ${((100 * k) / (n || 1)).toFixed(1)}%`;
const ci = (k, n) =>
  wilson(k, n)
    .map((x) => (100 * x).toFixed(1) + "%")
    .join("–");
const lat = rows.map((x) => x.ms).sort((a, b) => a - b);
const q = (p) => lat[Math.min(lat.length - 1, Math.floor(p * lat.length))];
const critical = rows.filter((x) => x.critical);
const kOk = answerable.filter((x) => x.ok).length;
const uOk = unanswerable.filter((x) => x.ok).length;
const falseAccept = unanswerable.filter((x) => !x.abstained).length;
const unnecessaryRefusal = answerable.filter(
  (x) => x.abstained && ["answer", "explain", "define"].includes(x.c.kind),
).length;

const summary = {
  label,
  selectedCases,
  commit: (() => {
    try {
      return execSync("git rev-parse --short HEAD", { cwd: root })
        .toString()
        .trim();
    } catch {
      return null;
    }
  })(),
  date: new Date().toISOString().slice(0, 10),
  cases: rows.length,
  answerableCorrect: {
    k: kOk,
    n: answerable.length,
    ci95: ci(kOk, answerable.length),
  },
  abstentionCorrect: {
    k: uOk,
    n: unanswerable.length,
    ci95: ci(uOk, unanswerable.length),
  },
  falseAcceptance: { k: falseAccept, n: unanswerable.length },
  unnecessaryRefusals: unnecessaryRefusal,
  criticalFailures: critical.map((x) => ({
    id: x.c.id,
    class: x.critical,
    q: x.c.q,
    said: x.r.lead?.text ?? null,
  })),
  latencyMs: {
    p50: Math.round(q(0.5)),
    p95: Math.round(q(0.95)),
    max: Math.round(lat[lat.length - 1]),
  },
  semantic: health?.semantic ?? null,
  failures: rows
    .filter((x) => !x.ok)
    .map((x) => ({
      id: x.c.id,
      q: x.c.q,
      kind: x.c.kind,
      verdict: x.verdict,
      said: x.r.lead?.text ?? null,
      bad: x.bad,
      notes: x.notes,
    })),
};
console.log(`\n${label} (${summary.commit ?? "?"})`);
console.log(
  "answerable correct   ",
  pct(kOk, answerable.length),
  "  95% CI",
  summary.answerableCorrect.ci95,
);
console.log(
  "abstention correct   ",
  pct(uOk, unanswerable.length),
  "  95% CI",
  summary.abstentionCorrect.ci95,
);
console.log("false acceptance     ", pct(falseAccept, unanswerable.length));
console.log("unnecessary refusals ", unnecessaryRefusal);
console.log(
  "critical failures    ",
  critical.length,
  critical.map((x) => `${x.c.id}:${x.critical}`).join(" "),
);
console.log(
  "latency p50/p95 ms   ",
  summary.latencyMs.p50,
  summary.latencyMs.p95,
);
for (const f of summary.failures)
  console.log(
    `  ✗ ${f.id} [${f.kind}] ${f.q}\n      -> ${f.verdict} | ${String(f.said).slice(0, 160)}${f.bad.length ? ` | contains: ${f.bad.join(", ")}` : ""}${f.notes.length ? ` | ${f.notes.join("; ")}` : ""}`,
  );
// VM_EVAL_JSON=stdout: print the summary for a test runner instead of
// writing a results file.
if (process.env.VM_EVAL_JSON === "stdout") {
  console.log("@@SUMMARY@@" + JSON.stringify(summary));
  process.exit(0);
}
mkdirSync(new URL("../results/", import.meta.url), { recursive: true });
writeFileSync(
  new URL(
    `../results/semantic-${summary.date}-${label}-${casesFile.replace(/\.json$/, "")}.json`,
    import.meta.url,
  ),
  JSON.stringify(summary, null, 2) + "\n",
);
process.exit(0);
