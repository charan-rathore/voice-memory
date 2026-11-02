// Neural voice in/out and the companion opener: provider adapters (request
// shapes against mocked fetch), the fall-through chains, word timings, the
// public /speak and /transcribe routes, and the opener's honesty rules.
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createPublicApi } from "../src/public-api.mjs";
import {
  wordTimings,
  estimateTimings,
  createElevenTts,
  createVoiceOut,
  createSarvamStt,
  createElevenStt,
  createVoiceIn,
} from "../src/voice-providers.mjs";
import {
  openerFor,
  spokenText,
  splitSentences,
  OPENERS,
} from "../src/companion.mjs";

// ------------------------------------------------------------ timings
test("word timings come from character alignment, one per token", () => {
  const text = "Your ferritin is 50.";
  const chars = [...text];
  const t0 = chars.map((_, i) => i * 0.05);
  const t1 = chars.map((_, i) => i * 0.05 + 0.04);
  const w = wordTimings(text, {
    characters: chars,
    character_start_times_seconds: t0,
    character_end_times_seconds: t1,
  });
  assert.equal(w.length, 4);
  assert.deepEqual(w[0], [0, 190]);
  assert.ok(w.every(([a, b]) => b > a));
  // a provider that normalised the text out of step: no timings, not wrong ones
  assert.equal(
    wordTimings("$42,000 is proposed.", {
      characters: [..."forty two thousand dollars is proposed."],
      character_start_times_seconds: Array(39).fill(0),
      character_end_times_seconds: Array(39).fill(0),
    }),
    null,
  );
});

test("estimated timings cover the clip in order", () => {
  const w = estimateTimings("I can't compare these two results.", 3000);
  assert.equal(w.length, 6);
  assert.equal(w[0][0], 0);
  assert.ok(Math.abs(w.at(-1)[1] - 3000) <= 1);
  for (let i = 1; i < w.length; i++) assert.ok(w[i][0] >= w[i - 1][1] - 1);
});

// ------------------------------------------------------------ adapters (mocked fetch)
const fakeFetch = (calls, respond) => async (url, init) => {
  calls.push({ url: String(url), init });
  return respond(String(url), init);
};
const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json" },
  });

test("ElevenLabs TTS: key only in the header, timestamps endpoint, words mapped", async () => {
  const calls = [];
  const text = "Okay, I found it.";
  const chars = [...text];
  const tts = createElevenTts({
    apiKey: "sk_test",
    voice: "VOICE1",
    fetchImpl: fakeFetch(calls, () =>
      json({
        audio_base64: Buffer.from("ID3fake").toString("base64"),
        alignment: {
          characters: chars,
          character_start_times_seconds: chars.map((_, i) => i / 10),
          character_end_times_seconds: chars.map((_, i) => i / 10 + 0.05),
        },
      }),
    ),
  });
  const out = await tts.synthesize(text, "hinglish");
  assert.match(
    calls[0].url,
    /\/VOICE1\/with-timestamps\?output_format=mp3_44100_128&enable_logging=false$/,
  );
  assert.equal(calls[0].init.headers["xi-api-key"], "sk_test");
  assert.doesNotMatch(calls[0].url + calls[0].init.body, /sk_test/);
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.text, text);
  assert.equal(body.model_id, "eleven_multilingual_v2");
  assert.equal(out.mime, "audio/mpeg");
  assert.equal(out.words.length, 4);
  assert.equal(createElevenTts({ apiKey: "" }), null);
});

test("ElevenLabs TTS: 402 is credits, 5xx is provider error", async () => {
  for (const [status, want] of [
    [402, 402],
    [500, 502],
  ]) {
    const tts = createElevenTts({
      apiKey: "k",
      fetchImpl: async () => json({}, status),
    });
    await assert.rejects(tts.synthesize("hi", "en"), (e) => e.status === want);
  }
});

