// Clinical prototype tests: extraction against hand-written gold, the
// numeric-safety traps from the plan, and the longitudinal comparisons.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ingestFile } from "../ingest/index.mjs";
import {
  extractReport,
  parseValue,
  compare,
  seriesFor,
} from "./observations.mjs";
import { clinicalTurn, clinicalAnswer } from "./answer.mjs";

const gold = JSON.parse(
  readFileSync(new URL("./fixtures/gold.json", import.meta.url), "utf8"),
);
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

for (const [file, g] of Object.entries(gold.reports)) {
  test(`extraction matches gold: ${file}`, async () => {
    const r = await report(file);
    assert.equal(r.meta.patient?.id, g.patientId);
    assert.equal(r.meta.collected, g.collected);
    assert.equal(r.meta.reported, g.reported);
    assert.equal(r.meta.status, g.status);
    for (const e of g.observations) {
      const o = r.observations.find((x) => x.test === e.test);
      assert.ok(o, `${e.test} extracted`);
      assert.equal(o.raw, e.raw, `${e.test} raw`);
      assert.equal(o.comparator, e.comparator, `${e.test} comparator`);
      assert.equal(o.value, e.value, `${e.test} value`);
      assert.equal(o.unit, e.unit, `${e.test} unit`);
      assert.equal(o.range, e.range, `${e.test} range`);
      assert.equal(o.flag, e.flag, `${e.test} flag`);
      assert.ok(
        o.source.page === 1 && o.source.bbox?.length === 4,
        "source row located on the page",
      );
    }
  });
}

test("numeric traps: 1.2 vs 12, 0.05 vs 0.5, <5 vs 5, decimal comma, thousands", () => {
  assert.deepEqual(parseValue("1.2"), {
    comparator: null,
    value: 1.2,
    notation: "decimal-point",
  });
  assert.equal(parseValue("12").value, 12);
  assert.notEqual(parseValue("0.05").value, parseValue("0.5").value);
  assert.deepEqual(
    [parseValue("<5").comparator, parseValue("<5").value],
    ["<", 5],
  );
  assert.equal(parseValue("5").comparator, null);
  assert.deepEqual(
    [parseValue("4,1").value, parseValue("4,1").notation],
    [4.1, "decimal-comma"],
  );
  assert.deepEqual(
    [parseValue("1,200").value, parseValue("1,200").notation],
    [1200, "thousands-comma"],
  );
  assert.equal(parseValue("Positive").value, null);
  assert.equal(parseValue("≥ 90").comparator, ">=");
});

test("a bound never becomes a value, and direction is only claimed when certain", () => {
  const o = (raw, unit = "mIU/L") => ({
    key: "tsh",
    raw,
    unit,
    range: "0.40-4.00",
    ...parseValue(raw),
  });
  assert.equal(compare(o("<0.05"), o("0.30")).direction, "higher");
  assert.equal(compare(o("0.30"), o("<0.05")).direction, "lower");
  assert.equal(compare(o("<0.05"), o("<0.10")).direction, "undetermined");
  assert.equal(compare(o("0.30"), o("0.30")).direction, "same");
  assert.deepEqual(compare(o("1.2", "mg/dL"), o("106", "µmol/L")), {
    comparable: false,
    reason: "unit",
  });
  assert.deepEqual(compare(o("1.2", null), o("1.3", "mg/dL")), {
    comparable: false,
    reason: "missing_unit",
  });
  assert.equal(
    compare(o("1.2", "mg/dL"), o("1.3", "MG/DL")).comparable,
    true,
    "unit case is not a different unit",
  );
});

