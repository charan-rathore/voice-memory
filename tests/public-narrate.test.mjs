// Public narration-audio route: fail-closed without an adapter, canonical
// server-side narration only (no client text), caps, cache, concurrency,
// and the sentence split the client highlights against.
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { createPublicApi } from "../src/public-api.mjs";
import { createSarvamTts } from "../src/sarvam-tts.mjs";

const NARR =
  "Ferritin is 50 ng/mL, inside the lab's range. Creatinine is 1.1 mg/dL, a little above range. TSH stays inside the printed range.";
const SENTENCES = [
  "Ferritin is 50 ng/mL, inside the lab's range. ",
  "Creatinine is 1.1 mg/dL, a little above range. ",
  "TSH stays inside the printed range.",
];
const WAV = Buffer.from("RIFFfakeWAVEfmt ");

async function start({ sarvam = null, env = {} } = {}) {
  const saved = {};
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  const api = createPublicApi({
    cases: { health: { bundle: { fake: true } }, deal: { bundle: { fake: true } } },
    resolve: async () => {
      throw new Error("not exercised");
    },
    visual: () => ({ kind: "labs", lang: "en", rows: [], narration: NARR }),
    sarvam,
  });
  const srv = createServer((req, res) =>
    api(req, res).then((handled) => {
      if (!handled) {
        res.writeHead(404);
        res.end();
      }
    }),
  );
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  return {
    base,
    close: async () => {
      for (const [k, v] of Object.entries(saved))
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      await new Promise((r) => srv.close(r));
    },
  };
}

const stubSarvam = (calls, impl) => ({
  key: "test|voice",
  synthesize: async (text, lang) => {
    calls.push({ text, lang });
    if (impl) return impl(text, lang);
    return WAV;
  },
});

test("503 and no provider call when the adapter is not configured", async () => {
  const { base, close } = await start({ sarvam: null });
  try {
    const r = await fetch(`${base}/api/public/narrate-audio/health/0?lang=en`);
    assert.equal(r.status, 503);
    assert.match((await r.json()).error, /not configured/);
  } finally {
    await close();
  }
});

test("unknown case 404s, bad index 400s, no provider call for either", async () => {
  const calls = [];
  const { base, close } = await start({ sarvam: stubSarvam(calls) });
  try {
    assert.equal(
      (await fetch(`${base}/api/public/narrate-audio/nope/0?lang=en`)).status,
      404,
    );
    const r = await fetch(`${base}/api/public/narrate-audio/health/99?lang=en`);
    assert.equal(r.status, 400);
    const j = await r.json();
    assert.equal(j.sentences, 3);
    assert.equal(calls.length, 0);
  } finally {
    await close();
  }
});

test("speaks canonical server narration only - client text is never spoken", async () => {
  const calls = [];
  const { base, close } = await start({ sarvam: stubSarvam(calls) });
  try {
    const r = await fetch(
      `${base}/api/public/narrate-audio/health/1?lang=en&text=HACKED%20TEXT`,
      { headers: { "content-type": "application/json" } },
    );
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("content-type"), "audio/wav");
    assert.equal(r.headers.get("x-vm-sentences"), "3");
    assert.deepEqual(
      Buffer.from(await r.arrayBuffer()).equals(WAV),
      true,
    );
    // exactly the server's own second sentence reached the provider
    assert.deepEqual(calls, [{ text: SENTENCES[1].trim(), lang: "en" }]);
  } finally {
    await close();
  }
});

test("identical sentences are synthesized once and served from cache", async () => {
  const calls = [];
  const { base, close } = await start({ sarvam: stubSarvam(calls) });
  try {
    for (let i = 0; i < 3; i++) {
      const r = await fetch(`${base}/api/public/narrate-audio/health/0?lang=en`);
      assert.equal(r.status, 200);
    }
    assert.equal(calls.length, 1);
  } finally {
    await close();
  }
});

test("per-visitor daily cap counts syntheses, not cached replays", async () => {
  const calls = [];
  const { base, close } = await start({
    sarvam: stubSarvam(calls),
    env: { VM_NARRATE_PER_IP_DAY: "1" },
  });
  try {
    assert.equal(
      (await fetch(`${base}/api/public/narrate-audio/health/0?lang=en`)).status,
      200,
    );
    // cached replay: still served, no new synthesis, no cap consumed
    assert.equal(
      (await fetch(`${base}/api/public/narrate-audio/health/0?lang=en`)).status,
      200,
    );
    // a new sentence needs a new synthesis: capped
    assert.equal(
      (await fetch(`${base}/api/public/narrate-audio/health/1?lang=en`)).status,
      429,
    );
    assert.equal(calls.length, 1);
  } finally {
    await close();
  }
});

