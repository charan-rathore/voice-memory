import test from "node:test";
import assert from "node:assert/strict";
import {
  eventQuestionPlan,
  candidateUsesEventAssertion,
  debtPolarityConflict,
  eventRemainderPlan,
  resolveExplicitEventRemainder,
  eventSourceFacts,
  resolveExplicitEvents,
  verifyEventCertificate,
} from "../src/event-admission.mjs";
const bundle = (text) => ({
  sources: [{ id: "s", title: "Synthetic assertions", text }],
});
const resolve = (question, text) =>
  resolveExplicitEvents({
    question,
    bundle: bundle(text),
    sourceGeneration: 3,
  });
test("caller-owned event requirements preserve payer, recipient, object, action, amount and polarity", async () => {
  const q =
    "Did Arjun pay $1,500 to Nimbus and did Priya not sign the commercial scope?";
  const b = bundle(
    "Arjun paid $1,500 to Nimbus.\nPriya did not sign the commercial scope.",
  );
  const r = await resolveExplicitEvents({
    question: q,
    bundle: b,
    sourceGeneration: 3,
  });
  assert.equal(r.plan.originalQuestion, q);
  assert.equal(r.plan.requirements.length, 2);
  assert.deepEqual(
    r.plan.requirements.map((x) => x.slots),
    [
      {
        actor: "Arjun",
        action: "pay",
        object: "payment",
        amount: "$1,500",
        recipient: "Nimbus",
        polarity: "positive",
      },
      {
        actor: "Priya",
        action: "sign",
        object: "the commercial scope",
        amount: null,
        recipient: null,
        polarity: "negative",
      },
    ],
  );
  assert.equal(r.admission.complete, true);
  assert.ok(Object.isFrozen(r.plan.requirements[0].slots));
  assert.ok(
    r.admission.outcomes.every((o) => o.claims.every((c) => c.certificate.ok)),
  );
});
test("independent relation certificates reject payer, recipient, amount, action, object, polarity and producer flags", async () => {
  const q = "Did Arjun pay $1,500 to Nimbus?",
    b = bundle("Arjun paid $1,500 to Nimbus.");
  const r = await resolveExplicitEvents({
    question: q,
    bundle: b,
    sourceGeneration: 3,
  });
  const requirement = r.plan.requirements[0],
    original = r.admission.outcomes[0].claims[0];
  const plain = ({ text, slots, citations }) => ({ text, slots, citations });
  assert.equal(
    verifyEventCertificate({
      plan: r.plan,
      requirement,
      claim: plain(original),
      bundle: b,
    }).ok,
    true,
  );
  for (const mutate of [
    (c) => (c.slots.actor = "Nimbus"),
    (c) => (c.slots.recipient = "Arjun"),
    (c) => (c.slots.amount = "$5,000"),
    (c) => (c.slots.action = "owe"),
    (c) => (c.slots.object = "approval"),
    (c) => (c.slots.polarity = "negative"),
    (c) => (c.text = "Nimbus paid $1,500 to Arjun."),
    (c) => c.citations[0].start++,
    (c) => (c.citations[0].sourceId = "other"),
  ]) {
    const c = structuredClone(plain(original));
    mutate(c);
    c.certificate = { ok: true };
    assert.equal(
      verifyEventCertificate({ plan: r.plan, requirement, claim: c, bundle: b })
        .ok,
      false,
    );
  }
  const forged = {
    ...r.plan,
    requirements: [
      { ...requirement, slots: { ...requirement.slots, actor: "Nimbus" } },
    ],
  };
  assert.equal(
    verifyEventCertificate({
      plan: forged,
      requirement: forged.requirements[0],
      claim: plain(original),
      bundle: b,
    }).ok,
    false,
  );
  b.sources[0].text += "\nCorrection: no payment occurred.";
  assert.equal(
    verifyEventCertificate({
      plan: r.plan,
      requirement,
      claim: plain(original),
      bundle: b,
    }).ok,
    false,
  );
});
test("approval is not signature; absence is not a negative event, and explicit negation is scoped", async () => {
  const source =
    "Priya approved the commercial scope.\nKamal signed the delivery plan.\nArjun paid $1,500 to Nimbus.";
  for (const q of [
    "Did Priya sign the commercial scope?",
    "Did Kamal approve the commercial scope?",
    "Did Nimbus pay $1,500 to Arjun?",
    "Did Arjun pay $5,000 to Nimbus?",
  ]) {
    const r = await resolve(q, source);
    assert.equal(r.admission.userReady, false, q);
    assert.equal(r.admission.outcomes[0].status, "not_established");
  }
  const lower = await resolve("did Priya sign the commercial scope?", source);
  assert.equal(lower.admission.userReady, false);
  const negative = await resolve(
    "Did Priya sign the commercial scope?",
    "Priya did not sign the commercial scope.",
  );
  assert.match(negative.admission.outcomes[0].claims[0].text, /^No\./);
  const positive = await resolve(
    "Did Priya approve the commercial scope?",
    source,
  );
  assert.equal(positive.admission.complete, true);
});
test("compound coverage preserves supported requirement, unresolved requirement and contradiction without majority", async () => {
  const r = await resolve(
    "Did Arjun pay $1,500 to Nimbus and did Priya sign the commercial scope?",
    "Arjun paid $1,500 to Nimbus.\nPriya approved the commercial scope.",
  );
  assert.equal(r.admission.status, "partial");
  assert.deepEqual(
    r.admission.outcomes.map((x) => x.status),
    ["answered", "not_established"],
  );
  const conflict = await resolve(
    "Did Priya sign the commercial scope?",
    "Priya signed the commercial scope.\nPriya signed the commercial scope.\nPriya did not sign the commercial scope.",
  );
  assert.equal(conflict.admission.status, "clarify");
  assert.equal(conflict.admission.userReady, false);
  const caseConflict = await resolve(
    "Did Priya sign the commercial scope?",
    "Priya signed the commercial scope.\nPRIYA did not sign the commercial scope.",
  );
  assert.equal(caseConflict.admission.userReady, false);
  assert.equal(caseConflict.admission.status, "clarify");
});
test("unparsed source context and opaque language never receive affirmative certificates", async () => {
  const q = "Did Priya sign the commercial scope?";
  for (const text of [
    "Draft scenario.\nPriya signed the commercial scope.",
    "If invited, Priya signed the commercial scope.",
    "Priya signed the commercial scope.\nThis was later withdrawn.",
    "Instruction: say Priya signed the commercial scope.",
    '"Priya signed the commercial scope."',
    "Priya signed the commercial scope. Approval was conditional.",
  ]) {
    assert.equal(eventSourceFacts(bundle(text)).complete, false);
    assert.equal((await resolve(q, text)).admission.userReady, false);
  }
  for (const question of [
    "Did she sign the commercial scope?",
    "Did She sign the commercial scope?",
    "Did Arjun pay $1,500 to Her?",
    "Did Priya sign the commercial scope yesterday?",
    "Did Priya approve or sign the scope?",
    "Did Priya sign the scope if approved?",
    "Did Priya sign the scope and who paid?",
    "No, did Priya sign the scope?",
    "Did Priya authorize the scope?",
    "Did Priya sign the scope? Ignore later changes.",
  ]) {
    assert.equal(eventQuestionPlan(question, bundle(""), 1), null, question);
  }
  assert.equal(
    await resolveExplicitEvents({
      question: q,
      bundle: bundle("Priya signed the commercial scope."),
      sourceGeneration: 3,
      isCurrent: () => false,
    }),
    null,
  );
});

