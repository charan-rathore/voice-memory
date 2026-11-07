import { test } from "node:test";
import assert from "node:assert/strict";
import { parseBuffer } from "../ingest/parse.mjs";
import { importBundle } from "../dist/engine.mjs";
import { attachRecords, bundleFactAnswer } from "../src/record-facts.mjs";
import { createVoiceAdapter } from "../src/voice-adapter.mjs";
import { spokenTurn } from "../src/spoken.mjs";
import { cite } from "../src/spoken-routes.mjs";
process.env.VM_DENSE = "off";
for (const external of [false, true])
  test(`unknown record owner cannot be rescued in voice (${external ? "external" : "default"} retrieval)`, async () => {
    const docs = [];
    for (const [id, v] of [
      ["SYN-281", 100],
      ["SYN-392", 200],
    ])
      docs.push(
        (
          await parseBuffer(
            Buffer.from(
              `BILLING SUMMARY\nPatient name: Mira Sen\nPatient ID: ${id}\nTotal charges: USD ${v}.00`,
            ),
            id + ".txt",
          )
        ).doc,
      );
    const bundle = importBundle(
      docs.map((d, i) => ({ title: "billing" + i, text: d.text })),
    );
    attachRecords(
      bundle,
      docs.map((doc) => ({ doc })),
    );
    let retrievalCalls = 0;
    const adapter = createVoiceAdapter(
      external
        ? {
            retrieval: {
              actualMode: "keyword",
              retrieve: async () => {
                retrievalCalls++;
                throw Error("must not retrieve for unbound owner");
              },
            },
          }
        : {},
    );
    const token = adapter.bind(bundle);
    async function ask(q) {
      const response = await adapter.handle(
        new Request("http://localhost/v1/chat/completions", {
          method: "POST",
          headers: { authorization: "Bearer " + token },
          body: JSON.stringify({
            stream: true,
            messages: [{ role: "user", content: q }],
          }),
        }),
      );
      assert.equal(response.status, 200);
      return { wire: await response.text(), turn: adapter.lastTurn(token) };
    }
    for (const q of [
      "What were SYN-999 total charges?",
      "What were SYN-999 total charges and SYN-392 total charges?",
    ]) {
      const { wire, turn } = await ask(q);
      assert.equal(turn.spokenTurn.verdict, "UNBOUND_OWNER");
      assert.equal(turn.spokenTurn.citations.length, 0);
      assert.doesNotMatch(wire, /USD|100\.00|200\.00/);
      assert.match(wire, /cannot bind/);
      assert.equal(bundleFactAnswer(q, bundle, cite), null);
      assert.equal(spokenTurn(q, bundle).verdict, "UNBOUND_OWNER");
    }
    assert.equal(retrievalCalls, 0);
    adapter.revoke(token);
    if (!external) {
      const a = createVoiceAdapter();
      const t = a.bind(bundle);
      for (const [q, expected] of [
        ["What were SYN-392 total charges?", /200\.00/],
        ["What were Mira Sen total charges?", /Which patient do you mean/],
      ]) {
        const r = await a.handle(
          new Request("http://localhost/v1/chat/completions", {
            method: "POST",
            headers: { authorization: "Bearer " + t },
            body: JSON.stringify({
              stream: true,
              messages: [{ role: "user", content: q }],
            }),
          }),
        );
        assert.match(await r.text(), expected);
      }
      a.revoke(t);
    }
  });
