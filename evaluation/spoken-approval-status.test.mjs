// Approval-status honesty: a conditional or contemplated approval is not a
// completed approval. Trailing if/unless clauses and modal verbs (may,
// might, could, will, ...) must never render as "records the approval".
import test from "node:test";
import assert from "node:assert/strict";
import { importBundle } from "../dist/engine.mjs";
import { spokenTurn } from "../src/spoken.mjs";

const mk = (text) => importBundle([{ title: "memo.md", text }]);
const ask = (bundle, q) =>
  spokenTurn(q, bundle, bundle.fields ?? [], {})?.spoken ?? "";

const NOT_APPROVED =
  /not approved|latest proposal|has not been approved|no approval recorded/i;
const CLAIMS_APPROVAL = /records the approval|\bis approved\b/i;

test("a trailing if-condition is not a completed approval", () => {
  const b = mk(
    "JAN 10 2026 - CALL\nThe client approves the fee of USD 20,000 if the board agrees.\n",
  );
  for (const q of ["Was the fee approved?", "Who approved the fee?"]) {
    const a = ask(b, q);
    assert.doesNotMatch(a, CLAIMS_APPROVAL, `${q} -> ${a}`);
    assert.match(a, NOT_APPROVED, `${q} -> ${a}`);
  }
});

test("a trailing unless-condition is not a completed approval", () => {
  const b = mk(
    "JAN 10 2026 - CALL\nThe client approves the fee of USD 20,000 unless the board objects.\n",
  );
  const a = ask(b, "Was the fee approved?");
  assert.doesNotMatch(a, CLAIMS_APPROVAL, a);
  assert.match(a, NOT_APPROVED, a);
});

test("a long trailing if-condition keeps its caveat decisive", () => {
  const b = mk(
    "JAN 10 2026 - CALL\nThe client approves the fee of USD 20,000 after the remaining commercial milestones have been reviewed, if the board gives its final written consent.\n",
  );
  const a = ask(b, "Was the fee approved?");
  assert.doesNotMatch(a, CLAIMS_APPROVAL, a);
  assert.match(a, NOT_APPROVED, a);
});

test("modal approval wording (may/might/will) is contemplated, never confirmed", () => {
  for (const verb of ["may approve", "might approve", "will approve"]) {
    const b = mk(
      `JAN 10 2026 - CALL\nThe board ${verb} the fee of USD 20,000.\n`,
    );
    const a = ask(b, "Was the fee approved?");
    assert.doesNotMatch(a, CLAIMS_APPROVAL, `${verb} -> ${a}`);
    assert.doesNotMatch(a, /Approved at committee level/i, `${verb} -> ${a}`);
    assert.match(a, NOT_APPROVED, `${verb} -> ${a}`);
  }
});

test("plain approvals still render as approved", () => {
  const b = mk(
    "JAN 10 2026 - CALL\nThe client approved the fee of USD 20,000.\n",
  );
  assert.match(ask(b, "Was the fee approved?"), /records the approval/);
});

test("a speech hedge does not downgrade a completed approval", () => {
  const b = mk(
    "JAN 10 2026 - CALL\nThe board approved the fee of USD 20,000, if I recall correctly.\n",
  );
  assert.match(ask(b, "Was the fee approved?"), /records the approval/);
});

test("a real approval stands beside a separate contemplated one", () => {
  const b = mk(
    "JAN 10 2026 - CALL\nCustomer A approved the fee of USD 20,000.\nFEB 01 2026 - CALL\nThe board may approve the fee of USD 20,000.\n",
  );
  assert.match(ask(b, "Was the fee approved?"), /records the approval/);
});

test("leading conditional markers stay proposed", () => {
  for (const marker of [
    "subject to board consent",
    "provided that the board consents",
  ]) {
    const b = mk(
      `JAN 10 2026 - CALL\nThe client approves the fee of USD 20,000 ${marker}.\n`,
    );
    const a = ask(b, "Was the fee approved?");
    assert.doesNotMatch(a, CLAIMS_APPROVAL, `${marker} -> ${a}`);
  }
});

test("an explicit denial or refusal is never an approval", () => {
  for (const text of [
    "The client did not approve the fee of USD 20,000.",
    "The client refused to approve the fee of USD 20,000.",
    "The client declined to sign the fee agreement for USD 20,000.",
  ]) {
    const a = ask(mk(`JAN 10 2026 - CALL\n${text}\n`), "Was the fee approved?");
    assert.doesNotMatch(a, CLAIMS_APPROVAL, `${text} -> ${a}`);
    assert.match(a, NOT_APPROVED, `${text} -> ${a}`);
  }
});

test("future or required signing is intent, not a completed approval", () => {
  for (const text of [
    "The client will sign the fee agreement for USD 20,000 on Friday.",
    "The client shall sign the fee agreement for USD 20,000.",
    "The client must sign the fee agreement for USD 20,000 before payment.",
    "The fee agreement for USD 20,000 must be signed by Friday.",
  ]) {
    const b = mk(`JAN 10 2026 - CALL\n${text}\n`);
    for (const q of [
      "Was the fee approved?",
      "Was the fee agreement signed?",
    ]) {
      const a = ask(b, q);
      assert.doesNotMatch(a, CLAIMS_APPROVAL, `${text} / ${q} -> ${a}`);
      assert.match(a, NOT_APPROVED, `${text} / ${q} -> ${a}`);
    }
  }
});

