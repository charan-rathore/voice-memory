// Frozen adversarial repros from the independent review of 748a365 (A1-A6):
// a cue-word line that is not a record must not mint claims; questions about
// parties or amounts the documents never mention must abstain, not answer
// from the records we do hold.
import { test } from "node:test";
import assert from "node:assert/strict";
import { importBundle } from "../dist/engine.mjs";
import { spokenTurn } from "../src/spoken.mjs";

const base = (extra) =>
  importBundle([
    {
      title: "01_Proposal.md",
      text: "# Pilot Proposal\nAuthor: X. Date: 2026-09-04. Type: proposal.\n1. We propose a pilot for a fixed engagement fee of $10,000.\n2. The proposed pilot deadline is 15 November 2026, with weekly progress reporting.\n3. This proposal is an offer, not an agreement.",
    },
    ...extra,
  ]);
const poisoned = base([
  {
    title: "02_Notes.md",
    text: "# Notes\nAuthor: Y. Date: 2026-09-10. Type: notes.\n1. Target practice for the sales team is scheduled for 5 January 2027.\n2. Lunch venue is undecided.",
  },
]);
const north = importBundle([
  {
    title: "01_Northstar.md",
    text: "# Northstar Proposal\nAuthor: M. Date: 2026-09-04. Type: proposal.\n1. Meridian proposes a pilot for Northstar Retail for a fixed engagement fee of $48,000.\n2. This proposal is an offer, not an agreement.",
  },
]);

test("A1/A2: cue-word line that is not a record mints no competing deadline", () => {
  const clean = spokenTurn("When is the pilot deadline?", base([]));
  assert.match(clean.spoken, /15 November 2026/);
  const poison = spokenTurn("When is the pilot deadline?", poisoned);
  assert.match(poison.spoken, /15 November 2026/);
  assert.doesNotMatch(poison.spoken, /January|5 January/);
});