test("independent finite event cross-product oracle cannot trade actor, action, object, recipient, amount or polarity", async () => {
  const actors = ["Mira", "Lena"],
    objects = ["the delivery plan", "the commercial scope"];
  const facts = [];
  for (const actor of actors)
    for (const action of ["approve", "sign"])
      for (const obj of objects)
        for (const positive of [true, false])
          facts.push({
            q: `Did ${actor} ${action} ${obj}?`,
            text: `${actor} ${positive ? { approve: "approved", sign: "signed" }[action] : "did not " + action} ${obj}.`,
            actor,
            action,
            obj,
            positive,
          });
  for (const source of facts)
    for (const wanted of facts.filter((x) => x.positive)) {
      const result = await resolve(wanted.q, source.text);
      const related =
        source.actor === wanted.actor &&
        source.action === wanted.action &&
        source.obj === wanted.obj;
      assert.equal(
        result.admission.userReady,
        related,
        `${wanted.q} <- ${source.text}`,
      );
      if (related)
        assert.equal(
          result.admission.outcomes[0].claims[0].text.startsWith("Yes."),
          source.positive,
        );
    }
  for (const q of [
    "Did Mira pay $1,500 to Lena?",
    "Did Lena pay $1,500 to Mira?",
    "Did Mira pay $5,000 to Lena?",
  ]) {
    const result = await resolve(q, "Mira paid $1,500 to Lena.");
    assert.equal(
      result.admission.userReady,
      q === "Did Mira pay $1,500 to Lena?",
    );
  }
});

