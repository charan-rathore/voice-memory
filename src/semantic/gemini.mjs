// Bounded Gemini access for the semantic layer.
//
// Gemini is an *interpreter*, never the source of truth:
//   interpret()        question -> intent, tests, subject, language, an English
//                      rewrite in the catalog's own words. The deterministic engine
//                      then answers the rewrite, so every number still comes
//                      from a cited row.
//   planClaims()       redacted passages -> structured claims, each with an exact
//                      quote from one passage. src/semantic/verify.mjs accepts a
//                      claim only if its quote is a literal span of the original
//                      document and its numbers, units, polarity and subject agree.
//   groundedExplain()  a generic term (never patient data) -> general background
//                      via the official google_search grounding tool, with URLs.
//   transcribe()       dictated audio -> verbatim text, biased to a vocabulary of
//                      test names / document terms (no values, no names).
//
// Safety and cost:
//   - Off unless GEMINI_API_KEY is set server-side; VM_GEMINI=off is a kill switch.
//     Without a key every caller gets null and the deterministic path answers.
//   - The key never leaves the server, is never logged, never sent to the browser.
//   - Hard caps: calls/day, search calls/day, estimated USD/day, calls/IP/hour,
//     per-call timeouts. Over a cap -> null (deterministic fallback), not an error.
//   - Identifiers (patient IDs, names, phone numbers, emails, dates of birth) are
//     replaced with placeholders before any document text is sent.
//   - Results are cached by content hash, so a repeated question costs nothing.
import { createHash } from "node:crypto";

const num = (v, d) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : d;
};

/** Daily/IP budget with a cost estimate from token usage. */
export function createBudget(env = process.env, now = () => Date.now()) {
  const caps = {
    callsPerDay: num(env.VM_GEMINI_DAILY_CALLS, 500),
    searchPerDay: num(env.VM_GEMINI_DAILY_SEARCH, 100),
    usdPerDay: num(env.VM_GEMINI_DAILY_USD, 2),
    callsPerIpHour: num(env.VM_GEMINI_CALLS_PER_IP_HOUR, 40),
    // Paid-tier list prices per 1M tokens (override when Google changes them).
    inUsdPerM: num(env.VM_GEMINI_IN_USD_PER_M, 0.75),
    outUsdPerM: num(env.VM_GEMINI_OUT_USD_PER_M, 3.75),
    searchUsd: num(env.VM_GEMINI_SEARCH_USD, 0.014),
  };
  let day = Math.floor(now() / 86400000);
  let used = { calls: 0, search: 0, usd: 0, refused: 0, errors: 0, cached: 0 };
  const perIp = new Map();
  const roll = () => {
    const d = Math.floor(now() / 86400000);
    if (d !== day) {
      day = d;
      used = { calls: 0, search: 0, usd: 0, refused: 0, errors: 0, cached: 0 };
    }
  };
  return {
    caps,
    /** May one more call of this kind go out? */
    admit(kind, ip = "*") {
      roll();
      const hour = Math.floor(now() / 3600000);
      const r = perIp.get(ip);
      const n = r && r.hour === hour ? r.n : 0;
      const ok =
        used.calls < caps.callsPerDay &&
        used.usd < caps.usdPerDay &&
        (kind !== "search" || used.search < caps.searchPerDay) &&
        n < caps.callsPerIpHour;
      if (!ok) {
        used.refused++;
        return false;
      }
      perIp.set(ip, { hour, n: n + 1 });
      if (perIp.size > 5000) perIp.delete(perIp.keys().next().value);
      used.calls++;
      if (kind === "search") used.search++;
      return true;
    },
    charge(usage, kind) {
      const i = usage?.promptTokenCount ?? 0;
      const o =
        (usage?.candidatesTokenCount ?? 0) + (usage?.thoughtsTokenCount ?? 0);
      used.usd +=
        (i * caps.inUsdPerM + o * caps.outUsdPerM) / 1e6 +
        (kind === "search" ? caps.searchUsd : 0);
    },
    error() {
      used.errors++;
    },
    hit() {
      used.cached++;
    },
    status() {
      roll();
      return { ...used, usd: Math.round(used.usd * 10000) / 10000, caps };
    },
  };
}

