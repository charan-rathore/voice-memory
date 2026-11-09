// Exposed built-in synthetic records only, no frozen semantic cases/providers.
import test from "node:test";
import assert from "node:assert/strict";
import { createLocalServer } from "../src/server.mjs";
test("multi-owner source blocks cannot promote a partly missing request to a whole answered result", async () => {
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
    const partialQ = "What is ferritin for SYN-0001 and SYN-0003?";
    const partial = await ask(partialQ);
    assert.equal(partial.final.kind, "partial");
    assert.match(partial.final.text, /50 ng\/mL/);
    assert.match(partial.final.text, /SYN-0003.*could not establish/);
    assert.equal(partial.questionPlan.originalQuestion, partialQ);
    assert.equal(partial.questionPlan.coverageEstablished, true);
    assert.equal(partial.requirementCoverage.scope, "owner-test-coverage-only");
    assert.equal(partial.requirementCoverage.semanticAdmissionVerified, false);
    assert.deepEqual(
      partial.requirementCoverage.outcomes.map((o) => [o.owner, o.status]),
      [
        ["SYN-0001", "answered"],
        ["SYN-0003", "not_established"],
      ],
    );
    assert.equal(
      await voice([{ role: "user", content: partialQ }]),
      partial.final.text,
    );
    const completeQ = "What is TSH for SYN-0001 and SYN-0003?";
    const complete = await ask(completeQ);
    assert.equal(complete.final.kind, "answered");
    assert.match(complete.final.text, /0.30/);
    assert.match(complete.final.text, /2.10/);
    assert.equal(complete.requirementCoverage.complete, true);
    assert.equal(complete.requirementCoverage.semanticAdmissionVerified, false);
    assert.equal(
      await voice([{ role: "user", content: completeQ }]),
      complete.final.text,
    );
    const missingQ = "What is sodium for SYN-0001 and SYN-0003?";
    const missing = await ask(missingQ);
    assert.equal(missing.final.kind, "abstained");
    assert.equal(missing.final.citations.length, 0);
    assert.equal(missing.requirementCoverage.complete, false);
    assert.deepEqual(
      missing.requirementCoverage.outcomes.map((o) => o.status),
      ["not_established", "not_established"],
    );
    assert.equal(
      await voice([{ role: "user", content: missingQ }]),
      missing.final.text,
    );
    const reversed = await ask("What is ferritin for SYN-0003 and SYN-0001?");
    assert.equal(reversed.final.kind, "partial");
    assert.deepEqual(
      Object.fromEntries(
        reversed.requirementCoverage.outcomes.map((o) => [o.owner, o.status]),
      ),
      { "SYN-0003": "not_established", "SYN-0001": "answered" },
    );
    const generic = await ask(
      "What are the results for SYN-0001 and SYN-0003?",
    );
    assert.equal(generic.final.kind, "partial");
    assert.equal(generic.requirementCoverage.semanticAdmissionVerified, false);
    assert.equal(calls, 0);
  } finally {
    s.closeAllConnections();
    await new Promise((r) => s.close(r));
    for (const n of names)
      if (saved[n] === undefined) delete process.env[n];
      else process.env[n] = saved[n];
  }
});
