import test from "node:test";
import assert from "node:assert/strict";
import {
  createConversationState,
  resolveConversationTurn,
  commitConversationTurn,
  normalizeUtterance,
  describeState,
} from "../src/conversation-turn.mjs";

const vocabulary = [
  { id: "deal.fee", label: "the fee", aliases: ["fee", "engagement fee"] },
  { id: "lab.ferritin", label: "ferritin", aliases: ["ferritin"] },
  { id: "lab.creatinine", label: "creatinine", aliases: ["creatinine"] },
  { id: "lab.tsh", label: "TSH", aliases: ["tsh"] },
];
function harness({ huge = false, missing = false } = {}) {
  const calls = [];
  const records = {
    vocabulary,
    resolve(req) {
      calls.push(req);
      if (missing) return { status: "unanswered" };
      const answer =
        req.subject.id === "deal.fee"
          ? "The fee is $42,000. This is a proposal. It is not approved."
          : req.subject.id === "lab.ferritin"
            ? "The corrected ferritin is 50 ng/mL. The preliminary value was 5. The earlier result was amended."
            : req.subject.id === "lab.tsh"
              ? "TSH is 3 mIU/L."
              : "Creatinine is 1.2 mg/dL.";
      return {
        status: "answered",
        spoken: huge ? "A".repeat(3000) : answer,
        verdict: "QUOTED",
        citations: [{ sourceId: "synthetic", start: 0, end: 10 }],
        factIds: [req.subject.id],
      };
    },
  };
  const input = (utterance, extra = {}) => ({
    utterance,
    callId: "one-call",
    sourceVersion: "v1",
    mode: "voice",
    records,
    ...extra,
  });
  return { calls, records, input };
}

test("unbound independent clause cannot be silently marked complete", () => {
  const h = harness();
  for (const q of [
    "What is the fee and when was it approved?",
    "What is the fee and the approval date?",
    "What is the fee? Did it change?",
  ]) {
    const { turn } = resolveConversationTurn(h.input(q));
    assert.equal(turn.outcome, "clarify", q);
    assert.equal(turn.answer.complete, false, q);
    assert.equal(turn.conversationDelta.carry, null, q);
    assert.match(turn.answer.spoken, /ask each part separately/i);
  }
  assert.equal(h.calls.length, 0, "no first-half fact was promoted");
});

test("two explicit subjects retain both parts and all factual sentences", () => {
  const h = harness();
  const { turn } = resolveConversationTurn(
    h.input("What is the fee and what is the TSH?"),
  );
  assert.equal(turn.outcome, "answered");
  assert.equal(turn.answer.complete, true);
  assert.deepEqual(turn.understanding.subject, ["deal.fee", "lab.tsh"]);
  assert.match(turn.answer.spoken, /not approved/i);
  assert.match(turn.answer.spoken, /TSH is 3/);
  assert.equal(h.calls.length, 2);
});

test("voice does not discard a third critical sentence", () => {
  const h = harness();
  const { turn } = resolveConversationTurn(h.input("What is the fee?"));
  assert.match(turn.answer.spoken, /fee is \$42,000/);
  assert.match(turn.answer.spoken, /proposal/i);
  assert.match(turn.answer.spoken, /not approved/i);
});

test("self-correction preserves a following independent request", () => {
  const h = harness();
  const normalized = normalizeUtterance(
    "What is creatinine, sorry ferritin and what is the TSH?",
    vocabulary,
  );
  assert.match(normalized.text, /ferritin.*TSH/i);
  assert.doesNotMatch(normalized.text, /creatinine/i);
  const { turn } = resolveConversationTurn(
    h.input("What is creatinine, sorry ferritin and what is the TSH?"),
  );
  assert.equal(turn.outcome, "answered");
  assert.deepEqual(turn.understanding.subject, ["lab.ferritin", "lab.tsh"]);
  assert.equal(h.calls.length, 2);
});

test("an interrupted delivery can retry the same utterance ID", () => {
  const h = harness();
  const first = resolveConversationTurn(
    h.input("What is the fee?", { utteranceId: "u17" }),
  );
  const dropped = commitConversationTurn(first.state, first.turn.turnId, {
    completed: false,
  });
  assert.equal(dropped.turns.length, 0);
  assert.equal(dropped.seen.length, 0);
  const retry = resolveConversationTurn(
    h.input("What is the fee?", { utteranceId: "u17" }),
    dropped,
  );
  assert.equal(retry.turn.outcome, "answered");
  const committed = commitConversationTurn(retry.state, retry.turn.turnId);
  const duplicate = resolveConversationTurn(
    h.input("What is the fee?", { utteranceId: "u17" }),
    committed,
  );
  assert.equal(duplicate.turn.outcome, "duplicate");
});

test("a document change resets previous utterance IDs", () => {
  const h = harness();
  const first = resolveConversationTurn(
    h.input("What is the fee?", { utteranceId: "event-1" }),
  );
  const committed = commitConversationTurn(first.state, first.turn.turnId);
  const next = resolveConversationTurn(
    h.input("What is the fee?", {
      sourceVersion: "v2",
      utteranceId: "event-1",
    }),
    committed,
  );
  assert.equal(next.turn.outcome, "answered");
  assert.ok(next.turn.conversationDelta.expire.includes("all_prior_turns"));
});

test("a wholly unsupported answer is not a verified record referent", () => {
  const h = harness({ missing: true });
  const first = resolveConversationTurn(h.input("What is the fee?"));
  assert.equal(first.turn.outcome, "abstain");
  const state = commitConversationTurn(first.state, first.turn.turnId);
  assert.ok(describeState(state).turns.every((t) => t.kind !== "record"));
  const repeat = resolveConversationTurn(h.input("say that again"), state);
  assert.match(repeat.turn.answer.spoken, /don't have a verified answer/i);
});

test("one oversized turn is evicted rather than exceeding the state byte budget", () => {
  const h = harness({ huge: true });
  const prior = createConversationState({
    callId: "one-call",
    sourceVersion: "v1",
    limits: { maxBytes: 500 },
  });
  const r = resolveConversationTurn(h.input("What is the fee?"), prior);
  const committed = commitConversationTurn(r.state, r.turn.turnId);
  assert.ok(describeState(committed).bytes <= 500);
  assert.equal(committed.turns.length, 0);
});