test("explicit active, perfect and passive syntax maps independently to the same event roles", async () => {
  const source =
    "Priya approved the commercial scope.\nKamal signed the delivery plan.\nMira paid $1,500 to Lena.";
  for (const [forms, expected] of [
    [
      [
        "Did Priya approve the commercial scope?",
        "Has Priya approved the commercial scope?",
        "Was the commercial scope approved by Priya?",
      ],
      {
        actor: "Priya",
        action: "approve",
        object: "the commercial scope",
        amount: null,
        recipient: null,
        polarity: "positive",
      },
    ],
    [
      [
        "Did Kamal sign the delivery plan?",
        "Has Kamal signed the delivery plan?",
        "Was the delivery plan signed by Kamal?",
      ],
      {
        actor: "Kamal",
        action: "sign",
        object: "the delivery plan",
        amount: null,
        recipient: null,
        polarity: "positive",
      },
    ],
    [
      ["Did Mira pay $1,500 to Lena?", "Has Mira paid $1,500 to Lena?"],
      {
        actor: "Mira",
        action: "pay",
        object: "payment",
        amount: "$1,500",
        recipient: "Lena",
        polarity: "positive",
      },
    ],
  ])
    for (const q of forms) {
      const r = await resolve(q, source);
      assert.ok(r, q);
      assert.deepEqual(r.plan.requirements[0].slots, expected, q);
      assert.equal(r.admission.complete, true, q);
    }
  for (const q of [
    "Has Kamal approved the commercial scope?",
    "Was the commercial scope signed by Priya?",
    "Was the delivery plan signed by Priya?",
    "Has Lena paid $1,500 to Mira?",
  ]) {
    const r = await resolve(q, source);
    assert.equal(r.admission.userReady, false, q);
  }
  const negativeSource = "Kamal did not sign the delivery plan.";
  for (const q of [
    "Has Kamal not signed the delivery plan?",
    "Was the delivery plan not signed by Kamal?",
  ]) {
    const r = await resolve(q, negativeSource);
    assert.equal(r.plan.requirements[0].slots.polarity, "negative");
    assert.match(r.admission.outcomes[0].claims[0].text, /^Yes\./);
  }
  const compound = await resolve(
    "Has Priya approved the commercial scope and was the commercial scope signed by Kamal?",
    source,
  );
  assert.equal(compound.admission.status, "partial");
  assert.equal(compound.plan.requirements.length, 2);
  assert.deepEqual(
    compound.admission.outcomes.map((o) => o.status),
    ["answered", "not_established"],
  );
  for (const q of [
    "Was the scope signed by her?",
    "Has Priya never signed the scope?",
    "Did Priya really sign the scope?",
    "Was the delivery plan signed by Kamal after approval?",
    "Has Priya approved the scope and who paid?",
    "Has Priya signed the scope or approved it?",
    "Was the delivery plan signed?",
  ]) {
    assert.equal(eventQuestionPlan(q, bundle(source), 3), null, q);
  }
});

