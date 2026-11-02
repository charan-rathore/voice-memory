// Neural voice in and out, provider-agnostic. The only modules that see the
// provider keys are this one and sarvam-tts.mjs; keys come from the
// environment and never reach a browser, a log line or a response.
//
//   voice out (TTS)   Sarvam Bulbul (sarvam-tts.mjs, best for Hindi and
//                     Hinglish, one pass over code-mixed text) and ElevenLabs
//                     (eleven_multilingual_v2 / eleven_flash_v2_5, with
//                     character-level timestamps for word highlighting).
//                     createVoiceOut() tries them in VM_TTS_ORDER.
//   voice in (STT)    Sarvam Saaras v3 (mode "codemix" keeps English words in
//                     Latin script inside Hindi speech) and ElevenLabs Scribe
//                     v2 (keyterm prompting with the case's own vocabulary).
//                     createVoiceIn() tries them in VM_STT_ORDER, then the
//                     existing Gemini transcriber, then the caller falls back
//                     to the browser's recogniser.
//
// Request/response shapes follow the providers' REST references:
//   ElevenLabs TTS  POST /v1/text-to-speech/{voice_id}/with-timestamps
//                   -> { audio_base64, alignment{characters, character_start_times_seconds, ...} }
//   ElevenLabs STT  POST /v1/speech-to-text  multipart(file, model_id, language_code, keyterms[])
//                   -> { text, language_code, words[] }
//   Sarvam STT      POST /speech-to-text     multipart(file, model, mode, language_code)
//                   -> { transcript, language_code }
// Every call is bounded by a timeout and returns a typed error with a
// status: 402 (credits), 4xx (request), 502 (provider down/garbled).

const err = (message, status, cause) =>
  Object.assign(new Error(message), { status, cause });

async function timed(fetchImpl, url, init, timeoutMs) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...init, signal: ac.signal });
  } catch (e) {
    throw err("Voice provider unreachable.", 502, e);
  } finally {
    clearTimeout(timer);
  }
}
const check = (r) => {
  if (r.status === 402 || r.status === 429)
    throw err(
      r.status === 402
        ? "Voice provider credits exhausted."
        : "Voice provider is rate limiting.",
      r.status,
    );
  if (!r.ok) throw err(`Voice provider error ${r.status}.`, 502);
};

// ------------------------------------------------------------ word timings
/**
 * Word start/end times (ms) from character-level alignment. Words are the
 * whitespace-separated tokens of `text`, the same split the client uses to
 * wrap the answer in spans, so index i here is span i there.
 */
export function wordTimings(text, alignment) {
  const chars = alignment?.characters;
  const t0 = alignment?.character_start_times_seconds;
  const t1 = alignment?.character_end_times_seconds;
  if (!Array.isArray(chars) || !Array.isArray(t0) || !Array.isArray(t1))
    return null;
  const words = [];
  let cur = null;
  for (let i = 0; i < chars.length; i++) {
    if (/\s/.test(chars[i])) {
      if (cur) words.push(cur);
      cur = null;
    } else if (!cur) cur = [Math.round(t0[i] * 1000), Math.round(t1[i] * 1000)];
    else cur[1] = Math.round(t1[i] * 1000);
  }
  if (cur) words.push(cur);
  const want = String(text).trim().split(/\s+/).filter(Boolean).length;
  // Providers may normalise text ("$42,000" read as words); when the token
  // count no longer lines up, timings would highlight the wrong word, so
  // the caller gets none and the client estimates from audio duration.
  return words.length === want ? words : null;
}

/** Proportional estimate when a provider returns no alignment. */
export function estimateTimings(text, durationMs) {
  const words = String(text).trim().split(/\s+/).filter(Boolean);
  const weight = words.map(
    (w) => Math.max(2, w.replace(/[^\p{L}\p{N}]/gu, "").length) + 1,
  );
  const total = weight.reduce((a, b) => a + b, 0) || 1;
  let at = 0;
  return words.map((_, i) => {
    const d = (durationMs * weight[i]) / total;
    const out = [Math.round(at), Math.round(at + d)];
    at += d;
    return out;
  });
}

