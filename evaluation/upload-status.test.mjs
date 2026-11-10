// Arbitrary-upload status, version and source checks: approval vocabulary
// with negation/modal/conditional guards, natural-format document dates,
// document-level supersession, and the approved-record demotion guard.
// Valid cases must be accepted; invalid ones must fail safe (never
// invented). Every corpus below is fictional.
import test from "node:test";
import assert from "node:assert/strict";
import { importBundle, extractClaims, resolveClaims } from "../dist/engine.mjs";
import { spokenTurn } from "../src/spoken.mjs";

const FIELDS = ["fee", "deadline", "paymentSplit", "duration"];
const claimsOf = (docs) => extractClaims(importBundle(docs), FIELDS);
const feeClaims = (docs) => claimsOf(docs).filter((c) => c.field === "fee");
const activeFees = (docs) =>
  [...resolveClaims(feeClaims(docs)).active.values()].flat();

test("ratified records the approval (valid positive)", () => {
  const claims = feeClaims([
    {
      title: "Board Minutes - Kitehill Toys",
      text: `# Board Minutes - Kitehill Toys
Date: September 1, 2026
The board ratified the fee of $3,200.`,
    },
  ]);
  assert.equal(claims.length, 1);
  assert.equal(claims[0].status, "approved");
});

test("conditional ratification is not approval (invalid: subject-to)", () => {
  const claims = feeClaims([
    {
      title: "Commercial Proposal - Kitehill Toys",
      text: `# Commercial Proposal - Kitehill Toys
Date: September 1, 2026
We propose a revised fee of $3,200, subject to board ratification.`,
    },
  ]);
  assert.equal(claims.length, 1);
  assert.notEqual(claims[0].status, "approved");
});

test("future ratification is not approval (invalid: modal)", () => {
  const claims = feeClaims([
    {
      title: "Planning Note - Kitehill Toys",
      text: `# Planning Note - Kitehill Toys
Date: September 1, 2026
The board will ratify the fee of $3,200 next week.`,
    },
  ]);
  assert.equal(claims.length, 1);
  assert.notEqual(claims[0].status, "approved");
});

test("negated ratification is not approval (invalid: negation)", () => {
  for (const line of [
    "The fee of $3,200 has not been ratified.",
    "Ratification of the $3,200 fee is pending.",
    "The fee of $3,200 is yet to be ratified.",
  ]) {
    const claims = feeClaims([
      {
        title: "Board Note - Kitehill Toys",
        text: `# Board Note - Kitehill Toys
Date: September 1, 2026
${line}`,
      },
    ]);
    assert.equal(claims.length, 1, line);
    assert.notEqual(claims[0].status, "approved", line);
  }
});

test("go-ahead records the approval (valid positive)", () => {
  const claims = feeClaims([
    {
      title: "Client Email - Kitehill Toys",
      text: `# Client Email - Kitehill Toys
Date: September 1, 2026
You have the go-ahead for the fee of $3,200.`,
    },
  ]);
  assert.equal(claims.length, 1);
  assert.equal(claims[0].status, "approved");
});

test("no go-ahead yet is not approval (invalid: negation)", () => {
  const claims = feeClaims([
    {
      title: "Client Email - Kitehill Toys",
      text: `# Client Email - Kitehill Toys
Date: September 1, 2026
There is no go-ahead yet for the fee of $3,200.`,
    },
  ]);
  assert.equal(claims.length, 1);
  assert.notEqual(claims[0].status, "approved");
});

test("natural-format Date headers are read, unparseable stays undated", () => {
  const claims = feeClaims([
    {
      title: "Fee Note - Kitehill Toys",
      text: `# Fee Note - Kitehill Toys
Date: September 1, 2026
The fee is $3,200.`,
    },
    {
      title: "Fee Note Two - Kitehill Toys",
      text: `# Fee Note Two - Kitehill Toys
Date: 5 September 2026
The fee is $3,100.`,
    },
  ]);
  assert.equal(claims[0].docDate, "2026-09-01");
  assert.equal(claims[1].docDate, "2026-09-05");
});

test("document-level replacement supersedes the older same-engagement record (valid)", () => {
  const docs = [
    {
      title: "Retainer Agreement - Kitehill Toys",
      text: `# Retainer Agreement - Kitehill Toys
Date: August 20, 2026
The engagement fee is $3,900, payable in two installments.`,
    },
    {
      title: "Commercial Proposal - Kitehill Toys",
      text: `# Commercial Proposal - Kitehill Toys
Date: September 1, 2026
We propose a revised fee of $3,200. This document replaces our earlier terms in full.`,
    },
  ];
  const r = resolveClaims(feeClaims(docs));
  const active = [...r.active.values()].flat().map((c) => c.value);
  assert.deepEqual(active, ["$3,200"]);
  assert.equal(r.superseded.length, 1);
  assert.equal(r.superseded[0].value, "$3,900");
});

