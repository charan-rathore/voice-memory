import test from "node:test";
import assert from "node:assert/strict";
import { createLocalServer } from "../src/server.mjs";
import { clinicalListPlan } from "../src/clinical-requirements.mjs";
test("caller-owned explicit clinical test list has immutable separate targets, not arbitrary compound parsing", () => {
  const q = "What are SYN-0001's ferritin and TSH results?";
  const p = clinicalListPlan(q, { sources: [] }, 1, "SYN-0001");
  assert.equal(p.originalQuestion, q);
  assert.deepEqual(
    p.requirements.map((r) => r.slots.object),
    ["ferritin", "tsh"],
  );
  assert.ok(Object.isFrozen(p.requirements[0].slots));
  for (const question of [
    "What are SYN-0001's latest ferritin and TSH results?",
    "What are SYN-0001's ferritin and who approved treatment results?",
    "What are SYN-0001's ferritin and SYN-0003's TSH results?",
    "What are SYN-0001's ferritin and ferritin results?",
    "What was SYN-0001's ferritin before correction and what is it now?",
  ]) {
    assert.equal(
      clinicalListPlan(question, { sources: [] }, 1, "SYN-0001"),
      null,
      question,
    );
  }
});
test("actual HTTP and fake voice preserve every requested clinical test without silently dropping missing sodium", async () => {
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
  const forbidden = async () => {
    calls++;
    throw Error("no providers");
  };
  const s = createLocalServer({
    port: 0,
    gemini: {
      enabled: () => true,
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
  const ask = (question) =>
    fetch(base + "/ask", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ case: "health", question, semantic: false }),
    }).then((r) => r.json());
  try {
    const key = await fetch(base + "/llm/key", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ case: "health" }),
    }).then((r) => r.json());
    const voice = async (question) => {
      const r = await fetch(base + "/llm/v1/chat/completions", {
        method: "POST",
        headers: {
          authorization: "Bearer " + key.apiKey,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          stream: true,
          messages: [{ role: "user", content: question }],
        }),
      });
      assert.equal(r.status, 200);
      const raw = await r.text();
      return [...raw.matchAll(/^data: (.+)$/gm)]
        .filter((m) => m[1] !== "[DONE]")
        .map((m) => JSON.parse(m[1]).choices?.[0]?.delta?.content ?? "")
        .join("");
    };
    const partialQ = "What are SYN-0001's ferritin and sodium results?";
    const partial = await ask(partialQ);
    assert.equal(partial.final.kind, "partial");
    assert.match(partial.final.text, /50 ng\/mL/);
    assert.match(partial.final.text, /sodium: I could not establish/);
    assert.equal(partial.questionPlan.requirements.length, 2);
    assert.deepEqual(
      partial.requirementCoverage.outcomes.map((o) => o.status),
      ["answered", "not_established"],
    );
    assert.equal(partial.requirementCoverage.semanticAdmissionVerified, false);
    assert.equal(partial.questionPlan.originalQuestion, partialQ);
    assert.equal(await voice(partialQ), partial.final.text);
    const q = "What are SYN-0001's ferritin and TSH results?",
      complete = await ask(q);
    assert.match(complete.final.text, /50 ng\/mL/);
    assert.match(complete.final.text, /0\.30 mIU\/L/);
    assert.equal(complete.final.kind, "answered");
    assert.ok(complete.final.citations.some((c) => /Ferritin/.test(c.quote)));
    assert.ok(complete.final.citations.some((c) => /TSH/.test(c.quote)));
    assert.equal(await voice(q), complete.final.text);
    const reverse = await ask("What are SYN-0001's TSH and ferritin results?");
    assert.match(reverse.final.text, /0\.30 mIU\/L/);
    assert.match(reverse.final.text, /50 ng\/mL/);
    const historical = await ask(
      "What was SYN-0001's ferritin before the correction and what is it now?",
    );
    assert.match(historical.final.text, /5 ng\/mL/);
    assert.match(historical.final.text, /50 ng\/mL/);
    const multi = await ask(
      "What are SYN-0001's ferritin and SYN-0003's TSH results?",
    );
    assert.match(multi.final.text, /50 ng\/mL/);
    assert.match(multi.final.text, /2\.10 mIU\/L/);
    assert.equal(calls, 0);
  } finally {
    s.closeAllConnections();
    await new Promise((r) => s.close(r));
    for (const n of names)
      if (saved[n] === undefined) delete process.env[n];
      else process.env[n] = saved[n];
  }
});
