import test from "node:test";
import assert from "node:assert/strict";
import { createLocalServer } from "../src/server.mjs";
import { createVoiceAdapter } from "../src/voice-adapter.mjs";
import { importBundle } from "../dist/engine.mjs";
import { parseBuffer } from "../ingest/parse.mjs";
import { attachRecords } from "../src/record-facts.mjs";
const a =
  "Parcel PINE-62; Tracking number: 555021; Recipient: Mira Chen; Units: 12.";
const b =
  "Parcel PINE-63; Tracking number: 555022; Recipient: Noor Vale; Units: 24.";
const collision =
  "Parcel PINE_62; Tracking number: 555022; Recipient: Noor Vale; Units: 24.\n" +
  a;
const fixtures = [
  [collision, "What is the tracking number for PINE-62?", "555021", "555022"],
  [collision, "What is the tracking number for PINE_62?", "555022", "555021"],
  [collision, "What is the tracking number for Pine 62?", null, "555022"],
  [
    b + "\n" + a,
    "What is the tracking number for PINE-62?",
    "555021",
    "555022",
  ],
  [
    b + "\n" + a,
    "What is the tracking number for Pine 62?",
    "555021",
    "555022",
  ],
  [a + "\n" + b, "Who is the recipient for PINE-63?", "Noor Vale", "Mira Chen"],
  [b + "\n" + a, "How many units for PINE-62?", "12", "24"],
  [
    "Order ORCHID-33; Recipient: Isha Sen; Document recorded for review.",
    "Who did not receive order ORCHID-33?",
    null,
    "Isha Sen",
  ],
  [
    "Order ORCHID-34; Recipient: not specified; Account manager Noor Vale.",
    "Who received order ORCHID-34?",
    "not specified",
    "Noor Vale",
  ],
];
test("actual public upload/ask lead obeys engine scope, including refusals and normalized ID", async () => {
  let modelCalls = 0;
  const gemini = new Proxy(
    {},
    {
      get: (_target, key) =>
        key === "enabled" || key === "searchEnabled"
          ? () => true
          : (..._args) => {
              modelCalls++;
              return Promise.resolve(null);
            },
    },
  );
  const oldLimit = process.env.VM_WS_PER_IP_HOUR;
  process.env.VM_WS_PER_IP_HOUR = "100";
  const server = createLocalServer({ port: 0, gemini });
  if (oldLimit === undefined) delete process.env.VM_WS_PER_IP_HOUR;
  else process.env.VM_WS_PER_IP_HOUR = oldLimit;
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}/api/public`;
  try {
    for (const [text, q, yes, no] of fixtures) {
      const ws = await (
        await fetch(base + "/workspace", { method: "POST" })
      ).json();
      const uploaded = await fetch(base + `/workspace/${ws.id}/upload`, {
        method: "POST",
        headers: { "x-file-name": "dispatch.txt" },
        body: text,
      });
      assert.equal(uploaded.status, 202);
      for (let i = 0; i < 100; i++) {
        const status = await (await fetch(base + `/workspace/${ws.id}`)).json();
        if (status.documents[0]?.status === "ready") break;
        if (i === 99) throw Error("upload timeout");
        await new Promise((r) => setTimeout(r, 30));
      }
      const response = await fetch(base + "/ask", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ case: ws.id, question: q, semantic: true }),
      });
      assert.equal(response.status, 200);
      const r = await response.json();
      const shown = r.lead?.text ?? "";
      assert.ok(!shown.includes(no), JSON.stringify({ q, r }));
      if (yes) assert.ok(shown.includes(yes), JSON.stringify({ q, r }));
      else assert.notEqual(r.lead?.verdict, "QUOTED", JSON.stringify({ q, r }));
      for (const e of r.lead?.citations ?? []) {
        assert.ok(
          e.documentId,
          "public lead citation must open the uploaded document",
        );
        assert.ok(e.location, "public lead citation retains source location");
        assert.equal(text.slice(e.start, e.end), e.quote);
        assert.ok(!e.quote.includes(no));
      }
    }
    assert.equal(
      modelCalls,
      0,
      "a bounded scope/refusal cannot be replaced by model rescue",
    );
  } finally {
    await new Promise((r) => server.close(r));
  }
});
for (const external of [false, true])
  test(
    "voice adapter SSE returned text and retained turn obey same scope with real parsed records external=" +
      external,
    async () => {
      for (const [text, q0, yes, no] of fixtures) {
        const q = q0.includes("Pine 62")
          ? q0.replace("Pine 62", "Pine sixty two")
          : q0;
        const parsed = await parseBuffer(Buffer.from(text), "dispatch.txt");
        assert.ok(parsed.doc);
        const bundle = importBundle([
          { title: "dispatch.txt", text: parsed.doc.text },
        ]);
        attachRecords(bundle, [{ doc: parsed.doc }]);
        const adapter = createVoiceAdapter(
          external
            ? {
                retrieval: {
                  actualMode: "keyword",
                  embeddingModel: null,
                  retrieve: async (_q, b) => ({
                    actualMode: "keyword",
                    corpusId: b.scope,
                    corpusScope: "corpus",
                    evidence: "positive",
                    chunks: b.sources.map((source) => ({
                      chunkId: "fixture",
                      documentId: source.id,
                      text: source.text,
                      title: source.title,
                      corpusId: b.scope,
                      rank: 1,
                      score: 1,
                    })),
                  }),
                },
              }
            : {},
        );
        const token = adapter.bind(bundle);
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
        const wire = await response.text();
        const turn = adapter.lastTurn(token);
        const spoken = turn?.spokenTurn?.spoken ?? turn?.result?.spoken ?? "";
        assert.ok(!spoken.includes(no), JSON.stringify({ q, turn }));
        if (yes)
          assert.ok(spoken.includes(yes), JSON.stringify({ q, wire, turn }));
        for (const e of turn?.spokenTurn?.citations ?? []) {
          assert.equal(parsed.doc.text.slice(e.start, e.end), e.quote);
          assert.ok(!e.quote.includes(no));
        }
        adapter.revoke(token);
      }
    },
  );
