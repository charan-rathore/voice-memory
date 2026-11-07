import { test } from "node:test";
import assert from "node:assert/strict";
import { createLocalServer } from "../src/server.mjs";
import { createVoiceAdapter } from "../src/voice-adapter.mjs";
import { importBundle } from "../dist/engine.mjs";
const q = "What is the Copper parking permit number?";
const scenarios = [
  {
    name: "other owner",
    text: "The Copper reference code is COP-731. The Violet parking permit number is PP-902.",
    ok: false,
  },
  {
    name: "wrong category",
    text: "The Copper entry permit number is EP-204. Parking was discussed at the Copper meeting.",
    ok: false,
  },
  {
    name: "empty record",
    text: "Entity: Copper\nParking permit number:\nEntity: Violet\nParking permit number: PP-902",
    ok: false,
  },
  {
    name: "template",
    text: "The Copper parking permit number is PP-123 (example only). No actual permit has been assigned.",
    ok: false,
  },
  {
    name: "conflict",
    text: "The Copper parking permit number is PP-204.\nThe Copper parking permit number is PP-902.",
    ok: false,
  },
  {
    name: "unknown table",
    text: "Entity | Parking permit number | Reference code\nCopper | Not assigned | COP-731\nViolet | PP-902 | VIO-419",
    ok: true,
    match: /Not assigned/i,
  },
  {
    name: "proposed",
    text: "The proposed Copper parking permit number is PP-204.",
    ok: true,
    match: /proposed/i,
  },
];
test("public typed and streaming voice paths preserve identifier bindings and refusals", async () => {
  const oldLimit = process.env.VM_WS_PER_IP_HOUR;
  const oldAudience = process.env.VM_SEMANTIC_AUDIENCE;
  process.env.VM_WS_PER_IP_HOUR = "20";
  process.env.VM_SEMANTIC_AUDIENCE = "all";
  let providerCalls = 0;
  const forbiddenProviderCall = async () => {
    providerCalls++;
    throw Error("Unexpected provider rescue");
  };
  const gemini = {
    enabled: () => true,
    searchEnabled: () => true,
    status: () => ({ enabled: true }),
    interpret: forbiddenProviderCall,
    planClaims: forbiddenProviderCall,
    groundedExplain: forbiddenProviderCall,
  };
  const server = createLocalServer({ port: 0, gemini });
  if (oldLimit === undefined) delete process.env.VM_WS_PER_IP_HOUR;
  else process.env.VM_WS_PER_IP_HOUR = oldLimit;
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}/api/public`;
  try {
    for (const scenario of scenarios) {
      const created = await fetch(base + "/workspace", { method: "POST" });
      assert.equal(created.status, 200);
      const { id } = await created.json();
      const text =
        "# Copper planning\n\n" +
        scenario.text +
        "\n\nThe session is a draft and requires twelve badges.";
      const upload = await fetch(`${base}/workspace/${id}/upload`, {
        method: "POST",
        headers: { "x-file-name": "copper.md" },
        body: text,
      });
      assert.equal(upload.status, 202);
      let ready = false;
      for (let i = 0; i < 100; i++) {
        const data = await fetch(`${base}/workspace/${id}`).then((r) =>
          r.json(),
        );
        if (data.documents[0]?.status === "ready") {
          ready = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 50));
      }
      assert.ok(ready);
      const response = await fetch(base + "/ask", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ case: id, question: q, semantic: true }),
      });
      assert.equal(response.status, 200);
      const typed = await response.json();
      const adapter = createVoiceAdapter();
      const token = adapter.bind(
        importBundle([{ title: "Copper planning", text }]),
      );
      try {
        const voice = await adapter.handle(
          new Request("http://localhost/v1/chat/completions", {
            method: "POST",
            headers: { authorization: "Bearer " + token },
            body: JSON.stringify({
              stream: true,
              messages: [{ role: "user", content: q }],
            }),
          }),
        );
        assert.equal(voice.status, 200);
        const wire = await voice.text();
        const turn = adapter.lastTurn(token);
        assert.equal(turn.result.refused, !scenario.ok, scenario.name);
        if (scenario.ok) {
          assert.match(typed.lead?.text ?? "", scenario.match, scenario.name);
          assert.match(turn.spokenTurn.spoken, scenario.match, scenario.name);
          assert.ok(typed.lead.citations.length);
        } else {
          assert.equal(
            typed.lead?.verdict ?? "UNKNOWN",
            "UNKNOWN",
            scenario.name,
          );
          assert.equal(typed.lead?.citations?.length ?? 0, 0);
          assert.doesNotMatch(
            typed.answer ?? "",
            /PP-902|COP-731|PP-123|EP-204/,
            scenario.name,
          );
          assert.doesNotMatch(
            wire,
            /PP-902|COP-731|PP-123|EP-204/,
            scenario.name,
          );
        }
      } finally {
        adapter.revoke(token);
      }
    }
    assert.equal(
      providerCalls,
      0,
      "Identifier decisions never invoke the enabled fake semantic provider",
    );
  } finally {
    await new Promise((r) => server.close(r));
    if (oldAudience === undefined) delete process.env.VM_SEMANTIC_AUDIENCE;
    else process.env.VM_SEMANTIC_AUDIENCE = oldAudience;
  }
});
