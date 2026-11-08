// Exposed built-in synthetic records only, no frozen semantic cases/providers.
import test from "node:test";
import assert from "node:assert/strict";
import { createLocalServer } from "../src/server.mjs";
test("opt-in direct clinical factual turns use the typed resolver after channel repair without model consent", async () => {
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
    throw Error("no provider consent");
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
    for (const question of [
      "What is SYN-0001's ferritin result?",
      "What was SYN-0001's ferritin before the correction?",
      "Did SYN-0001's ferritin change since September?",
      "What is the TSH for SYN-0003?",
    ]) {
      const typed = await ask(question);
      assert.ok(typed.final.citations.length, question);
      const spoken = await voice([{ role: "user", content: question }]);
      assert.equal(spoken, typed.final.text, question);
    }
    const question = "What is SYN-0001's ferritin result?",
      first = await ask(question),
      follow = "What was it before the correction?";
    const typedFollow = await ask(follow, first.lead.field);
    const spokenFollow = await voice([
      { role: "user", content: question },
      { role: "assistant", content: first.final.text },
      { role: "user", content: follow },
    ]);
    assert.equal(
      spokenFollow,
      typedFollow.final.text,
      "follow-up version selection survives channel history",
    );
    assert.equal(calls, 0);
  } finally {
    s.closeAllConnections();
    await new Promise((r) => s.close(r));
    for (const n of names)
      if (saved[n] === undefined) delete process.env[n];
      else process.env[n] = saved[n];
  }
});

test("a clinical hit does not bypass the common resolver and its request retains repaired facts", async () => {
  const { readFileSync } = await import("node:fs");
  const { ingestFile } = await import("../ingest/index.mjs");
  const { importBundle } = await import("../dist/engine.mjs");
  const { clinicalReportsFor } = await import("../clinical/answer.mjs");
  const { extractReport } = await import("../clinical/observations.mjs");
  const { createVoiceAdapter } = await import("../src/voice-adapter.mjs");
  const file = "a-2026-10-amended.pdf";
  const doc = await ingestFile(
    readFileSync(
      new URL("../clinical/fixtures/files/" + file, import.meta.url),
    ),
    file,
  );
  assert.ok(doc.ok);
  const bundle = importBundle([{ title: file, text: doc.doc.text }]);
  bundle.clinical = clinicalReportsFor(
    bundle,
    [{ doc: doc.doc }],
    extractReport,
  );
  let captured;
  const adapter = createVoiceAdapter();
  adapter.setAnswerResolver(async (input) => {
    captured = input;
    return {
      lead: {
        text: "Shared boundary exercised.",
        verdict: "UNKNOWN",
        citations: [],
      },
    };
  });
  const token = adapter.bind(bundle);
  const response = await adapter.handle(
    new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { authorization: "Bearer " + token },
      body: JSON.stringify({
        stream: true,
        messages: [
          { role: "user", content: "What is SYN-0001's ferritin result?" },
        ],
      }),
    }),
  );
  assert.match(await response.text(), /Shared boundary exercised/);
  assert.equal(captured.bundle, bundle);
  assert.equal(
    captured.exactSchemaOnly,
    false,
    "direct clinical answers are not restricted to table fields",
  );
  assert.match(captured.question, /SYN-0001/);
  assert.match(captured.question, /ferritin/i);
});
