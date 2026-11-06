import { test } from "node:test";
import assert from "node:assert/strict";
import { createVoiceAdapter } from "../src/voice-adapter.mjs";
import { importBundle } from "../dist/engine.mjs";
const caseId = "w_" + "a".repeat(32);
const make = (n) =>
  importBundle(
    [
      {
        id: "safety",
        title: "Warehouse safety",
        text: `The east warehouse recorded ${n} open safety items during the October safety review. Nine items are overdue and require action.`,
      },
    ],
    { scope: caseId },
  );
const spoken = (raw) =>
  [...raw.matchAll(/^data: (.+)$/gm)]
    .filter((m) => m[1] !== "[DONE]")
    .map((m) => JSON.parse(m[1]).choices?.[0]?.delta?.content || "")
    .join("");
for (const state of [
  "expired",
  "pending",
  "malformed",
  "exception",
  "replacement",
])
  test(`voice drops old evidence if workspace becomes ${state} before output`, async () => {
    const original = make(14);
    const replacement = make(77);
    const a = createVoiceAdapter();
    const token = a.bind(original);
    let reads = 0;
    a.setBundleResolver(() => {
      reads++;
      if (reads === 1) return { bundle: original, caseId, call: "call-a" };
      if (state === "exception") throw Error("resolver unavailable");
      if (state === "replacement")
        return { bundle: replacement, caseId, call: "call-a" };
      return {
        caseId,
        call: "call-a",
        [state]: state === "pending" ? "reading" : true,
      };
    });
    const r = await a.handle(
      new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { authorization: "Bearer " + token },
        body: JSON.stringify({
          stream: true,
          messages: [
            {
              role: "user",
              content:
                "How many open safety items did the east warehouse record?",
            },
          ],
        }),
      }),
    );
    const said = spoken(await r.text());
    assert.ok(reads >= 2);
    assert.doesNotMatch(said, /14|fourteen/i);
    assert.match(said, /changed|unavailable|again|expired/i);
    a.revoke(token);
  });
