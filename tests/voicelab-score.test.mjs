import { test } from "node:test";
import assert from "node:assert/strict";
import {
  wer,
  entityErrors,
  clockOffset,
  scoreCall,
} from "../public/voicelab-score.mjs";

test("WER counts word edits", () => {
  assert.equal(wer("what fee did we agree", "what fee did we agree"), 0);
  assert.equal(wer("what fee did we agree", "what fees did we agree"), 0.2);
});

test("critical entities: notation-insensitive, meaning-sensitive", () => {
  assert.deepEqual(
    entityErrors(
      "did they approve forty two thousand",
      "did they approve $42,000",
    ),
    [],
  );
  assert.deepEqual(
    entityErrors("is it forty two thousand", "is it fourteen thousand"),
    ['number "42000" lost', 'number "14000" inserted'],
  );
  assert.deepEqual(entityErrors("was it not approved", "was it approved"), [
    "negation count 1 -> 0",
  ]);
  assert.deepEqual(
    entityErrors("the fifteenth of november", "the fifteenth of december"),
    ['month "november" lost', 'month "december" inserted'],
  );
});

test("critical entities retain decimal percentages and compact splits", () => {
  assert.deepEqual(entityErrors("the rate is 12.5%", "the rate is 15.5%"), [
    'number "12.5" lost', 'number "15.5" inserted',
  ]);
  assert.deepEqual(entityErrors("the split is 40/60", "the split is 40/50"), [
    'number "60" lost', 'number "50" inserted',
  ]);
  assert.deepEqual(entityErrors("the amount is 1,234,567.25", "the amount is 1234567.25"), []);
  assert.deepEqual(entityErrors("constructor", ""), []);
});

test("clock alignment keeps the tightest round trip", () => {
  const c = clockOffset([
    { t0: 0, serverNow: 1500, t1: 400 },
    { t0: 1000, serverNow: 2050, t1: 1100 },
  ]);
  assert.equal(c.offset, 1000);
  assert.equal(c.errorMs, 50);
});

test("stage latencies come only from measured timestamps", () => {
  const r = scoreCall({
    script: ["what fee did we agree"],
    clock: { offset: 1000, errorMs: 20 },
    speechEnds: [10000],
    agentAudioStarts: [11900],
    turns: [
      {
        transcript: "what fee did we agree",
        receivedAt: 11700,
        firstByteAt: 11710,
      },
    ],
  });
  assert.deepEqual(r.rows[0].ms, {
    asrAndNetwork: 700,
    engine: 10,
    ttsAndNetwork: 1190,
    speechToAnswer: 1900,
  });
  const none = scoreCall({
    script: [],
    clock: null,
    speechEnds: [],
    agentAudioStarts: [],
    turns: [{ transcript: "x", receivedAt: 1, firstByteAt: 2 }],
  });
  assert.equal(none.rows[0].ms.speechToAnswer, null);
});
