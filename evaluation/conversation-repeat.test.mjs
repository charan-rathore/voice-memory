// Conversation regressions replayed through the voice adapter (the Bolna
// path) on the Northstar corpus. Each was RED on main 6edac74:
//  - "Say that again" after "Thanks" or "Can you hear me?" repeated that
//    social reply, not the last answer about the records.
//  - "Thanks. Didn't they quote 48,000 earlier?" got "You're welcome".
//  - "Does he have hypothyroidism?" / "Should my father take iron tablets?"
//    were declined with "whether YOU have a condition", "YOUR reports".
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadBundle, speak } from "./spoken-eval.mjs";
import { createVoiceAdapter } from "../src/voice-adapter.mjs";
import { socialTurn, isSocialReply } from "../src/conversation.mjs";
import { declineLead, adviceKind } from "../src/vernacular.mjs";

const CAP = "spokeneval" + "0".repeat(56);
const dir = new URL("../examples/corpus-md/", import.meta.url).pathname;
const call = () => {
  const v = createVoiceAdapter({
    ttlMs: 60000,
    hardExpiresAtMs: Date.now() + 3600000,
  });
  v.bind(loadBundle(dir), CAP);
  return v;
};
const FEE = /\$42,000 is the latest proposal, and it is not approved\./;

test("'say that again' repeats the last record answer, past social replies", async () => {
  const v = call();
  const a1 = await speak(v, ["What is the fee?"]);
  assert.match(a1.text, FEE);
  for (const social of ["Thanks", "Can you hear me?"]) {
    const s = await speak(v, ["What is the fee?", a1.text, social]);
    assert.ok(isSocialReply(s.text), `expected a social reply: ${s.text}`);
    const again = await speak(v, [
      "What is the fee?",
      a1.text,
      social,
      s.text,
      "Say that again",
    ]);
    assert.match(again.text, FEE, `after "${social}": ${again.text}`);
  }
});

test("'say that again, but shorter' is the first sentence of the same answer", () => {
  const last =
    "The earlier record was $48,000. It was superseded by $42,000, which is still not approved.";
  assert.equal(
    socialTurn("Say that again, but shorter", { last }).spoken,
    "The earlier record was $48,000.",
  );
  assert.equal(socialTurn("Say that again", { last }).spoken, last);
  // a one-word first sentence is not a usable shorter answer
  assert.equal(
    socialTurn("Say that again, but shorter.", {
      last: "No. Per the internal action log from October 9: no signed commercial agreement exists for the revised terms.",
    }).spoken,
    "No. Per the internal action log from October 9: no signed commercial agreement exists for the revised terms.",
  );
  assert.match(
    socialTurn("Say that again", { last: null }).spoken,
    /haven't answered/,
  );
});

test("a question after a thank-you is answered, not signed off", async () => {
  const v = call();
  const r = await speak(v, ["Thanks. Didn't they quote 48,000 earlier?"]);
  assert.match(r.text, /earlier record was \$48,000/);
  assert.ok(
    ["THANKS", "BYE"].includes(socialTurn("Thanks, that's all")?.intent),
  );
  assert.equal(socialTurn("Thank you")?.intent, "THANKS");
  assert.equal(socialTurn("Thanks. What is the deadline?"), null);
});

test("declines about someone else never say 'you'", async () => {
  for (const q of [
    "Does he have hypothyroidism?",
    "Should my father take iron tablets?",
    "Should he start statins?",
    "kya papa ko diabetes hai?",
  ]) {
    const text = declineLead(adviceKind(q), "en", q).text;
    assert.doesNotMatch(text, /\byou(r)?\b/i, `${q} -> ${text}`);
    assert.match(text, /\btheir\b|\bthey\b/, q);
  }
  for (const q of ["Do I have hypothyroidism?", "Should I take iron tablets?"])
    assert.match(declineLead(adviceKind(q), "en", q).text, /\byou\b/, q);
  // same through the voice path
  const r = await speak(call(), ["Should my father take iron tablets?"]);
  assert.doesNotMatch(r.text, /\byour\b/i, r.text);
});

test("lab answers about someone else say 'The TSH result', not 'Your'", async () => {
  const { ingestFile } = await import("../ingest/index.mjs");
  const { extractReport } = await import("../clinical/observations.mjs");
  const { clinicalAnswer } = await import("../clinical/answer.mjs");
  const text = [
    "Chain Diagnostics (synthetic)",
    "Name : SAMPLE PATIENT    Age : 52 Years    Gender : Male",
    "Collected : 14/3/2025 9:10:00AM    Reported : 14/3/2025 6:00:00PM    Report Status : Final",
    "",
    "Test Name    Results    Units    Bio. Ref. Interval",
    "",
    "THYROID PROFILE",
    "TSH    25.17    µIU/mL    0.35 - 5.50",
    "",
  ].join("\n");
  const r = await ingestFile(Buffer.from(text), "dad.txt");
  const R = [{ title: "dad", sourceId: "s", ...extractReport(r.doc) }];
  const his = clinicalAnswer("What is his TSH?", R).spoken;
  assert.match(his, /^The TSH result is 25\.17 µIU\/mL/);
  assert.doesNotMatch(
    his,
    /\b[Yy]our (TSH|doctor|medicines|other results)\b|how you feel/,
  );
  assert.match(
    clinicalAnswer("What is my TSH?", R).spoken,
    /^Your TSH result is 25\.17/,
  );
});
