// Paired performance harness (PR #50). Run once per checked-out version:
//   VM_DENSE=off node evaluation/perf-paired.mjs <repo-root> [warmup=5] [measured=30]
// Builds a deterministic 512 KB corpus (16 docs from the Mariner + Northstar
// texts) and prints p50/p95 import, claim extraction and per-question answer
// latency, peak RSS, and sha256 of the serialized claims and answers, so two
// versions can be compared for speed AND byte-identical output.
import { createHash } from "node:crypto";
const root = process.argv[2];
const WARM = Number(process.argv[3] ?? 5), MEAS = Number(process.argv[4] ?? 30);
const { importBundle, extractClaims, answer } = await import(root + "/dist/engine.mjs");
const { MARINER_DOCS } = await import(root + "/examples/corpus-mariner.mjs");
const { NORTHSTAR_DOCS } = await import(root + "/examples/corpus-northstar.mjs");
const { spokenTurn } = await import(root + "/src/spoken.mjs");
const base = [...MARINER_DOCS, ...NORTHSTAR_DOCS];
const N = 16;
const per = (512 * 1024) / N;
const docs = [];
for (let i = 0; i < N; i++) {
  const d = base[i % base.length];
  let text = d.text;
  let k = 1;
  while (text.length < per)
    text += `\n\n## Appendix ${i}.${k++}\n\n` + base[(i + k) % base.length].text;
  docs.push({ title: `perf-${String(i).padStart(2, "0")}-${d.title}`, text: text.slice(0, per) });
}
const FIELDS = ["fee", "paymentSplit", "deadline", "scope", "signoffWho", "signedAgreement", "launchApproval", "reporting"];
const QS = [
  "What is the fee?",
  "Was the $58,000 revision approved?",
  "Is the data-processing addendum signed?",
  "How long do you keep the transcripts?",
  "Which sites are approved for phase one?",
  "What is the deadline?",
  "Who needs to sign off?",
  "How much was invoiced?",
];
const pct = (a, p) => {
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)];
};
let peak = 0;
const tick = () => (peak = Math.max(peak, process.memoryUsage().rss));
const t = { import: [], extract: [], answer: [] };
let claimSig = null;
let answerSig = null;
for (let it = 0; it < WARM + MEAS; it++) {
  let t0 = performance.now();
  const b = importBundle(docs);
  const ti = performance.now() - t0;
  tick();
  t0 = performance.now();
  const claims = extractClaims(b, FIELDS);
  const te = performance.now() - t0;
  tick();
  t0 = performance.now();
  const outs = QS.map((q) => {
    const r = answer(q, b);
    const s = spokenTurn(q, b, null);
    return {
      a: r.answer,
      ev: r.evidence.map((e) => [e.title, e.start, e.end, e.firstLine, e.lastLine, e.quote]),
      s: s?.spoken ?? null,
      c: (s?.citations ?? []).map((c) => [c.title, c.start, c.end, c.firstLine]),
    };
  });
  const ta = (performance.now() - t0) / QS.length;
  tick();
  const h = (x) => createHash("sha256").update(JSON.stringify(x)).digest("hex").slice(0, 12);
  const cs = h(claims.map((c) => [c.field, c.value, c.status, c.title, c.start, c.end, c.firstLine, c.lastLine, c.quote]));
  const as = h(outs);
  if ((claimSig && claimSig !== cs) || (answerSig && answerSig !== as))
    throw Error("nondeterministic output");
  claimSig = cs;
  answerSig = as;
  if (it >= WARM) {
    t.import.push(ti);
    t.extract.push(te);
    t.answer.push(ta);
  }
}
const f = (a) => `p50 ${pct(a, 0.5).toFixed(1)} / p95 ${pct(a, 0.95).toFixed(1)}`;
console.log("RAW " + JSON.stringify({ root, ...t, peak, claimSig, answerSig }));
console.log(
  [
    root.padEnd(14),
    `bytes ${docs.reduce((n, d) => n + d.text.length, 0)}`,
    `import ${f(t.import)}`,
    `extract ${f(t.extract)}`,
    `answer/q ${f(t.answer)}`,
    `peakRSS ${(peak / 1048576).toFixed(0)}MB`,
    `claims#${claimSig}`,
    `answers#${answerSig}`,
  ].join(" | "),
);
