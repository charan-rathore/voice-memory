// Two callers on the same fixed bearer must never share conversation state.
// Bolna sends the full message history every turn, so context comes from the
// request alone; nothing about caller A's last question may reach caller B.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadBundle, speak } from "./spoken-eval.mjs";
import { createVoiceAdapter } from "../voice-adapter.mjs";

const CAP = "spokeneval" + "0".repeat(56);
const dir = new URL("../corpus-md/", import.meta.url).pathname;

test("caller B's follow-up does not inherit caller A's field", async () => {
  const voice = createVoiceAdapter({
    ttlMs: 60000,
    hardExpiresAtMs: Date.now() + 3600000,
  });
  voice.bind(loadBundle(dir), CAP);
  // Caller A asks about the payment split.
  await speak(voice, ["What's the payment split?"]);
  // Caller B (fresh call, no history) asks an anaphoric follow-up.
  const b = await speak(voice, ["Was that approved?"]);
  assert.doesNotMatch(b.text, /40\/60|50\/50/, `leaked A's field: ${b.text}`);
});

test("a draft request drafts from THIS call's previous question only", async () => {
  const voice = createVoiceAdapter({
    ttlMs: 60000,
    hardExpiresAtMs: Date.now() + 3600000,
  });
  voice.bind(loadBundle(dir), CAP);
  await speak(voice, ["How many regions are we covering?"]); // caller A, answerable
  const b = await speak(voice, ["Draft an email"]); // caller B, nothing asked
  assert.match(b.text, /Ask a question/i, `B got A's draft: ${b.text}`);
});

test("follow-up within one call still works from its own history", async () => {
  const voice = createVoiceAdapter({
    ttlMs: 60000,
    hardExpiresAtMs: Date.now() + 3600000,
  });
  voice.bind(loadBundle(dir), CAP);
  const a1 = await speak(voice, ["What's the payment split?"]);
  const a2 = await speak(voice, [
    "What's the payment split?",
    a1.text,
    "Was that approved?",
  ]);
  assert.match(a2.text, /40\/60|50\/50|not/i, a2.text);
});