test("document-level replacement never reaches another engagement (invalid: cross-entity)", () => {
  const docs = [
    {
      title: "Retainer Agreement - Kitehill Toys",
      text: `# Retainer Agreement - Kitehill Toys
Date: August 20, 2026
The engagement fee is $3,900, payable in two installments.`,
    },
    {
      title: "Meridian Advisory - Warehouse Study",
      text: `# Meridian Advisory - Warehouse Study
Date: August 21, 2026
The study fee is $19,000.`,
    },
    {
      title: "Commercial Proposal - Kitehill Toys",
      text: `# Commercial Proposal - Kitehill Toys
Date: September 1, 2026
We propose a revised fee of $3,200. This document replaces our earlier terms in full.`,
    },
  ];
  const r = resolveClaims(feeClaims(docs));
  const active = [...r.active.values()].flat().map((c) => c.value);
  assert.ok(active.includes("$19,000"), "other engagement untouched");
  assert.ok(active.includes("$3,200"));
  assert.ok(!active.includes("$3,900"), "same-engagement record superseded");
  assert.equal(
    r.superseded.filter((c) => c.value === "$19,000").length,
    0,
    "cross-engagement demotion must not happen",
  );
});

test("a proposed replacement cannot demote an approved record (invalid: authority)", () => {
  const docs = [
    {
      title: "Signed Agreement - Kitehill Toys",
      text: `# Signed Agreement - Kitehill Toys
Date: August 20, 2026
The agreed fee is $3,900, invoiced 50% on signing.`,
    },
    {
      title: "Commercial Proposal - Kitehill Toys",
      text: `# Commercial Proposal - Kitehill Toys
Date: September 1, 2026
We propose a revised fee of $3,200. This document replaces our earlier terms in full.`,
    },
  ];
  const r = resolveClaims(feeClaims(docs));
  const active = [...r.active.values()].flat();
  const approved = active.find((c) => c.status === "approved");
  assert.ok(approved, "approved record survives");
  assert.equal(approved.value, "$3,900");
  assert.ok(
    active.some((c) => c.value === "$3,200"),
    "proposal stays live",
  );
});

test("an undated replacement declaration supersedes nothing (invalid: no date)", () => {
  const docs = [
    {
      title: "Retainer Agreement - Kitehill Toys",
      text: `# Retainer Agreement - Kitehill Toys
Date: August 20, 2026
The engagement fee is $3,900, payable in two installments.`,
    },
    {
      title: "Commercial Proposal - Kitehill Toys",
      text: `# Commercial Proposal - Kitehill Toys
We propose a revised fee of $3,200. This document replaces our earlier terms in full.`,
    },
  ];
  const r = resolveClaims(feeClaims(docs));
  const active = [...r.active.values()].flat().map((c) => c.value);
  assert.deepEqual(r.superseded, []);
  assert.ok(active.includes("$3,900") && active.includes("$3,200"));
});

test("mention-only value is reported as on record, never as a proposal", () => {
  const docs = [
    {
      title: "Working Notes - Kitehill Toys",
      text: `# Working Notes - Kitehill Toys
Date: August 21, 2026
A fee of $3,200 was mentioned for the narrower scope.`,
    },
  ];
  const bundle = importBundle(docs);
  const r = spokenTurn(
    "Was the $3,200 fee approved?",
    bundle,
    bundle.fields ?? [],
    {},
  );
  assert.match(r.spoken, /on record/i);
  assert.match(r.spoken, /no approval is recorded/i);
  assert.doesNotMatch(r.spoken, /latest proposal/i);
});

test("a record with no approval language is not upgraded to a proposal", () => {
  const docs = [
    {
      title: "Client Email - Kitehill Toys",
      text: `# Client Email - Kitehill Toys
Date: September 1, 2026
There is no go-ahead yet for the fee of $3,200.`,
    },
  ];
  const bundle = importBundle(docs);
  const r = spokenTurn(
    "Was the $3,200 fee approved?",
    bundle,
    bundle.fields ?? [],
    {},
  );
  assert.match(r.spoken, /no approval is recorded/i);
  assert.doesNotMatch(r.spoken, /latest proposal/i);
});

test("did-not ratification is never approval (review B1)", () => {
  for (const line of [
    "The board did not ratify the fee of $3,200.",
    "The board didn't ratify the fee of $3,200.",
    "The board does not ratify the fee of $3,200.",
    "The board will not ratify the fee of $3,200.",
    "The board never ratified the fee of $3,200.",
  ]) {
    const claims = feeClaims([
      {
        title: "Board Note - Kitehill Toys",
        text: `# Board Note - Kitehill Toys
Date: September 1, 2026
${line}`,
      },
    ]);
    assert.equal(claims.length, 1, line);
    assert.notEqual(claims[0].status, "approved", line);
  }
});

