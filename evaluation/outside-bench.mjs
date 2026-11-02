// Outside-authored retrieval benchmark: real, messy records written by people
// who never saw this engine, with questions written by other people again.
//
//   QMSum test split (Zhong et al., NAACL 2021): 35 real meeting transcripts
//     (AMI/ICSI product and research meetings, Welsh Parliament committees),
//     speech with disfluencies and overlaps. Queries were written by
//     annotators; each names the transcript turns that answer it. Kept: the
//     specific queries whose answer covers at most 15% of the meeting, so a
//     hit means finding the place, not landing anywhere in a big span.
//   CUAD v1 test split (Hendrycks et al., NeurIPS 2021): real commercial
//     contracts from SEC EDGAR. Lawyers marked the clause for each question
//     type, or marked it absent. The question asked is the category's own
//     plain-English description ("Which state/country's law governs the
//     interpretation of the contract?"), a paraphrase of the clause by
//     construction. Absent clauses are the unanswerable set.
//
// What runs: the sentence-unit retriever behind paraphrase discovery
// (src/paraphrase.mjs): keyword only (BM25 with lay-term expansion), and,
// when the dense model is resident (CI bench workflow), dense + BM25 fused
// with RRF and the calibrated gate that decides whether a closest line is
// shown at all. Nothing is tuned here: GATE comes from the Northstar
// development split. Each record is its own bundle, so ranking is within
// one meeting or one contract, as when a person uploads one file.
//
//   evaluation/outside/fetch.sh            # once, into .cache/outside
//   node evaluation/outside-bench.mjs      # keyword (local)
//   VM_DENSE_CACHE=.cache/models VM_MEMORY_LIMIT_MB=4096 node evaluation/outside-bench.mjs
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
import {
  unitsOf,
  warmUnits,
  rankUnits,
  rankUnitsLexical,
  gate,
  GATE,
  discoveryGate,
  DISCOVERY,
  QUERY_PREFIX,
} from "../src/paraphrase.mjs";
import { warmDense, embedTextsReady, DENSE_MODEL_ID } from "../src/dense.mjs";

const DATA = process.env.VM_OUTSIDE_DATA || ".cache/outside";
const LIMIT = {
  meetings: Number(process.env.VM_OUTSIDE_MEETINGS || 35),
  contracts: Number(process.env.VM_OUTSIDE_CONTRACTS || 30),
};
// 14 clause types a buyer or lawyer asks about first; fixed before any run.
const CUAD_TYPES = [
  "Governing Law",
  "Expiration Date",
  "Renewal Term",
  "Notice Period To Terminate Renewal",
  "Termination For Convenience",
  "Non-Compete",
  "Exclusivity",
  "Cap On Liability",
  "Insurance",
  "Audit Rights",
  "Anti-Assignment",
  "Minimum Commitment",
  "Warranty Duration",
  "Effective Date",
];
if (!existsSync(`${DATA}/QMSum`) || !existsSync(`${DATA}/cuad-data`)) {
  console.error(`no outside data in ${DATA}: run evaluation/outside/fetch.sh`);
  process.exit(2);
}
const sha = (d) => {
  try {
    return execSync(`git -C ${d} rev-parse --short HEAD`).toString().trim();
  } catch {
    return null;
  }
};
const bundleOf = (title, text) => ({
  sources: [{ id: title, title, text, hash: title }],
});