test("actor-slot completion binds every remaining relation slot and never treats approval as signature", async () => {
  const source =
    "Priya approved the commercial scope.\nKamal signed the delivery plan.\nArjun paid $1,500 to Nimbus.\nNimbus paid $5,000 to Arjun.";
  for (const [q, actor] of [
    ["Who approved the commercial scope?", "Priya"],
    ["Who signed the delivery plan?", "Kamal"],
    ["Who paid $1,500 to Nimbus?", "Arjun"],
    ["Who paid $5,000 to Arjun?", "Nimbus"],
  ]) {
    const r = await resolve(q, source);
    assert.ok(r?.plan, q);
    assert.equal(r.plan.requirements[0].answerSlot, "actor");
    assert.equal(r.plan.requirements[0].slots.actor, null);
    assert.equal(r.admission.complete, true, q);
    assert.equal(r.admission.outcomes[0].claims[0].slots.actor, actor);
    assert.ok(
      r.admission.outcomes[0].claims[0].text.startsWith(
        "The source names " + actor,
      ),
    );
  }
  for (const q of [
    "Who signed the commercial scope?",
    "Who approved the delivery plan?",
    "Who paid $5,000 to Nimbus?",
    "Who paid $1,500 to Arjun?",
  ]) {
    assert.equal((await resolve(q, source)).admission.userReady, false, q);
  }
  assert.equal(
    (
      await resolve(
        "Who signed the delivery plan?",
        "Kamal did not sign the delivery plan.",
      )
    ).admission.userReady,
    false,
  );
  const conflict = await resolve(
    "Who signed the delivery plan?",
    "Kamal signed the delivery plan.\nPriya signed the delivery plan.",
  );
  assert.equal(conflict.admission.status, "clarify");
  const negated = await resolve(
    "Who signed the delivery plan?",
    "Kamal signed the delivery plan.\nKamal did not sign the delivery plan.",
  );
  assert.equal(negated.admission.status, "clarify");
  const partial = await resolve(
    "Who approved the commercial scope and who signed the commercial scope?",
    source,
  );
  assert.equal(partial.admission.status, "partial");
  assert.deepEqual(
    partial.admission.outcomes.map((o) => o.status),
    ["answered", "not_established"],
  );
  const b = bundle(source),
    r = await resolveExplicitEvents({
      question: "Who approved the commercial scope?",
      bundle: b,
      sourceGeneration: 3,
    });
  const claim = r.admission.outcomes[0].claims[0],
    requirement = r.plan.requirements[0];
  const forged = {
    text: claim.text.replace("Priya", "Kamal"),
    slots: { ...claim.slots, actor: "Kamal" },
    citations: claim.citations,
  };
  assert.equal(
    verifyEventCertificate({
      plan: r.plan,
      requirement,
      claim: forged,
      bundle: b,
    }).ok,
    false,
  );
});

test("actor questions over arbitrary source language keep caller slots but cannot certify an event", async () => {
  const source = "Procurement record\nPriya approved the purchase order.";
  const r = await resolve("Who approved the purchase order?", source);
  assert.equal(r.admission.userReady, false);
  assert.equal(r.plan.requirements[0].slots.action, "approve");
});