test("go-ahead requires an affirmative event (review B2)", () => {
  for (const line of [
    "The go-ahead for the $3,200 fee was not given.",
    "The client requested a go-ahead for the $3,200 fee.",
    "We are still waiting on the go-ahead for the $3,200 fee.",
  ]) {
    const claims = feeClaims([
      {
        title: "Client Email - Kitehill Toys",
        text: `# Client Email - Kitehill Toys
Date: September 1, 2026
${line}`,
      },
    ]);
    assert.equal(claims.length, 1, line);
    assert.notEqual(claims[0].status, "approved", line);
  }
  // Positive controls stay affirmative.
  for (const line of [
    "You have the go-ahead for the fee of $3,200.",
    "The go-ahead was given for the fee of $3,200.",
  ]) {
    const claims = feeClaims([
      {
        title: "Client Email - Kitehill Toys",
        text: `# Client Email - Kitehill Toys
Date: September 1, 2026
${line}`,
      },
    ]);
    assert.equal(claims.length, 1, line);
    assert.equal(claims[0].status, "approved", line);
  }
});

test("document replacement must be affirmative and unconditional (review B3)", () => {
  for (const decl of [
    "This document replaces no earlier terms.",
    "This document replaces our earlier terms only if the client signs.",
    "This document does not replace our earlier terms.",
    "This document supersedes our earlier terms subject to board approval.",
  ]) {
    const docs = [
      {
        title: "Retainer Agreement - Kitehill Toys",
        text: `# Retainer Agreement - Kitehill Toys
Date: August 20, 2026
The engagement fee is $3,900.`,
      },
      {
        title: "Commercial Proposal - Kitehill Toys",
        text: `# Commercial Proposal - Kitehill Toys
Date: September 1, 2026
The fee is now $3,200. ${decl}`,
      },
    ];
    const claims = feeClaims(docs);
    const newer = claims.find((c) => c.value === "$3,200");
    assert.equal(newer.supersedes, false, decl);
    const r = resolveClaims(claims);
    assert.deepEqual(r.superseded, [], decl);
  }
});

test("approval expressed as a noun counts when affirmatively recorded (review F1)", () => {
  const claims = feeClaims([
    {
      title: "Board Minutes - Kitehill Toys",
      text: `# Board Minutes - Kitehill Toys
Date: September 1, 2026
The board's approval of the $3,200 fee was recorded.`,
    },
  ]);
  assert.equal(claims.length, 1);
  assert.equal(claims[0].status, "approved");
  for (const line of [
    "Approval of the $3,200 fee is pending.",
    "Approval of the $3,200 fee was not recorded.",
    "We are awaiting approval of the $3,200 fee.",
  ]) {
    const neg = feeClaims([
      {
        title: "Board Note - Kitehill Toys",
        text: `# Board Note - Kitehill Toys
Date: September 1, 2026
${line}`,
      },
    ]);
    assert.equal(neg.length, 1, line);
    assert.notEqual(neg[0].status, "approved", line);
  }
});

test("impossible dates stay undated (review F2)", () => {
  for (const header of [
    "Date: September 31, 2026",
    "Date: 2026-02-31",
    "Date: February 29, 2026",
    "Date: 2026-13-01",
  ]) {
    const claims = feeClaims([
      {
        title: "Fee Note - Kitehill Toys",
        text: `# Fee Note - Kitehill Toys
${header}
The fee is $3,200.`,
      },
    ]);
    assert.equal(claims.length, 1, header);
    assert.equal(claims[0].docDate, "", header);
  }
  // Valid leap day still parses.
  const ok = feeClaims([
    {
      title: "Fee Note - Kitehill Toys",
      text: `# Fee Note - Kitehill Toys
Date: February 29, 2028
The fee is $3,200.`,
    },
  ]);
  assert.equal(ok[0].docDate, "2028-02-29");
});

test("a genuine approved addendum supersedes the approved original (review F3)", () => {
  const docs = [
    {
      title: "Signed Agreement - Kitehill Toys",
      text: `# Signed Agreement - Kitehill Toys
Date: August 20, 2026
The agreed fee is $3,900, invoiced 50% on signing.`,
    },
    {
      title: "Signed Addendum - Kitehill Toys",
      text: `# Signed Addendum - Kitehill Toys
Date: September 1, 2026
The parties approved the amended fee of $3,200. This addendum supersedes the earlier terms in full.`,
    },
  ];
  const r = resolveClaims(feeClaims(docs));
  const active = [...r.active.values()].flat();
  const approvedActive = active.filter((c) => c.status === "approved");
  assert.deepEqual(
    approvedActive.map((c) => c.value),
    ["$3,200"],
    "approved amendment replaces approved original",
  );
});