// ------------------------------------------------------------ datasets
function qmsum() {
  const out = [];
  const lines = readFileSync(`${DATA}/QMSum/data/ALL/jsonl/test.jsonl`, "utf8")
    .split("\n")
    .filter(Boolean)
    .slice(0, LIMIT.meetings);
  lines.forEach((l, m) => {
    const d = JSON.parse(l);
    // one line per turn: "Speaker: what they said"; remember where each starts
    let text = `# Meeting ${m + 1}\n`;
    const turnAt = [];
    for (const t of d.meeting_transcripts) {
      turnAt.push(text.length);
      text += `${t.speaker}: ${t.content.replace(/\s+/g, " ").trim()}\n`;
    }
    turnAt.push(text.length);
    const bundle = bundleOf(`meeting-${m + 1}`, text);
    const T = d.meeting_transcripts.length;
    for (const q of d.specific_query_list) {
      const spans = q.relevant_text_span.map(([a, b]) => [
        turnAt[+a],
        turnAt[Math.min(+b + 1, T)],
      ]);
      const covered = q.relevant_text_span.reduce(
        (n, [a, b]) => n + (+b - +a + 1),
        0,
      );
      if (covered / T > 0.15) continue;
      out.push({ set: "qmsum", bundle, q: q.query, spans, answerable: true });
    }
  });
  return out;
}

function cuad() {
  const out = [];
  const d = JSON.parse(readFileSync(`${DATA}/cuad-data/test.json`, "utf8"));
  const docs = [...d.data]
    .sort((a, b) => a.title.localeCompare(b.title))
    .slice(0, LIMIT.contracts);
  for (const doc of docs) {
    const p = doc.paragraphs[0];
    const bundle = bundleOf(doc.title, p.context);
    for (const qa of p.qas) {
      const type = qa.id.split("__").pop();
      if (!CUAD_TYPES.includes(type)) continue;
      const q = qa.question.split("Details:")[1]?.trim();
      if (!q) continue;
      const spans = qa.answers.map((a) => [
        a.answer_start,
        a.answer_start + a.text.length,
      ]);
      out.push({
        set: "cuad",
        type,
        bundle,
        q,
        spans,
        answerable: spans.length > 0,
      });
    }
  }
  return out;
}

// ------------------------------------------------------------ scoring
const overlaps = (u, spans) =>
  spans.some(([a, b]) => u.sent.start < b && u.sent.end > a);
function score(rank, it) {
  const k = rank.findIndex((r) => overlaps(r.unit, it.spans));
  return {
    hit1: k === 0,
    hit3: k >= 0 && k < 3,
    rr10: k >= 0 && k < 10 ? 1 / (k + 1) : 0,
  };
}
// chance of a random unit being inside the answer (the floor to beat)
const chance = (it) => {
  const u = unitsOf(it.bundle).units;
  return u.filter((x) => overlaps(x, it.spans)).length / (u.length || 1);
};

const items = [...qmsum(), ...cuad()];
const bundles = [...new Set(items.map((i) => i.bundle))];
let dense = false;
if (process.env.VM_DENSE !== "off") {
  await warmDense([]).catch(() => null);
  const probe = await embedTextsReady(["probe"]).catch(() => null);
  dense = !!probe;
}
if (dense) for (const b of bundles) await warmUnits(b);

const rows = [];
for (const it of items) {
  const lex = rankUnitsLexical(it.q, it.bundle);
  const row = {
    set: it.set,
    type: it.type ?? null,
    q: it.q,
    answerable: it.answerable,
    units: unitsOf(it.bundle).units.length,
    chance: it.answerable ? +chance(it).toFixed(4) : null,
    keyword: it.answerable ? score(lex, it) : null,
    keywordTopScore: +(lex[0]?.lexical ?? 0).toFixed(3),
  };
  if (dense) {
    const [qv] = (await embedTextsReady([QUERY_PREFIX + it.q])) ?? [];
    const hyb = rankUnits(it.q, it.bundle, qv);
    const den = [...hyb].sort((a, b) => b.cosine - a.cosine);
    const g = gate(hyb, GATE);
    row.hybrid = it.answerable ? score(hyb, it) : null;
    row.dense = it.answerable ? score(den, it) : null;
    // features of the top hybrid unit, for the discovery-gate sweep
    const top = hyb[0];
    const rival = hyb.slice(1).reduce((m, r) => Math.max(m, r.cosine), -1);
    row.top = {
      cosine: +top.cosine.toFixed(4),
      margin: +(top.cosine - rival).toFixed(4),
      lexRank:
        top.lexical > 0
          ? 1 + hyb.filter((r) => r.lexical > top.lexical).length
          : null,
      right: it.answerable ? overlaps(top.unit, it.spans) : false,
    };
    const d = discoveryGate(hyb, DISCOVERY);
    row.discovery = d
      ? {
          shown: true,
          right: it.answerable ? overlaps(d.unit, it.spans) : false,
        }
      : { shown: false };
    row.gate = g
      ? {
          shown: true,
          right: it.answerable ? overlaps(g.unit, it.spans) : false,
          cosine: +g.cosine.toFixed(3),
          margin: +g.margin.toFixed(3),
        }
      : { shown: false };
  }
  rows.push(row);
}

