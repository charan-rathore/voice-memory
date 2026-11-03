// Cairngorms honest-abstention: a REAL, unseen public document (Cairngorms
// National Park Authority Planning Committee minutes, 24 January 2025,
// cairngorms-planning-minutes-2025-01-24.pdf; sentences below are verbatim
// from the published minutes). Out-of-domain questions must abstain or
// cite the record - never fabricate fees, invoices, or declarations.
import test from "node:test";
import assert from "node:assert/strict";
import { importBundle, answer } from "../dist/engine.mjs";
import { spokenTurn } from "../src/spoken.mjs";

const MINUTES = [
  "Planning Committee Meeting Minutes",
  "Held at Cairngorms National Park Authority HQ, Grantown on Spey",
  "In person at 11 am on 24 January 2025",
  "Bill Lobban declared an interest in Item 5 of the agenda, as a close neighbour of the application site.",
  "Bill Lobban declared an interest in Item 6, as the Highland Council, along with the applicant, are shareholders of the development company.",
  "Bill Lobban left the meeting at 11.08am.",
  "10. The Committee approved the application.",
  "20. Date of the next meeting is 14 March 2025.",
].join("\n");
const bundle = () =>
  importBundle([
    { title: "cairngorms-planning-minutes-2025-01-24.pdf", text: MINUTES },
  ]);
const ask = (b, q) => spokenTurn(q, b, b.fields ?? [], {})?.spoken ?? null;

test("out-of-domain fee question fabricates nothing", () => {
  const b = bundle();
  const spoken = ask(b, "What is the fee?");
  if (spoken) {
    assert.doesNotMatch(spoken, /\$|USD|\bfee of\b/i);
  }
  const eng = answer("What is the fee?", b);
  assert.ok(
    eng.refused || !/\$|USD|\bfee of\b/i.test(eng.answer ?? ""),
    "engine must refuse or stay silent on fees here",
  );
});

test("a person's name never routes to the invoice absence path", () => {
  const a = ask(bundle(), "What did Bill Lobban declare?");
  assert.match(a, /declared an interest in Item 5/);
  assert.doesNotMatch(a, /invoice/i);
});

test("invoice absence answer stays scoped to these documents", () => {
  const a = ask(bundle(), "What is the invoice amount?");
  assert.match(a, /These documents don't record an invoice\./);
});

test("next-meeting question: correct date or honest abstention, no invention", () => {
  const a = ask(bundle(), "When is the next meeting?") ?? "";
  // Retrieval currently abstains here (safe); the only unacceptable
  // outcome is an invented date.
  assert.match(a, /14 March 2025|don't see that|could not find/i);
  assert.doesNotMatch(a, /\b(January|February|April|May|June|July)\s+\d/);
});
