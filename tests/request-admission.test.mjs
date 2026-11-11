// The request frame (semantic/intent.mjs requestOf), relation verification
// (semantic/verify.mjs), the plan's slots (question-plan.mjs) and the
// canonical request view (answer-contract.mjs). Pure functions; the server
// and voice routes are covered in evaluation/canonical-question-plan.test.mjs.
import test from "node:test";
import assert from "node:assert/strict";
import { requestOf } from "../src/semantic/intent.mjs";
import {
  assertedAgent,
  relationSupport,
  deniesRelation,
  mentionsRelation,
} from "../src/semantic/verify.mjs";
import { questionPlan } from "../src/question-plan.mjs";
import { finalAnswer } from "../src/answer-contract.mjs";
import { sourceVersionOf } from "../src/source-version.mjs";

test("requestOf reads one clause: relation, actor, object", () => {
  const who = requestOf("Who pays the maintenance retainer?").relation;
  assert.deepEqual(
    [who.family, who.ask, who.actor, who.object],
    ["pay", "actor", null, "the maintenance retainer"],
  );
  assert.deepEqual(who.terms, ["maintenance", "retainer"]);
  const polar = requestOf("Does Harbor Logistics pay the retainer?").relation;
  assert.deepEqual(
    [polar.family, polar.ask, polar.actor],
    ["pay", "polar", "Harbor Logistics"],
  );
  const passive = requestOf("Was the fee approved by client finance?").relation;
  assert.deepEqual(
    [passive.family, passive.actor, passive.object],
    ["approve", "client finance", "the fee"],
  );
  assert.equal(
    requestOf("Who is the owner of the Leeds depot?").relation.family,
    "own",
  );
  assert.equal(
    requestOf("Who approved the $42,000 fee?").relation.object,
    "the $42,000 fee",
    "a thousands separator is not a clause boundary",
  );
});

test("requestOf claims no relation it did not fully consume", () => {
  for (const q of [
    "Was the fee approved?", // a status question: no party is asked for
    "Was the fee approved by Friday?", // a time, not a party
    "Who pays the retainer and who pays the travel costs?", // compound
    "Who pays the retainer if the contract ends?", // condition
    "Who approved the Q3 budget, and what is the backup interval?",
    "Does it pay well?",
    "What is the fee?",
  ])
    assert.equal(requestOf(q).relation, null, q);
});

test("requestOf reads polarity, version and status qualifiers", () => {
  assert.equal(requestOf("Is the retainer not approved?").negated, true);
  assert.equal(requestOf("Wasn't the contract signed?").negated, true);
  assert.equal(requestOf("Is the retainer approved?").negated, false);
  assert.equal(
    requestOf("What is not approved?").negated,
    false,
    "not a yes/no question",
  );
  const first = requestOf("What was the first proposed retainer?");
  assert.deepEqual([first.version, first.statusAsked], ["first", "proposed"]);
  assert.equal(requestOf("What is the latest fee?").version, "latest");
  assert.equal(requestOf("What was it before that?").version, "previous");
  assert.deepEqual(requestOf("Which invoice is for $4,750?").amounts, [
    "$4,750",
  ]);
});

test("assertedAgent accepts asserted statements only", () => {
  const yes = [
    [
      "pay",
      "Calder Foods pays the maintenance retainer to Harbor Logistics.",
      "Calder Foods",
    ],
    [
      "sign",
      "Mira Okafor signed this agreement for Calder Foods.",
      "Mira Okafor",
    ],
    ["approve", "The board has approved the budget.", "The board"],
    ["approve", "The budget was approved by the board.", "the board"],
    ["request", "Northstar asked to narrow the pilot.", "Northstar"],
  ];
  for (const [family, s, agent] of yes)
    assert.equal(assertedAgent(family, s)?.agent, agent, s);
  const no = [
    [
      "approve",
      "The revised retainer is subject to Calder Foods finance approval and is not yet approved.",
    ],
    ["approve", "No revised deadline has been approved by Northstar."],
    ["approve", "Client finance had not yet signed off on any revised terms."],
    ["approve", "Priya would approve the commercial scope if funding arrived."],
    ["approve", "If the client approves the scope, work begins."],
    ["pay", "The revised fee is $42,000, with 40% payable upfront."],
    ["propose", "The proposed engagement fee is $48,000."],
    ["sign", "The signed agreement is attached."],
    // a recorded role field is an observation, not an event that happened
    ["approve", "Approved by: Priya Nair"],
    ["approve", "Approver: Priya"],
    ["sign", "Signed by Mira Okafor for Calder Foods on 2026-04-10."],
  ];
  for (const [family, s] of no) assert.equal(assertedAgent(family, s), null, s);
});

test("relationSupport binds the asked object; overlap alone is related, not support", () => {
  const c = [
    {
      text: "Calder Foods pays the maintenance retainer to Harbor Logistics.",
      context: "Maintenance Agreement",
    },
    {
      text: "Harbor Logistics pays its own travel costs.",
      context: "Maintenance Agreement",
    },
    { text: "Site: Leeds depot.", context: "Invoice INV-1001" },
    {
      text: "The revised fee is $42,000, with 40% payable upfront.",
      context: "",
    },
  ];
  const s = (family, object) =>
    relationSupport(requestOf(`Who ${family} ${object}?`).relation, c);
  assert.deepEqual(
    s("pays", "the maintenance retainer").supported.map((x) => x.index),
    [0],
  );
  assert.deepEqual(
    s("pays", "the travel costs").supported.map((x) => x.index),
    [1],
  );
  const own = s("owns", "the Leeds depot");
  assert.deepEqual(own.supported, []);
  assert.deepEqual(own.related, [2]);
  const fee = s("pays", "the $42,000 fee");
  assert.deepEqual(fee.supported, []);
  assert.deepEqual(fee.related, [3]);
  // an amount in the object must be the same amount to count as support
  assert.deepEqual(s("pays", "the $48,000 fee").supported, []);
});

