import test from "node:test";
import assert from "node:assert/strict";
import { bindEvidenceToRecords } from "../src/library.mjs";
const text =
  "Patient A PRELIMINARY value 5.4 ".padEnd(100, " ") +
  "Patient B AMENDED value 6.9 ".padEnd(100, " ");
const reports = [
  {
    sourceId: "s1",
    title: "p1",
    span: { start: 0, end: 100 },
    meta: { patient: { id: "A", name: "Maya" } },
  },
  {
    sourceId: "s1",
    title: "p2",
    span: { start: 100, end: 200 },
    meta: { patient: { id: "B", name: "Maya" } },
  },
];
const ev = {
  sourceId: "s1",
  start: 0,
  end: 200,
  quote: text,
  location: { pages: [1, 2] },
};
const bind = (used = [], rs = reports, e = ev) =>
  bindEvidenceToRecords([e], "Maya sugar average", rs, used);
test("multiple citations preserve both records regardless of citation order", () => {
  const cs = [
    { sourceId: "s1", start: 25, end: 28 },
    { sourceId: "s1", start: 122, end: 125 },
  ];
  for (const used of [cs, [...cs].reverse()]) {
    const xs = bind(used);
    assert.equal(xs.length, 2);
    assert.deepEqual(
      xs.map((x) => x.record.patientId),
      ["A", "B"],
    );
    assert.ok(xs.every((x) => !x.contextOnly));
    assert.match(xs[0].quote, /PRELIMINARY/);
    assert.match(xs[1].quote, /AMENDED/);
  }
});
test("citationless abstention retains all intersected identities without heuristic selection", () => {
  const xs = bind();
  assert.equal(xs.length, 2);
  assert.ok(xs.every((x) => x.contextOnly));
  for (const x of xs) assert.equal(x.quote, text.slice(x.start, x.end));
});
test("a sole known record clips an unrelated uncovered prefix", () => {
  const [x] = bind([{ sourceId: "s1", start: 122, end: 125 }], [reports[1]]);
  assert.equal(x.start, 100);
  assert.doesNotMatch(x.quote, /Patient A/);
  assert.equal(x.location, null);
});
test("an in-record chunk carries explicit identity even without header text", () => {
  const [x] = bind([], reports, {
    ...ev,
    start: 122,
    end: 125,
    quote: text.slice(122, 125),
  });
  assert.equal(x.record.patientId, "B");
  assert.equal(x.quote, text.slice(122, 125));
});
test("unsegmented evidence is marked unbound context, not falsely record-owned", () => {
  const [x] = bind([], []);
  assert.equal(x.binding, "unsegmented");
  assert.equal(x.contextOnly, true);
});
test("known segmented source with no matching record never displays uncovered quote", () => {
  const xs = bind([], [reports[1]], {
    ...ev,
    start: 0,
    end: 50,
    quote: text.slice(0, 50),
  });
  assert.deepEqual(xs, []);
});

test("a broad supporting citation associates with every intersected record", () => {
  const xs = bind([{ sourceId: "s1", start: 50, end: 150 }]);
  assert.equal(xs.length, 2);
  assert.ok(xs.every((x) => !x.contextOnly));
});

test("repeated broad chunks do not multiply repeated record evidence", () => {
  const recs = Array.from({ length: 100 }, (_, i) => ({
    sourceId: "many",
    title: `p${i}`,
    span: { start: i * 100, end: (i + 1) * 100 },
    meta: { patient: { id: `P${i}`, name: "Synthetic" } },
  }));
  const t = "x".repeat(10000),
    ev = { sourceId: "many", start: 0, end: 10000, quote: t };
  const out = bindEvidenceToRecords(
    Array.from({ length: 250 }, () => ev),
    "",
    recs,
    [],
  );
  assert.equal(out.length, 100);
  assert.equal(new Set(out.map((x) => x.record.patientId)).size, 100);
  assert.equal(
    out.reduce((n, x) => n + x.quote.length, 0),
    t.length,
  );
});

test("distinct overlapping broad chunks aggregate without losing record coverage", () => {
  const rs = Array.from({ length: 100 }, (_, i) => ({
    sourceId: "s",
    span: { start: i * 100, end: (i + 1) * 100 },
    meta: { patient: { id: "P" + i } },
  }));
  const es = Array.from({ length: 250 }, (_, i) => ({
    sourceId: "s",
    start: 0,
    end: 10000 - i,
    quote: "x".repeat(10000 - i),
  }));
  const out = bindEvidenceToRecords(es, "", rs);
  assert.equal(out.length, 100);
  assert.equal(new Set(out.map((x) => x.record.patientId)).size, 100);
  assert.equal(
    out.reduce((n, x) => n + x.quote.length, 0),
    10000,
  );
});

test("nonclinical final citations in a partly clinical source remain unchanged", async () => {
  const { bindAnswerCitations } = await import("../src/library.mjs");
  const records = [
    {
      sourceId: "s",
      span: { start: 100, end: 200 },
      meta: { patient: { id: "P1" } },
    },
  ];
  for (const start of [0, 120]) {
    const c = {
      sourceId: "s",
      start,
      end: start + 20,
      quote: "generic source fact",
    };
    assert.deepEqual(bindAnswerCitations([c], "", records), [c]);
  }
});