test("a completed signing renders as approved", () => {
  const b = mk(
    "JAN 10 2026 - CALL\nThe client signed the fee agreement for USD 20,000.\n",
  );
  assert.match(ask(b, "Was the fee agreement signed?"), /records the approval/);
});

test("a condition after 'if it'/'if not' still governs the approval (review finding 1)", () => {
  for (const text of [
    "The client approved the fee of USD 20,000 if it received board consent.",
    "The client approved the fee of USD 20,000 if not disputed by Friday.",
  ]) {
    const a = ask(mk(`JAN 10 2026 - CALL\n${text}\n`), "Was the fee approved?");
    assert.doesNotMatch(a, CLAIMS_APPROVAL, `${text} -> ${a}`);
    assert.match(a, NOT_APPROVED, `${text} -> ${a}`);
  }
});

test("a leading if-condition governs the whole statement (review finding 1)", () => {
  const a = ask(
    mk(
      "JAN 10 2026 - CALL\nIf the board consents, the client approves the fee of USD 20,000.\n",
    ),
    "Was the fee approved?",
  );
  assert.doesNotMatch(a, CLAIMS_APPROVAL, a);
  assert.match(a, NOT_APPROVED, a);
});

test("a modal approval for one object never downgrades a completed approval of another (review finding 2)", () => {
  const a = ask(
    mk(
      "JAN 10 2026 - CALL\nThe client may approve the scope and the board approved the fee of USD 20,000.\n",
    ),
    "Was the fee approved?",
  );
  assert.match(a, /records the approval/, a);
});

test("an affirming clause supplies both status and authority (review finding 3)", async () => {
  const { semanticOf } = await import("../memory/graph.mjs");
  const b = mk(
    "JAN 10 2026 - CALL\nClient finance did not approve the USD 20,000 fee; steering committee approved it.\n",
  );
  const fee = semanticOf(b).get("fee")?.[0];
  assert.equal(fee?.status, "approved");
  assert.equal(fee?.claims?.[0]?.authority, "body");
});

test("a completed approval of one object never confirms a contemplated approval of another (review round 2)", () => {
  const a = ask(
    mk(
      "JAN 10 2026 - CALL\nThe board approved the scope and the client may approve the fee of USD 20,000.\n",
    ),
    "Was the fee approved?",
  );
  assert.doesNotMatch(a, CLAIMS_APPROVAL, a);
  assert.match(a, NOT_APPROVED, a);
});

test("an 'if I' obligation is a condition, not a hedge (review round 2)", () => {
  for (const text of [
    "The board approved the fee of USD 20,000 if I pay the deposit.",
    "The client approved the fee of USD 20,000 if I send the invoice.",
  ]) {
    const a = ask(mk(`JAN 10 2026 - CALL\n${text}\n`), "Was the fee approved?");
    assert.doesNotMatch(a, CLAIMS_APPROVAL, `${text} -> ${a}`);
    assert.match(a, NOT_APPROVED, `${text} -> ${a}`);
  }
});

test("a completed approval stands when a separate contemplated approval follows", () => {
  const a = ask(
    mk(
      "JAN 10 2026 - CALL\nThe fee of USD 20,000 was approved and the board may approve the scope.\n",
    ),
    "Was the fee approved?",
  );
  assert.match(a, /records the approval/, a);
});

test("a condition on another object's approval never downgrades a completed fee approval (review round 3)", () => {
  const a = ask(
    mk(
      "JAN 10 2026 - CALL\nThe board approved the fee of USD 20,000 and may approve the scope if funding arrives.\n",
    ),
    "Was the fee approved?",
  );
  assert.match(a, /records the approval/, a);
});
// Reviewer round-4 finding: a verb governing another object must not take
// precedence over the claim's own predicate that follows the anchor.
test("a contemplated fee predicate after the anchor governs over an earlier completed scope approval (review round 4)", () => {
  const a = ask(
    mk(
      "JAN 10 2026 - CALL\nThe board approved the scope and the fee of USD 20,000 may be approved.\n",
    ),
    "Was the fee approved?",
  );
  assert.doesNotMatch(a, /records the approval/, a);
});

test("a completed fee predicate after the anchor is not downgraded by an earlier contemplated scope approval (review round 4)", () => {
  const a = ask(
    mk(
      "JAN 10 2026 - CALL\nThe board may approve the scope and the fee of USD 20,000 was approved.\n",
    ),
    "Was the fee approved?",
  );
  assert.match(a, /records the approval/, a);
});

// Reviewer round-5 finding: a denial of one object must not negate the
// completed approval of another object in the same unsplit clause.
test("a denial of the scope does not negate the completed approval of the fee (review round 5)", () => {
  const a = ask(
    mk(
      "JAN 10 2026 - CALL\nThe client did not approve the scope and approved the fee of USD 20,000.\n",
    ),
    "Was the fee approved?",
  );
  assert.match(a, /records the approval/, a);
  assert.doesNotMatch(a, /not approved/, a);
});

// Reviewer round-6 finding: with two denials in one unsplit clause, the
// denial that governs the claim's own verb must be the one that binds.
test("the denial governing the fee binds even when another object is denied first (review round 6)", () => {
  const a = ask(
    mk(
      "JAN 10 2026 - CALL\nThe client did not approve the scope and did not approve the fee of USD 20,000.\n",
    ),
    "Was the fee approved?",
  );
  assert.doesNotMatch(a, /records the approval/, a);
});

