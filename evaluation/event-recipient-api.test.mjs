// Exposed synthetic event assertions, never frozen semantic cases or providers.
import test from "node:test";
import assert from "node:assert/strict";
import { createLocalServer } from "../src/server.mjs";
test("recipient completion preserves reciprocal payer/recipient binding and full compound outcomes", async () => {
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
    throw Error("No provider permission");
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
  const base = `http://127.0.0.1:${s.address().port}/api/public`;
  const ws = () =>
    fetch(base + "/workspace", { method: "POST" }).then((r) => r.json());
  const upload = async (w, name, body) => {
    assert.equal(
      (
        await fetch(`${base}/workspace/${w.id}/upload`, {
          method: "POST",
          headers: { "x-file-name": name },
          body,
        })
      ).status,
      202,
    );
    for (let i = 0; i < 200; i++) {
      const x = await fetch(`${base}/workspace/${w.id}`).then((r) => r.json());
      if (x.ready && x.documents.every((d) => d.status === "ready")) return;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw Error("not ready");
  };
  const ask = async (w, question) => {
    const r = await fetch(base + "/ask", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ case: w.id, question, semantic: false }),
    });
    assert.equal(r.status, 200);
    return r.json();
  };
  try {
    const w = await ws();
    await upload(
      w,
      "Assertions.txt",
      "Arjun paid $1,500 to Nimbus.\nNimbus paid $5,000 to Arjun.\nPriya approved the commercial scope.\nKamal signed the delivery plan.",
    );
    const key = await fetch(base + "/llm/key", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ case: w.id }),
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
    for (const [q, recipient] of [
      ["To whom did Arjun pay $1,500?", "Nimbus"],
      ["Who did Nimbus pay $5,000 to?", "Arjun"],
    ]) {
      const r = await ask(w, q);
      assert.equal(r.final.kind, "answered", q);
      assert.match(r.final.text, new RegExp(recipient + " as recipient"));
      assert.equal(
        r.admission.outcomes[0].claims[0].slots.recipient,
        recipient,
      );
      assert.equal(await voice(q), r.final.text);
    }
    for (const q of [
      "To whom did Nimbus pay $1,500?",
      "Who did Arjun owe $1,500 to?",
      "Who did Priya pay $1,500 to?",
    ]) {
      const r = await ask(w, q);
      assert.equal(r.final.kind, "abstained", q);
      assert.equal(r.final.citations.length, 0);
      assert.equal(await voice(q), r.final.text);
    }
    const compound =
      "To whom did Arjun pay $1,500 and who did Nimbus pay $5,000 to?";
    const all = await ask(w, compound);
    assert.equal(all.final.kind, "answered");
    assert.deepEqual(
      all.admission.outcomes.map((o) => o.claims[0].slots.recipient),
      ["Nimbus", "Arjun"],
    );
    assert.equal(await voice(compound), all.final.text);
    const mixed =
      "To whom did Arjun pay $1,500 and who did Arjun owe $1,500 to?";
    const partial = await ask(w, mixed);
    assert.equal(partial.final.kind, "partial");
    assert.deepEqual(
      partial.admission.outcomes.map((o) => o.status),
      ["answered", "not_established"],
    );
    assert.equal(await voice(mixed), partial.final.text);
    assert.equal(calls, 0);
  } finally {
    s.closeAllConnections();
    await new Promise((r) => s.close(r));
    for (const n of names)
      if (saved[n] === undefined) delete process.env[n];
      else process.env[n] = saved[n];
  }
});