test("replacement in one brand family never reaches another (review F3)", () => {
  const docs = [
    {
      title: "Retainer Agreement - Kitehill Toys",
      text: `# Retainer Agreement - Kitehill Toys
Date: August 20, 2026
The engagement fee is $3,900.`,
    },
    {
      title: "Supply Agreement - Kitehill Foods",
      text: `# Supply Agreement - Kitehill Foods
Date: August 21, 2026
The supply fee is $19,000.`,
    },
    {
      title: "Commercial Proposal - Kitehill Toys",
      text: `# Commercial Proposal - Kitehill Toys
Date: September 1, 2026
We propose a revised fee of $3,200. This document replaces our earlier terms in full.`,
    },
  ];
  const r = resolveClaims(feeClaims(docs));
  const active = [...r.active.values()].flat().map((c) => c.value);
  assert.ok(active.includes("$19,000"), "Kitehill Foods untouched");
  assert.equal(
    r.superseded.filter((c) => c.value === "$19,000").length,
    0,
    "shared brand word is not a shared engagement",
  );
});

test("conditional authorization is never approval (re-review B1)", () => {
  for (const line of [
    "You have the go-ahead for the fee of $3,200 only if the board signs.",
    "The board ratified the fee of $3,200 subject to legal review.",
    "Approval of the $3,200 fee was recorded only if due diligence passes.",
  ]) {
    const claims = feeClaims([
      {
        title: "Client Email - Kitehill Toys",
        text: `# Client Email - Kitehill Toys
Date: September 1, 2026
${line}`,
      },
    ]);
    assert.equal(claims.length, 1, line);
    assert.notEqual(claims[0].status, "approved", line);
  }
  // Unconditional positive control stays approved.
  const pos = feeClaims([
    {
      title: "Client Email - Kitehill Toys",
      text: `# Client Email - Kitehill Toys
Date: September 1, 2026
You have the go-ahead for the fee of $3,200.`,
    },
  ]);
  assert.equal(pos[0].status, "approved");
});

test("plain if/when conditions block document replacement (re-review B2)", () => {
  for (const decl of [
    "This document replaces our earlier terms if the client signs.",
    "This document supersedes our earlier terms when the board agrees.",
  ]) {
    const docs = [
      {
        title: "Retainer Agreement - Kitehill Toys",
        text: `# Retainer Agreement - Kitehill Toys
Date: August 20, 2026
The engagement fee is $3,900.`,
      },
      {
        title: "Commercial Proposal - Kitehill Toys",
        text: `# Commercial Proposal - Kitehill Toys
Date: September 1, 2026
The fee is $3,200. ${decl}`,
      },
    ];
    const claims = feeClaims(docs);
    assert.equal(
      claims.find((c) => c.value === "$3,200").supersedes,
      false,
      decl,
    );
    assert.deepEqual(resolveClaims(claims).superseded, [], decl);
  }
});

test("not-only affirmation is a genuine approval (re-review F1)", () => {
  const claims = feeClaims([
    {
      title: "Board Minutes - Kitehill Toys",
      text: `# Board Minutes - Kitehill Toys
Date: September 1, 2026
The board not only ratified the $3,200 fee but also approved it.`,
    },
  ]);
  assert.equal(claims.length, 1);
  assert.equal(claims[0].status, "approved");
});

test("requested, denied or conditional go-ahead is never approval (round-3 B1)", () => {
  for (const line of [
    "We have requested a go-ahead for the fee of $3,200.",
    "We have been denied a go-ahead for the fee of $3,200.",
    "You have the go-ahead for the fee of $3,200 if the board signs.",
  ]) {
    const claims = feeClaims([
      {
        title: "Client Email - Kitehill Toys",
        text: `# Client Email - Kitehill Toys
Date: September 1, 2026
${line}`,
      },
    ]);
    assert.equal(claims.length, 1, line);
    assert.notEqual(claims[0].status, "approved", line);
  }
  const pos = feeClaims([
    {
      title: "Client Email - Kitehill Toys",
      text: `# Client Email - Kitehill Toys
Date: September 1, 2026
You have the go-ahead for the fee of $3,200.`,
    },
  ]);
  assert.equal(pos[0].status, "approved", "unconditional positive stands");
});

test("signature-dependent or pending replacement is not effective (round-3 B2)", () => {
  for (const decl of [
    "This document replaces our earlier terms upon the client signing.",
    "This document replaces our earlier terms pending board approval.",
  ]) {
    const docs = [
      {
        title: "Retainer Agreement - Kitehill Toys",
        text: `# Retainer Agreement - Kitehill Toys
Date: August 20, 2026
The engagement fee is $3,900.`,
      },
      {
        title: "Commercial Proposal - Kitehill Toys",
        text: `# Commercial Proposal - Kitehill Toys
Date: September 1, 2026
The fee is $3,200. ${decl}`,
      },
    ];
    const claims = feeClaims(docs);
    assert.equal(
      claims.find((c) => c.value === "$3,200").supersedes,
      false,
      decl,
    );
    assert.deepEqual(resolveClaims(claims).superseded, [], decl);
  }
});

