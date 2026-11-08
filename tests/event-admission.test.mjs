import test from "node:test";
import assert from "node:assert/strict";
import {
  eventQuestionPlan,
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
