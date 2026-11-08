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
  const original = "What is SYN-0001's ferriting result?";
  const response = await adapter.handle(
    new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { authorization: "Bearer " + token },
      body: JSON.stringify({
        stream: true,
        messages: [{ role: "user", content: original }],
      }),
    }),
  );
  assert.match(await response.text(), /Shared boundary exercised/);
  assert.equal(captured.bundle, bundle);
  assert.equal(
    captured.originalQuestion,
    original,
    "raw utterance precedes repairs and history",
  );
  assert.notEqual(
    captured.question,
    original,
    "repair is a distinct candidate",
  );
  assert.equal(
    captured.exactSchemaOnly,
    false,
    "direct clinical answers are not restricted to table fields",
  );
  assert.match(captured.question, /SYN-0001/);
  assert.match(captured.question, /ferritin/i);
});

test("actual local voice contract keeps original utterance in its opaque plan separately from repaired retrieval", async () => {
  const { readFileSync } = await import("node:fs");
  const previous = process.env.VM_SHARED_VOICE_REASONING;
  process.env.VM_SHARED_VOICE_REASONING = "on";
  const server = createLocalServer({
    port: 0,
    gemini: { enabled: () => false, searchEnabled: () => false },
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const session = await fetch(base + "/api/session");
    const cookie = session.headers.get("set-cookie").split(";")[0];
    const csrf = (await session.json()).csrf;
    const headers = { cookie, origin: base, "X-CSRF-Token": csrf };
    const post = (path, data) =>
      fetch(base + "/api/" + path, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify(data),
      });
    const file = "a-2026-10-amended.pdf";
    const upload = await fetch(base + "/api/upload", {
      method: "POST",
      headers: { ...headers, "x-file-name": file },
      body: readFileSync(
        new URL("../clinical/fixtures/files/" + file, import.meta.url),
      ),
    });
    assert.equal(upload.status, 202);
    let ready = false;
    for (let i = 0; i < 300; i++) {
      const lib = await fetch(base + "/api/library", {
        headers: { cookie },
      }).then((r) => r.json());
      if (lib.indexed === 1) {
        ready = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.ok(ready);
    assert.equal((await post("voice/start", {})).status, 200);
    const original = "What is SYN-0001's ferriting result?";
    const response = await post("voice/turn", {
      stream: true,
      messages: [{ role: "user", content: original }],
    });
    assert.equal(response.status, 200);
    assert.match(await response.text(), /50/);
    const { turn } = await fetch(base + "/api/voice/last", {
      headers: { cookie },
    }).then((r) => r.json());
    const plan = turn.spokenTurn.questionPlan;
    assert.equal(plan.originalQuestion, original);
    assert.equal(plan.requirements[0].protectedText, original);
    assert.equal(plan.coverageEstablished, false);
    assert.equal(plan.semanticQualification, "unresolved");
    assert.equal(plan.normalizationCandidates.length, 1);
    assert.match(plan.normalizationCandidates[0].text, /Ferritin/i);
    assert.notEqual(plan.normalizationCandidates[0].text, original);
    assert.equal(
      plan.normalizationCandidates[0].semanticPreservationVerified,
      false,
    );
    // A fully consumed grammar for the repaired tail cannot certify the
    // caller's larger original utterance. It stays opaque, not exact-fields.
    assert.equal(
      (
        await post("import", {
          documents: [
            {
              title: "Synthetic custody table",
              text: "| Field | Value |\n| --- | --- |\n| custody | escrow |\n| reserve | 27 units |",
            },
          ],
        })
      ).status,
      200,
    );
    assert.equal((await post("voice/start", {})).status, 200);
    const compoundOriginal = "What is reserve? No, what is custody?";
    const repaired = await post("voice/turn", {
      stream: true,
      messages: [{ role: "user", content: compoundOriginal }],
    });
    assert.equal(repaired.status, 200);
    await repaired.text();
    const replay = await fetch(base + "/api/voice/last", {
      headers: { cookie },
    }).then((r) => r.json());
    assert.equal(
      replay.turn.spokenTurn.questionPlan.originalQuestion,
      compoundOriginal,
    );
    assert.equal(
      replay.turn.spokenTurn.questionPlan.coverageEstablished,
      false,
    );
    assert.equal(
      replay.turn.spokenTurn.admission,
      null,
      "repaired exact-table tail is not a certificate for raw request",
    );
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    if (previous === undefined) delete process.env.VM_SHARED_VOICE_REASONING;
    else process.env.VM_SHARED_VOICE_REASONING = previous;
  }
});
