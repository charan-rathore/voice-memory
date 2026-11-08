// Natural ways people ask about a whole set of lab reports, in English,
// Hindi and Hinglish. Each must reach a bounded, cited summary - never a
// lookup of a "test" named after the qualifier ("abnormal"), never the
// generic help reply, and never one person's results under another's name.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ingestFile } from "../ingest/index.mjs";
import { extractReport } from "./observations.mjs";
import { clinicalAnswer, changesFor, subjectsFor } from "./answer.mjs";
import { socialTurn } from "../src/conversation.mjs";

const cache = new Map();
async function report(file) {
  if (!cache.has(file)) {
    const r = await ingestFile(
      readFileSync(new URL("./fixtures/files/" + file, import.meta.url)),
      file,
    );
    assert.equal(r.ok, true, `${file}: ${r.message}`);
    cache.set(file, { title: file, sourceId: file, ...extractReport(r.doc) });
  }
  return cache.get(file);
}
const all = () =>
  Promise.all(
    [
      "a-2026-09.pdf",
      "a-2026-10-prelim.pdf",
      "a-2026-10-amended.pdf",
      "c-2026-10.pdf",
    ].map(report),
  );
const one = () =>
  Promise.all(
    ["a-2026-09.pdf", "a-2026-10-prelim.pdf", "a-2026-10-amended.pdf"].map(
      report,
    ),
  );

// Out of the lab's printed range in SYN-0001's amended October report.
const FLAGGED = [/Hemoglobin 12\.9/, /HbA1c 6\.1/, /TSH 0\.30/];

const SUMMARY_ASKS = [
  ["en", "What are the abnormal results?"],
  ["en", "Is anything abnormal?"],
  ["en", "What is outside the printed range?"],
  ["en", "Which results are high or low?"],
  ["en", "Are any of my values out of range?"],
  ["hinglish", "kya kuch abnormal hai?"],
  ["hinglish", "kaunse results range se bahar hain?"],
  ["hi", "कौन से रिज़ल्ट रेंज से बाहर हैं?"],
  ["hi", "क्या कुछ असामान्य है?"],
];

for (const [lang, q] of SUMMARY_ASKS)
  test(`summary (${lang}): "${q}" lists what is outside the printed range, cited`, async () => {
    const a = clinicalAnswer(q, await one());
    assert.ok(a, "answered");
    assert.equal(a.verdict, "FLAGGED");
    assert.equal(a.lang, lang);
    for (const re of FLAGGED) assert.match(a.spoken, re);
    // every listed value is a cited observation from the reports
    const usedTests = a.used.map((o) => o.test);
    for (const t of ["Hemoglobin", "HbA1c", "TSH"])
      assert.ok(usedTests.includes(t), `${t} cited`);
    // no diagnosis vocabulary
    assert.doesNotMatch(
      a.spoken,
      /\b(anemi|anaemi|diabet|hyperthyroid|hypothyroid|disease|you have)\b/i,
    );
  });