// ------------------------------------------------------------ summary
const mean = (xs) =>
  xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
const pct = (x) => +(100 * x).toFixed(1);
function summarize(rs) {
  const A = rs.filter((r) => r.answerable);
  const U = rs.filter((r) => !r.answerable);
  const m = (k, f) => pct(mean(A.map((r) => (r[k]?.[f] ? 1 : 0))));
  const s = {
    questions: rs.length,
    answerable: A.length,
    unanswerable: U.length,
    chanceTop1: pct(mean(A.map((r) => r.chance))),
    keyword: {
      top1: m("keyword", "hit1"),
      top3: m("keyword", "hit3"),
      mrr10: +mean(A.map((r) => r.keyword.rr10)).toFixed(3),
    },
  };
  if (rs[0]?.hybrid !== undefined) {
    s.hybrid = {
      top1: m("hybrid", "hit1"),
      top3: m("hybrid", "hit3"),
      mrr10: +mean(A.map((r) => r.hybrid.rr10)).toFixed(3),
    };
    s.denseOnly = { top1: m("dense", "hit1"), top3: m("dense", "hit3") };
    const shownA = A.filter((r) => r.gate.shown);
    s.gate = {
      shownOnAnswerable: pct(shownA.length / (A.length || 1)),
      rightWhenShown: pct(
        shownA.filter((r) => r.gate.right).length / (shownA.length || 1),
      ),
      shownOnUnanswerable: U.length
        ? pct(U.filter((r) => r.gate.shown).length / U.length)
        : null,
    };
    const shownD = A.filter((r) => r.discovery.shown);
    s.discovery = {
      shownOnAnswerable: pct(shownD.length / (A.length || 1)),
      rightWhenShown: pct(
        shownD.filter((r) => r.discovery.right).length / (shownD.length || 1),
      ),
      shownOnUnanswerable: U.length
        ? pct(U.filter((r) => r.discovery.shown).length / U.length)
        : null,
    };
  }
  return s;
}

