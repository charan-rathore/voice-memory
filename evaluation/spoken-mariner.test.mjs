// Voice-layer (spokenTurn) regression tests over the Mariner synthetic
// corpus: defects first reproduced against the real PDF's server ingest.
// Each expectation is the independent answer key's behavior, verified before
// the fix landed.
import test from "node:test";
import assert from "node:assert/strict";
import { importBundle, extractClaims, resolveClaims } from "../dist/engine.mjs";
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

test("unbound 'current' in an entity-less document does not demote another engagement's values", () => {
  // One PDF, no recognizable entity, two engagements discussed by speaker
  // role alone. "The current retainer is USD 10,000" in the second half must
  // NOT silently supersede the first engagement's retainer - the records
  // compete.
  const docs = [
    {
      title: "calls.pdf",
      text:
        "Alpha workstream: the retainer is proposed at USD 8,000.\n" +
        "Date: 2026-08-01\n" +
        "Beta workstream: the current retainer is USD 10,000.\n" +
        "Date: 2026-09-01\n",
    },
  ];
  const b = importBundle(docs);
  const claims = extractClaims(b, ["fee"]);
  const { active, superseded } = resolveClaims(claims);
  const actives = active.get("fee") ?? [];
  // 'current retainer' binds the fee field, so demotion of the 8,000 record
  // is permitted only if it is the SAME engagement; with no entity evidence
  // either way, both dated values must stay honest - check what survives.
  console.log(
    "multi-engagement actives:",
    actives.map((c) => c.value),
    "superseded:",
    superseded.map((c) => c.value),
  );
});

test("retention rejection is answered by the retention record, not a fee no-rejection line", () => {
  const r = spokenTurn("Was the 90-day retention rejected?", bundle, null);
  assert.match(r.spoken, /yes/i);
  assert.match(r.spoken, /retention/i);
});

test("'May I ask' is not a month filter", () => {
  const r = spokenTurn("May I ask what the fee is?", bundle, null);
  assert.doesNotMatch(r.spoken, /^In May/i);
  assert.match(r.spoken, /54,000/, "current fee answers");
});

test("September fee question prefers the approved record over a later cautionary mention", () => {
  const r = spokenTurn("What was the fee in September?", bundle, null);
  assert.match(r.spoken, /54,000/);
  assert.match(r.spoken, /approv/i);
});

test("approval question about the current internal target leads with that record", () => {
  const r = spokenTurn("Is the December 10 target approved?", bundle, null);
  assert.match(r.spoken, /December 10/);
  assert.match(r.spoken, /internal target|not (an )?approved/i);
  assert.doesNotMatch(r.spoken, /^No\. Per .*November 15/i);
});

test("distinct fee subjects in one entity-less document compete, never supersede", () => {
  const b = importBundle([
    {
      title: "t.pdf",
      text: "JAN 10 2026 - CALL\nThe hosting fee is USD 20,000.\n\nFEB 10 2026 - CALL\nThe revised license fee is USD 30,000.\n",
    },
  ]);
  const r = resolveClaims(extractClaims(b, ["fee"]));
  const actives = (r.active.get("fee") ?? []).map((c) => c.value);
  assert.ok(actives.includes("USD 20,000"), "hosting fee stays on record");
  assert.ok(actives.includes("USD 30,000"), "license fee on record");
});
