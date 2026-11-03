// Voice-layer (spokenTurn) regression tests over the Mariner synthetic
// corpus: defects first reproduced against the real PDF's server ingest.
// Each expectation is the independent answer key's behavior, verified before
// the fix landed.
import test from "node:test";
import assert from "node:assert/strict";
import { importBundle } from "../dist/engine.mjs";
import { spokenTurn } from "../src/spoken.mjs";
import { MARINER_DOCS } from "../examples/corpus-mariner.mjs";

const bundle = importBundle(MARINER_DOCS);
const fields = bundle.fields ?? [];

test("rejection question is answered by the no-rejection record, not an approval line", () => {
  const r = spokenTurn("Was the fee rejected?", bundle, fields, {});
  assert.match(r.spoken, /no rejection is recorded/i);
  assert.doesNotMatch(r.spoken, /is approved\.?$/i);
});

test("'originally proposed' scope reports the earliest record, not current scope", () => {
  const r = spokenTurn(
    "How many sites were originally proposed?",
    bundle,
    fields,
    {},
  );
  assert.match(r.spoken, /four/i, "earliest four-site record answers");
  assert.match(r.spoken, /east and west/i, "current scope disclosed");
});

test("latest launch target is the disclosed internal target, not a flat no", () => {
  const r = spokenTurn("What is the latest launch target?", bundle, fields, {});
  assert.match(r.spoken, /December 10/);
  assert.notEqual(r.verdict, "NO-RECORD");
  assert.match(r.spoken, /internal|not (an )?approved/i, "status disclosed");
});

test("month-scoped history binds the revised record of that month", () => {
  const r = spokenTurn(
    "What was the revised fee in August?",
    bundle,
    fields,
    {},
  );
  assert.match(r.spoken, /58,000/, "August revision answers");
  assert.match(r.spoken, /54,000/, "current approved record disclosed");
  assert.match(r.spoken, /August 2026/, "month and year disclosed");
});