test("a due date is never the document version date (round-3 B3)", () => {
  const docs = [
    {
      title: "Retainer Agreement - Kitehill Toys",
      text: `# Retainer Agreement - Kitehill Toys
Date: August 20, 2026
The engagement fee is $3,900.`,
    },
    {
      title: "Commercial Proposal - Kitehill Toys",
      text: `# Commercial Proposal - Kitehill Toys
Due Date: September 1, 2026
The fee is $3,200. This document replaces our earlier terms in full.`,
    },
  ];
  const claims = feeClaims(docs);
  const newer = claims.find((c) => c.value === "$3,200");
  assert.equal(newer.docDate, "", "due date must not become version date");
  assert.deepEqual(
    resolveClaims(claims).superseded,
    [],
    "no cross-document supersession from a due date",
  );
  // Header positions still parse: line-start and sentence boundary.
  const ok = feeClaims([
    {
      title: "Fee Note - Kitehill Toys",
      text: `# Fee Note - Kitehill Toys
Author: R. Mehta. Date: 2026-09-01. Type: proposal.
The fee is $3,200.`,
    },
  ]);
  assert.equal(ok[0].docDate, "2026-09-01");
});

test("nominal ratification affirmatively recorded counts (round-3 P2)", () => {
  const claims = feeClaims([
    {
      title: "Board Minutes - Kitehill Toys",
      text: `# Board Minutes - Kitehill Toys
Date: September 1, 2026
The board's ratification of the $3,200 fee was recorded.`,
    },
  ]);
  assert.equal(claims.length, 1);
  assert.equal(claims[0].status, "approved");
  const pending = feeClaims([
    {
      title: "Board Note - Kitehill Toys",
      text: `# Board Note - Kitehill Toys
Date: September 1, 2026
Ratification of the $3,200 fee is pending.`,
    },
  ]);
  assert.notEqual(pending[0].status, "approved", "pending stays unapproved");
});

test("a condition preceding the go-ahead is never approval (round-4 B1)", () => {
  for (const line of [
    "When the board signs, you have the go-ahead for the fee of $3,200.",
    "Once the board signs, you have the go-ahead for the fee of $3,200.",
    "You have the go-ahead for the fee of $3,200 once the board signs.",
  ]) {
    const claims = feeClaims([
      {
        title: "Planning Note - Kitehill Toys",
        text: `# Planning Note - Kitehill Toys
Date: September 1, 2026
${line}`,
      },
    ]);
    assert.equal(claims.length, 1);
    assert.notEqual(claims[0].status, "approved", line);
  }
  // Unconditional and realized-condition forms must stay approved.
  for (const line of [
    "You have the go-ahead for the fee of $3,200.",
    "When the board signed on Monday, we received the go-ahead for the fee of $3,200.",
  ]) {
    const claims = feeClaims([
      {
        title: "Board Minutes - Kitehill Toys",
        text: `# Board Minutes - Kitehill Toys
Date: September 1, 2026
${line}`,
      },
    ]);
    assert.equal(claims[0].status, "approved", line);
  }
});

test("replacement with a field exception never supersedes that field (round-4 B2)", () => {
  const docs = (decl) => [
    {
      title: "Retainer Agreement - Kitehill Toys",
      text: `# Retainer Agreement - Kitehill Toys
Date: August 20, 2026
The engagement fee is $3,900, payable in two installments.`,
    },
    {
      title: "Commercial Proposal - Kitehill Toys",
      text: `# Commercial Proposal - Kitehill Toys
Date: September 1, 2026
The fee is $3,200. ${decl}`,
    },
  ];
  // Explicit fee exception: both records compete, nothing superseded.
  const r = resolveClaims(
    feeClaims(
      docs(
        "This document replaces our earlier terms in full, except for fees.",
      ),
    ),
  );
  const active = [...r.active.values()].flat().map((c) => c.value);
  assert.ok(active.includes("$3,900"), "carved-out older fee survives");
  assert.ok(active.includes("$3,200"), "newer fee stays live");
  assert.deepEqual(r.superseded, []);
  // A statement preserving the fee elsewhere binds the same way.
  const r2 = resolveClaims(
    feeClaims(
      docs(
        "This document replaces the earlier commercial terms in full. It does not replace the fee terms.",
      ),
    ),
  );
  const active2 = [...r2.active.values()].flat().map((c) => c.value);
  assert.ok(active2.includes("$3,900") && active2.includes("$3,200"));
  assert.deepEqual(r2.superseded, []);
  // Plain declaration keeps superseding (control).
  const r3 = resolveClaims(
    feeClaims(docs("This document replaces our earlier terms in full.")),
  );
  assert.deepEqual(
    [...r3.active.values()].flat().map((c) => c.value),
    ["$3,200"],
  );
  assert.deepEqual(
    r3.superseded.map((c) => c.value),
    ["$3,900"],
  );
});