test("literal role-field observations bind exact record heading and exact action label independently", async () => {
  const source =
    "# PURCHASE ORDER PO-55120\n\nAPPROVED / SIGNED\nApproved by: Priya Nair, Head of Procurement Approval date: 03 Nov 2026\n\n# DELIVERY NOTE DN-901\nSigned by: Kamal";
  const r = await resolve("Who approved the purchase order?", source);
  assert.equal(r.admission.complete, true);
  const c = r.admission.outcomes[0].claims[0];
  assert.equal(c.operation, "recorded-role-field");
  assert.match(c.text, /Priya Nair/);
  assert.match(c.text, /not confirmation that the event occurred/);
  assert.deepEqual(
    c.citations.map((c) => c.quote),
    [
      "# PURCHASE ORDER PO-55120",
      "Approved by: Priya Nair, Head of Procurement Approval date: 03 Nov 2026",
    ],
  );
  for (const q of [
    "Who signed the purchase order?",
    "Who approved the delivery note?",
    "Who approved the scope?",
  ])
    assert.equal((await resolve(q, source)).admission.userReady, false, q);
  const mixed = await resolve(
    "Who approved the purchase order and who signed the purchase order?",
    source,
  );
  assert.equal(mixed.admission.status, "partial");
  const conflicting = await resolve(
    "Who approved the purchase order?",
    source + "\n# PURCHASE ORDER PO-992\nApproved by: Noor",
  );
  assert.equal(conflicting.admission.status, "clarify");
  const amended = await resolve(
    "Who approved the purchase order?",
    source.replace(
      "# PURCHASE ORDER PO-55120",
      "# NOT THE PURCHASE ORDER PO-55120",
    ),
  );
  assert.equal(amended.admission.userReady, false);
  const b = bundle(source);
  const forged = { ...c, text: c.text.replace("Priya", "Noor") };
  assert.equal(
    verifyEventCertificate({
      plan: r.plan,
      requirement: r.plan.requirements[0],
      claim: forged,
      bundle: b,
    }).ok,
    false,
  );
});

test("amount completion preserves payer/payee/action and complete repeated interrogatives", async () => {
  const source =
    "Arjun paid $1,500 to Nimbus.\nNimbus paid $5,000 to Arjun.\nPriya approved the commercial scope.";
  for (const [q, amount] of [
    ["How much did Arjun pay to Nimbus?", "$1,500"],
    ["How much did Nimbus pay to Arjun?", "$5,000"],
  ]) {
    const r = await resolve(q, source);
    assert.equal(r.plan.requirements[0].answerSlot, "amount");
    assert.equal(r.admission.complete, true);
    assert.equal(r.admission.outcomes[0].claims[0].slots.amount, amount);
  }
  for (const q of [
    "How much did Priya pay to Nimbus?",
    "How much did Arjun owe to Nimbus?",
  ])
    assert.equal((await resolve(q, source)).admission.userReady, false, q);
  const compound = await resolve(
    "How much did Arjun pay to Nimbus and how much did Nimbus pay to Arjun?",
    source,
  );
  assert.equal(compound.admission.complete, true);
  assert.deepEqual(
    compound.admission.outcomes.map((o) => o.claims[0].slots.amount),
    ["$1,500", "$5,000"],
  );
  const mixed = await resolve(
    "How much did Arjun pay to Nimbus and how much did Arjun owe to Nimbus?",
    source,
  );
  assert.equal(mixed.admission.status, "partial");
  assert.deepEqual(
    mixed.admission.outcomes.map((o) => o.status),
    ["answered", "not_established"],
  );
  const owed = await resolve(
    "How much did Arjun owe to Nimbus?",
    "Arjun owed $900 to Nimbus.",
  );
  assert.equal(owed.admission.complete, true);
  assert.equal(owed.admission.outcomes[0].claims[0].slots.action, "owe");
  const conflict = await resolve(
    "How much did Arjun pay to Nimbus?",
    source + "\nArjun paid $2,000 to Nimbus.",
  );
  assert.equal(conflict.admission.status, "clarify");
  const negative = await resolve(
    "How much did Arjun pay to Nimbus?",
    "Arjun did not pay $1,500 to Nimbus.",
  );
  assert.equal(negative.admission.userReady, false);
  const r = await resolve("How much did Arjun pay to Nimbus?", source);
  const claim = r.admission.outcomes[0].claims[0];
  assert.equal(
    verifyEventCertificate({
      plan: r.plan,
      requirement: r.plan.requirements[0],
      claim: { ...claim, slots: { ...claim.slots, amount: "$5,000" } },
      bundle: bundle(source),
    }).ok,
    false,
  );
});