test("a flag that contradicts its own printed range is flagged", async () => {
  const doc = {
    text: "Patient: Test Person D, ID SYN-0004\nCollected: 1 October 2026",
    elements: [
      { id: "t", type: "table" },
      {
        id: "h",
        parent: "t",
        type: "table-header",
        cells: ["Test", "Result", "Unit", "Reference range", "Flag"],
      },
      {
        id: "r1",
        parent: "t",
        type: "table-row",
        cells: ["Sodium", "140", "mmol/L", "135-145", "H"],
        start: 0,
        end: 1,
      },
      {
        id: "r2",
        parent: "t",
        type: "table-row",
        cells: ["Potassium", "5.6", "mmol/L", "3.5-5.1", "H"],
        start: 0,
        end: 1,
      },
    ],
  };
  const r = extractReport(doc);
  assert.equal(
    r.observations.find((o) => o.test === "Sodium").flagConflict,
    true,
  );
  assert.equal(
    r.observations.find((o) => o.test === "Potassium").flagConflict,
    false,
  );
  const said = clinicalTurn("What was the sodium result?", [
    { ...r, title: "d", sourceId: "d" },
  ]).spoken;
  assert.match(said, /flag doesn't match its own range/);
});

for (const c of gold.comparisons) {
  test(`comparison: ${c.test} -> ${c.outcome} (${c.files.join(", ")})`, async () => {
    const reports = await Promise.all(c.files.map(report));
    const verb =
      c.outcome === "single"
        ? "Did my HbA1c change?"
        : `Did the ${c.test} result change since the previous report?`;
    const t = clinicalTurn(verb, reports);
    assert.ok(t, "clinical answer produced");
    const expected = {
      compared: "COMPARED",
      not_comparable: "NOT_COMPARABLE",
      ambiguous_patient: "AMBIGUOUS_PATIENT",
      single: "SINGLE",
    }[c.outcome];
    assert.equal(t.verdict, expected, t.spoken);
    if (c.direction) assert.equal(t.direction, c.direction, t.spoken);
    if (c.reason === "unit")
      assert.match(t.spoken, /don't convert between units/);
    if (c.latestRaw) {
      assert.equal(t.used[0].raw, c.latestRaw, "amended value used");
      assert.ok(
        t.used.some((o) => o.raw === c.supersededRaw),
        "superseded value still cited",
      );
      assert.match(
        t.spoken,
        new RegExp(`corrected from ${c.supersededRaw} to ${c.latestRaw}`),
      );
    }
    if (expected === "COMPARED")
      assert.match(
        t.spoken,
        /Your doctor can read it alongside how you feel, your medicines and your other results\.$/,
      );
    assert.doesNotMatch(
      t.spoken,
      /\b(normal|healthy|nothing to worry|fine|good news|bad news|diagnos)/i,
      "no clinical judgement",
    );
  });
}

test("a patient named in the question resolves the ambiguity, never mixes patients", async () => {
  const reports = await Promise.all(
    ["a-2026-09.pdf", "a-2026-10-amended.pdf", "c-2026-10.pdf"].map(report),
  );
  const t = clinicalTurn("Did hemoglobin change for SYN-0001?", reports);
  assert.equal(t.verdict, "COMPARED");
  assert.ok(t.used.every((o) => o.report.meta.patient.id === "SYN-0001"));
  assert.match(
    t.spoken,
    /^Your Hemoglobin went from 12\.1 g\/dL on 3 September 2026 to 12\.9 g\/dL on 12 October 2026\. That's higher than before\./,
  );
});

test("a series uses one value per collection date", async () => {
  const reports = await Promise.all(
    ["a-2026-09.pdf", "a-2026-10-prelim.pdf", "a-2026-10-amended.pdf"].map(
      report,
    ),
  );
  const s = seriesFor(reports, "ferritin", "SYN-0001");
  assert.deepEqual(
    s.map((x) => [x.date, x.current.raw]),
    [
      ["2026-09-03", "0.5"],
      ["2026-10-12", "50"],
    ],
  );
});

test("questions about something that isn't a test are left to the document engine", async () => {
  const reports = [await report("a-2026-09.pdf")];
  assert.equal(clinicalTurn("Who prepared this report?", reports), null);
});

test("overview: one patient answers, several patients ask whose", async () => {
  const a09 = await report("a-2026-09.pdf");
  const a10 = await report("a-2026-10-amended.pdf");
  const c10 = await report("c-2026-10.pdf");
  // A genuine single-patient overview still answers.
  const solo = clinicalAnswer("how am i doing", [a09, a10]);
  assert.equal(solo?.verdict, "OVERVIEW");
  // A second patient in the set makes an unnamed overview a question back,
  // never a silent pick of the patient holding more reports.
  const multi = clinicalAnswer("how am i doing", [a09, a10, c10]);
  assert.equal(multi?.verdict, "AMBIGUOUS_PATIENT");
  assert.match(multi?.spoken, /more than one person/);
  // Naming the patient resolves it.
  const named = clinicalAnswer("what are SYN-0001's blood levels", [
    a09,
    a10,
    c10,
  ]);
  assert.equal(named?.verdict, "OVERVIEW");
});

// A question that anchors a report by date must be answered from THAT
// report, never silently with the latest value. The public demo's teaching
// case is exactly this: September printed creatinine in mg/dL, October
// changed the unit - so "what did September say" must say 1.2 mg/dL.
test("date-anchored question answers the anchored report, not the latest", async () => {
  const reports = await Promise.all(
    ["a-2026-09.pdf", "a-2026-10-prelim.pdf", "a-2026-10-amended.pdf"].map(
      report,
    ),
  );
  for (const q of [
    "What was the creatinine value and unit in the September report?",
    "In the 3 September 2026 report, what was the creatinine result?",
    "What was my creatinine in September 2026? SYN-0001",
  ]) {
    const t = clinicalTurn(q, reports);
    assert.ok(t, `answered: ${q}`);
    assert.equal(t.verdict, "VALUE", `${q} -> ${t.verdict}`);
    assert.equal(t.used[0].raw, "1.2", q);
    assert.equal(t.used[0].unit, "mg/dL", q);
    assert.equal(t.used[0].report.title, "a-2026-09.pdf", q);
    assert.match(t.spoken, /1\.2 mg\/dL/, q);
    assert.match(t.spoken, /3 September 2026/, q);
    assert.doesNotMatch(t.spoken, /106|µmol/, q);
  }
});

test("date-anchored question uses the anchored report's own unit and range", async () => {
  const reports = await Promise.all(
    ["a-2026-09.pdf", "a-2026-10-amended.pdf"].map(report),
  );
  const t = clinicalTurn("What was the ferritin result in September?", reports);
  assert.equal(t.verdict, "VALUE");
  assert.equal(t.used[0].raw, "0.5");
  assert.match(t.spoken, /0\.5 ng\/mL/);
  assert.match(t.spoken, /3 September 2026/);
  assert.doesNotMatch(
    t.spoken,
    /50 ng\/mL|corrected/,
    "no October correction leaks into a September answer",
  );
});

test("an October anchor uses the amended value, with the correction note", async () => {
  const reports = await Promise.all(
    ["a-2026-09.pdf", "a-2026-10-prelim.pdf", "a-2026-10-amended.pdf"].map(
      report,
    ),
  );
  const t = clinicalTurn("What was the ferritin result in October?", reports);
  assert.equal(t.verdict, "VALUE");
  assert.equal(t.used[0].raw, "50");
  assert.equal(t.used[0].report.title, "a-2026-10-amended.pdf");
  assert.match(t.spoken, /corrected from 5 to 50/);
});

test("no date anchor keeps the latest-value behaviour", async () => {
  const reports = await Promise.all(
    ["a-2026-09.pdf", "a-2026-10-amended.pdf"].map(report),
  );
  const t = clinicalTurn("What was my creatinine result? SYN-0001", reports);
  assert.equal(t.verdict, "LATEST");
  assert.equal(t.used[0].raw, "106");
});

test("an anchor no report matches is an honest miss, never the latest value", async () => {
  const reports = await Promise.all(
    ["a-2026-09.pdf", "a-2026-10-amended.pdf"].map(report),
  );
  const t = clinicalTurn(
    "What was the creatinine result in the August report?",
    reports,
  );
  assert.ok(t, "answered");
  assert.equal(t.verdict, "NOT_IN_REPORT");
  assert.doesNotMatch(t.spoken, /106|1\.2/);
});

test("a person named with a date anchor still isolates that person", async () => {
  const reports = await Promise.all(
    ["a-2026-09.pdf", "a-2026-10-amended.pdf", "c-2026-10.pdf"].map(report),
  );
  const t = clinicalTurn(
    "What was the creatinine in the September report for SYN-0001?",
    reports,
  );
  assert.equal(t.verdict, "VALUE");
  assert.ok(t.used.every((o) => o.report.meta.patient.id === "SYN-0001"));
  assert.equal(t.used[0].raw, "1.2");
});

test("a compare question mentioning a month still compares, anchors don't hijack it", async () => {
  const reports = await Promise.all(
    ["a-2026-09.pdf", "a-2026-10-amended.pdf"].map(report),
  );
  const t = clinicalTurn(
    "Did my creatinine change since the September report?",
    reports,
  );
  assert.equal(t.verdict, "NOT_COMPARABLE", t.spoken);
  assert.match(t.spoken, /don't convert between units/);
});

test("a month name inside an ordinary word is not an anchor", async () => {
  const reports = await Promise.all(
    ["a-2026-09.pdf", "a-2026-10-amended.pdf"].map(report),
  );
  for (const q of [
    "What was the creatinine value marked on my report?",
    "What was my creatinine result? Please remark on it.",
  ]) {
    const t = clinicalTurn(q, reports);
    assert.ok(t, `answered: ${q}`);
    assert.equal(t.verdict, "LATEST", `${q} -> ${t.verdict}`);
    assert.equal(t.used[0].raw, "106", q);
  }
});

test("Hindi month anchors resolve the same way, answered in Hindi", async () => {
  const reports = await Promise.all(
    ["a-2026-09.pdf", "a-2026-10-prelim.pdf", "a-2026-10-amended.pdf"].map(
      report,
    ),
  );
  const t = clinicalTurn(
    "सितंबर की रिपोर्ट में मेरा क्रिएटिनिन क्या था?",
    reports,
  );
  assert.ok(t, "answered");
  assert.equal(t.verdict, "VALUE");
  assert.equal(t.used[0].raw, "1.2");
  assert.equal(t.used[0].report.title, "a-2026-09.pdf");
  assert.match(t.spoken, /3 सितंबर 2026/);
  assert.doesNotMatch(t.spoken, /106/);
  const t2 = clinicalTurn("मेरा फेरिटिन सितंबर 2026 में क्या था?", reports);
  assert.equal(t2.verdict, "VALUE");
  assert.equal(t2.used[0].raw, "0.5");
});

// Month-day-year order ("September 3, 2026") is an explicit date anchor: it
// must resolve that exact report or be an honest miss - never silently
// degrade to a bare month. Multi-September fixture makes the distinctions
// observable: bare month lands on 2026-09-20, the explicit day on 2026-09-03.
function mkLabReport(title, collected, rows) {
  const doc = {
    text: `Patient: Test Person A (synthetic), ID SYN-0001\nCollected: ${collected}  Reported: ${collected}\nReport status: FINAL`,
    elements: [
      { id: "t", type: "table" },
      {
        id: "h",
        parent: "t",
        type: "table-header",
        cells: ["Test", "Result", "Unit", "Reference range", "Flag"],
      },
      ...rows.map((cells, i) => ({
        id: "r" + i,
        parent: "t",
        type: "table-row",
        cells,
        start: 0,
        end: 1,
      })),
    ],
  };
  return { title, sourceId: title, ...extractReport(doc) };
}
const MULTIYEAR = () => [
  mkLabReport("s2025.pdf", "5 September 2025", [
    ["Creatinine", "1.1", "mg/dL", "0.7-1.3", ""],
  ]),
  mkLabReport("s2026a.pdf", "3 September 2026", [
    ["Creatinine", "1.2", "mg/dL", "0.7-1.3", ""],
  ]),
  mkLabReport("s2026b.pdf", "20 September 2026", [
    ["Creatinine", "1.25", "mg/dL", "0.7-1.3", ""],
  ]),
  mkLabReport("o2026.pdf", "12 October 2026", [
    ["Creatinine", "106", "µmol/L", "62-115", ""],
  ]),
];

test("month-day-year anchors resolve the exact date, never degrade to bare month", () => {
  const reports = MULTIYEAR();
  const t = clinicalTurn(
    "What was the creatinine on September 3, 2026?",
    reports,
  );
  assert.ok(t, "answered");
  assert.equal(t.verdict, "VALUE");
  assert.equal(
    t.used[0].raw,
    "1.2",
    "the 3 September 2026 report, not the 20 September one",
  );
  assert.equal(t.used[0].report.title, "s2026a.pdf");
  assert.match(t.spoken, /3 September 2026/);
});

test("an explicit date with no matching report is an honest miss", () => {
  const reports = MULTIYEAR();
  const t = clinicalTurn(
    "What was the creatinine on September 9, 2026?",
    reports,
  );
  assert.ok(t, "answered");
  assert.equal(t.verdict, "NOT_IN_REPORT");
  assert.doesNotMatch(t.spoken, /1\.25|106/);
});

test("a month-year anchor picks that year's report", () => {
  const reports = MULTIYEAR();
  const t = clinicalTurn(
    "What was the creatinine in the September 2025 report?",
    reports,
  );
  assert.equal(t.verdict, "VALUE");
  assert.equal(t.used[0].raw, "1.1");
  assert.match(t.spoken, /5 September 2025/);
});

test("a bare month with several years names the most recent, and says which", () => {
  const reports = MULTIYEAR();
  const t = clinicalTurn("What was my creatinine in September?", reports);
  assert.equal(t.verdict, "VALUE");
  assert.equal(t.used[0].raw, "1.25");
  assert.match(
    t.spoken,
    /20 September 2026/,
    "the date is disclosed in the answer",
  );
});

test("a child's result is never judged against an adult band, even glued to numbers", async () => {
  // RED 2026-11-03: "11.5-15.5child;13-17adult" (no spaces, the printed
  // corpus format) let the adult 13-17 band judge a 7-year-old's 11.3 and
  // the answer said "clearly below this lab's range of 13 to 17".
  const r = await ingestFile(
    Buffer.from(
      [
        "Name: Test Child",
        "Patient ID: SYN-0007",
        "Age: 7 Yrs",
        "Collected: 20 October 2026",
        "Reported: 21 October 2026",
        "Report status: FINAL",
        "",
        "| Test | Result | Unit | Reference range | Flag |",
        "| --- | --- | --- | --- | --- |",
        "| Hemoglobin | 11.3 | g/dL | 11.5-15.5child;13-17adult | L |",
        "",
        "Values flagged L or H are outside the laboratory's reference range.",
        "",
      ].join("\n"),
    ),
    "child-2026-10.txt",
  );
  assert.equal(r.ok, true, r.message);
  const rep = {
    title: "child-2026-10.txt",
    sourceId: "child-2026-10.txt",
    ...extractReport(r.doc),
  };
  assert.equal(rep.meta.patient?.age, 7, "child age parsed");
  const t = clinicalTurn("What is the hemoglobin result?", [rep]);
  assert.ok(t, "clinical answer produced");
  assert.doesNotMatch(
    t.spoken,
    /13 to 17|13\.0-17|below this lab's range of 13/,
    "adult band numbers never reach the spoken answer",
  );
  assert.match(
    t.spoken,
    /adult ranges?|haven't judged|not judged/i,
    "the child/adult-range caveat is spoken",
  );
});

test("anonymous reports are never attributed to the caller (graph audit #1)", async () => {
  const reports = await Promise.all(
    ["a-2026-09.pdf", "c-2026-10.pdf"].map(report),
  );
  const anon = reports.map((r) => {
    const c = { ...r, meta: { ...r.meta } };
    delete c.meta.patient;
    return c;
  });
  const t = clinicalTurn("What is the latest creatinine?", anon);
  assert.equal(t.verdict, "NOT_COMPARABLE", t.spoken);
  assert.match(t.spoken, /can't tell whose/i);
  // a single anonymous document on its own still answers from itself
  const solo = clinicalTurn("What is the latest creatinine?", [anon[0]]);
  assert.equal(solo.verdict, "LATEST", solo.spoken);
});