test("an unrelated carve-out does not suppress a genuine replacement (round-4 F1)", () => {
  const docs = [
    {
      title: "Retainer Agreement - Kitehill Toys",
      text: `# Retainer Agreement - Kitehill Toys
Date: August 20, 2026
The engagement fee is $3,900, payable in two installments.`,
    },
    {
      title: "Commercial Proposal - Kitehill Toys",
      text: `# Commercial Proposal - Kitehill Toys
Date: September 1, 2026
The fee is $3,200. This document replaces the earlier commercial terms in full. It does not replace the confidentiality terms.`,
    },
  ];
  const r = resolveClaims(feeClaims(docs));
  assert.deepEqual(
    [...r.active.values()].flat().map((c) => c.value),
    ["$3,200"],
  );
  assert.deepEqual(
    r.superseded.map((c) => c.value),
    ["$3,900"],
  );
});

test("an unrealized passive condition is never a completed event (round-5 B1)", () => {
  for (const line of [
    "When the audit is completed, you have the go-ahead for the fee of $3,200.",
    "When the fee is approved, the fee of $3,200 applies.",
    "Once approved, the fee of $3,200 stands.",
  ]) {
    const claims = feeClaims([
      {
        title: "Planning Note - Kitehill Toys",
        text: `# Planning Note - Kitehill Toys
Date: September 1, 2026
${line}`,
      },
    ]);
    assert.equal(claims.length, 1);
    assert.notEqual(claims[0].status, "approved", line);
  }
  // Recorded satisfaction stays approved: active simple past with a
  // subject, and recorded past passive.
  for (const line of [
    "When the audit was completed, we received the go-ahead for the fee of $3,200.",
    "When the board signed on Monday, we received the go-ahead for the fee of $3,200.",
    "When the board approved the fee of $3,200, work began.",
    "The fee of $3,200 is approved and signed by both parties.",
  ]) {
    const claims = feeClaims([
      {
        title: "Board Minutes - Kitehill Toys",
        text: `# Board Minutes - Kitehill Toys
Date: September 1, 2026
${line}`,
      },
    ]);
    assert.equal(claims[0].status, "approved", line);
  }
});

test("an explicit field-preservation statement blocks supersession (round-5 B2)", () => {
  const docs = (extra) => [
    {
      title: "Retainer Agreement - Kitehill Toys",
      text: `# Retainer Agreement - Kitehill Toys
Date: August 20, 2026
The engagement fee is $3,900, payable in two installments.`,
    },
    {
      title: "Commercial Proposal - Kitehill Toys",
      text: `# Commercial Proposal - Kitehill Toys
Date: September 1, 2026
The fee is $3,200. This document replaces our earlier terms in full. ${extra}`,
    },
  ];
  for (const extra of [
    "The fee terms remain unchanged.",
    "There is no change to the fee.",
    "The fees are unchanged.",
  ]) {
    const r = resolveClaims(feeClaims(docs(extra)));
    const active = [...r.active.values()].flat().map((c) => c.value);
    assert.ok(active.includes("$3,900"), extra);
    assert.ok(active.includes("$3,200"), extra);
    assert.deepEqual(r.superseded, [], extra);
  }
  // Positive control: no preservation statement, replacement supersedes.
  const r = resolveClaims(feeClaims(docs("")));
  assert.deepEqual(
    [...r.active.values()].flat().map((c) => c.value),
    ["$3,200"],
  );
  assert.deepEqual(
    r.superseded.map((c) => c.value),
    ["$3,900"],
  );
});

test("a hypothetical past condition is never a recorded event (round-6 B1)", () => {
  for (const line of [
    "If the board approved the fee of $3,200, we received the go-ahead.",
    "If the board approved the fee of $3,200, the fee applies.",
  ]) {
    const claims = feeClaims([
      {
        title: "Planning Note - Kitehill Toys",
        text: `# Planning Note - Kitehill Toys
Date: September 1, 2026
${line}`,
      },
    ]);
    assert.equal(claims.length, 1);
    assert.notEqual(claims[0].status, "approved", line);
  }
  // Temporal marks with recorded satisfaction stay approved.
  for (const line of [
    "When the board signed on Monday, we received the go-ahead for the fee of $3,200.",
    "When the board approved the fee of $3,200, work began.",
  ]) {
    const claims = feeClaims([
      {
        title: "Board Minutes - Kitehill Toys",
        text: `# Board Minutes - Kitehill Toys
Date: September 1, 2026
${line}`,
      },
    ]);
    assert.equal(claims[0].status, "approved", line);
  }
});

