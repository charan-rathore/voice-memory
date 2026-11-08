import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseBuffer } from "../ingest/parse.mjs";
import {
  extractReport,
  packetSegments,
  extractSegment,
  seriesFor,
} from "./observations.mjs";
import { clinicalAnswer } from "./answer.mjs";
async function reps(name) {
  const { doc } = await parseBuffer(
    readFileSync(new URL("./fixtures/files/" + name, import.meta.url)),
    name,
  );
  const parts = packetSegments(doc);
  return (
    parts
      ? parts.map((s) => ({ ...extractSegment(doc, s), segment: s.index }))
      : [extractReport(doc)]
  ).map((r, i) => ({ ...r, title: name, sourceId: name + "-" + i }));
}
test("same physical page separates two owners and does not lend lower values to upper owner", async () => {
  const r = await reps("boundary-same-page.pdf");
  assert.equal(r.length, 2);
  assert.doesNotMatch(
    clinicalAnswer("What is SYN-4101's ferritin?", r)?.spoken ?? "",
    /result is 80/,
  );
  assert.match(
    clinicalAnswer("What is SYN-4102's ferritin?", r)?.spoken ?? "",
    /result is 80/,
  );
});
test("digit-varying margin identity lines remain indexed owner evidence", async () => {
  const r = await reps("boundary-margin.pdf");
  assert.equal(r.length, 2);
  assert.deepEqual(
    r.map((x) => x.meta.patient?.id),
    ["SYN-4101", "SYN-4102"],
  );
});
test("an independent headerless page never inherits the preceding owner", async () => {
  const r = await reps("boundary-headerless.pdf");
  assert.equal(r.length, 2);
  assert.equal(r[1].meta.patient?.id ?? null, null);
  assert.doesNotMatch(
    clinicalAnswer("What is SYN-4101's ferritin?", r)?.spoken ?? "",
    /result is 80/,
  );
});
test("same-page explicit amendment remains authoritative, unlike equal FINAL peers", async () => {
  const r = await reps("boundary-same-page-amended.pdf");
  assert.equal(r.length, 2);
  assert.match(
    clinicalAnswer("What is SYN-4101's ferritin?", r)?.spoken ?? "",
    /result is 40/,
  );
});
test("equal-status equally-dated conflicting peers are not upload-order corrections", () => {
  const make = (raw, status = "final") => ({
    meta: {
      patient: { id: "RX-1" },
      collected: "2026-11-05",
      reported: "2026-11-06",
      status,
    },
    observations: [
      {
        key: "ferritin",
        test: "Ferritin",
        raw,
        value: Number(raw),
        unit: "ng/mL",
        source: {},
      },
    ],
  });
  for (const rs of [
    [make("4"), make("40")],
    [make("40"), make("4")],
  ]) {
    const [s] = seriesFor(rs, "ferritin", "RX-1");
    assert.ok(s.conflicts?.length);
    assert.equal(s.superseded.length, 0);
    const a = clinicalAnswer("What is RX-1's ferritin?", rs);
    assert.equal(a.verdict, "NOT_COMPARABLE");
    assert.doesNotMatch(a.spoken, /corrected from|result is/);
  }
  const [s] = seriesFor([make("4"), make("40", "amended")], "ferritin", "RX-1");
  assert.equal(s.current.raw, "40");
  assert.equal(s.conflicts?.length ?? 0, 0);
});