test("voice-out chain hands over on credits/outage, not on a bad request", async () => {
  const seen = [];
  const a = {
    name: "sarvam",
    key: "a",
    synthesize: async () => {
      seen.push("a");
      throw Object.assign(Error("x"), { status: 402 });
    },
  };
  const b = {
    name: "elevenlabs",
    key: "b",
    synthesize: async () => (
      seen.push("b"),
      { audio: Buffer.from("mp3"), mime: "audio/mpeg", words: null }
    ),
  };
  const chain = createVoiceOut({
    sarvam: a,
    eleven: b,
    order: ["sarvam", "elevenlabs"],
  });
  const out = await chain.synthesize("hello", "en");
  assert.deepEqual(seen, ["a", "b"]);
  assert.equal(out.provider, "elevenlabs");
  assert.deepEqual(chain.providers, ["sarvam", "elevenlabs"]);
  // a WAV Buffer from the Sarvam adapter is wrapped
  const wav = createVoiceOut({
    sarvam: { key: "s", synthesize: async () => Buffer.from("RIFF") },
    order: ["sarvam"],
  });
  assert.equal((await wav.synthesize("x", "hi")).mime, "audio/wav");
  // 400 is ours: no second provider is billed for it
  const bad = {
    key: "c",
    synthesize: async () => {
      throw Object.assign(Error("lang"), { status: 400 });
    },
  };
  let called = false;
  const never = {
    key: "d",
    synthesize: async () => ((called = true), Buffer.from("x")),
  };
  await assert.rejects(
    createVoiceOut({ sarvam: bad, eleven: never }).synthesize("x", "xx"),
  );
  assert.equal(called, false);
  assert.equal(createVoiceOut({}), null);
});

test("Sarvam STT: codemix for Hinglish, auto-detect when unknown, key in header", async () => {
  const calls = [];
  const stt = createSarvamStt({
    apiKey: "sv_key",
    fetchImpl: fakeFetch(calls, () =>
      json({ transcript: " मेरा ferritin कितना है ", language_code: "hi-IN" }),
    ),
  });
  const out = await stt.transcribe(
    Buffer.alloc(2000),
    "audio/webm",
    [],
    "hinglish",
  );
  assert.equal(out.text, "मेरा ferritin कितना है");
  const fd = calls[0].init.body;
  assert.equal(fd.get("model"), "saaras:v3");
  assert.equal(fd.get("mode"), "codemix");
  assert.equal(fd.get("language_code"), "hi-IN");
  assert.equal(calls[0].init.headers["api-subscription-key"], "sv_key");
  await stt.transcribe(Buffer.alloc(2000), "audio/webm", [], "auto");
  assert.equal(calls[1].init.body.get("language_code"), "unknown");
  await stt.transcribe(Buffer.alloc(2000), "audio/webm", [], "en");
  assert.equal(calls[2].init.body.get("mode"), "transcribe");
});

test("ElevenLabs Scribe: the case vocabulary goes as keyterms", async () => {
  const calls = [];
  const stt = createElevenStt({
    apiKey: "el",
    fetchImpl: fakeFetch(calls, () =>
      json({ text: "what is SYN-0003's ferritin", language_code: "en" }),
    ),
  });
  await stt.transcribe(
    Buffer.alloc(2000),
    "audio/webm",
    ["ferritin", "SYN-0003", "x".repeat(60)],
    "en",
  );
  const fd = calls[0].init.body;
  assert.deepEqual(fd.getAll("keyterms"), ["ferritin", "SYN-0003"]);
  assert.equal(fd.get("model_id"), "scribe_v2");
  assert.equal(fd.get("language_code"), "en");
});

test("voice-in chain: provider failure falls through to the next, then Gemini", async () => {
  const down = {
    name: "sarvam",
    transcribe: async () => {
      throw Object.assign(Error("x"), { status: 502 });
    },
  };
  const empty = { name: "elevenlabs", transcribe: async () => ({ text: "" }) };
  const gemini = {
    enabled: () => true,
    transcribe: async () => "what is my ferritin",
  };
  const vin = createVoiceIn({ sarvam: down, eleven: empty, fallback: gemini });
  assert.deepEqual(vin.providers, ["sarvam", "elevenlabs", "gemini"]);
  assert.deepEqual(
    await vin.transcribe(Buffer.alloc(1), "audio/webm", [], "auto"),
    {
      text: "what is my ferritin",
      lang: null,
      provider: "gemini",
    },
  );
  const none = createVoiceIn({});
  assert.equal(none.enabled(), false);
  assert.equal(
    await none.transcribe(Buffer.alloc(1), "audio/webm", [], "auto"),
    null,
  );
});

