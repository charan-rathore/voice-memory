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
import { clinicalTurn } from "./answer.mjs";

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
  assert.match(said, /flag doesn't match its own reference range/);
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
    if (c.reason === "unit") assert.match(t.spoken, /don't convert units/);
    if (c.latestRaw) {
      assert.equal(t.used[0].raw, c.latestRaw, "amended value used");
      assert.ok(
        t.used.some((o) => o.raw === c.supersededRaw),
        "superseded value still cited",
      );
      assert.match(
        t.spoken,
        new RegExp(`amended from ${c.supersededRaw} to ${c.latestRaw}`),
      );
    }
    if (expected === "COMPARED")
      assert.match(t.spoken, /question for your clinician\.$/);
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
    /^Hemoglobin for Test Person A went from 12\.1 g\/dL on 3 September 2026 to 12\.9 g\/dL on 12 October 2026: the later result is higher\./,
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