// ------------------------------------------------------------ ElevenLabs TTS
const ELEVEN_LANG = { en: "en", hi: "hi", hinglish: "hi" };
export function createElevenTts({
  apiKey = process.env.ELEVENLABS_API_KEY,
  model = process.env.VM_ELEVEN_MODEL || "eleven_multilingual_v2",
  // A warm, conversational default; override per deployment.
  voice = process.env.VM_ELEVEN_VOICE || "21m00Tcm4TlvDq8ikWAM",
  endpoint = "https://api.elevenlabs.io/v1/text-to-speech",
  timeoutMs = 15000,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (!apiKey) return null;
  return {
    name: "elevenlabs",
    key: `elevenlabs|${model}|${voice}`,
    async synthesize(text, lang) {
      if (!ELEVEN_LANG[lang]) throw err("Unsupported language.", 400);
      const r = await timed(
        fetchImpl,
        `${endpoint}/${encodeURIComponent(voice)}/with-timestamps?output_format=mp3_44100_128&enable_logging=false`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", "xi-api-key": apiKey },
          body: JSON.stringify({
            text,
            model_id: model,
            // A friend, not a newsreader: a little more expressive than the
            // default, still steady enough for numbers.
            voice_settings: {
              stability: 0.45,
              similarity_boost: 0.8,
              style: 0.25,
              use_speaker_boost: true,
            },
            ...(model.includes("v2_5")
              ? { language_code: ELEVEN_LANG[lang] }
              : {}),
          }),
        },
        timeoutMs,
      );
      check(r);
      const j = await r.json().catch(() => null);
      if (typeof j?.audio_base64 !== "string" || !j.audio_base64.length)
        throw err("Voice provider returned no audio.", 502);
      return {
        audio: Buffer.from(j.audio_base64, "base64"),
        mime: "audio/mpeg",
        words: wordTimings(text, j.alignment),
        provider: "elevenlabs",
      };
    },
  };
}

// ------------------------------------------------------------ voice out chain
/**
 * Try each configured TTS provider in order; a provider that is out of
 * credits, rate limited or down hands over to the next. Returns null when
 * none is configured (callers fail closed: no browser fallback on the
 * public Listen path).
 */
export function createVoiceOut({
  sarvam = null,
  eleven = null,
  order = (process.env.VM_TTS_ORDER || "sarvam,elevenlabs").split(","),
} = {}) {
  const byName = { sarvam, elevenlabs: eleven };
  const chain = order.map((n) => byName[n.trim()]).filter(Boolean);
  for (const p of [sarvam, eleven]) if (p && !chain.includes(p)) chain.push(p);
  if (!chain.length) return null;
  const nameOf = (p) => p.name ?? (p === sarvam ? "sarvam" : "elevenlabs");
  return {
    key: chain.map((p) => p.key).join("+"),
    providers: chain.map(nameOf),
    async synthesize(text, lang) {
      let last = null;
      for (const p of chain) {
        try {
          const out = await p.synthesize(text, lang);
          return Buffer.isBuffer(out)
            ? {
                audio: out,
                mime: "audio/wav",
                words: null,
                provider: nameOf(p),
              }
            : { provider: nameOf(p), ...out };
        } catch (e) {
          last = e;
          if (e?.status === 400) throw e; // our request, not the provider's day
        }
      }
      throw last ?? err("Voice unavailable.", 502);
    },
  };
}

// ------------------------------------------------------------ voice in
const blobOf = (audio, mime) => new Blob([audio], { type: mime });
const extOf = (mime) =>
  ({
    "audio/webm": "webm",
    "audio/ogg": "ogg",
    "audio/mp4": "m4a",
    "audio/mpeg": "mp3",
    "audio/wav": "wav",
    "audio/x-wav": "wav",
    "audio/aac": "aac",
    "audio/m4a": "m4a",
  })[mime] ?? "webm";

