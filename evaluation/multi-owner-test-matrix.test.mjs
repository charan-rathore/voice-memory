// Exposed built-in synthetic records only, no frozen semantic cases/providers.
import test from "node:test";
import assert from "node:assert/strict";
import { clinicalOwnerTestPlan } from "../src/clinical-requirements.mjs";
import { createLocalServer } from "../src/server.mjs";
test("owner-test plan consumes complete inventory and binds exact unique printed labels", () => {
  const bundle = { sources: [{ id: "x", hash: "h", text: "source" }] };
  const owners = ["AA-1", "BB-2"];
  const labels = [
    { owner: "AA-1", name: "Alice Smith" },
    { owner: "BB-2", name: "Bob Jones" },
  ];
  const q = "What are Alice Smith and Bob Jones's TSH and ferritin results?";
  const p = clinicalOwnerTestPlan(q, bundle, 3, owners, labels);
  assert.equal(p.originalQuestion, q);
  assert.equal(p.requirements.length, 4);
  assert.equal(p.sourceGeneration, 3);
  assert.deepEqual(
    p.requirements.map((r) => [r.slots.targetOwner, r.slots.object]),
    [
      ["AA-1", "tsh"],
      ["AA-1", "ferritin"],
      ["BB-2", "tsh"],
      ["BB-2", "ferritin"],
    ],
  );
  assert.ok(Object.isFrozen(p.requirements[0].slots));
  assert.notEqual(
    clinicalOwnerTestPlan(q, { sources: [] }, 3, owners, labels).key,
    p.key,
  );
  assert.notEqual(
    clinicalOwnerTestPlan(q, bundle, 4, owners, labels).key,
    p.key,
  );
  for (const bad of [
    "What are TSH and TSH results for AA-1 and BB-2?",
    "What are TSH results for AA-1 and AA-1?",
    "What are TSH results for AA-1 and CC-3?",
    "What are TSH results for AA-1 and BB-2 yesterday?",
    "What are latest TSH results for AA-1 and BB-2?",
    "What are TSH or ferritin results for AA-1 and BB-2?",
    "What are Alice and Bob Jones's TSH results?",
    "What are AA-1's TSH and BB-2's TSH results yesterday?",
  ])
    assert.equal(
      clinicalOwnerTestPlan(bad, bundle, 3, owners, labels),
      null,
      bad,
    );
  assert.equal(
    clinicalOwnerTestPlan(q, bundle, 3, owners, [
      ...labels,
      { owner: "CC-3", name: "Alice Smith" },
    ]),
    null,
  );
});
test("multi-owner test matrix requires every owner-test pair and does not discard constraints", async () => {
  const names = [
    "VM_SHARED_VOICE_REASONING",
    "VM_BYO_VOICE",
    "VM_COUNTERS_ALLOW_FILE",
  ];
  const saved = Object.fromEntries(names.map((n) => [n, process.env[n]]));
  Object.assign(process.env, {
    VM_SHARED_VOICE_REASONING: "on",
    VM_BYO_VOICE: "on",
    VM_COUNTERS_ALLOW_FILE: "on",
  });
  let calls = 0;
  let providerEnabled = true;
  const forbidden = async () => {
    calls++;
    throw Error("no provider consent");
  };
  const s = createLocalServer({
    port: 0,
    gemini: {
      enabled: () => providerEnabled,
      searchEnabled: () => false,
      interpret: forbidden,
      planClaims: forbidden,
      documentRead: forbidden,
      documentAudit: forbidden,
    },
  });
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  await s.loadPublicCases();
  const base = `http://127.0.0.1:${s.address().port}/api/public`;
  const ask = (question, context) =>
    fetch(base + "/ask", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        case: "health",
        question,
        context,
        semantic: false,
      }),
    }).then((r) => r.json());
  try {
    const key = await fetch(base + "/llm/key", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ case: "health" }),
    }).then((r) => r.json());
    assert.ok(key.apiKey);
    const voice = async (messages) => {
      const response = await fetch(base + "/llm/v1/chat/completions", {
        method: "POST",
        headers: {
          authorization: "Bearer " + key.apiKey,
          "content-type": "application/json",
        },
        body: JSON.stringify({ stream: true, messages }),
      });
      assert.equal(response.status, 200);
      const raw = await response.text();
      return [...raw.matchAll(/^data: (.+)$/gm)]
        .filter((m) => m[1] !== "[DONE]")
        .map((m) => JSON.parse(m[1]).choices?.[0]?.delta?.content ?? "")
        .join("");
    };
    const q = "What are TSH and sodium results for SYN-0001 and SYN-0003?";
    const partial = await ask(q);
    assert.equal(partial.final.kind, "partial");
    assert.equal(partial.questionPlan.originalQuestion, q);
    assert.deepEqual(
      partial.requirementCoverage.outcomes.map((o) => [
        o.owner,
        o.test,
        o.status,
      ]),
      [
        ["SYN-0001", "tsh", "answered"],
        ["SYN-0001", "sodium", "not_established"],
        ["SYN-0003", "tsh", "answered"],
        ["SYN-0003", "sodium", "not_established"],
      ],
    );
    assert.match(partial.final.text, /0.30/);
    assert.match(partial.final.text, /2.10/);
    assert.match(partial.final.text, /sodium.*could not establish/);
    assert.equal(partial.requirementCoverage.semanticAdmissionVerified, false);
    assert.equal(
      await voice([{ role: "user", content: q }]),
      partial.final.text,
    );
    const mixed = await ask(
      "What are ferritin and TSH results for SYN-0001 and SYN-0003?",
    );
    assert.equal(mixed.final.kind, "partial");
    assert.match(mixed.final.text, /50 ng/);
    assert.match(mixed.final.text, /0.30/);
    assert.match(mixed.final.text, /2.10/);
    assert.equal(
      mixed.requirementCoverage.outcomes.filter((o) => o.status === "answered")
        .length,
      3,
    );
    const complete = await ask(
      "What are TSH results for SYN-0003 and SYN-0001?",
    );
    assert.equal(complete.final.kind, "answered");
    assert.match(complete.final.text, /0.30/);
    assert.match(complete.final.text, /2.10/);
    const missing = await ask(
      "What are sodium and potassium results for SYN-0001 and SYN-0003?",
    );
    assert.equal(missing.final.kind, "abstained");
    assert.equal(missing.final.citations.length, 0);
    for (const suffix of [
      " yesterday",
      " if treatment was approved",
      " in total",
      " before correction",
    ]) {
      const question = "What is TSH for SYN-0001 and SYN-0003" + suffix + "?";
      const r = await ask(question);
      assert.notEqual(r.final.kind, "answered", question);
      assert.equal(r.final.citations.length, 0);
      assert.equal(r.questionPlan.originalQuestion, question);
      assert.equal(
        await voice([{ role: "user", content: question }]),
        r.final.text,
      );
    }
    assert.equal(calls, 0);
  } finally {
    s.closeAllConnections();
    await new Promise((r) => s.close(r));
    for (const n of names)
      if (saved[n] === undefined) delete process.env[n];
      else process.env[n] = saved[n];
  }
});