test("historical preservation never vetoes a current replacement (round-6 B2)", () => {
  const docs = [
    {
      title: "Commercial Proposal - Kitehill Toys",
      text: `# Commercial Proposal - Kitehill Toys
Date: August 20, 2026
The fee is $3,900.`,
    },
    {
      title: "Commercial Amendment - Kitehill Toys",
      text: `# Commercial Amendment - Kitehill Toys
Date: September 1, 2026
The fee is $3,200. The fees remained unchanged under the previous agreement. This document replaces our earlier terms in full.`,
    },
  ];
  const r = resolveClaims(feeClaims(docs));
  assert.deepEqual(
    [...r.active.values()].flat().map((c) => c.value),
    ["$3,200"],
  );
  assert.deepEqual(
    r.superseded.map((c) => c.value),
    ["$3,900"],
  );
});

test("hypothetical conditions block every approval route (round-7 B1)", () => {
  for (const line of [
    "If the board accepted the fee of $3,200, work began.",
    "If approval of the $3,200 fee was recorded, work began.",
    "If the board ratified the fee of $3,200, work began.",
  ]) {
    const claims = feeClaims([
      {
        title: "Planning Note - Kitehill Toys",
        text: `# Planning Note - Kitehill Toys
Date: September 1, 2026
${line}`,
      },
    ]);
    assert.equal(claims.length, 1);
    assert.notEqual(claims[0].status, "approved", line);
  }
  // Unconditional and temporal-recorded forms stay approved.
  for (const line of [
    "The board accepted the fee of $3,200.",
    "The board's approval of the $3,200 fee was recorded.",
    "When the board accepted the fee of $3,200, work began.",
    "When the board met, approval of the $3,200 fee was recorded.",
  ]) {
    const claims = feeClaims([
      {
        title: "Board Minutes - Kitehill Toys",
        text: `# Board Minutes - Kitehill Toys
Date: September 1, 2026
${line}`,
      },
    ]);
    assert.equal(claims[0].status, "approved", line);
  }
});

test("a condition preceding a replacement declaration creates no supersession (round-7 B2)", () => {
  const docs = [
    {
      title: "Retainer Agreement - Kitehill Toys",
      text: `# Retainer Agreement - Kitehill Toys
Date: August 20, 2026
The engagement fee is $3,900, payable in two installments.`,
    },
    {
      title: "Commercial Proposal - Kitehill Toys",
      text: `# Commercial Proposal - Kitehill Toys
Date: September 1, 2026
The fee is $3,200. If the client signs, this document replaces our earlier terms in full.`,
    },
  ];
  const r = resolveClaims(feeClaims(docs));
  const active = [...r.active.values()].flat().map((c) => c.value);
  assert.ok(active.includes("$3,900"));
  assert.ok(active.includes("$3,200"));
  assert.deepEqual(r.superseded, []);
});

test("a condition trailing the affirmative event blocks approval (round-8 P1)", () => {
  for (const line of [
    "The board accepted the fee of $3,200 if the client pays.",
    "The board approved the fee of $3,200 if payment is received.",
  ]) {
    const claims = feeClaims([
      {
        title: "Planning Note - Kitehill Toys",
        text: `# Planning Note - Kitehill Toys
Date: September 1, 2026
${line}`,
      },
    ]);
    assert.equal(claims.length, 1);
    assert.notEqual(claims[0].status, "approved", line);
  }
  for (const line of [
    "The board accepted the fee of $3,200.",
    "The board approved the fee of $3,200.",
    "The board approved the fee of $3,200 when the client countersigned.",
  ]) {
    const claims = feeClaims([
      {
        title: "Board Minutes - Kitehill Toys",
        text: `# Board Minutes - Kitehill Toys
Date: September 1, 2026
${line}`,
      },
    ]);
    assert.equal(claims[0].status, "approved", line);
  }
});

test("a plural-noun tail is not a conditional clause (round-9 P1)", () => {
  for (const line of [
    "The board approved the fee of $3,200 after discussions.",
    "The board approved the fee of $3,200 after meetings.",
    "The board approved the fee of $3,200 after the meeting.",
    "The board approved the fee of $3,200 when the client countersigned.",
  ]) {
    const claims = feeClaims([
      {
        title: "Board Minutes - Kitehill Toys",
        text: `# Board Minutes - Kitehill Toys
Date: September 1, 2026
${line}`,
      },
    ]);
    assert.equal(claims[0].status, "approved", line);
  }
  const claims = feeClaims([
    {
      title: "Planning Note - Kitehill Toys",
      text: `# Planning Note - Kitehill Toys
Date: September 1, 2026
The board approved the fee of $3,200 if payment is received.`,
    },
  ]);
  assert.notEqual(claims[0].status, "approved");
});