export function createSarvamStt({
  apiKey = process.env.VM_SARVAM_API_KEY,
  model = process.env.VM_SARVAM_STT_MODEL || "saaras:v3",
  endpoint = "https://api.sarvam.ai/speech-to-text",
  timeoutMs = 12000,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (!apiKey) return null;
  return {
    name: "sarvam",
    async transcribe(audio, mime, _vocabulary = [], hint = "auto") {
      const fd = new FormData();
      fd.append("file", blobOf(audio, mime), `clip.${extOf(mime)}`);
      fd.append("model", model);
      // codemix: "मेरा ferritin कितना है" keeps the test name in Latin
      // script, which is what the engine and the vocabulary repair read.
      fd.append(
        "mode",
        hint === "en" ? "transcribe" : hint === "hi" ? "transcribe" : "codemix",
      );
      fd.append(
        "language_code",
        hint === "en" ? "en-IN" : hint === "auto" ? "unknown" : "hi-IN",
      );
      const r = await timed(
        fetchImpl,
        endpoint,
        {
          method: "POST",
          headers: { "api-subscription-key": apiKey },
          body: fd,
        },
        timeoutMs,
      );
      check(r);
      const j = await r.json().catch(() => null);
      if (typeof j?.transcript !== "string")
        throw err("Voice provider returned no transcript.", 502);
      return {
        text: j.transcript.trim(),
        lang: j.language_code ?? null,
        provider: "sarvam",
      };
    },
  };
}

export function createElevenStt({
  apiKey = process.env.ELEVENLABS_API_KEY,
  model = process.env.VM_ELEVEN_STT_MODEL || "scribe_v2",
  endpoint = "https://api.elevenlabs.io/v1/speech-to-text",
  timeoutMs = 12000,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (!apiKey) return null;
  return {
    name: "elevenlabs",
    async transcribe(audio, mime, vocabulary = [], hint = "auto") {
      const fd = new FormData();
      fd.append("file", blobOf(audio, mime), `clip.${extOf(mime)}`);
      fd.append("model_id", model);
      if (hint === "en") fd.append("language_code", "en");
      else if (hint === "hi" || hint === "hinglish")
        fd.append("language_code", "hi");
      fd.append("tag_audio_events", "false");
      // Keyterm prompting: the test names, IDs and deal terms on screen
      // (no values), so "ferritin" and "SYN-0003" come back spelt right.
      for (const k of vocabulary.filter((v) => v.length <= 50).slice(0, 100))
        fd.append("keyterms", k);
      const r = await timed(
        fetchImpl,
        `${endpoint}?enable_logging=false`,
        { method: "POST", headers: { "xi-api-key": apiKey }, body: fd },
        timeoutMs,
      );
      check(r);
      const j = await r.json().catch(() => null);
      if (typeof j?.text !== "string")
        throw err("Voice provider returned no transcript.", 502);
      return {
        text: j.text.trim(),
        lang: j.language_code ?? null,
        provider: "elevenlabs",
      };
    },
  };
}

/**
 * STT chain: configured providers in VM_STT_ORDER, then `fallback` (the
 * Gemini transcriber, which returns a string or null). Returns null when
 * nothing produced a transcript, so the client keeps the browser's words.
 */
export function createVoiceIn({
  sarvam = null,
  eleven = null,
  fallback = null,
  order = (process.env.VM_STT_ORDER || "sarvam,elevenlabs").split(","),
} = {}) {
  const byName = { sarvam, elevenlabs: eleven };
  const chain = order.map((n) => byName[n.trim()]).filter(Boolean);
  for (const p of [sarvam, eleven]) if (p && !chain.includes(p)) chain.push(p);
  return {
    providers: [
      ...chain.map((p) => p.name),
      ...(fallback?.enabled?.() ? ["gemini"] : []),
    ],
    enabled: () => chain.length > 0 || !!fallback?.enabled?.(),
    async transcribe(audio, mime, vocabulary, hint, opts = {}) {
      for (const p of chain) {
        try {
          const out = await p.transcribe(audio, mime, vocabulary, hint);
          if (out?.text) return out;
        } catch {
          /* next provider */
        }
      }
      if (fallback?.enabled?.()) {
        const text = await fallback
          .transcribe(audio, mime, vocabulary, hint, opts)
          .catch(() => null);
        if (text) return { text, lang: null, provider: "gemini" };
      }
      return null;
    },
  };
}

// ------------------------------------------------------------ local fake (tests and design review only)
/**
 * VM_TTS_FAKE=on: a soft tone the length of the sentence, with estimated
 * word timings, so the Listen flow (karaoke, prefetch, stop, errors) can be
 * exercised in a browser without a provider key. Never on by default.
 */
export function createFakeTts({ on = process.env.VM_TTS_FAKE === "on" } = {}) {
  if (!on) return null;
  return {
    name: "fake",
    key: "fake",
    async synthesize(text, lang) {
      if (!["en", "hi", "hinglish"].includes(lang))
        throw err("Unsupported language.", 400);
      const rate = 8000;
      const secs = Math.min(12, 0.25 + String(text).length / 15);
      const n = Math.round(rate * secs);
      const pcm = Buffer.alloc(n * 2);
      for (let i = 0; i < n; i++)
        pcm.writeInt16LE(
          Math.round(
            Math.sin((2 * Math.PI * 220 * i) / rate) *
              900 *
              Math.sin((Math.PI * i) / n),
          ),
          i * 2,
        );
      const h = Buffer.alloc(44);
      h.write("RIFF", 0);
      h.writeUInt32LE(36 + pcm.length, 4);
      h.write("WAVEfmt ", 8);
      h.writeUInt32LE(16, 16);
      h.writeUInt16LE(1, 20);
      h.writeUInt16LE(1, 22);
      h.writeUInt32LE(rate, 24);
      h.writeUInt32LE(rate * 2, 28);
      h.writeUInt16LE(2, 32);
      h.writeUInt16LE(16, 34);
      h.write("data", 36);
      h.writeUInt32LE(pcm.length, 40);
      return {
        audio: Buffer.concat([h, pcm]),
        mime: "audio/wav",
        words: estimateTimings(text, secs * 1000),
        provider: "fake",
      };
    },
  };
}