test("global daily cap holds regardless of visitor", async () => {
  const calls = [];
  const { base, close } = await start({
    sarvam: stubSarvam(calls),
    env: { VM_NARRATE_GLOBAL_PER_DAY: "1", VM_NARRATE_PER_IP_DAY: "99" },
  });
  try {
    assert.equal(
      (await fetch(`${base}/api/public/narrate-audio/health/0?lang=en`)).status,
      200,
    );
    assert.equal(
      (await fetch(`${base}/api/public/narrate-audio/health/1?lang=en`)).status,
      429,
    );
    assert.equal(calls.length, 1);
  } finally {
    await close();
  }
});

test("concurrency cap rejects parallel syntheses beyond the limit", async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  const calls = [];
  const sarvam = {
    key: "test|voice",
    synthesize: async (text, lang) => {
      calls.push({ text, lang });
      await gate;
      return WAV;
    },
  };
  const { base, close } = await start({
    sarvam,
    env: { VM_NARRATE_CONCURRENT: "1" },
  });
  try {
    const slow = fetch(`${base}/api/public/narrate-audio/health/0?lang=en`);
    await new Promise((r) => setTimeout(r, 50)); // let the first enter
    const second = await fetch(
      `${base}/api/public/narrate-audio/health/1?lang=en`,
    );
    assert.equal(second.status, 429);
    release();
    assert.equal((await slow).status, 200);
    assert.equal(calls.length, 1);
  } finally {
    await close();
  }
});

test("provider 402 surfaces as an explicit credits-exhausted 503", async () => {
  const sarvam = createSarvamTts({
    apiKey: "test-key",
    fetchImpl: async () => ({ ok: false, status: 402 }),
  });
  const { base, close } = await start({ sarvam });
  try {
    const r = await fetch(`${base}/api/public/narrate-audio/health/0?lang=en`);
    assert.equal(r.status, 503);
    assert.match((await r.json()).error, /credits are exhausted/);
  } finally {
    await close();
  }
});

test("adapter maps languages, posts the documented shape, decodes audios[0]", async () => {
  const seen = [];
  const sarvam = createSarvamTts({
    apiKey: "test-key",
    fetchImpl: async (url, init) => {
      seen.push({ url, init });
      return {
        ok: true,
        json: async () => ({ audios: [WAV.toString("base64")] }),
      };
    },
  });
  const out = await sarvam.synthesize("Namaste duniya", "hi");
  assert.equal(out.equals(WAV), true);
  const { url, init } = seen[0];
  assert.equal(url, "https://api.sarvam.ai/text-to-speech");
  assert.equal(init.headers["api-subscription-key"], "test-key");
  const body = JSON.parse(init.body);
  assert.equal(body.language_code, "hi-IN");
  assert.equal(body.model, "bulbul:v4-flash");
  assert.equal(body.speaker, "ritu_hi_conversation"); // v4 persona, hi
  assert.equal(body.text, "Namaste duniya");
});

test("adapter is null without a key (route fails closed upstream)", () => {
  assert.equal(createSarvamTts({ apiKey: undefined }), null);
});

test("server sentence split matches the client regex in site/visual.js", () => {
  const clientSrc = readFileSync(
    new URL("../site/visual.js", import.meta.url),
    "utf8",
  );
  const serverSrc = readFileSync(
    new URL("../src/public-api.mjs", import.meta.url),
    "utf8",
  );
  const pick = (src) => {
    const i = src.indexOf("match(/");
    if (i < 0) return null;
    const j = src.indexOf("/g", i);
    return j < 0 ? null : src.slice(i + 7, j);
  };
  const clientRe = pick(clientSrc);
  const serverRe = pick(serverSrc);
  assert.ok(clientRe, "client split regex found");
  assert.equal(clientRe, serverRe);
  // both produce the same indexed chunks the highlight mapping relies on
  const re = new RegExp(clientRe, "g");
  assert.deepEqual(NARR.match(re), SENTENCES);
});

test("visual payload carries the sentence list for the client", async () => {
  const { base, close } = await start({ sarvam: stubSarvam([]) });
  try {
    const r = await fetch(`${base}/api/public/visual/health?lang=en`);
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.deepEqual(j.visual.sentences, SENTENCES);
  } finally {
    await close();
  }
});
