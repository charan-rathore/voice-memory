// Evidence selection regressions, run against the shipping engine
// (dist/engine.mjs) and the real final-answer contract. No provider calls.
//
// Failure modes reproduced here:
//   - a cited excerpt that does not answer the question was shown as a
//     successful answer (a document header, or a sentence about another actor
//     or status);
//   - the excerpt was cut at 280 characters, so the sentence that answered
//     the question was lost and a neighbouring one was shown in its place.
// Negative controls keep genuine answers and honest abstentions unchanged.
import { test } from "node:test";
import assert from "node:assert/strict";
import { importBundle, answer, validateEvidence } from "../dist/engine.mjs";
import { NORTHSTAR_DOCS } from "../examples/corpus-northstar.mjs";
import { intentLead } from "../src/semantic/route.mjs";
import { finalAnswer, ABSTAIN_TEXT } from "../src/answer-contract.mjs";

const PAYMENTS = [
  {
    title: "Hospital_Bill_2026.md",
    text: `# Hospital Bill - Visit 14 March 2026
Author: Riverside Hospital billing. Date: 2026-03-20. Type: invoice.
1. The patient pays a copay of $40 at the visit.
2. The insurer pays $160 of the $200 bill under the policy.
3. The balance after insurance is due within 30 days of this invoice.`,
  },
  {
    title: "Contractor_Invoice.md",
    text: `# Contractor Invoice - March
Author: Ravi Build Works. Date: 2026-03-02. Type: invoice.
1. The contractor invoice is due within 30 days of receipt.
2. Payment is made by bank transfer only.`,
  },
];

/** What the shipping path shows for one question: engine + intent lead. */
function shownFor(docs, question) {
  const bundle = importBundle(docs);
  bundle.clinical = [];
  const r = answer(question, bundle);
  const lead = intentLead(question, bundle, (ev) =>
    validateEvidence(ev, bundle),
  );
  return {
    question: r.question ?? question,
    lead,
    evidence: r.evidence ?? [],
    answer: r.answer,
  };
}

const northstar = (q) => finalAnswer(shownFor(NORTHSTAR_DOCS, q));
const payments = (q) => finalAnswer(shownFor(PAYMENTS, q));

// --- RED: an excerpt that does not answer the question is not an answer ---

test("RED: a document header cited for 'who pays the invoice on signing' is not a successful answer", () => {
  const f = northstar("Who pays the invoice on signing?");
  assert.notEqual(f.kind, "quoted", f.text);
  assert.equal(f.kind, "preview", f.text);
  assert.equal(f.text, ABSTAIN_TEXT);
  assert.doesNotMatch(f.text, /Proposal v1|Author:/);
});

test("RED: 'is the revised fee approved' is not answered with the superseded $48,000 proposal sentence", () => {
  const f = northstar("Is the revised fee approved?");
  assert.doesNotMatch(f.text, /\$48,000/, f.text);
  // The sentence that does address the revised fee's approval is the one shown.
  assert.match(f.text, /remains pending/, f.text);
});

// --- RED: the answering sentence must be the one shown, for the right actor ---

test("RED: 'what does the insurer pay' shows the insurer sentence, not the patient copay above it", () => {
  const f = payments("What does the insurer pay?");
  assert.equal(f.kind, "quoted", f.text);
  assert.match(f.text, /insurer pays \$160/, f.text);
  assert.doesNotMatch(f.text, /copay/, f.text);
});

test("RED: a negated status answer ('who signed the commercial terms') keeps the sentence that says so", () => {
  const f = northstar("Who signed the commercial terms?");
  assert.match(f.text, /had not yet signed off/, f.text);
});

// --- Positive controls: a sentence that answers the question stays an answer ---

test("control: a cited sentence that answers the question is still a quoted answer", () => {
  const f = payments("When is the contractor invoice due?");
  assert.equal(f.kind, "quoted", f.text);
  assert.match(f.text, /due within 30 days of receipt/);
});

test("control: the patient's own payment still answers 'what does the patient pay'", () => {
  const f = payments("What does the patient pay?");
  assert.equal(f.kind, "quoted", f.text);
  assert.match(f.text, /patient pays a copay of \$40/);
});

test("RED: '22 November date client-approved' is answered by the sentence that says it is not", () => {
  const f = northstar("Is the 22 November date client-approved?");
  assert.equal(f.kind, "quoted", f.text);
  assert.match(f.text, /internal delivery target, not a client-approved/);
});

// --- Negative controls: nothing supported is never invented ---

test("control: an agreed payment schedule that no document records is abstained, not guessed", () => {
  const f = northstar("What is the payment schedule the client agreed to?");
  assert.equal(f.kind, "abstained", f.text);
  assert.equal(f.text, ABSTAIN_TEXT);
});

test("control: a question about a measure no document holds is abstained", () => {
  const f = payments("What is the iron storage test?");
  assert.notEqual(f.kind, "quoted", f.text);
});
