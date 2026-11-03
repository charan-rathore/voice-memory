// Cross-engagement safety + status preservation (radar reviews of 2c75391
// and 9137520): distinct customers/subjects in one entity-less document
// never collapse; approval status is never erased; ambiguous questions ask
// which engagement instead of picking silently; a subject-less question
// never matches an arbitrary record and never claims a global no-record.
import test from "node:test";
import assert from "node:assert/strict";
import { importBundle, extractClaims, resolveClaims } from "../dist/engine.mjs";
import { spokenTurn } from "../src/spoken.mjs";

const doc = (text) => ({ title: "memo.pdf", text });
const bundleOf = (text) => importBundle([doc(text)]);
const ask = (b, q) => spokenTurn(q, b, b.fields ?? [], {}).spoken;

const PROPOSED_AB =
  "JAN 10 2026 - CALL\nThe Alpha migration fee is USD 20,000.\n\nFEB 10 2026 - CALL\nThe revised Beta migration fee is USD 30,000.\n";
const APPROVED_AB =
  "JAN 10 2026 - CALL\nThe Alpha migration fee of USD 20,000 is approved.\n\nFEB 10 2026 - CALL\nThe revised Beta migration fee of USD 30,000 is approved.\n";
const APPROVED_CUSTOMERS =
  "JAN 10 2026 - CALL\nCustomer A approved the fee of USD 20,000.\n\nFEB 10 2026 - CALL\nCustomer B approved the revised fee of USD 30,000.\n";

test("distinct named customers compete; one side never supersedes the other", () => {
  const b = bundleOf(PROPOSED_AB);
  const active = (
    resolveClaims(extractClaims(b, ["fee"])).active.get("fee") ?? []
  ).map((c) => c.value);
  assert.deepEqual(active.sort(), ["USD 20,000", "USD 30,000"]);
});

test("a named proposed subject answers its amount with its true status", () => {
  const a = ask(bundleOf(PROPOSED_AB), "What is the Alpha migration fee?");
  assert.match(a, /20,000/);
  assert.doesNotMatch(a, /30,000/);
  assert.match(a, /not approved/); // proposed stays proposed - no invented approval
});

test("a named APPROVED subject answers with the approval, never erased", () => {
  const b = bundleOf(APPROVED_AB);
  const a = ask(b, "What is the Alpha migration fee?");
  assert.match(a, /approval of USD 20,000/);
  assert.doesNotMatch(a, /30,000/);
  assert.doesNotMatch(a, /not approved/);
  const bb = ask(b, "What is the Beta migration fee?");
  assert.match(bb, /approval of USD 30,000/);
  assert.doesNotMatch(bb, /20,000/);
});

test("two engagements' approved fees: ambiguity with approval preserved", () => {
  const a = ask(bundleOf(APPROVED_CUSTOMERS), "What is the fee?");
  assert.match(a, /Different engagements have different approved values/);
  assert.match(a, /Customer A approved USD 20,000/);
  assert.match(a, /Customer B approved USD 30,000/);
  assert.match(a, /Which do you mean\?/);
  assert.doesNotMatch(a, /not approved/);
  assert.doesNotMatch(a, /^Yes\./); // never a silent single pick
});

test("a named Customer A question binds A's record, not the bare word customer", () => {
  const a = ask(bundleOf(APPROVED_CUSTOMERS), "What is Customer A's fee?");
  assert.match(a, /approval of USD 20,000/);
  assert.doesNotMatch(a, /30,000/);
  assert.doesNotMatch(a, /not approved/);
});

test("a subject-less rejection question asks which item and cites the record", () => {
  const b = bundleOf(
    "The 90-day retention suggestion is rejected on September 1. The fee of USD 54,000 is approved internally on September 10.",
  );
  const a = ask(b, "Was it rejected?");
  assert.match(a, /Which item do you mean\?/i);
  assert.match(a, /retention/i);
  assert.doesNotMatch(a, /no record shows a rejection/i); // false globally: one exists
  assert.doesNotMatch(a, /^(Yes|No)\. /); // never an arbitrary verdict
});

test("free-text approved variants without source equivalence are not merged", () => {
  const a = ask(
    bundleOf(
      "JAN 10 2026 - CALL\nThe East and West site scope is approved.\n\nFEB 10 2026 - CALL\nThe two-site scope is approved.\n",
    ),
    "What is the scope?",
  );
  assert.match(a, /East and West site/);
  assert.match(a, /two site/);
  assert.match(a, /don't say whether those are the same scope/);
  assert.doesNotMatch(a, /not approved/);
});

test("free-text approved variants WITH source equivalence stay one fact", () => {
  const a = ask(
    bundleOf(
      "JAN 10 2026 - CALL\nThe East and West site scope is approved. The two sites are East and West.\n\nFEB 10 2026 - CALL\nThe two-site scope is approved.\n",
    ),
    "What is the scope?",
  );
  assert.match(a, /East and West site/);
  assert.doesNotMatch(a, /don't say whether/);
});