test("an unknown or ambiguous temporal tail is an unproven condition, never unconditional approval", () => {
  // Unknown syntax never defaults to approved: only an unambiguous bare
  // noun phrase is exempt; a novel verb or any subject+predicate shape is
  // an unproven condition (round-10 contract correction).
  for (const line of [
    "The board approved the fee of $3,200 after escrow releases the funds.",
    "The board approved the fee of $3,200 once counsel clears the wording.",
    "The board approved the fee of $3,200 when funds settle.",
    "The board approved the fee of $3,200 after lengthy discussions.",
  ]) {
    const claims = feeClaims([
      {
        title: "Planning Note - Kitehill Toys",
        text: `# Planning Note - Kitehill Toys
Date: September 1, 2026
${line}`,
      },
    ]);
    assert.equal(claims.length, 1);
    assert.notEqual(claims[0].status, "approved", line);
  }
});

test("temporal-tail exemption is a nominal whitelist; unknown syntax stays an unproven condition (round-11 P1)", () => {
  for (const line of [
    "The board approved the fee of $3,200 once paid.",
    "The board approved the fee of $3,200 once done.",
    "The board approved the fee of $3,200 when staff pay.",
    "The board approved the fee of $3,200 when staff agree.",
    "The board approved the fee of $3,200 after legal signs.",
    "The board approved the fee of $3,200 once finance signs.",
    "The board approved the fee of $3,200 after releases.",
    "The board approved the fee of $3,200 after clears.",
  ]) {
    const claims = feeClaims([
      {
        title: "Planning Note - Kitehill Toys",
        text: `# Planning Note - Kitehill Toys
Date: September 1, 2026
${line}`,
      },
    ]);
    assert.equal(claims.length, 1);
    assert.notEqual(claims[0].status, "approved", line);
  }
  for (const line of [
    "The board approved the fee of $3,200 after discussions.",
    "The board approved the fee of $3,200 after meetings.",
    "The board approved the fee of $3,200 after the meeting.",
    "The board approved the fee of $3,200 after payment.",
    "The board approved the fee of $3,200 after signing.",
  ]) {
    const claims = feeClaims([
      {
        title: "Board Minutes - Kitehill Toys",
        text: `# Board Minutes - Kitehill Toys
Date: September 1, 2026
${line}`,
      },
    ]);
    assert.equal(claims[0].status, "approved", line);
  }
});

test("an explicit prerequisite operator defeats the nominal exemption (round-11 P1)", () => {
  for (const line of [
    "The fee of $3,200 is approved only after payment.",
    "The fee of $3,200 is approved only after signing.",
    "The fee of $3,200 is approved only after acceptance.",
  ]) {
    const claims = feeClaims([
      {
        title: "Planning Note - Kitehill Toys",
        text: `# Planning Note - Kitehill Toys
Date: September 1, 2026
${line}`,
      },
    ]);
    assert.equal(claims.length, 1);
    assert.notEqual(claims[0].status, "approved", line);
  }
  for (const line of [
    "The board approved the fee of $3,200 after payment.",
    "The board approved the fee of $3,200 after signing.",
    "The board approved the fee of $3,200 after discussions.",
    "The fee of $3,200 is approved only after the client countersigned.",
  ]) {
    const claims = feeClaims([
      {
        title: "Board Minutes - Kitehill Toys",
        text: `# Board Minutes - Kitehill Toys
Date: September 1, 2026
${line}`,
      },
    ]);
    assert.equal(claims[0].status, "approved", line);
  }
});

test("determiner + token exemption never swallows a following predicate (span boundary)", () => {
  // "after the client signs" is determiner + noun + VERB: the clause span
  // past the noun must stay in scope; only the recorded past realizes.
  const conditional = feeClaims([
    {
      title: "Planning Note - Kitehill Toys",
      text: `# Planning Note - Kitehill Toys
Date: September 1, 2026
The board approved the fee of $3,200 after the client signs.`,
    },
  ]);
  assert.notEqual(conditional[0].status, "approved");
  const conditional2 = feeClaims([
    {
      title: "Planning Note - Kitehill Toys",
      text: `# Planning Note - Kitehill Toys
Date: September 1, 2026
The board approved the fee of $3,200 after the client pays.`,
    },
  ]);
  assert.notEqual(conditional2[0].status, "approved");
  const realized = feeClaims([
    {
      title: "Board Minutes - Kitehill Toys",
      text: `# Board Minutes - Kitehill Toys
Date: September 1, 2026
The board approved the fee of $3,200 after the client signed.`,
    },
  ]);
  assert.equal(realized[0].status, "approved");
});
