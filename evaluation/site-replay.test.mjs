// The landing page labels its hero as "a replay of answers the engine gave".
// Keep that true: every replayed answer must equal what the voice endpoint
// says today for the same conversation.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadBundle, speak } from "./spoken-eval.mjs";
import { createVoiceAdapter } from "../voice-adapter.mjs";

test("landing-page replay equals the engine's current spoken answers", async () => {
  const src = readFileSync(new URL("../site/site.js", import.meta.url), "utf8");
  const turns = [
    ...src.matchAll(/q: "((?:[^"\\]|\\.)*)",[\s\S]*?a: "((?:[^"\\]|\\.)*)",/g),
  ].map((m) => ({ q: JSON.parse(`"${m[1]}"`), a: JSON.parse(`"${m[2]}"`) }));
  assert.ok(turns.length >= 3, "found the replay turns");
  const v = createVoiceAdapter({
    ttlMs: 60000,
    hardExpiresAtMs: Date.now() + 3600e3,
  });
  v.bind(
    loadBundle(new URL("../corpus-md/", import.meta.url).pathname),
    "spokeneval" + "0".repeat(56),
  );
  const h = [];
  for (const t of turns) {
    h.push(t.q);
    const r = await speak(v, h);
    assert.equal(r.text, t.a, `"${t.q}"`);
    h.push(r.text);
  }
  assert.match(
    readFileSync(new URL("../site/index.html", import.meta.url), "utf8"),
    /not a live call/,
  );
});