test("a denied or pending event is told apart from a stated one", () => {
  assert.equal(
    deniesRelation(
      "approve",
      "$42,000 is the latest proposal, and it is not approved.",
    ),
    true,
  );
  assert.equal(
    deniesRelation("sign", "No signed commercial agreement exists."),
    true,
  );
  assert.equal(
    deniesRelation(
      "approve",
      "The signed agreement records the approval of $16,200.",
    ),
    false,
  );
  assert.equal(
    mentionsRelation(
      "approve",
      "The signed agreement records the approval of $16,200.",
    ),
    true,
  );
  assert.equal(mentionsRelation("pay", "Site: Leeds depot."), false);
});

test("the plan keeps the original wording frozen and whole, with closed-grammar slots", () => {
  const q = "Does Harbor Logistics not pay the maintenance retainer?";
  const p = questionPlan({
    originalQuestion: q,
    sourceGeneration: 4,
    scope: { key: "ws:x", version: "abc" },
    followUp: {
      referencedTurnId: "c#2",
      subject: "deal.fee",
      correction: true,
      extra: "dropped",
    },
    normalizationCandidates: [{ kind: "model-rewrite", text: "Who pays?" }],
  });
  assert.equal(p.originalQuestion, q);
  assert.ok(Object.isFrozen(p) && Object.isFrozen(p.requirements[0].slots));
  assert.throws(() => {
    "use strict";
    p.originalQuestion = "x";
  });
  assert.equal(p.requirements.length, 1);
  assert.equal(p.requirements[0].text, q);
  const s = p.requirements[0].slots;
  assert.deepEqual(
    [s.actor, s.relation, s.action, s.object, s.polarity],
    [
      "Harbor Logistics",
      "pay",
      "confirm-actor",
      "the maintenance retainer",
      "negated",
    ],
  );
  assert.deepEqual(p.scope, { key: "ws:x", version: "abc" });
  assert.deepEqual(p.followUp, {
    referencedTurnId: "c#2",
    subject: "deal.fee",
    correction: true,
  });
  // a rewrite is recorded as a candidate; it never becomes the request
  assert.equal(p.normalizationCandidates[0].text, "Who pays?");
  assert.equal(p.coverageEstablished, false);
  // compound wording stays one opaque requirement
  const c = questionPlan({
    originalQuestion: "Did Nimbus pay $1,500, and did Priya approve the scope?",
    sourceGeneration: 4,
  });
  assert.equal(c.requirements.length, 1);
  assert.equal(c.request.relation, null);
  assert.equal(c.requirementSource, "opaque-lossless");
});

test("the request view: admitted text, requirement outcomes, related evidence, scope", () => {
  const plan = questionPlan({
    originalQuestion: "Who owns the Leeds depot?",
    sourceGeneration: 1,
    scope: { key: "ws:x", version: "v1" },
  });
  const cite = {
    quote: "Site: Leeds depot.",
    sourceId: "s1",
    start: 0,
    end: 18,
  };
  const abstained = finalAnswer({
    questionPlan: plan,
    lead: {
      text: "These documents don't state who owns the Leeds depot.",
      verdict: "UNKNOWN",
      citations: [],
    },
    evidence: [cite],
    requestAdmission: {
      requirements: [
        {
          requirementId: plan.requirements[0].id,
          text: plan.originalQuestion,
          outcome: "unsupported",
          reason: "relation_not_stated",
        },
      ],
    },
  });
  assert.equal(abstained.kind, "abstained");
  assert.equal(abstained.admittedText, null);
  assert.deepEqual(abstained.citations, []);
  assert.equal(abstained.relatedEvidence.length, 1);
  assert.equal(abstained.answeredRequirements.length, 0);
  assert.equal(
    abstained.unresolvedRequirements[0].reason,
    "relation_not_stated",
  );
  assert.deepEqual(abstained.scope, { key: "ws:x", version: "v1" });

  const answered = finalAnswer({
    questionPlan: plan,
    lead: {
      text: "Calder Foods owns the Leeds depot.",
      verdict: "QUOTED",
      citations: [cite],
    },
    relatedEvidence: [{ quote: "Site: Leeds depot." }],
  });
  assert.equal(answered.admittedText, "Calder Foods owns the Leeds depot.");
  assert.equal(answered.answeredRequirements[0].outcome, "supported");
  assert.equal(answered.relatedEvidence.length, 1, "kept apart from citations");

  const clarify = finalAnswer({
    questionPlan: plan,
    lead: {
      text: "Whose report?",
      verdict: "AMBIGUOUS_PATIENT",
      citations: [],
    },
  });
  assert.equal(clarify.admittedText, null);
  assert.equal(clarify.unresolvedRequirements[0].outcome, "unresolved");
  assert.deepEqual(clarify.relatedEvidence, []);
});

test("the source version follows the documents, including an in-place change", () => {
  const b = {
    scope: "ws:x",
    sources: [{ id: "a", hash: "h1", title: "A", text: "one" }],
  };
  const v1 = sourceVersionOf(b);
  assert.match(v1, /^[0-9a-f]{16}$/);
  assert.equal(sourceVersionOf({ ...b, sources: [...b.sources] }), v1);
  b.sources.push({ id: "b", hash: "h2", title: "B", text: "two" });
  assert.notEqual(sourceVersionOf(b), v1);
  assert.equal(sourceVersionOf(null), null);
});