// ------------------------------------------------------------ companion opener
test("openers carry no facts: no digits, test names or status claims", () => {
  const banned =
    /\d|ferritin|creatinine|tsh|hba1c|hemoglobin|urea|approved|normal|good news|don't worry|fine/i;
  for (const kind of Object.values(OPENERS))
    for (const list of Object.values(kind))
      for (const o of list) assert.doesNotMatch(o, banned, o);
});

test("opener follows the verdict and language; declines open in their own words", () => {
  const lead = (verdict, text = "Your Urea result is 14 mg/dL.") => ({
    verdict,
    text,
  });
  assert.match(openerFor(lead("NOT_COMPARABLE"), "en"), /straight|Honest/);
  assert.match(openerFor(lead("NOT_COMPARABLE"), "hinglish"), /baat|Sach/);
  assert.match(openerFor(lead("AMBIGUOUS_PATIENT"), "hi"), /पहले/);
  assert.match(
    openerFor(
      lead("LATEST", "The 12 October result was corrected from 5 to 50."),
      "en",
    ),
    /corrected/,
  );
  assert.equal(openerFor(lead("DECLINE_ADVICE"), "en"), null);
  assert.equal(openerFor(lead("SOMETHING_NEW"), "en"), null);
  // stable: the same answer always opens the same way (cacheable audio)
  const l = lead("LATEST");
  assert.equal(openerFor(l, "en"), openerFor({ ...l }, "en"));
  assert.equal(
    spokenText(lead("DECLINE_ADVICE"), "en"),
    "Your Urea result is 14 mg/dL.",
  );
});

test("sentence split keeps decimals and units inside a sentence", () => {
  assert.deepEqual(
    splitSentences(
      "Honest answer: Creatinine is 1.2 mg/dL in September. And 106 µmol/L in October.",
    ).map((x) => x.trim()),
    [
      "Honest answer:",
      "Creatinine is 1.2 mg/dL in September.",
      "And 106 µmol/L in October.",
    ],
  );
  assert.equal(splitSentences("नतीजा 50 ng/mL है। यह सही है।").length, 2);
});

