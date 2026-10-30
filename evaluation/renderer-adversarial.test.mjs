// Frozen adversarial repros from the independent review of 748a365 (A1-A6):
// a cue-word line that is not a record must not mint claims; questions about
// parties or amounts the documents never mention must abstain, not answer
// from the records we do hold.
import { test } from "node:test";
import assert from "node:assert/strict";
import { importBundle } from "../dist/engine.mjs";
import { spokenTurn } from "../spoken.mjs";

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