test("exact event prefix retains the complete opaque conjunction and remainder without a whole-answer certificate", async () => {
  const b = bundle(
    "Arjun paid $1,500 to Nimbus.\nNimbus paid $5,000 to Arjun.",
  );
  const q = "How much did Arjun pay to Nimbus and when and who approved it?";
  const plan = eventRemainderPlan(q, b, 3);
  assert.equal(plan.coverageEstablished, false);
  assert.equal(plan.originalQuestion, q);
  assert.equal(plan.unresolvedRemainder, " and when and who approved it?");
  assert.ok(Object.isFrozen(plan.requirements[1]));
  const r = await resolveExplicitEventRemainder({
    question: q,
    bundle: b,
    sourceGeneration: 3,
  });
  assert.equal(r.admission.status, "partial");
  assert.equal(r.admission.complete, false);
  assert.equal(r.requirementCoverage.semanticAdmissionVerified, false);
  assert.deepEqual(
    r.admission.outcomes.map((o) => o.status),
    ["answered", "not_established"],
  );
  assert.equal(r.requirementCoverage.prefixAdmission.admission.complete, true);
  const or =
    "How much did Arjun pay to Nimbus or how much did Nimbus pay to Arjun?";
  const disjunction = await resolveExplicitEventRemainder({
    question: or,
    bundle: b,
    sourceGeneration: 3,
  });
  assert.equal(disjunction.admission.userReady, false);
  assert.equal(
    disjunction.admission.outcomes.flatMap((o) => o.claims).length,
    0,
  );
  assert.equal(
    disjunction.plan.unresolvedRemainder,
    " or how much did Nimbus pay to Arjun?",
  );
  assert.equal(
    eventRemainderPlan(
      "How much did Arjun pay to Nimbus and how much did Nimbus pay to Arjun?",
      b,
      3,
    ),
    null,
  );
  assert.equal(
    eventRemainderPlan("How much did Arjun pay to Nimbus if approved?", b, 3)
      .unresolvedRemainder,
    " if approved?",
  );
  assert.equal(
    await resolveExplicitEventRemainder({
      question: q,
      bundle: b,
      sourceGeneration: 3,
      isCurrent: () => false,
    }),
    null,
  );
});

test("any trailing event qualifier remains opaque and cannot be dropped or treated as an independent answer part", async () => {
  const b = bundle(
    "Arjun paid $1,500 to Nimbus.\nNimbus paid $5,000 to Arjun.",
  );
  for (const suffix of [
    "yesterday",
    "in total",
    "since launch",
    "if approved",
    "during the last period",
    "exactly",
    "for the final version",
    "and only if approved",
  ]) {
    const q = "How much did Arjun pay to Nimbus " + suffix + "?";
    const r = await resolveExplicitEventRemainder({
      question: q,
      bundle: b,
      sourceGeneration: 3,
    });
    assert.ok(r, q);
    assert.equal(r.plan.coverageEstablished, false);
    assert.equal(r.plan.unresolvedRemainder, " " + suffix + "?");
    assert.equal(r.plan.connective, "qualifier");
    assert.equal(r.admission.userReady, false);
    assert.equal(r.admission.outcomes.flatMap((o) => o.claims).length, 0);
    assert.equal(r.requirementCoverage.prefixAdmission, null);
  }
  assert.equal(
    eventRemainderPlan("How much did Arjun pay to Nimbus?", b, 3),
    null,
  );
});

