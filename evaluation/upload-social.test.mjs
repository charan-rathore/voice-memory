import { test } from "node:test";
import assert from "node:assert/strict";
import { socialTurn, isSocialReply } from "../src/conversation.mjs";
import { createVoiceAdapter } from "../src/voice-adapter.mjs";
import { importBundle } from "../dist/engine.mjs";
for (const lang of ["en", "hi", "hinglish"])
  for (const q of [
    "hello",
    "can you hear me",
    "what can I ask",
    "say that again",
    "in hindi",
  ])
    test(`uploaded social reply stays grounded in its UI scope: ${lang}/${q}`, () => {
      const s = socialTurn(q, { lang, uploaded: true });
      assert.ok(s);
      assert.doesNotMatch(
        s.spoken,
        /SYN|S Y N|Northstar|ferritin|forty two thousand/i,
      );
      assert.ok(isSocialReply(s.spoken));
      if (s.intent === "HELP") assert.equal(s.action, undefined);
    });
test("document questions bypass social layer and repeat preserves the prior answer", () => {
  assert.equal(
    socialTurn("What is the document deadline?", { uploaded: true }),
    null,
  );
  const last = "The warehouse recorded 14 open safety items.";
  assert.equal(
    socialTurn("say that again", { uploaded: true, last }).spoken,
    last,
  );
  assert.match(socialTurn("hello").spoken, /ferritin/);
});
test("actual adapter selects upload social replies from the server-owned workspace", async () => {
  const bundle = importBundle([
    {
      title: "Warehouse",
      text: "The east warehouse recorded fourteen open safety items during its latest safety review.",
    },
  ]);
  const a = createVoiceAdapter();
  a.setBundleResolver(() => ({ bundle, caseId: "w_" + "a".repeat(32) }));
  const token = a.bind(bundle);
  const r = await a.handle(
    new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { authorization: "Bearer " + token },
      body: JSON.stringify({
        stream: true,
        messages: [{ role: "user", content: "hello" }],
      }),
    }),
  );
  assert.equal(r.status, 200);
  const raw = await r.text();
  assert.doesNotMatch(raw, /Northstar|ferritin|S Y N/);
  assert.match(raw, /uploaded/);
  a.revoke(token);
});
