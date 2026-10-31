// RED-first regressions for evidence anchoring on long documents and for the
// small-count false abstention. Reproduced at dfd848e before the fix:
//  - chunks after the first carry an overlap tail or a repeated table header,
//    so `source.text.indexOf(chunk.text)` finds nothing and the passage is
//    silently dropped from evidence;
//  - "how many ..." refused when the answer was a small integer.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { importBundle, answer, validateEvidence } from "../dist/engine.mjs";
import { ingestFile } from "./index.mjs";

const B =
  "Warranty terms. " +
  "Claims must be filed within 45 days of delivery with the original invoice and photographs of the damage. ".repeat(
    18,
  );
const U = (n) =>
  `Unique section ${n}. ` +
  `Inspection note ${n} describes the condition of bay ${n} and the corrective work scheduled for it. `.repeat(
    20,
  );
const BOILER = `# Report\n\n${U(1)}\n\n## Terms\n\n${B}\n\n${U(2)}\n\n## Terms\n\n${B}\n\n${U(3)}`;

test("every chunk of a long document is anchored to an exact source span", () => {
  const b = importBundle([{ title: "boilerplate.md", text: BOILER }]);
  assert.ok(b.rows.length > 3, "long document produces several chunks");
  for (const r of b.rows) {
    const a = b.anchors?.get(r.chunk.id);
    assert.ok(a, "chunk has an anchor");
    const s = b.sources.find((x) => x.id === r.chunk.document_id);
    assert.ok(a.end > a.start && s.text.slice(a.start, a.end).length > 0);
    assert.ok(
      r.chunk.text.includes(s.text.slice(a.start, a.end).trim().slice(0, 200)),
      "anchor is the chunk's own verbatim core",
    );
  }
  // Repeated boilerplate resolves to two distinct places, in document order.
  const termAnchors = b.rows
    .filter((r) => r.chunk.text.includes("Warranty terms"))
    .map((r) => b.anchors.get(r.chunk.id).start);
  assert.ok(
    new Set(termAnchors).size >= 2,
    "repeated section anchored twice, not deduplicated or dropped",
  );
});

test("a fact deep inside a long document is cited with an exact, validated quote", () => {
  const b = importBundle([{ title: "boilerplate.md", text: BOILER }]);
  const r = answer("When must warranty claims be filed?", b);
  assert.equal(r.supported, true, r.answer);
  assert.ok(r.evidence.length > 0);
  for (const e of r.evidence) {
    assert.equal(validateEvidence(e, b), true);
    assert.equal(b.sources[0].text.slice(e.start, e.end), e.quote);
  }
  assert.ok(r.evidence.some((e) => e.quote.includes("within 45 days")));
});

test("a table row on page 3 of an ingested PDF is citable", async () => {
  const f = new URL(
    "./fixtures/files/chrome-multipage-table.pdf",
    import.meta.url,
  );
  const ing = await ingestFile(readFileSync(f), "bp-log.pdf");
  assert.equal(ing.ok, true);
  const b = importBundle([{ title: "bp-log.pdf", text: ing.doc.text }]);
  const r = answer("What were the Day 70 systolic and diastolic readings?", b);
  assert.ok(
    [...r.evidence, ...r.reviewEvidence].some((e) =>
      e.quote.includes("| Day 70 | 118 | 83 | mmHg |"),
    ),
    "the Day 70 row is in the cited evidence: " + r.answer,
  );
});

test("how-many questions accept a small count stated next to the asked noun", () => {
  const paras = [];
  for (let i = 1; i <= 40; i++)
    paras.push(
      `## Section ${i}\n\nThe site inspection for unit ${i} recorded ${i * 3} open items. Facilities owner Priya reviewed the drainage report.`,
    );
  const b = importBundle([
    { title: "long.md", text: "# Long report\n\n" + paras.join("\n\n") },
  ]);
  const r = answer(
    "How many open items did the inspection for unit 27 record?",
    b,
  );
  assert.equal(r.supported, true, r.answer);
  assert.ok(
    r.evidence.some((e) => e.quote.includes("unit 27 recorded 81 open items")),
  );
});

test("how-many still refuses when no count is attached to the asked noun", () => {
  const b = importBundle([
    {
      title: "notes.md",
      text: "# Notes\n\nThe warehouse team reviewed open items on Tuesday. Unit 4 has a new manager since 2024. Priya will follow up.",
    },
  ]);
  const r = answer("How many open items does the warehouse have?", b);
  assert.equal(
    r.supported,
    false,
    "a year or an unrelated number must not answer a count question",
  );
});