// Discovery-gate calibration: choose on the development half (even rows of
// each set), report on the held-out half (odd rows). Most lines shown with
// >= 90% right and <= 10% shown when the answer is absent.
function evalRule(rs, rule) {
  const pass = (r) =>
    r.top.cosine >= rule.minCosine &&
    r.top.margin >= rule.minMargin &&
    (rule.lexTop == null ||
      (r.top.lexRank != null && r.top.lexRank <= rule.lexTop));
  const A = rs.filter((r) => r.answerable);
  const U = rs.filter((r) => !r.answerable);
  const shown = A.filter(pass);
  return {
    shown: shown.length,
    answerable: A.length,
    right: shown.filter((r) => r.top.right).length,
    absentShown: U.filter(pass).length,
    absent: U.length,
  };
}
function calibrate(rows) {
  const dev = [],
    held = [];
  for (const set of ["qmsum", "cuad"])
    rows
      .filter((r) => r.set === set)
      .forEach((r, i) => (i % 2 ? held : dev).push(r));
  let best = null;
  for (let c = 0.5; c <= 0.92; c += 0.01)
    for (let m = 0; m <= 0.1001; m += 0.005)
      for (const lexTop of [1, 3, null]) {
        const rule = {
          minCosine: +c.toFixed(2),
          minMargin: +m.toFixed(3),
          lexTop,
        };
        const e = evalRule(dev, rule);
        const prec = e.shown ? e.right / e.shown : 0;
        const absent = e.absent ? e.absentShown / e.absent : 0;
        if (e.shown < 5 || prec < 0.9 || absent > 0.1) continue;
        if (!best || e.shown > best.dev.shown) best = { rule, dev: e };
      }
  if (!best)
    return {
      rule: null,
      note: "no rule reaches 90% right with <= 10% absent shown on dev",
    };
  return { ...best, held: evalRule(held, best.rule) };
}
const summary = {
  qmsum: summarize(rows.filter((r) => r.set === "qmsum")),
  cuad: summarize(rows.filter((r) => r.set === "cuad")),
};
const calibration = dense ? calibrate(rows) : null;
const out = {
  calibration,
  discovery: DISCOVERY,
  date: new Date().toISOString().slice(0, 10),
  sha: sha("."),
  data: { qmsum: sha(`${DATA}/QMSum`), cuad: sha(`${DATA}/cuad`) },
  model: dense ? DENSE_MODEL_ID : null,
  gate: GATE,
  summary,
  rows,
};
mkdirSync(new URL("./results/", import.meta.url), { recursive: true });
writeFileSync(
  new URL(
    `./results/outside-${dense ? "dense" : "keyword"}.json`,
    import.meta.url,
  ),
  JSON.stringify(out, null, 1),
);
const line = (name, s) =>
  `| ${name} | ${s.answerable} / ${s.unanswerable} | ${s.chanceTop1}% | ${s.keyword.top1}% / ${s.keyword.top3}% | ${s.hybrid ? `${s.hybrid.top1}% / ${s.hybrid.top3}%` : "-"} | ${s.denseOnly ? `${s.denseOnly.top1}% / ${s.denseOnly.top3}%` : "-"} | ${s.gate ? `${s.gate.shownOnAnswerable}% shown, ${s.gate.rightWhenShown}% right` : "-"} | ${s.gate?.shownOnUnanswerable ?? "-"}${s.gate?.shownOnUnanswerable != null ? "%" : ""} |`;
console.log(
  `### Outside-authored retrieval bench (${out.sha}, ${dense ? DENSE_MODEL_ID : "keyword only: dense model not resident"})\n`,
);
console.log(
  "| Set | answerable / not | chance top-1 | keyword top-1 / top-3 | hybrid top-1 / top-3 | dense top-1 / top-3 | closest-line gate (answerable) | shown when absent |",
);
console.log("| --- | --- | --- | --- | --- | --- | --- | --- |");
console.log(line("QMSum meetings", summary.qmsum));
console.log(line("CUAD contracts", summary.cuad));
if (dense) {
  const d = (n, s) =>
    `| ${n} | ${s.discovery.shownOnAnswerable}% shown, ${s.discovery.rightWhenShown}% right | ${s.discovery.shownOnUnanswerable ?? "-"}${s.discovery.shownOnUnanswerable != null ? "%" : ""} |`;
  console.log(`\n**Shipped discovery gate** ${JSON.stringify(DISCOVERY)}\n`);
  console.log("| Set | answerable | shown when absent |\n| --- | --- | --- |");
  console.log(d("QMSum", summary.qmsum));
  console.log(d("CUAD", summary.cuad));
  const c = calibration;
  const fmt = (e) =>
    `${e.shown}/${e.answerable} shown, ${e.shown ? ((100 * e.right) / e.shown).toFixed(1) : 0}% right, absent shown ${e.absentShown}/${e.absent}`;
  console.log(
    c.rule
      ? `\n**Calibrated on dev** ${JSON.stringify(c.rule)}: dev ${fmt(c.dev)}; held-out ${fmt(c.held)}`
      : `\n**Calibration:** ${c.note}`,
  );
}
process.exit(0);
