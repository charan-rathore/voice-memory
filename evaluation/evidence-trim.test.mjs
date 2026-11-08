// bindEvidenceToRecords: diagnostic evidence is bound to the source-owned
// record the question matches, using the clinical packet segmentation -
// not lexical guesses over rendered text. Invariants: a clipped span is an
// exact slice of the original at shifted offsets; the clip only ever
// happens at real record boundaries from packetSegments; the record
// containing the first salient question token wins; a paraphrase (no
// salient token) binds by largest character overlap; unsegmented sources
// and undecidable cases are kept whole, never mis-clipped.
import test from "node:test";
import assert from "node:assert/strict";
import { bindEvidenceToRecords } from "../src/library.mjs";

const REC = (name, id, body) =>
  `Patient name: ${name} Patient ID: ${id}\n\nDOB: 04 Dec 1968 Sex: Female\n\n${body}`;

function fixture() {
  const other = REC("Other Person", "X-1", "HbA1c 5.4 %\n");
  const pad = "z".repeat(320) + "\n";
  const match = REC(
    "Maya Sharma",
    "HLG-P1048",
    "Report status: AMENDED\nCollected: 2026-10-22\nHbA1c 6.9 %\n",
  );
  const text = other + pad + match;
  const reports = [
    {
      sourceId: "s1",
      title: "packet.pdf · p.1",
      span: { start: 0, end: other.length + pad.length },
    },
    {
      sourceId: "s1",
      title: "packet.pdf · p.2",
      span: { start: other.length + pad.length, end: text.length },
    },
  ];
  return { text, reports, other, pad, match };
}

test("evidence clips to the record holding the salient token", () => {
  const { text, reports } = fixture();
  const ev = { sourceId: "s1", start: 0, end: text.length, quote: text };
  const [b] = bindEvidenceToRecords([ev], "What is Maya's HbA1c?", reports);
  assert.equal(b.quote, text.slice(b.start, b.end)); // exact slice
  assert.equal(b.start, reports[1].span.start); // opens at the record boundary
  assert.equal(b.end, reports[1].span.end);
  assert.match(b.quote, /Report status: AMENDED/); // status context kept
  assert.match(b.quote, /Patient name: Maya Sharma/); // identity kept
  assert.doesNotMatch(b.quote, /Other Person/);
  assert.equal(b.record, "packet.pdf · p.2");
});

test("a paraphrase with no verbatim token binds by largest overlap", () => {
  const { text, reports, other, pad } = fixture();
  // chunk mostly inside Maya's record, spilling into the prefix
  const start = reports[1].span.start - 40;
  const ev = { sourceId: "s1", start, end: text.length, quote: text.slice(start) };
  const [b] = bindEvidenceToRecords(
    [ev],
    "What is her three-month sugar average?",
    reports,
  );
  assert.equal(b.start, reports[1].span.start);
  assert.equal(b.quote, text.slice(b.start, b.end));
  assert.doesNotMatch(b.quote, /zzz/);
  assert.ok(other.length + pad.length === reports[1].span.start);
});

test("a salient token in an unrelated record keeps that record, not the prefix", () => {
  const { text, reports } = fixture();
  // question token "HbA1c" first occurs in the OTHER record: the match is
  // bound to the record it actually sits in, never blended across both
  const ev = { sourceId: "s1", start: 0, end: text.length, quote: text };
  const [b] = bindEvidenceToRecords([ev], "What is the HbA1c?", reports);
  assert.equal(b.start, reports[0].span.start);
  assert.equal(b.end, reports[0].span.end);
  assert.match(b.quote, /Other Person/);
  assert.doesNotMatch(b.quote, /Maya Sharma/);
});

test("sources without record segmentation are left whole", () => {
  const ev = { sourceId: "solo", start: 10, end: 90, quote: "q".repeat(80) };
  const [b] = bindEvidenceToRecords([ev], "anything?", []);
  assert.deepEqual(b, ev);
});

test("a single-record source is left whole", () => {
  const ev = { sourceId: "s1", start: 0, end: 50, quote: "x".repeat(50) };
  const reports = [{ sourceId: "s1", span: { start: 0, end: 1000 } }];
  const [b] = bindEvidenceToRecords([ev], "anything?", reports);
  assert.deepEqual(b, ev);
});

test("the answer-cited record wins over a token-favored unrelated record", () => {
  const { text, reports } = fixture();
  const ev = { sourceId: "s1", start: 0, end: text.length, quote: text };
  // "HbA1c" occurs in the OTHER record first, so the token heuristic alone
  // binds there (see the test above). A citation the answer itself used
  // inside Maya's record must outrank it: the excerpt belongs to the
  // record the answer was actually built from.
  const mid = reports[1].span.start + 60;
  const [b] = bindEvidenceToRecords([ev], "What is the HbA1c?", reports, [
    { sourceId: "s1", start: mid, end: mid + 12 },
  ]);
  assert.equal(b.start, reports[1].span.start);
  assert.equal(b.end, reports[1].span.end);
  assert.match(b.quote, /Maya Sharma/);
  assert.doesNotMatch(b.quote, /Other Person/);
  // a citation that does not intersect the chunk changes nothing
  const [c] = bindEvidenceToRecords([ev], "What is the HbA1c?", reports, [
    { sourceId: "s1", start: 99999, end: 100010 },
  ]);
  assert.equal(c.start, reports[0].span.start); // heuristic fallback intact
});