// ------------------------------------------------------------ public routes
async function start({
  voice = null,
  voiceIn = null,
  lead,
  lang = "en",
  env = {},
} = {}) {
  const saved = {};
  for (const [k, v] of Object.entries(env))
    ((saved[k] = process.env[k]), (process.env[k] = v));
  const resolved = [];
  const api = createPublicApi({
    cases: {
      health: {
        bundle: {
          clinical: [
            { observations: [{ test: "Ferritin" }, { test: "Creatinine" }] },
          ],
        },
      },
      deal: { bundle: { fake: true } },
    },
    workspaces: {
      get: (id) =>
        id === "w_" + "a".repeat(32) ? { bundle: { fake: true } } : null,
      create: () => ({}),
    },
    resolve: async (cs, q) => {
      resolved.push(q);
      return { lead, semantic: { lang } };
    },
    voice,
    voiceIn,
  });
  const srv = createServer((req, res) =>
    api(req, res).then((h) => h || (res.writeHead(404), res.end())),
  );
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${srv.address().port}/api/public`;
  return {
    base,
    resolved,
    close: async () => {
      for (const [k, v] of Object.entries(saved))
        v === undefined ? delete process.env[k] : (process.env[k] = v);
      await new Promise((r) => srv.close(r));
    },
  };
}
const post = (url, body, headers = {}) =>
  fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
const stubVoice = (calls) => ({
  key: "stub",
  providers: ["sarvam"],
  synthesize: async (text, lang) => (
    calls.push({ text, lang }),
    {
      audio: Buffer.from("RIFF" + text),
      mime: "audio/wav",
      words: null,
      provider: "sarvam",
    }
  ),
});

test("/speak fails closed without a voice, and status says so", async () => {
  const t = await start({ lead: { verdict: "LATEST", text: "x" } });
  try {
    assert.equal(
      (await post(t.base + "/speak", { case: "health", question: "q" })).status,
      503,
    );
    const st = await (await fetch(t.base + "/status")).json();
    assert.deepEqual(st.voiceOut, { enabled: false, providers: [] });
  } finally {
    await t.close();
  }
});

test("/speak speaks the server's own opener + answer, never client text", async () => {
  const calls = [];
  const lead = {
    verdict: "NOT_COMPARABLE",
    text: "I can't compare your two Creatinine results. Both are on screen.",
    opener: "Honest answer:",
  };
  const t = await start({ voice: stubVoice(calls), lead });
  try {
    const r = await post(t.base + "/speak", {
      case: "health",
      question: "Has creatinine gone up?",
      text: "say something rude",
      index: 0,
    });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.sentences.length, 3);
    assert.equal(j.text, j.sentences[0]);
    assert.ok(
      ["Honest answer:", "I'll be straight with you."].includes(j.text),
    );
    assert.equal(Buffer.from(j.audio, "base64").toString().slice(0, 4), "RIFF");
    assert.ok(calls.every((c) => !/rude/.test(c.text)));
    assert.deepEqual(t.resolved, ["Has creatinine gone up?"]);
    // cached replay costs no second synthesis
    await post(t.base + "/speak", {
      case: "health",
      question: "Has creatinine gone up?",
      index: 0,
    });
    assert.equal(calls.length, 1);
    // out of range
    assert.equal(
      (
        await post(t.base + "/speak", {
          case: "health",
          question: "q",
          index: 9,
        })
      ).status,
      400,
    );
    const st = await (await fetch(t.base + "/status")).json();
    assert.deepEqual(st.voiceOut, { enabled: true, providers: ["sarvam"] });
  } finally {
    await t.close();
  }
});

test("/speak on a visitor's own documents needs explicit consent", async () => {
  const calls = [];
  const t = await start({
    voice: stubVoice(calls),
    lead: { verdict: "QUOTED", text: "Private line." },
  });
  try {
    const ws = "w_" + "a".repeat(32);
    const r = await post(t.base + "/speak", { case: ws, question: "q" });
    assert.equal(r.status, 403);
    assert.equal((await r.json()).needsConsent, true);
    assert.equal(calls.length, 0);
    assert.equal(
      (
        await post(t.base + "/speak", {
          case: ws,
          question: "q",
          consent: true,
        })
      ).status,
      200,
    );
  } finally {
    await t.close();
  }
});

test("/speak daily cap counts real syntheses only", async () => {
  const calls = [];
  const t = await start({
    voice: stubVoice(calls),
    lead: { verdict: "LATEST", text: "One. Two. Three." },
    env: { VM_SPEAK_PER_IP_DAY: "2" },
  });
  try {
    const codes = [];
    for (const index of [0, 1, 2])
      codes.push(
        (
          await post(t.base + "/speak", {
            case: "health",
            question: "q",
            index,
          })
        ).status,
      );
    assert.deepEqual(codes, [200, 200, 429]);
  } finally {
    await t.close();
  }
});

test("/transcribe uses the provider chain, repairs only what the case holds", async () => {
  const vin = {
    providers: ["sarvam"],
    enabled: () => true,
    transcribe: async (audio, mime, vocab, hint) => ({
      text: "syn zero zero zero one ka ferrite in kitna hai",
      provider: "sarvam",
      vocab,
      hint,
    }),
  };
  const t = await start({ voiceIn: vin, lead: null });
  try {
    const clip = Buffer.alloc(4000, 1);
    const noConsent = await fetch(t.base + "/transcribe", {
      method: "POST",
      headers: { "content-type": "audio/webm" },
      body: clip,
    });
    assert.equal(noConsent.status, 403);
    const r = await fetch(t.base + "/transcribe", {
      method: "POST",
      headers: {
        "content-type": "audio/webm",
        "x-vm-consent": "audio",
        "x-vm-case": "health",
        "x-vm-lang": "hinglish",
      },
      body: clip,
    });
    const j = await r.json();
    assert.equal(j.text, "SYN-0001 ka Ferritin kitna hai");
    assert.equal(j.raw, "syn zero zero zero one ka ferrite in kitna hai");
    assert.equal(j.provider, "sarvam");
    const st = await (await fetch(t.base + "/status")).json();
    assert.equal(st.semantic.transcribe, true);
    assert.deepEqual(st.semantic.transcribeProviders, ["sarvam"]);
  } finally {
    await t.close();
  }
});