test('"the abnormal results" is never read as a test named "abnormal"', async () => {
  for (const q of [
    "What are the abnormal results?",
    "show me the high values",
    "what are my flagged results",
    "what are the out of range values",
  ]) {
    const a = clinicalAnswer(q, await one());
    assert.notEqual(a?.verdict, "CLARIFY", q);
    assert.doesNotMatch(a?.spoken ?? "", /couldn't find a ".*" test/, q);
  }
  // a real unknown test name still gets the honest clarification
  const unknown = clinicalAnswer("what is my heritage level", await one());
  assert.equal(unknown?.verdict, "CLARIFY");
});

test("two people, no name: each summarised separately, nothing mixed", async () => {
  const a = clinicalAnswer("Is anything abnormal?", await all());
  assert.equal(a.verdict, "FLAGGED");
  assert.deepEqual(a.subjects, ["SYN-0001", "SYN-0003"]);
  assert.match(a.spoken, /for 2 people, so I keep their results apart/);
  const [first, second] = a.spoken.split(/In SYN-0003's report/);
  assert.ok(second, "SYN-0003 has its own part");
  for (const re of FLAGGED) assert.match(first, re);
  // SYN-0001's out-of-range values never appear in SYN-0003's part
  for (const re of FLAGGED) assert.doesNotMatch(second, re);
  // a neutral question does not ask "which is you"
  assert.doesNotMatch(a.spoken, /which of these is you/);
  // every cited row belongs to the person it is spoken under
  const pids = new Set(a.used.map((o) => o.report?.meta?.patient?.id ?? null));
  assert.ok(!pids.has("SYN-9999"));
});

test("which values changed: a correction is a fix to the report, not the body", async () => {
  for (const [q, lang] of [
    ["Which values changed?", "en"],
    ["kya badla hai?", "hinglish"],
    ["क्या बदला है?", "hi"],
  ]) {
    const a = clinicalAnswer(q, await one());
    assert.equal(a?.verdict, "OVERVIEW", q);
    assert.equal(a.lang, lang, q);
    assert.match(a.spoken, /Ferritin/);
    assert.match(a.spoken, /5/);
    assert.match(a.spoken, /50/);
    assert.match(
      a.spoken,
      {
        en: /a fix to the report, not a change in the body/,
        hinglish: /report ka sudhaar hai, body mein badlav nahi/,
        hi: /रिपोर्ट का सुधार है, शरीर में बदलाव नहीं/,
      }[lang],
    );
    // the unit change is a refusal to compare, never a direction
    assert.match(a.spoken, /Creatinine/);
    assert.doesNotMatch(a.spoken, /Creatinine (went|badha|ghata|बढ़ा|घटा)/);
  }
});

test("changesFor is the single source of the change summary", async () => {
  const reps = await one();
  const ch = changesFor("SYN-0001", reps);
  assert.deepEqual(
    ch.corrected.map((x) => [x.test, x.from, x.to]),
    [["Ferritin", "5", "50"]],
  );
  assert.deepEqual(
    ch.notComparable.map((x) => x.test),
    ["Creatinine"],
  );
  assert.ok(!ch.up.includes("Creatinine") && !ch.down.includes("Creatinine"));
});

test("what should I ask my doctor: questions from cited lines, no advice", async () => {
  for (const [q, lang] of [
    ["What should I ask my doctor?", "en"],
    ["doctor se kya poochun?", "hinglish"],
    ["डॉक्टर से क्या पूछूं?", "hi"],
  ]) {
    // the help reply must not swallow it
    assert.equal(socialTurn(q, { lang: lang === "en" ? "en" : "hi" }), null, q);
    const a = clinicalAnswer(q, await one());
    assert.equal(a?.intent, "ASK_DOCTOR", q);
    assert.equal(a.lang, lang, q);
    assert.match(a.spoken, /1\) /);
    assert.match(a.spoken, /Ferritin/); // the correction
    assert.match(a.spoken, /TSH 0\.30/); // an out-of-range value
    assert.match(a.spoken, /Creatinine/); // the unit change
    assert.ok(a.used.length >= 3, "each question rests on a cited row");
    assert.doesNotMatch(
      a.spoken,
      /\b(you should take|take (iron|supplement)|stop taking|diagnos(is|ed) with|you have)\b/i,
    );
    assert.match(
      a.spoken,
      { en: /not a diagnosis/, hinglish: /diagnosis nahi/, hi: /निदान नहीं/ }[
        lang
      ],
    );
  }
  // several people: one disclaimer, each person labelled
  const g = clinicalAnswer("What should I ask my doctor?", await all());
  assert.equal(g.spoken.match(/not a diagnosis/g).length, 1);
  assert.match(g.spoken, /about SYN-0001's report/);
  assert.match(g.spoken, /For SYN-0003, nothing here is outside/);
});

test("ordinary help questions still get the help reply", () => {
  for (const q of ["what can I ask?", "how can you help", "what should I ask"])
    assert.equal(socialTurn(q, { lang: "en" })?.intent, "HELP", q);
});

// Asking about someone else's report must not put the caller in the
// questions: third-person references with no first-person possessive get
// "for them", not "for me".
test("doctor questions for someone else's report speak about them, not me", async () => {
  const a = clinicalAnswer(
    "What should I ask the doctor about her report?",
    await one(),
  );
  assert.equal(a?.intent, "ASK_DOCTOR");
  assert.match(a.spoken, /for them\?/);
  assert.doesNotMatch(a.spoken, /for me\?/);
  const b = clinicalAnswer("What should I ask my doctor?", await one());
  assert.match(b.spoken, /for me\?/);
});

// "my mother's and my results" names both a relative and the caller: no
// single pronoun is right, so the suggested questions stay neutral -
// never "for me" (drops the mother) and never "for them" (drops the caller).
test("mixed caller + kinship doctor questions stay pronoun-neutral", async () => {
  const a = clinicalAnswer(
    "What should I ask the doctor about my mother's and my results?",
    await one(),
  );
  assert.equal(a?.intent, "ASK_DOCTOR");
  assert.match(a.spoken, /what does that mean\?/);
  assert.doesNotMatch(a.spoken, /for (me|them)\?/);
  assert.match(a.spoken, /not a diagnosis/);
  // pure third-person and pure first-person phrasing is unchanged
  const b = clinicalAnswer(
    "What should I ask the doctor about her report?",
    await one(),
  );
  assert.match(b.spoken, /for them\?/);
  const c = clinicalAnswer("What should I ask my doctor?", await one());
  assert.match(c.spoken, /for me\?/);
});

// Multi-patient questions narrow ONLY on explicit, validated context.
// Record counts never break a same-name tie ("what is my HbA1c?" with two
// Maya Sharmas stays ambiguous and asks which person); a kinship reference
// ("my mother's HbA1c") names someone counts know nothing about; a selected
// patient id the caller passed (API/UI) is honored only when it is an
// actual subject - an unknown or stale id selects nothing.
test("explicit context, not counts, resolves a same-name tie", () => {
  const rep = (id, n) => ({
    sourceId: `${id}-${n}`,
    title: `${id}-${n}.pdf`,
    meta: { patient: { id, name: "Maya Sharma" } },
    observations: [],
  });
  const reports = [
    rep("HLG-P1047", 1),
    rep("HLG-P1047", 2),
    rep("HLG-P1047", 3),
    rep("HLG-P1048", 1),
  ];
  const both = ["HLG-P1047", "HLG-P1048"];
  // no context: counts do not decide, every candidate stays in
  assert.deepEqual(subjectsFor("what is my hba1c?", reports).sort(), both);
  assert.deepEqual(subjectsFor("my mother's hba1c?", reports).sort(), both);
  assert.deepEqual(subjectsFor("mere papa ka sugar?", reports).sort(), both);
  // an explicit id in the question always wins
  assert.deepEqual(subjectsFor("what is HLG-P1048's hba1c?", reports), [
    "HLG-P1048",
  ]);
  // validated explicit context (a selected patient id) wins
  assert.deepEqual(
    subjectsFor("what is my hba1c?", reports, reports, "HLG-P1048"),
    ["HLG-P1048"],
  );
  // mismatched context (not a subject here) selects nothing
  assert.deepEqual(
    subjectsFor("what is my hba1c?", reports, reports, "HLG-P9999").sort(),
    both,
  );
});

test("Hindi and Hinglish mother spelling variants never speak as the caller", async () => {
  for (const [q, yes, no] of [
    [
      "मेरी मां की रिपोर्ट के बारे में डॉक्टर से क्या पूछूं?",
      /उनके/,
      /मेरे लिए/,
    ],
    [
      "मेरी माँ की रिपोर्ट के बारे में डॉक्टर से क्या पूछूं?",
      /उनके/,
      /मेरे लिए/,
    ],
    ["meri maa ki report doctor se kya poochun?", /unke/, /mere liye/],
    [
      "What should I ask the doctor about my grandmother's report?",
      /for them/,
      /for me/,
    ],
  ]) {
    const a = clinicalAnswer(q, await one());
    assert.equal(a?.intent, "ASK_DOCTOR", q);
    assert.match(a.spoken, yes);
    assert.doesNotMatch(a.spoken, no);
  }
});

test("mixed caller-relative named-measurement doctor prompts stay neutral", async () => {
  for (const q of [
    "What should I ask the doctor about my mother's and my HbA1c results?",
    "What should I ask the doctor about my mother's HbA1c and mine?",
    "meri maa aur mera sugar result doctor se kya poochun?",
    "मेरी माँ और मेरी HbA1c रिपोर्ट डॉक्टर से क्या पूछूं?",
  ]) {
    const a = clinicalAnswer(q, await one());
    assert.equal(a?.intent, "ASK_DOCTOR", q);
    assert.doesNotMatch(
      a.spoken,
      /for (me|them)\?|उनके लिए|मेरे लिए|unke liye|mere liye/,
      q,
    );
  }
});