// ------------------------------------------------------------ redaction
const PHONE = /(?<!\d)(?:\+?\d[\d -]{8,}\d)(?!\d)/g;
const EMAIL = /[\w.+-]+@[\w-]+\.[\w.]+/g;
const DOB =
  /\b(?:dob|date of birth|d\.o\.b\.?)\s*[:\-]?\s*[0-9A-Za-z ,/.-]{6,20}/gi;
const ID_LIKE =
  /\b(?:SYN-\d{3,}|(?:UHID|MRN|PID|Lab\s*No|Patient\s*ID|Reg(?:istration)?\s*No)\.?\s*[:#-]?\s*[A-Z0-9-]{3,})\b/gi;

/**
 * Replace identifiers with stable placeholders. `names` are printed patient
 * names known from report headers. Returns the text and a function that maps
 * placeholders back to the original strings.
 */
export function redact(text, names = []) {
  const map = new Map();
  let n = 0;
  const sub = (m) => {
    for (const [k, v] of map) if (v === m) return k;
    const k = `[ID${++n}]`;
    map.set(k, m);
    return k;
  };
  let out = String(text ?? "");
  for (const name of names)
    if (name && name.length > 2) out = out.split(name).join(sub(name));
  out = out
    .replace(ID_LIKE, sub)
    .replace(EMAIL, sub)
    .replace(DOB, sub)
    .replace(PHONE, sub);
  const restore = (s) =>
    String(s ?? "").replace(/\[ID\d+\]/g, (k) => map.get(k) ?? k);
  return { text: out, restore, count: map.size };
}

// ------------------------------------------------------------ client
const INTERPRET_SCHEMA = {
  type: "object",
  properties: {
    intent: {
      type: "string",
      enum: [
        "LOOKUP",
        "COMPARE",
        "WHY",
        "TERM",
        "SUMMARY",
        "MISSING",
        "FOLLOW_UP",
        "UNCLEAR",
      ],
    },
    language: { type: "string", enum: ["en", "hi", "hinglish"] },
    tests: {
      type: "array",
      items: { type: "string" },
      description:
        "Catalog entries the question is about, copied exactly from the catalog.",
    },
    subject: {
      type: "string",
      description:
        "A subject label copied exactly from the catalog, or 'unspecified'.",
    },
    term: { type: "string", description: "For TERM: the word asked about." },
    rewrite: {
      type: "string",
      description:
        "The question in plain English using only catalog words. Never add values.",
    },
    clarify: {
      type: "string",
      description:
        "If genuinely ambiguous: one short question back to the user. Else empty.",
    },
  },
  required: ["intent", "language", "tests", "subject", "rewrite"],
};

const CLAIMS_SCHEMA = {
  type: "object",
  properties: {
    answerable: { type: "boolean" },
    claims: {
      type: "array",
      items: {
        type: "object",
        properties: {
          statement: {
            type: "string",
            description: "One short sentence answering part of the question.",
          },
          passage: {
            type: "integer",
            description: "Index of the passage that states it.",
          },
          quote: {
            type: "string",
            description:
              "Exact words copied from that passage that state it (no paraphrase).",
          },
          subject: { type: "string" },
          polarity: {
            type: "string",
            enum: ["affirmed", "negated", "uncertain"],
          },
        },
        required: ["statement", "passage", "quote", "polarity"],
      },
    },
    missing: {
      type: "string",
      description: "What the question asks that no passage states, or empty.",
    },
  },
  required: ["answerable", "claims"],
};

const sha = (s) => createHash("sha256").update(s).digest("hex");

/**
 * @param {object} [o]
 * @param {any} [o.client] injected client with models.generateContent (tests)
 */
export function createGemini({
  env = process.env,
  client = null,
  now = () => Date.now(),
  budget = createBudget(env, now),
} = {}) {
  const key = env.GEMINI_API_KEY || env.GOOGLE_API_KEY || "";
  const model = env.VM_GEMINI_MODEL || "gemini-3.8-flash";
  const killed = env.VM_GEMINI === "off";
  const searchOn = env.VM_GEMINI_SEARCH !== "off";
  const timeouts = {
    interpret: num(env.VM_GEMINI_INTERPRET_MS, 4500),
    claims: num(env.VM_GEMINI_CLAIMS_MS, 8000),
    search: num(env.VM_GEMINI_SEARCH_MS, 9000),
    transcribe: num(env.VM_GEMINI_TRANSCRIBE_MS, 12000),
  };
  const cache = new Map();
  const CACHE_MAX = 600;
  const CACHE_TTL = 24 * 3600000;
  let sdk = client;
  let lastError = null;
  let lastOkAt = null;

  const enabled = () => !killed && (!!key || !!client);
  async function getClient() {
    if (sdk) return sdk;
    const { GoogleGenAI } = await import("@google/genai");
    sdk = new GoogleGenAI({ apiKey: key });
    return sdk;
  }

  /** One bounded call: cache -> budget -> timeout -> usage accounting. */
  async function call(kind, request, { ip = "*", cacheKey } = {}) {
    if (!enabled()) return null;
    const ck = cacheKey ? sha(kind + "\0" + model + "\0" + cacheKey) : null;
    const hit = ck && cache.get(ck);
    if (hit && now() - hit.at < CACHE_TTL) {
      budget.hit();
      return hit.value;
    }
    if (!budget.admit(kind === "search" ? "search" : kind, ip)) return null;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeouts[kind] ?? 6000);
    try {
      const c = await getClient();
      const res = await c.models.generateContent({
        model,
        ...request,
        config: {
          ...request.config,
          abortSignal: ctl.signal,
          httpOptions: { timeout: timeouts[kind] ?? 6000 },
        },
      });
      budget.charge(res?.usageMetadata, kind);
      lastOkAt = now();
      const value = res;
      if (ck) {
        cache.set(ck, { at: now(), value });
        if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
      }
      return value;
    } catch (e) {
      budget.error();
      // Never log request content or the key; only the error class.
      lastError = {
        at: now(),
        kind,
        code:
          e?.status ?? e?.code ?? (ctl.signal.aborted ? "timeout" : "error"),
      };
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
  const textOf = (res) => {
    try {
      return typeof res?.text === "string"
        ? res.text
        : (res?.candidates?.[0]?.content?.parts ?? [])
            .map((p) => p.text ?? "")
            .join("");
    } catch {
      return "";
    }
  };
  const jsonOf = (res) => {
    const t = textOf(res);
    if (!t) return null;
    try {
      return JSON.parse(t.replace(/^```(?:json)?\s*|\s*```$/g, ""));
    } catch {
      return null;
    }
  };

  return {
    model,
    enabled,
    searchEnabled: () => enabled() && searchOn,
    status: () => ({
      configured: !!key,
      enabled: enabled(),
      model,
      search: searchOn,
      lastOkAt,
      lastError,
      budget: budget.status(),
    }),

    /**
     * @param {string} question already redacted by the caller
     * @param {{tests: string[], subjects: string[], documents: string[], domain: string}} catalog
     */
    async interpret(question, catalog, opts = {}) {
      const prompt = [
        "You read one question a person asked about their own documents and classify it.",
        "You do NOT answer it. You never state values, dates or facts.",
        "Copy test names and subject labels exactly from the catalog; if none fit, leave them empty.",
        "The question may be English, Hindi (Devanagari) or Hinglish, and may contain speech-recognition errors or typos.",
        "Intent: LOOKUP (a value/status), COMPARE (change across time/reports), WHY (a reason/cause/explanation),",
        "TERM (what a word means, in general), SUMMARY (whole report/documents), MISSING (asks for something documents like these never record),",
        "FOLLOW_UP (depends on the previous turn), UNCLEAR (genuinely ambiguous).",
        "",
        `Domain: ${catalog.domain}`,
        `Catalog tests/fields: ${JSON.stringify(catalog.tests.slice(0, 80))}`,
        `Catalog subjects: ${JSON.stringify(catalog.subjects.slice(0, 10))}`,
        `Catalog documents: ${JSON.stringify(catalog.documents.slice(0, 20))}`,
        catalog.previous ? `Previous topic: ${catalog.previous}` : "",
        "",
        `Question: ${question}`,
      ].join("\n");
      const res = await call(
        "interpret",
        {
          contents: prompt,
          config: {
            responseMimeType: "application/json",
            responseJsonSchema: INTERPRET_SCHEMA,
            thinkingConfig: { thinkingLevel: "LOW" },
            maxOutputTokens: 2048,
          },
        },
        { ...opts, cacheKey: prompt },
      );
      return res ? jsonOf(res) : null;
    },

    /**
     * @param {string} question redacted
     * @param {string[]} passages redacted, indexed from 0
     */
    async planClaims(question, passages, opts = {}) {
      const prompt = [
        "Answer the question ONLY from the numbered passages.",
        "Return claims. Each claim: one short sentence, the passage index, and an EXACT quote copied character-for-character from that passage that states it.",
        "Never infer a value, unit, date, status, diagnosis, symptom or approval that a passage does not state.",
        "If a passage says something was proposed, pending, discussed or preliminary, keep that status in the statement.",
        "If no passage answers the question, set answerable=false and say what is missing.",
        "Placeholders like [ID1] stand for identifiers; keep them as they are.",
        "",
        ...passages.map((p, i) => `[${i}] ${p}`),
        "",
        `Question: ${question}`,
      ].join("\n");
      const res = await call(
        "claims",
        {
          contents: prompt,
          config: {
            responseMimeType: "application/json",
            responseJsonSchema: CLAIMS_SCHEMA,
            thinkingConfig: { thinkingLevel: "LOW" },
            maxOutputTokens: 4096,
          },
        },
        { ...opts, cacheKey: prompt },
      );
      return res ? jsonOf(res) : null;
    },

    /**
     * General background for a term, grounded with Google Search. The input is
     * a generic term and a language; never patient data.
     * @returns {Promise<null | {text: string, sources: {title:string, uri:string}[]}>}
     */
    async groundedExplain(term, lang = "en", opts = {}) {
      if (!searchOn) return null;
      const safeTerm = redact(String(term).slice(0, 80)).text;
      if (/\[ID\d+\]/.test(safeTerm)) return null; // identifier-like: never search it
      const language =
        {
          en: "English",
          hi: "Hindi (Devanagari)",
          hinglish: "Hinglish (romanized Hindi)",
        }[lang] ?? "English";
      const prompt = [
        `In two or three plain sentences in ${language}, explain what "${safeTerm}" means in general.`,
        "Prefer authoritative clinical or public-health sources (MedlinePlus, NIH, NHS, WHO, CDC, Mayo Clinic) for medical terms,",
        "and standard business or legal references for commercial terms.",
        "General information only: no advice, no diagnosis, nothing about any particular person.",
      ].join(" ");
      const res = await call(
        "search",
        {
          contents: prompt,
          config: { tools: [{ googleSearch: {} }], maxOutputTokens: 2048 },
        },
        { ...opts, cacheKey: prompt },
      );
      if (!res) return null;
      const text = textOf(res).trim();
      const chunks =
        res?.candidates?.[0]?.groundingMetadata?.groundingChunks ?? [];
      const sources = chunks
        .map((c) => c.web)
        .filter((w) => w?.uri)
        .map((w) => ({ title: w.title ?? w.uri, uri: w.uri }))
        .slice(0, 4);
      // Ungrounded text is not shown: a definition must come with sources.
      if (!text || !sources.length) return null;
      return { text: text.slice(0, 700), sources };
    },

    /**
     * @param {Buffer} audio
     * @param {string} mime
     * @param {string[]} vocabulary test names / document terms (no values)
     */
    async transcribe(audio, mime, vocabulary = [], hint = "auto", opts = {}) {
      const prompt = [
        "Transcribe this spoken question verbatim, in the language and script it was spoken",
        "(English, Hindi in Devanagari, or Hinglish in Latin script as spoken).",
        'Apply only the speaker\'s own self-corrections ("no, I mean...", "sorry, ...") and drop filler sounds (um, uh, hmm).',
        "Spell these terms exactly when they are spoken:",
        JSON.stringify(vocabulary.slice(0, 120)),
        "Write numbers as digits and IDs like SYN-0001 in that form.",
        "Return only the transcript. If nothing intelligible was said, return an empty string.",
        hint !== "auto" ? `Expected language: ${hint}.` : "",
      ].join(" ");
      const res = await call(
        "transcribe",
        {
          contents: [
            {
              role: "user",
              parts: [
                {
                  inlineData: {
                    mimeType: mime,
                    data: audio.toString("base64"),
                  },
                },
                { text: prompt },
              ],
            },
          ],
          config: {
            thinkingConfig: { thinkingLevel: "LOW" },
            maxOutputTokens: 1024,
          },
        },
        opts,
      );
      if (!res) return null;
      return textOf(res).trim().replace(/^"|"$/g, "").slice(0, 400);
    },
  };
}