test("A3/A4: a client the documents never mention gets an abstention", () => {
  for (const q of ["What fee did Bluebird agree?", "What did Bluebird sign?"]) {
    const r = spokenTurn(q, north);
    assert.doesNotMatch(r.spoken, /\$48,000/);
    assert.match(r.spoken, /don't see/);
  }
});

test("A5: an un-cited amount abstains instead of answering with a real figure", () => {
  const r = spokenTurn("Was the $99,999 fee finalized?", north);
  assert.doesNotMatch(r.spoken, /\$48,000/);
  assert.match(r.spoken, /\$99,999/);
});

test("A6: 'three retail regions' phrasing still resolves to the scope claim", () => {
  const scopey = importBundle([
    {
      title: "01_P.md",
      text: "# P\nAuthor: X. Date: 2026-09-04. Type: proposal.\n1. Pilot across three retail regions (North, South, West) for a fixed engagement fee of $48,000.\n2. Offer, not an agreement.",
    },
  ]);
  const r = spokenTurn("What is the scope?", scopey);
  assert.match(r.spoken, /three regions/i);
});

test("A7: retainer/retention phrasing clarifies, never aliases, the engagement fee", () => {
  // The corpus records an engagement fee and never says "retainer" or
  // "retention": the system must not present the engagement figure AS the
  // asked-for retention/retainer fee. It says the asked term is absent and
  // names what fee the documents do record, with its own label and status.
  for (const q of ["What is the retention fee?", "What is the retainer fee?"]) {
    const r = spokenTurn(q, north);
    assert.match(r.spoken, /don't see a (retention|retainer) fee/, q);
    assert.match(r.spoken, /engagement fee of \$48,000/, q);
    assert.match(r.spoken, /not approved/, q);
  }
});

test("A9: distinct descriptors answer their own figure, not each other's", () => {
  const both = importBundle([
    {
      title: "01_Northstar.md",
      text: "# Northstar Proposal\nAuthor: M. Date: 2026-09-04. Type: proposal.\n1. Meridian proposes a pilot for Northstar Retail for a fixed engagement fee of $48,000.\n2. This proposal is an offer, not an agreement.",
    },
    {
      title: "02_Notes.md",
      text: "# Notes\nAuthor: Y. Date: 2026-09-10. Type: notes.\n1. The workshop would sit under a monthly retainer of $5,000.\n2. Lunch venue is undecided.",
    },
  ]);
  const r1 = spokenTurn("What is the retainer?", both);
  assert.match(r1.spoken, /\$5,000/);
  assert.doesNotMatch(r1.spoken, /\$48,000/);
  const r2 = spokenTurn("What is the engagement fee?", both);
  assert.match(r2.spoken, /\$48,000/);
  assert.doesNotMatch(r2.spoken, /\$5,000/);
});

test("A8: out-of-corpus attributes still abstain, not answer with a real figure", () => {
  const marked = importBundle([
    {
      title: "01_Northstar.md",
      text: "# Northstar Proposal\nAuthor: M. Date: 2026-09-04. Type: proposal.\n1. Meridian proposes a pilot for Northstar Retail for a fixed engagement fee of $48,000.\n2. This proposal is an offer, not an agreement.",
    },
    {
      title: "02_Notes.md",
      text: "# Notes\nAuthor: Y. Date: 2026-09-10. Type: notes.\n1. The campaign marked the quarter.\n2. Lunch venue is undecided.",
    },
  ]);
  for (const q of [
    "What is the marketing budget?",
    "What is the private retainer?",
    "What is the retention deadline?",
  ]) {
    const r = spokenTurn(q, marked);
    assert.doesNotMatch(r.spoken, /\$48,000/, q);
    assert.match(r.spoken, /don't see/, q);
  }
});

// Invoice family of clarify-never-alias (production repro 2026-11-03): the
// deal corpus records a proposed fee and invoicing TERMS ("invoiced 50% on
// signing and 50% on pilot acceptance") but no invoice document, number or
// payment. Every invoice phrasing was answered with the same fee lead
// ("$42,000 is the current proposal; approval is not recorded."), inviting
// the false inference that an invoice lifecycle exists. The records must
// say what they do not record for the asked aspect - scoped to the
// documents, never asserting what exists outside them - and may then name
// the recorded fee under its own label and status.
const northInvoice = importBundle([
  {
    title: "01_Northstar.md",
    text: "# Northstar Proposal\nAuthor: M. Date: 2026-09-04. Type: proposal.\n1. Meridian proposes a customer analytics pilot for Northstar Retail.\n2. The proposed engagement fee is $48,000, invoiced 50% on signing and 50% on pilot acceptance.\n3. This proposal is an offer, not an agreement.",
  },
  {
    title: "02_Commercial_Revision.md",
    text: "# Commercial Revision - Northstar Pilot\nAuthor: M. Date: 2026-09-18. Type: revision memo.\n1. Following the narrower scope, the revised fee is $42,000, with 40% payable upfront and 60% after acceptance.",
  },
]);

test("A10: invoice asks name the absent record, never alias the proposed fee", () => {
  for (const [q, aspect] of [
    ["What is the invoice amount?", "an invoice"],
    ["How much was the invoice?", "an invoice"],
    ["Has the client been invoiced?", "an invoice"],
    ["When was the invoice issued?", "an invoice"],
    ["When was the invoice paid?", "a payment"],
    ["Was the invoice paid?", "a payment"],
    ["What is the invoice number?", "an invoice number"],
  ]) {
    const r = spokenTurn(q, northInvoice);
    assert.equal(r.verdict, "NO-RECORD", q);
    assert.match(
      r.spoken,
      new RegExp(`^These documents don't record ${aspect}\\.`),
      q,
    );
    assert.match(r.spoken, /They do record a revised fee of \$42,000/, q);
    assert.match(r.spoken, /proposed, not approved\.$/, q);
    assert.equal(r.citations.length, 1, q);
    assert.match(r.citations[0].quote, /42,000/, q);
  }
});

test("A11: a recorded invoice document still answers invoice asks", () => {
  // Counter-requirement (R-family): when the records DO hold an invoice
  // document, invoice phrasing must find it - the absence guard never
  // fires on a real-invoice corpus.
  const inv = importBundle([
    {
      title: "Acme_Invoice.txt",
      text: "Invoice total due: 18,500 INR, payable by 15 November 2026.\n",
    },
  ]);
  const r = spokenTurn("What is the invoice amount due?", inv);
  assert.notEqual(r.verdict, "NO-RECORD");
  assert.match(r.spoken, /18,500/);
  assert.doesNotMatch(r.spoken, /don't record/);
});

test("A12: no invoice and no fee - a bare absence, no pointer", () => {
  const lab = importBundle([
    {
      title: "Lab_Report.md",
      text: "# Lab Report\nAuthor: L. Date: 2026-10-01. Type: report.\n1. Ferritin is 42 ng/mL (reference 30-400).\n",
    },
  ]);
  const r = spokenTurn("What is the invoice amount?", lab);
  assert.equal(r.verdict, "NO-RECORD");
  assert.equal(r.spoken, "These documents don't record an invoice.");
  const p = spokenTurn("Was the invoice paid?", lab);
  assert.equal(p.spoken, "These documents don't record a payment.");
});
