import test from "node:test";
import assert from "node:assert/strict";
import { importBundle, answer } from "../dist/engine.mjs";
import { NORTHSTAR_DOCS } from "../corpus-northstar.mjs";

const feeQ = "What is the engagement fee?";

test("missing document dates: undated records are never silently demoted", () => {
  const undated = NORTHSTAR_DOCS.map((d) => ({
    title: d.title,
    text: d.text.replace(/Date: [0-9-]+\. /g, ""),
  }));
  const r = answer(feeQ, importBundle(undated));
  // Without dates, supersession cannot run: $48,000 and $42,000 must both stay
  // active and surface as competing, never one silently winning.
  assert.equal(r.unresolved, true);
  assert.match(r.answer, /\$48,000/);
  assert.match(r.answer, /\$42,000/);
});

test("unrelated revised fee in another engagement does not supersede Northstar history", () => {
  const acme = {
    title: "08_Acme_Revision.md",
    text: `# Acme Logistics - Warehouse Proposal Revision
Author: Meridian Advisory. Date: 2026-10-01. Type: revision memo.
1. The revised fee is $19,000 for the Acme warehouse study.
2. This revision is subject to Acme board sign-off.`,
  };
  const r = answer(feeQ, importBundle([...NORTHSTAR_DOCS, acme]));
  // The Acme revision must not erase the Northstar $48,000 -> $42,000 history.
  // Either the Northstar history answer stands, or all active fees compete -
  // but $48,000 may not silently disappear.
  assert.match(r.answer, /\$48,000/);
  assert.match(r.partialNotice ?? r.answer, /superseded|competing/i);
});

test("explicit approved statement wins over a newer merely-discussed proposal", () => {
  const docs = [
    {
      title: "01_Q_Appproval.md",
      text: `# Q Project - Approved Terms
Author: PMO. Date: 2026-09-01. Type: approval record.
1. The engagement fee of $30,000 is approved and signed by both parties.
2. Work may begin immediately.`,
    },
    {
      title: "02_Q_Discussion.md",
      text: `# Q Project - Later Discussion
Author: Sales. Date: 2026-09-20. Type: meeting notes.
1. We discussed a possible fee of $25,000 for a reduced scope, but no decision was taken and nothing was approved.`,
    },
  ];
  const r = answer(feeQ, importBundle(docs));
  assert.equal(r.supported, true);
  assert.match(r.answer, /approved record \$30,000/);
  assert.match(r.answer, /non-authoritative/i);
  assert.ok(!r.unresolved);
});

test("two approved but conflicting records stay conflicted", () => {
  const docs = [
    {
      title: "01_Q_Appproval.md",
      text: `# Q Project - Approved Terms
Author: PMO. Date: 2026-09-01. Type: approval record.
1. The engagement fee of $30,000 is approved and signed by both parties.`,
    },
    {
      title: "02_Q_Second_Approval.md",
      text: `# Q Project - Second Approval
Author: Finance. Date: 2026-09-20. Type: approval record.
1. The engagement fee of $25,000 is approved and signed by both parties.`,
    },
  ];
  const r = answer(feeQ, importBundle(docs));
  assert.equal(r.unresolved, true);
  assert.match(r.answer, /\$30,000/);
  assert.match(r.answer, /\$25,000/);
});

test("full fee answer never reasserts the stale value as current", () => {
  const r = answer(
    "What is the engagement fee and how is it invoiced?",
    importBundle(NORTHSTAR_DOCS),
  );
  // $48,000 may appear ONLY inside the superseded-history phrasing.
  const idx = r.answer.indexOf("$48,000");
  assert.ok(idx > -1);
  assert.match(r.answer.slice(Math.max(0, idx - 60), idx), /superseded/i);
  assert.ok(!r.answer.includes("fee of $48,000"));
  assert.match(r.answer, /approval is not established by this check/);
});
test("an unresolved open-decision line never supersedes the records it reports", () => {
  // Regression: D7's action log REPORTS the open payment-split decision
  // ("40/60 in the revision memo vs 50/50 in steering notes"). Its wording
  // "revision memo" must not supersede the D4 steering-notes record it flags
  // as open. Before the fix this silently flipped the journey to a false
  // resolved history: "current record 40/60 ... superseded 50/50 (04_Steering)".
  const r = answer(
    "What payment terms did we finally agree to?",
    importBundle(NORTHSTAR_DOCS),
  );
  assert.equal(r.unresolved, true);
  assert.match(r.answer, /unresolved competing statements/);
  assert.match(r.answer, /50\/50 \(04_Steering_Committee_Notes\.md/);
  assert.doesNotMatch(
    r.answer,
    /Superseded record\(s\):[^]*50\/50 \(04_Steering_Committee_Notes\.md/,
  );
});

test("a refused answer never carries a partial notice", () => {
  // Regression: the signoff-timing refusal (and any claims-guard refusal)
  // inherited the retrieval-level partial flag and notice, so the UI showed
  // "No supporting evidence found" alongside an amber "Partial: cited
  // passages are real evidence..." notice. A refused answer cites nothing.
  const r = answer(
    "When is signoff expected?",
    importBundle(NORTHSTAR_DOCS),
  );
  assert.equal(r.refused, true);
  assert.equal(r.partial, false);
  assert.equal(r.partialNotice, null);
  const r2 = answer(
    "What payment terms did we finally agree to?",
    importBundle(NORTHSTAR_DOCS),
  );
  assert.equal(r2.unresolved, true);
  assert.equal(r2.partial, false);
  assert.equal(r2.partialNotice, null);
});