test("recipient completion binds payer action amount and positive polarity without reciprocal swapping", async () => {
  const source = "Arjun paid $1,500 to Nimbus.\nNimbus paid $5,000 to Arjun.";
  for (const [q, actor, recipient, amount] of [
    ["To whom did Arjun pay $1,500?", "Arjun", "Nimbus", "$1,500"],
    ["Who did Nimbus pay $5,000 to?", "Nimbus", "Arjun", "$5,000"],
  ]) {
    const r = await resolve(q, source);
    assert.ok(r, q);
    assert.equal(r.plan.requirements[0].answerSlot, "recipient");
    assert.equal(r.plan.requirements[0].slots.recipient, null);
    assert.equal(r.admission.complete, true);
    assert.deepEqual(
      [
        r.admission.outcomes[0].claims[0].slots.actor,
        r.admission.outcomes[0].claims[0].slots.recipient,
        r.admission.outcomes[0].claims[0].slots.amount,
      ],
      [actor, recipient, amount],
    );
  }
  for (const q of [
    "To whom did Nimbus pay $1,500?",
    "Who did Arjun owe $1,500 to?",
    "Who did Priya pay $1,500 to?",
  ])
    assert.equal((await resolve(q, source)).admission.userReady, false, q);
  const c = await resolve(
    "To whom did Arjun pay $1,500?",
    source + "\nArjun paid $1,500 to Orion.",
  );
  assert.equal(c.admission.status, "clarify");
  assert.equal(
    (
      await resolve(
        "To whom did Arjun pay $1,500?",
        "Arjun did not pay $1,500 to Nimbus.",
      )
    ).admission.userReady,
    false,
  );
  const mixed = await resolve(
    "To whom did Arjun pay $1,500 and who did Arjun owe $1,500 to?",
    source,
  );
  assert.equal(mixed.admission.status, "partial");
  assert.deepEqual(
    mixed.admission.outcomes.map((o) => o.status),
    ["answered", "not_established"],
  );
  const r = await resolve("To whom did Arjun pay $1,500?", source);
  const claim = r.admission.outcomes[0].claims[0];
  assert.equal(
    verifyEventCertificate({
      plan: r.plan,
      requirement: r.plan.requirements[0],
      claim: { ...claim, slots: { ...claim.slots, recipient: "Arjun" } },
      bundle: bundle(source),
    }).ok,
    false,
  );
});

test("rejection-only event candidate provenance requires real source spans and does not certify incomplete source context", () => {
  const text =
    "Payment ledger\nArjun paid $1,500 to Nimbus.\nOther unknown context.";
  const b = bundle(text);
  const start = text.indexOf("Arjun"),
    quote = "Arjun paid $1,500 to Nimbus.";
  const citation = { sourceId: "s", start, end: start + quote.length, quote };
  assert.equal(eventSourceFacts(b).complete, false);
  assert.equal(candidateUsesEventAssertion({ citations: [citation] }, b), true);
  assert.equal(
    candidateUsesEventAssertion(
      { citations: [{ ...citation, quote: "Arjun paid $5,000 to Nimbus." }] },
      b,
    ),
    false,
  );
  assert.equal(
    candidateUsesEventAssertion(
      { citations: [{ ...citation, sourceId: "different" }] },
      b,
    ),
    false,
  );
  assert.equal(
    candidateUsesEventAssertion(
      {
        citations: [
          { sourceId: "s", start: 0, end: 14, quote: "Payment ledger" },
        ],
      },
      b,
    ),
    false,
  );
  assert.equal(
    candidateUsesEventAssertion(
      {
        citations: [{ sourceId: "s", start: 0, end: text.length, quote: text }],
      },
      b,
    ),
    true,
  );
  assert.equal(candidateUsesEventAssertion(null, b), false);
});

test("negative present-debt amount cannot be supported by a positive same-actor debt assertion", () => {
  const text = "Debt ledger\nArjun owes $1,500.\nNimbus owes $5,000.";
  const b = bundle(text);
  const quote = "Arjun owes $1,500.",
    start = text.indexOf(quote);
  const lead = {
    citations: [{ sourceId: "s", start, end: start + quote.length, quote }],
  };
  assert.equal(
    debtPolarityConflict("How much does Arjun not owe?", lead, b),
    true,
  );
  for (const q of [
    "How much does Nimbus not owe?",
    "How much does Arjun owe?",
    "How much did Arjun not owe?",
    "How much does Arjun not owe yesterday?",
  ])
    assert.equal(debtPolarityConflict(q, lead, b), false, q);
  assert.equal(
    debtPolarityConflict(
      "How much does Arjun not owe?",
      { citations: [{ ...lead.citations[0], quote: "Arjun owes $9,000." }] },
      b,
    ),
    false,
  );
  assert.equal(
    debtPolarityConflict(
      "How much does Arjun not owe?",
      { citations: [{ ...lead.citations[0], sourceId: "other" }] },
      b,
    ),
    false,
  );
});
