// Sarvam Bulbul text-to-speech adapter - the only module that talks to
// api.sarvam.ai. The API key arrives via environment and never leaves this
// file. Request/response shape per the Sarvam REST reference (POST
// /text-to-speech, api-subscription-key header, base64 WAV in audios[0]):
// https://docs.sarvam.ai/api-reference/text-to-speech/convert
//
// Returns null when no key is configured; callers treat a null adapter as
// "not configured" and fail closed (503). There is no fallback provider:
// the visitor hears this voice or reads the text.
const LANGS = { en: "en-IN", hi: "hi-IN", hinglish: "hi-IN" };

export function createSarvamTts({
  apiKey = process.env.VM_SARVAM_API_KEY,
  model = process.env.VM_SARVAM_MODEL || "bulbul:v3",
  speaker = process.env.VM_SARVAM_SPEAKER || "shubh",
  endpoint = "https://api.sarvam.ai/text-to-speech",
  timeoutMs = 15000,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (!apiKey) return null;
  const key = `${model}|${speaker}`;
  async function synthesize(text, lang) {
    const language_code = LANGS[lang];
    if (!language_code)
      throw Object.assign(Error("Unsupported language."), { status: 400 });
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    let r;
    try {
      r = await fetchImpl(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "api-subscription-key": apiKey,
        },
        body: JSON.stringify({
          text,
          language_code,
          model,
          speaker,
          output_audio_codec: "wav",
          speech_sample_rate: 22050,
        }),
        signal: ac.signal,
      });
    } catch (e) {
      throw Object.assign(Error("Voice provider unreachable."), {
        status: 502,
        cause: e,
      });
    } finally {
      clearTimeout(timer);
    }
    if (r.status === 402)
      throw Object.assign(Error("Voice provider credits exhausted."), {
        status: 402,
      });
    if (!r.ok)
      throw Object.assign(Error(`Voice provider error ${r.status}.`), {
        status: 502,
      });
    const j = await r.json().catch(() => null);
    const b64 = j?.audios?.[0];
    if (typeof b64 !== "string" || !b64.length)
      throw Object.assign(Error("Voice provider returned no audio."), {
        status: 502,
      });
    return Buffer.from(b64, "base64");
  }
  return { synthesize, key };
}
