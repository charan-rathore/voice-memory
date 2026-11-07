import test from "node:test";
import assert from "node:assert/strict";
import { buildDocument } from "../ingest/canonical.mjs";
import { extractSegment } from "./observations.mjs";
const header = (id, status = "final") => ({
  type: "paragraph",
  text: `Patient: Test Person (synthetic), ID ${id}\nCollected: 05 Nov 2026\nReport status: ${status}`,
  page: 1,
  method: "fixture",
});
const table = (value, page = 1) => ({
  type: "table",
  rows: [
    { cells: ["Test", "Result", "Unit", "Reference range"] },
    { cells: ["Ferritin", String(value), "ng/mL", "15 - 150"] },
  ],
  page,
  method: "fixture",
});
function docOf(blocks) {
  return buildDocument({
    blocks,
    kind: "text",
    mime: "text/plain",
    filename: "synthetic.txt",
    bytes: Buffer.from("synthetic"),
    parser: { name: "test" },
    pages: [{ number: 1 }, { number: 2 }],
  });
}
const values = (r) => r.observations.map((o) => o.raw);
function segment(doc, start, end, pages = [1]) {
  return extractSegment(doc, { index: 1, start, end, pages });
}
test("same-page correct spans exclude other patient table cells and preserve source offsets", () => {
  const d = docOf([
    header("SYN-0001"),
    table(4),
    header("SYN-0002"),
    table(80),
  ]);
  const cut = d.elements.filter((e) => e.type === "paragraph")[1].start;
  const a = segment(d, 0, cut),
    b = segment(d, cut, d.text.length);
  assert.deepEqual(values(a), ["4"]);
  assert.deepEqual(values(b), ["80"]);
  assert.equal(a.meta.patient.id, "SYN-0001");
  assert.equal(b.meta.patient.id, "SYN-0002");
  for (const [r, s, e] of [
    [a, 0, cut],
    [b, cut, d.text.length],
  ])
    for (const o of r.observations) {
      assert.ok(o.source.start >= s && o.source.end <= e);
      assert.ok(d.text.slice(o.source.start, o.source.end).includes(o.raw));
    }
});
test("boundary inside a table preserves contained rows and their structural header", () => {
  const t = table(4);
  t.rows.push({ cells: ["Hemoglobin", "11.2", "g/dL", "12 - 16"] });
  const d = docOf([header("SYN-0001"), t]);
  const rows = d.elements.filter((e) => e.type === "table-row");
  assert.deepEqual(values(segment(d, rows[1].start, d.text.length)), ["11.2"]);
  assert.deepEqual(values(segment(d, 0, rows[1].start)), ["4"]);
});
test("partially cut table row never retains its original complete cells", () => {
  const d = docOf([header("SYN-0001"), table(80)]);
  const row = d.elements.find((e) => e.type === "table-row");
  assert.deepEqual(values(segment(d, row.start + 15, row.end - 10)), []);
});
test("page-less text table uses spans rather than missing page metadata", () => {
  const d = docOf([
    header("SYN-0001"),
    table(4),
    header("SYN-0002"),
    table(80),
  ]);
  d.pages = [];
  for (const e of d.elements) e.page = null;
  const cut = d.elements.filter((e) => e.type === "paragraph")[1].start;
  assert.deepEqual(values(segment(d, 0, cut, [])), ["4"]);
  assert.deepEqual(values(segment(d, cut, d.text.length, [])), ["80"]);
});
test("headerless independent note does not borrow neighboring patient or tables", () => {
  const d = docOf([
    header("SYN-0001"),
    table(4),
    {
      type: "paragraph",
      text: "DRAFT NOTE\nFerritin 40 ng/mL",
      page: 1,
      method: "fixture",
    },
    header("SYN-0002"),
    table(80),
  ]);
  const ps = d.elements.filter((e) => e.type === "paragraph");
  const r = segment(d, ps[1].start, ps[2].start);
  assert.equal(r.meta.patient, null);
  assert.ok(!values(r).includes("4"));
  assert.ok(!values(r).includes("80"));
});
test("same-page amendment retains its own 40 not preliminary 4 or other patient 80", () => {
  const d = docOf([
    header("SYN-0001", "preliminary"),
    table(4),
    header("SYN-0001", "amended"),
    table(40),
    header("SYN-0002"),
    table(80),
  ]);
  const ps = d.elements.filter((e) => e.type === "paragraph");
  const r = segment(d, ps[1].start, ps[2].start);
  assert.equal(r.meta.status, "amended");
  assert.deepEqual(values(r), ["40"]);
});
test("multi-page segment preserves both its valid tables without adjacent record", () => {
  const d = docOf([
    header("SYN-0001"),
    table(4),
    table(11, 2),
    header("SYN-0002"),
    table(80),
  ]);
  const cut = d.elements.filter((e) => e.type === "paragraph")[1].start;
  assert.deepEqual(values(segment(d, 0, cut, [1, 2])), ["4", "11"]);
});
test("non-indexed overlay on a retained page still marks the value suspected-covered", () => {
  const d = docOf([
    header("SYN-0001"),
    table(4),
    header("SYN-0002"),
    table(80),
  ]);
  const row = d.elements.find((e) => e.type === "table-row");
  row.bbox = [10, 10, 100, 30];
  d.elements.push({
    id: "stamp",
    type: "overlay",
    indexed: false,
    start: null,
    end: null,
    page: 1,
    bbox: [5, 5, 110, 40],
    text: "SAMPLE",
  });
  const cut = d.elements.filter((e) => e.type === "paragraph")[1].start;
  const before = JSON.stringify(d);
  const r = segment(d, 0, cut);
  assert.equal(r.observations[0].suspectObscured, true);
  assert.equal(JSON.stringify(d), before);
});
test("invalid and empty spans reject rather than parse a whole document", () => {
  const d = docOf([header("SYN-0001"), table(4)]);
  for (const [a, b] of [
    [-1, 20],
    [0, d.text.length + 1],
    [10, 10],
    [20, 10],
    [0.5, 20],
  ])
    assert.throws(() => segment(d, a, b), RangeError);
});

test("partial plain-text line never becomes a new result after losing its range", () => {
  const d = docOf([
    {
      type: "paragraph",
      text: "Ferritin 80 ng/mL 15-150",
      page: 1,
      method: "fixture",
    },
  ]);
  const cut = d.text.indexOf("15-150");
  assert.deepEqual(values(segment(d, 0, cut)), []);
});
test("complete line inside a larger paragraph retains source location and value", () => {
  const d = docOf([
    {
      type: "paragraph",
      text: "NOTES\nFerritin 80 ng/mL 15-150\nEND",
      page: 1,
      bbox: [10, 10, 200, 100],
      method: "fixture",
    },
  ]);
  const a = d.text.indexOf("Ferritin"),
    b = d.text.indexOf("\nEND");
  const r = segment(d, a, b);
  assert.deepEqual(values(r), ["80"]);
  assert.equal(r.observations[0].source.page, 1);
  assert.ok(
    r.observations[0].source.start >= a && r.observations[0].source.end <= b,
  );
});
