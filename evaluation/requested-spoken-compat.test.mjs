import test from "node:test";
import { readFileSync } from "node:fs";
import { parseBuffer } from "../ingest/parse.mjs";
import { extractReport } from "../clinical/observations.mjs";
import assert from "node:assert/strict";
import { importBundle } from "../dist/engine.mjs";
import { spokenTurn } from "../src/spoken.mjs";
import { createVoiceAdapter } from "../src/voice-adapter.mjs";
const records =
  "Parcel PINE-63; Tracking number: 555022; Recipient: Noor Vale; Units: 24.\nParcel PINE-62; Tracking number: 555021; Recipient: Mira Chen; Units: 12.";
for (const question of [
  "What is the tracking number for PINE-62?",
  "What is the tracking number for Pine sixty two?",
])
  test("spokenTurn returns scoped text, not null: " + question, () => {
    const bundle = importBundle([{ title: "dispatch", text: records }]);
    const result = spokenTurn(question, bundle);
    assert.equal(typeof result.spoken, "string");
    assert.match(result.spoken, /555021/);
    assert.doesNotMatch(result.spoken, /555022/);
    assert.equal(result.verdict, "QUOTED");
    for (const e of result.citations) {
      const s = bundle.sources.find((s) => s.id === e.sourceId);
      assert.equal(s.text.slice(e.start, e.end), e.quote);
      assert.equal(s.hash, e.hash);
      assert.doesNotMatch(e.quote, /555022/);
    }
  });
for (const [name, text, q] of [
  [
    "absent field",
    "Parcel PINE-62; Internal reference 555022.",
    "What is the tracking number for PINE-62?",
  ],
  ["unknown root", records, "What is the tracking number for PINE-69?"],
  [
    "normalized separator collision",
    records + "\nParcel PINE_62; Tracking number: 888099.",
    "What is the tracking number for Pine sixty two?",
  ],
])
  test("spokenTurn does not quote unsupported " + name, () => {
    const b = importBundle([{ title: "dispatch", text }]);
    const r = spokenTurn(q, b);
    assert.notEqual(r?.verdict, "QUOTED");
    assert.equal(r?.citations?.length ?? 0, 0);
  });
test("actual mixed-domain voice caller keeps scoped tracking subquestion", async () => {
  const lab = await parseBuffer(
    readFileSync(
      new URL(
        "../clinical/fixtures/files/a-2026-10-amended.pdf",
        import.meta.url,
      ),
    ),
    "a-2026-10-amended.pdf",
  );
  assert.ok(lab.doc);
  const b = importBundle([
    {
      title: "Northstar dispatch",
      text: "Northstar project dispatch.\n" + records,
    },
    { title: "Synthetic lab report", text: lab.doc.text },
  ]);
  b.clinical = [
    {
      title: b.sources[1].title,
      sourceId: b.sources[1].id,
      ...extractReport(lab.doc),
    },
  ];
  const adapter = createVoiceAdapter();
  const token = adapter.bind(b);
  try {
    const response = await adapter.handle(
      new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { authorization: "Bearer " + token },
        body: JSON.stringify({
          stream: true,
          messages: [
            {
              role: "user",
              content:
                "What is the Northstar tracking number for PINE-62 and what is my ferritin?",
            },
          ],
        }),
      }),
    );
    assert.equal(response.status, 200);
    await response.text();
    const r = adapter.lastTurn(token);
    assert.match(r.spokenTurn.spoken, /555021/);
    assert.match(r.spokenTurn.spoken, /Ferritin result is 50 ng\/mL/);
    assert.doesNotMatch(r.spokenTurn.spoken, /555022/);
    assert.ok(r.spokenTurn.citations.length);
    for (const e of r.spokenTurn.citations) {
      const s = b.sources.find((s) => s.id === e.sourceId);
      assert.equal(s.text.slice(e.start, e.end), e.quote);
      assert.doesNotMatch(e.quote, /555022/);
    }
  } finally {
    adapter.revoke(token);
  }
});
