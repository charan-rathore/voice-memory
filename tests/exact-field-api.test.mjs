import test from "node:test";
import assert from "node:assert/strict";
import { createLocalServer } from "../src/server.mjs";
test("actual upload/ask admits independent compound field requirements without a provider; conflicts preserve supported subanswer", async () => {
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
  const s = createLocalServer({
    port: 0,
    gemini: {
      enabled: () => true,
      searchEnabled: () => false,
      interpret: async () => {
        calls++;
        throw Error("no model");
      },
      documentRead: async () => {
        calls++;
        throw Error("no model");
      },
      documentAudit: async () => {
        calls++;
        throw Error("no model");
      },
    },
  });
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${s.address().port}/api/public`;
  try {
    const ws = await fetch(base + "/workspace", { method: "POST" }).then((r) =>
      r.json(),
    );
    const upload = async (name, body) => {
      const r = await fetch(`${base}/workspace/${ws.id}/upload`, {
        method: "POST",
        headers: { "x-file-name": name },
        body,
      });
      assert.equal(r.status, 202);
      for (let i = 0; i < 200; i++) {
        const state = await fetch(`${base}/workspace/${ws.id}`).then((r) =>
          r.json(),
        );
        if (state.ready && state.documents.every((d) => d.status === "ready"))
          return;
        await new Promise((r) => setTimeout(r, 20));
      }
      throw Error("upload not ready");
    };
    const ask = (question) =>
      fetch(base + "/ask", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ case: ws.id, question, semantic: false }),
      }).then((r) => r.json());
    await upload(
      "policy.txt",
      "Draft policy; conditions remain unresolved.\n| Field | Value |\n|---|---|\n| Handling window | 19 working days |\n| Approval status | Proposed, not approved |",
    );
    for (const question of [
      "What are the handling window and approval status?",
      "WHAT ARE THE HANDLING WINDOW AND APPROVAL STATUS?",
    ]) {
      const r = await ask(question);
      assert.equal(r.final.verdict, "SCHEMA_FIELDS");
      assert.equal(r.questionPlan.originalQuestion, question);
      assert.equal(r.questionPlan.coverageEstablished, true);
      assert.equal(r.questionPlan.requirements.length, 2);
      assert.equal(r.admission.complete, true);
      assert.match(r.final.text, /19 working days/);
      assert.match(r.final.text, /Proposed, not approved/);
      assert.equal(r.final.citations.length, 2);
      assert.ok(
        r.admission.outcomes.every((o) =>
          o.claims.every((c) => c.admission === "deterministic_verified"),
        ),
      );
    }
    const voiceKey = await fetch(base + "/llm/key", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ case: ws.id }),
    }).then((r) => r.json());
    const voiceAsk = async (question) => {
      const r = await fetch(base + "/llm/v1/chat/completions", {
        method: "POST",
        headers: {
          authorization: "Bearer " + voiceKey.apiKey,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          stream: true,
          messages: [{ role: "user", content: question }],
        }),
      });
      assert.equal(r.status, 200);
      const text = await r.text();
      return [...text.matchAll(/^data: (.+)$/gm)]
        .filter((m) => m[1] !== "[DONE]")
        .map((m) => JSON.parse(m[1]).choices?.[0]?.delta?.content ?? "")
        .join("");
    };
    const compound = "What are the handling window and approval status?";
    assert.equal(
      await voiceAsk(compound),
      (await ask(compound)).final.text,
      "bounded compound typed/voice must retain both field outcomes",
    );
    await upload(
      "conflict.txt",
      "| Field | Value |\n| Handling window | 7 days |",
    );
    const conflict = await ask(
      "What are the handling window and approval status?",
    );
    assert.equal(conflict.admission.status, "partial");
    assert.equal(conflict.admission.complete, false);
    assert.equal(conflict.final.verdict, "PARTIAL_FIELDS");
    assert.match(conflict.final.text, /Proposed, not approved/);
    assert.match(conflict.final.text, /conflicting table values/);
    assert.doesNotMatch(conflict.final.text, /19 working days|7 days/);
    assert.equal(
      await voiceAsk(compound),
      conflict.final.text,
      "voice keeps supported subanswer while field conflict stays explicit",
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
