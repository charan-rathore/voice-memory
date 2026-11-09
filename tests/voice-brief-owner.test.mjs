// Synthetic legacy voice fallback scope regression, no provider or microphone.
import test from "node:test";
import assert from "node:assert/strict";
import { parseBuffer } from "../ingest/parse.mjs";
import { importBundle } from "../dist/engine.mjs";
import { attachRecords } from "../src/record-facts.mjs";
import { createVoiceAdapter } from "../src/voice-adapter.mjs";
process.env.VM_DENSE = "off";
async function bundle({ sameName = false, conflictingId = false } = {}) {
  const docs = [];
  for (const [id, name, drug] of [
    ["AL-101", "Alice Smith", "AlphaOnlyDrug"],
    [
      conflictingId ? "AL-101" : "BJ-202",
      sameName ? "Alice Smith" : "Bob Jones",
      "BetaOnlyDrug",
    ],
  ])
    docs.push(
      (
        await parseBuffer(
          Buffer.from(
            `DISCHARGE SUMMARY\nPatient name: ${name}\nPatient ID: ${id}\nDate of birth: ${drug === "AlphaOnlyDrug" ? "12 January 1980" : "3 July 1965"}\nStatus: signed final\nMedications: ${drug} 10 mg daily.\nFollow-up: review in 7 days.`,
          ),
          id + ".txt",
        )
      ).doc,
    );
  const b = importBundle(
    docs.map((d, i) => ({ title: "discharge" + i, text: d.text })),
  );
  attachRecords(
    b,
    docs.map((doc) => ({ doc })),
  );
  return b;
}
async function ask(a, t, q) {
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
  assert.equal(r.status, 200);
  const wire = await r.text();
  const text = [...wire.matchAll(/"content":"((?:[^"\\]|\\.)*)"/g)]
    .map((m) => JSON.parse('"' + m[1] + '"'))
    .join("");
  return { text, turn: a.lastTurn(t) };
}
test("legacy medicine brief answers each explicitly source-bound patient without cross-patient drug", async () => {
  const a = createVoiceAdapter(),
    t = a.bind(await bundle());
  try {
    for (const [q, yes, no] of [
      ["What medicines is AL-101 taking?", /AlphaOnlyDrug/, /BetaOnlyDrug/],
      ["What medicines is BJ-202 taking?", /BetaOnlyDrug/, /AlphaOnlyDrug/],
      [
        "What medicines is Alice Smith taking?",
        /AlphaOnlyDrug/,
        /BetaOnlyDrug/,
      ],
      ["What medicines is Bob Jones taking?", /BetaOnlyDrug/, /AlphaOnlyDrug/],
    ]) {
      const r = await ask(a, t, q);
      assert.match(r.text, yes);
      assert.doesNotMatch(r.text, no);
      assert.ok(r.turn.spokenTurn.citations.some((c) => yes.test(c.quote)));
      assert.ok(r.turn.spokenTurn.citations.every((c) => !no.test(c.quote)));
    }
  } finally {
    a.revoke(t);
  }
});
test("legacy unknown, pronoun and multi-owner requests do not inherit a single medicine scope", async () => {
  const a = createVoiceAdapter(),
    t = a.bind(await bundle());
  try {
    for (const q of [
      "What medicines is ZZ-999 taking?",
      "What medicines is she taking?",
      "What medicines is AL-101 taking and what medicines is BJ-202 taking?",
    ]) {
      const r = await ask(a, t, q);
      assert.doesNotMatch(r.text, /AlphaOnlyDrug|BetaOnlyDrug/);
    }
  } finally {
    a.revoke(t);
  }
});

test("legacy brief uses explicit IDs beside namesakes, not a shared name", async () => {
  const a = createVoiceAdapter(),
    t = a.bind(await bundle({ sameName: true }));
  try {
    for (const [q, yes, no] of [
      ["What medicines is AL-101 taking?", /AlphaOnlyDrug/, /BetaOnlyDrug/],
      ["What medicines is BJ-202 taking?", /BetaOnlyDrug/, /AlphaOnlyDrug/],
    ]) {
      const r = await ask(a, t, q);
      assert.match(r.text, yes);
      assert.doesNotMatch(r.text, no);
    }
    const ambiguous = await ask(a, t, "What medicines is Alice Smith taking?");
    assert.doesNotMatch(ambiguous.text, /AlphaOnlyDrug|BetaOnlyDrug/);
  } finally {
    a.revoke(t);
  }
});

test("conflicted printed identity cannot authorize a medicine brief", async () => {
  const a = createVoiceAdapter(),
    t = a.bind(await bundle({ conflictingId: true }));
  try {
    const r = await ask(a, t, "What medicines is AL-101 taking?");
    assert.doesNotMatch(r.text, /AlphaOnlyDrug|BetaOnlyDrug/);
    assert.equal(r.turn.spokenTurn.verdict, "AMBIGUOUS_PATIENT");
  } finally {
    a.revoke(t);
  }
});
