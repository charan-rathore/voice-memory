// Semantic layer: intent, redaction, claim verification, budgets, the bounded
// Gemini client (with an injected fake - no network, no key), the router's
// rescue paths and the final audit.
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyIntent, termOf } from "../src/semantic/intent.mjs";
import { verifyClaims, auditLead } from "../src/semantic/verify.mjs";
import { createGemini, createBudget, redact } from "../src/semantic/gemini.mjs";
import { semanticRescue } from "../src/semantic/route.mjs";
import { semanticConsentFor } from "../src/semantic/scope.mjs";
import { importBundle, validateEvidence } from "../dist/engine.mjs";
import { NORTHSTAR_DOCS } from "../examples/corpus-northstar.mjs";

test("intent: why / term / missing / summary / compare / lookup, in three languages", () => {
  const cases = [
    ["Why is creatinine in different units?", "WHY"],
    ["creatinine ka unit alag kyun hai", "WHY"],
    ["फेरिटिन क्यों बदला?", "WHY"],
    ["What is hemoglobin?", "TERM"],
    ["what is a retainer?", "TERM"],
    ["ferritin kya hota hai", "TERM"],
    ["फेरिटिन क्या है", "TERM"],
    ["What is the TSH?", "LOOKUP"],
    ["What is SYN-0001's ferritin result?", "LOOKUP"],
    ["mera ferritin kitna hai?", "LOOKUP"],
    ["what is my blood pressure", "MISSING"],
    ["summarize the deal", "SUMMARY"],
    ["Has creatinine gone up since September?", "COMPARE"],
    ["and creatinine?", "LOOKUP"],
  ];
  for (const [q, want] of cases)
    assert.equal(classifyIntent(q).intent, want, q);
  assert.equal(termOf("what does ferritin mean?"), "ferritin");
  assert.equal(termOf("What is the engagement fee?"), null);
});

test("redaction replaces identifiers and restores them exactly", () => {
  const r = redact(
    "Patient: Test Person A, ID SYN-0001, call +91 98765 43210, a@b.co",
    ["Test Person A"],
  );
  assert.doesNotMatch(r.text, /SYN-0001|Test Person A|98765|a@b\.co/);
  assert.equal(
    r.restore(r.text),
    "Patient: Test Person A, ID SYN-0001, call +91 98765 43210, a@b.co",
  );
});

const P = (text, extra = {}) => ({
  text,
  restore: (s) => s,
  evidence: {
    sourceId: "s1",
    title: "t",
    hash: "h",
    start: 100,
    end: 100 + text.length,
    quote: text,
  },
  ...extra,
});

test("verifyClaims: literal quotes only; values, units, status, polarity, subject must agree", () => {
  const passages = [
    P(
      "The revised fee is $42,000, a proposal until finance sign-off is recorded.",
    ),
    P("No pleural effusion is seen."),
    P("| Ferritin | 50 | ng/mL | 30-400 |", { subject: "SYN-0001" }),
  ];
  const { accepted, rejected } = verifyClaims(
    [
      {
        statement: "The revised fee of $42,000 is proposed.",
        passage: 0,
        quote: "The revised fee is $42,000",
        polarity: "affirmed",
      },
      {
        statement: "The revised fee is $40,000.",
        passage: 0,
        quote: "The revised fee is $42,000",
        polarity: "affirmed",
      },
      {
        statement: "The $42,000 fee was approved.",
        passage: 0,
        quote: "The revised fee is $42,000, a proposal",
        polarity: "affirmed",
      },
      {
        statement: "There is a pleural effusion.",
        passage: 1,
        quote: "No pleural effusion is seen.",
        polarity: "affirmed",
      },
      {
        statement: "There is no pleural effusion.",
        passage: 1,
        quote: "No pleural effusion is seen.",
        polarity: "negated",
      },
      {
        statement: "Ferritin is 50 ng/mL.",
        passage: 2,
        quote: "Ferritin | 50 | ng/mL",
        polarity: "affirmed",
      },
      {
        statement: "Ferritin is 50 mg/dL.",
        passage: 2,
        quote: "Ferritin | 50 | ng/mL",
        polarity: "affirmed",
      },
      {
        statement: "SYN-0003 ferritin is 50.",
        passage: 2,
        quote: "Ferritin | 50",
        polarity: "affirmed",
      },
      {
        statement: "Ferritin is 50.",
        passage: 2,
        quote: "Ferritin is fifty",
        polarity: "affirmed",
      },
      { statement: "x", passage: 9, quote: "anything", polarity: "affirmed" },
    ],
    passages,
  );
  assert.deepEqual(
    accepted.map((a) => a.statement),
    [
      "The revised fee of $42,000 is proposed.",
      "There is no pleural effusion.",
      "Ferritin is 50 ng/mL.",
    ],
  );
  assert.deepEqual(
    rejected.map((r) => r.reason),
    [
      "value_not_in_quote:40000",
      "status_upgraded",
      "polarity_mismatch",
      "unit_not_in_quote:mg/dl",
      "subject_mismatch",
      "quote_not_in_source",
      "no_passage",
    ],
  );
  // exact offsets into the source
  assert.equal(accepted[0].evidence.start, 100);
  assert.equal(accepted[0].evidence.quote, "The revised fee is $42,000");
});

test("audit: a why answered with a bare value, or a missing reading answered with other values, fails", () => {
  assert.equal(
    auditLead(
      { intent: "WHY" },
      { text: "Your Creatinine result is 106 µmol/L.", verdict: "LATEST" },
    ).ok,
    false,
  );
  assert.equal(
    auditLead(
      { intent: "WHY" },
      {
        text: "The reports don't say why the unit changed.",
        verdict: "EXPLAINED",
      },
    ).ok,
    true,
  );
  assert.equal(
    auditLead(
      { intent: "MISSING" },
      { text: "For SYN-0001 Hemoglobin went up", verdict: "OVERVIEW" },
    ).ok,
    false,
  );
  assert.equal(
    auditLead(
      { intent: "LOOKUP" },
      {
        text: "The fee is $45,000.",
        verdict: "QUOTED",
        origin: "model",
        citations: [{ quote: "fee is $42,000" }],
      },
    ).ok,
    false,
  );
});

test("budget: daily, per-IP and cost caps refuse further calls", () => {
  let t = 0;
  const b = createBudget(
    {
      VM_GEMINI_DAILY_CALLS: "3",
      VM_GEMINI_CALLS_PER_IP_HOUR: "2",
      VM_GEMINI_DAILY_SEARCH: "1",
    },
    () => t,
  );
  assert.ok(b.admit("interpret", "a"));
  assert.ok(b.admit("interpret", "a"));
  assert.equal(b.admit("interpret", "a"), false, "per-IP hour cap");
  assert.ok(b.admit("search", "b"));
  assert.equal(b.admit("search", "c"), false, "daily call cap reached");
  t += 86400000;
  assert.ok(b.admit("interpret", "a"), "new day");
  const c = createBudget({ VM_GEMINI_DAILY_USD: "0.001" }, () => 0);
  assert.ok(c.admit("claims"));
  c.charge({ promptTokenCount: 1e6, candidatesTokenCount: 0 }, "claims");
  assert.equal(c.admit("claims"), false, "USD cap");
});

const fakeClient = (fn) => {
  const calls = [];
  return {
    calls,
    models: {
      async generateContent(req) {
        calls.push(req);
        return fn(req);
      },
    },
  };
};

test("gemini client: off without a key, kill switch, cache, timeout falls back to null", async () => {
  const off = createGemini({ env: {} });
  assert.equal(off.enabled(), false);
  assert.equal(
    await off.interpret("q", {
      tests: [],
      subjects: [],
      documents: [],
      domain: "x",
    }),
    null,
  );
  assert.equal(
    createGemini({ env: { GEMINI_API_KEY: "k", VM_GEMINI: "off" } }).enabled(),
    false,
  );

  const fc = fakeClient(() => ({
    text: '{"intent":"LOOKUP","language":"en","tests":[],"subject":"unspecified","rewrite":"x"}',
  }));
  const g = createGemini({ env: {}, client: fc });
  assert.equal(g.model, "gemini-3.8-flash");
  const cat = {
    tests: ["Ferritin"],
    subjects: [],
    documents: [],
    domain: "lab reports",
  };
  await g.interpret("what's my iron store", cat);
  await g.interpret("what's my iron store", cat);
  assert.equal(fc.calls.length, 1, "second call served from cache");
  assert.equal(fc.calls[0].config.responseMimeType, "application/json");

  const slow = fakeClient(
    (req) =>
      new Promise((_, rej) =>
        req.config.abortSignal.addEventListener("abort", () =>
          rej(Object.assign(Error("aborted"), { code: "timeout" })),
        ),
      ),
  );
  const g2 = createGemini({
    env: { VM_GEMINI_INTERPRET_MS: "20" },
    client: slow,
  });
  assert.equal(await g2.interpret("q", cat), null);
  assert.equal(g2.status().lastError.kind, "interpret");
});

test("grounded search: only a generic term goes out; ungrounded text is dropped", async () => {
  const fc = fakeClient(() => ({
    text: "A retainer is an advance fee paid to secure services.",
    candidates: [
      {
        groundingMetadata: {
          groundingChunks: [
            { web: { uri: "https://example.org/retainer", title: "Retainer" } },
          ],
        },
      },
    ],
  }));
  const g = createGemini({ env: {}, client: fc });
  const r = await g.groundedExplain("retainer", "en");
  assert.equal(r.sources[0].uri, "https://example.org/retainer");
  assert.ok(fc.calls[0].config.tools[0].googleSearch);
  assert.equal(
    await g.groundedExplain("SYN-0001", "en"),
    null,
    "identifier never searched",
  );
  const bare = createGemini({
    env: {},
    client: fakeClient(() => ({ text: "something" })),
  });
  assert.equal(await bare.groundedExplain("retainer", "en"), null);
});

function northstar() {
  const bundle = importBundle(NORTHSTAR_DOCS);
  bundle.clinical = [];
  return bundle;
}

test("router: verified model claims are accepted, fabricated ones rejected, with consent only", async () => {
  const bundle = northstar();
  const src = bundle.sources.find((s) => /Commercial_Revision/.test(s.title));
  const i = src.text.indexOf("1. Following");
  const ev = {
    sourceId: src.id,
    title: src.title,
    hash: src.hash,
    start: i,
    end: i + 120,
    quote: src.text.slice(i, i + 120),
  };
  const gem = createGemini({
    env: {},
    client: fakeClient((req) => {
      if (req.config.responseJsonSchema?.properties?.claims)
        return {
          text: JSON.stringify({
            answerable: true,
            claims: [
              {
                statement: "The revised fee is $42,000.",
                passage: 0,
                quote: "the revised fee is $42,000",
                polarity: "affirmed",
              },
              {
                statement: "The fee was approved at $42,000.",
                passage: 0,
                quote: "the revised fee is $42,000",
                polarity: "affirmed",
              },
              {
                statement: "The revised fee is $39,000.",
                passage: 0,
                quote: "the revised fee is $42,000",
                polarity: "affirmed",
              },
            ],
          }),
        };
      return {
        text: '{"intent":"UNCLEAR","language":"en","tests":[],"subject":"unspecified","rewrite":""}',
      };
    }),
  });
  const validate = (e) => validateEvidence(e, bundle);
  const out = await semanticRescue({
    question: "how much will the narrower pilot cost them",
    bundle,
    lead: null,
    raw: { evidence: [ev] },
    rerun: async () => null,
    validate,
    gemini: gem,
    consent: true,
  });
  assert.equal(out.lead.origin, "model");
  assert.equal(out.lead.text, "The revised fee is $42,000.");
  assert.equal(out.lead.citations.length, 1);
  assert.ok(validate(out.lead.citations[0]));

  const noConsent = await semanticRescue({
    question: "how much will the narrower pilot cost them",
    bundle,
    lead: null,
    raw: { evidence: [ev] },
    rerun: async () => null,
    validate,
    gemini: gem,
    consent: false,
  });
  assert.equal(
    noConsent.lead,
    null,
    "no consent: no passages sent, no model answer",
  );
});

test("router: the model's rewrite is answered by the engine; invented numbers in a rewrite are refused", async () => {
  const bundle = northstar();
  let rewrite = "What is the engagement fee?";
  const gem = createGemini({
    env: {},
    client: fakeClient(() => ({
      text: JSON.stringify({
        intent: "LOOKUP",
        language: "en",
        tests: [],
        subject: "unspecified",
        rewrite,
      }),
    })),
  });
  const engineLead = {
    text: "$42,000 is the latest proposal, and it is not approved.",
    verdict: "PROPOSED",
    citations: [{ quote: "$42,000" }],
  };
  const out = await semanticRescue({
    question: "how much are they paying meridian",
    bundle,
    lead: null,
    raw: { evidence: [] },
    rerun: async (q) =>
      q === "What is the engagement fee?" ? engineLead : null,
    validate: () => true,
    gemini: gem,
    consent: true,
  });
  assert.equal(out.lead.verdict, "PROPOSED");
  assert.equal(out.lead.interpretedAs, "What is the engagement fee?");

  rewrite = "Is the fee $45,000?";
  const gem2 = createGemini({
    env: {},
    client: fakeClient(() => ({
      text: JSON.stringify({
        intent: "LOOKUP",
        language: "en",
        tests: [],
        subject: "unspecified",
        rewrite,
      }),
    })),
  });
  const out2 = await semanticRescue({
    question: "how much are they paying",
    bundle,
    lead: null,
    raw: { evidence: [] },
    rerun: async () => engineLead,
    validate: () => true,
    gemini: gem2,
    consent: true,
  });
  assert.notEqual(
    out2.lead?.verdict,
    "PROPOSED",
    "rewrite adding a value is not used",
  );
});

test("router without a key: deterministic answers pass through unchanged; a why met by a value abstains", async () => {
  const bundle = northstar();
  const lead = {
    text: "$42,000 is the latest proposal.",
    verdict: "PROPOSED",
    citations: [{ quote: "$42,000" }],
  };
  const same = await semanticRescue({
    question: "What is the fee?",
    bundle,
    lead,
    raw: {},
    gemini: createGemini({ env: {} }),
  });
  assert.equal(same.lead, lead);
  const why = await semanticRescue({
    question: "Why is the fee $42,000?",
    bundle,
    lead,
    raw: {},
    gemini: createGemini({ env: {} }),
  });
  assert.equal(
    why.lead,
    null,
    "a why met by a bare value becomes an honest no-answer",
  );
  assert.ok(
    why.trace.steps.some((x) =>
      x.startsWith("audit_failed:why_answered_with_value"),
    ),
  );
});

// ---------------------------------------------------------------------------
// OpenRouter transport: translation, normalization, fail-closed defaults.
const fakeFetch = (fn) => {
  const calls = [];
  const f = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return fn(url, init);
  };
  f.calls = calls;
  return f;
};
const orResponse = (content, extra = {}) => ({
  ok: true,
  json: async () => ({
    choices: [{ message: { content, ...(extra.message ?? {}) } }],
    usage: {
      prompt_tokens: 120,
      completion_tokens: 40,
      ...(extra.usage ?? {}),
    },
  }),
});

test("openrouter: interpret translates the request and normalizes the reply", async () => {
  const fetchImpl = fakeFetch(async () =>
    orResponse(
      '{"intent":"LOOKUP","language":"en","tests":["Ferritin"],"subject":"","rewrite":"What is the ferritin result?"}',
    ),
  );
  const gem = createGemini({
    env: { OPENROUTER_API_KEY: "sk-or-test" },
    fetchImpl,
  });
  assert.equal(gem.enabled(), true);
  assert.equal(gem.status().provider, "openrouter");
  const it = await gem.interpret("mera ferritin?", {
    domain: "lab reports",
    tests: ["Ferritin"],
    subjects: [],
    documents: [],
    previous: null,
  });
  assert.equal(it.intent, "LOOKUP");
  assert.equal(fetchImpl.calls.length, 1);
  const c = fetchImpl.calls[0];
  assert.equal(c.url, "https://openrouter.ai/api/v1/chat/completions");
  assert.equal(c.body.model, "google/gemini-3.8-flash");
  assert.equal(c.body.messages[0].role, "user");
  assert.match(c.body.messages[0].content, /mera ferritin\?/);
  assert.equal(c.body.response_format.type, "json_schema");
  assert.deepEqual(c.body.reasoning, { effort: "low" });
  assert.equal(c.init.headers.authorization, "Bearer sk-or-test");
  const st = gem.status();
  assert.ok(st.budget.usd > 0, "usage is charged from normalized token counts");
});

test("openrouter: provider selection and kill switch", async () => {
  const fetchImpl = fakeFetch(async () => orResponse("{}"));
  // Explicit provider wins even when a direct Gemini key exists.
  const forced = createGemini({
    env: {
      GEMINI_API_KEY: "g",
      OPENROUTER_API_KEY: "sk-or-test",
      VM_LLM_PROVIDER: "openrouter",
    },
    fetchImpl,
  });
  assert.equal(forced.status().provider, "openrouter");
  // A direct Gemini key alone keeps the old provider and does no fetch.
  const direct = createGemini({ env: { GEMINI_API_KEY: "g" }, fetchImpl });
  assert.equal(direct.status().provider, "gemini");
  // Kill switch beats everything.
  const off = createGemini({
    env: { OPENROUTER_API_KEY: "sk-or-test", VM_GEMINI: "off" },
    fetchImpl,
  });
  assert.equal(off.enabled(), false);
  assert.equal(
    await off.interpret("q", {
      domain: "d",
      tests: [],
      subjects: [],
      documents: [],
      previous: null,
    }),
    null,
  );
  assert.equal(fetchImpl.calls.length, 0);
});

test("openrouter: grounded search is off unless enabled; annotations become sources", async () => {
  const fetchImpl = fakeFetch(async () =>
    orResponse("Ferritin stores iron.", {
      message: {
        annotations: [
          {
            type: "url_citation",
            url_citation: {
              url: "https://medlineplus.gov/x",
              title: "MedlinePlus",
            },
          },
        ],
      },
    }),
  );
  const quiet = createGemini({
    env: { OPENROUTER_API_KEY: "sk-or-test" },
    fetchImpl,
  });
  assert.equal(quiet.searchEnabled(), false);
  assert.equal(await quiet.groundedExplain("ferritin", "en"), null);
  assert.equal(fetchImpl.calls.length, 0, "no search call without opt-in");

  const on = createGemini({
    env: { OPENROUTER_API_KEY: "sk-or-test", VM_OPENROUTER_SEARCH: "on" },
    fetchImpl,
  });
  const bg = await on.groundedExplain("ferritin", "en");
  assert.equal(fetchImpl.calls.length, 1);
  assert.deepEqual(fetchImpl.calls[0].body.plugins, [{ id: "web" }]);
  assert.match(bg.text, /iron/);
  assert.deepEqual(bg.sources, [
    { title: "MedlinePlus", uri: "https://medlineplus.gov/x" },
  ]);
});

test("openrouter: audio maps to input_audio; provider errors fail closed to null", async () => {
  const fetchImpl = fakeFetch(async (url) => {
    if (url.includes("chat/completions")) return orResponse("what is ferritin");
    throw new Error("unreachable");
  });
  const gem = createGemini({
    env: { OPENROUTER_API_KEY: "sk-or-test" },
    fetchImpl,
  });
  const text = await gem.transcribe(
    Buffer.from("RIFF....synthetic-audio-bytes"),
    "audio/webm",
    ["Ferritin"],
    "en",
  );
  assert.equal(text, "what is ferritin");
  const part = fetchImpl.calls[0].body.messages[0].content.find(
    (p) => p.type === "input_audio",
  );
  assert.equal(part.input_audio.format, "webm");
  assert.equal(
    part.input_audio.data,
    Buffer.from("RIFF....synthetic-audio-bytes").toString("base64"),
  );

  const failing = createGemini({
    env: { OPENROUTER_API_KEY: "sk-or-test" },
    fetchImpl: fakeFetch(async () => ({
      ok: false,
      status: 429,
      json: async () => ({}),
    })),
  });
  assert.equal(
    await failing.interpret("q", {
      domain: "d",
      tests: [],
      subjects: [],
      documents: [],
      previous: null,
    }),
    null,
    "a provider error falls back, never throws",
  );
  assert.equal(failing.status().lastError.code, 429);
});

// ---------------------------------------------------------------------------
// Privacy: egress gates. All fixtures here are synthetic; no real personal
// data appears in this file or in any payload these tests send to the fake
// client (which is a recording stub, never a network).
function identifiedBundle() {
  const bundle = importBundle([
    {
      title: "Discharge summary - Test Person B.md",
      text: "# Discharge summary\nPatient: Test Person B, ID SYN-4242. Ferritin 50 ng/mL on 2026-09-01. The revised dose is 65 mg daily.",
    },
    {
      title: "02_Followup_Notes.md",
      text: "# Followup\nTest Person B reported fatigue. Ferritin rechecked: 48 ng/mL on 2026-10-01.",
    },
  ]);
  bundle.clinical = [
    {
      meta: { patient: { id: "SYN-4242", name: "Test Person B" } },
      observations: [
        { test: "Ferritin", value: 50, unit: "ng/mL", date: "2026-09-01" },
        { test: "Ferritin", value: 48, unit: "ng/mL", date: "2026-10-01" },
      ],
    },
  ];
  return bundle;
}
const IDENTIFIERS = [/Test Person B/i, /SYN-?4242/i];
const payloadsOf = (gem) =>
  gem.calls.map((c) =>
    JSON.stringify({ c: c.contents, p: c.config?.systemInstruction }),
  );

test("privacy: without visitor consent no Gemini call happens on any rescue path", async () => {
  const bundle = identifiedBundle();
  const src = bundle.sources[0];
  const ev = {
    sourceId: src.id,
    title: src.title,
    hash: src.hash,
    start: 0,
    end: 120,
    quote: src.text.slice(0, 120),
  };
  const client = fakeClient((req) => {
    if (req.config.responseJsonSchema?.properties?.claims)
      return {
        text: JSON.stringify({
          answerable: false,
          claims: [],
        }),
      };
    return {
      text: '{"intent":"LOOKUP","language":"en","tests":["Ferritin"],"subject":"","rewrite":""}',
    };
  });
  const gem = createGemini({ env: {}, client });
  const base = {
    bundle,
    lead: null,
    raw: { evidence: [ev] },
    rerun: async () => null,
    validate: () => false,
    gemini: gem,
    consent: false,
    ctx: "Test Person B ferritin trend",
  };
  // Path 1: TERM -> grounded explain (would send the extracted term).
  await semanticRescue({ ...base, question: "What is ferritin?" });
  // Path 2: weak lead + rerun -> interpret (would send question + catalog).
  await semanticRescue({ ...base, question: "Did the dose change?" });
  // Path 3: weak lead + evidence -> planClaims (would send passages).
  await semanticRescue({ ...base, question: "how much ferritin", lead: null });
  assert.equal(
    client.calls.length,
    0,
    "no consent: zero model calls, so titles, ids, names, topics and passages never leave",
  );
});

test("privacy: a consented interpret catalog carries no patient names, ids or raw titles", async () => {
  const bundle = identifiedBundle();
  const client = fakeClient(() => ({
    text: '{"intent":"UNCLEAR","language":"en","tests":[],"subject":"","rewrite":"","clarify":"Which report do you mean?"}',
  }));
  const gem = createGemini({ env: {}, client });
  await semanticRescue({
    question: "What do the recent documents say?",
    bundle,
    lead: null,
    raw: { evidence: [] },
    rerun: async () => null,
    validate: () => false,
    gemini: gem,
    consent: true,
    ctx: "Test Person B and SYN-4242 trend",
  });
  assert.ok(client.calls.length >= 1, "consented path does call the model");
  for (const p of payloadsOf(client))
    for (const id of IDENTIFIERS)
      assert.doesNotMatch(p, id, `identifier leaked in payload: ${id}`);
  const interpretCall = client.calls.find((c) =>
    String(c.contents).includes("Catalog subjects:"),
  );
  assert.ok(interpretCall, "interpret call recorded");
  assert.match(
    String(interpretCall.contents),
    /Catalog subjects: \[\]/,
    "subject labels are never sent, even consented",
  );
  assert.doesNotMatch(
    String(interpretCall.contents),
    /Discharge summary - Test Person B/,
    "document titles are redacted before sending",
  );
});

test("privacy: a name-shaped TERM never reaches grounded search, consent or not", async () => {
  const bundle = identifiedBundle();
  const client = fakeClient(() => ({ text: "background" }));
  const gem = createGemini({ env: {}, client });
  await semanticRescue({
    question: "What is Test Person B?",
    bundle,
    lead: null,
    raw: { evidence: [] },
    rerun: async () => null,
    validate: () => false,
    gemini: gem,
    consent: true,
  });
  const grounded = client.calls.filter(
    (c) =>
      String(c.config?.systemInstruction ?? "").includes("grounded") ||
      (c.config?.tools ?? []).length > 0,
  );
  assert.equal(
    grounded.length,
    0,
    "a term that redaction changes is never sent to grounded search",
  );
});

// The demo-trial audience gate: VM_SEMANTIC_AUDIENCE=demo keeps paid
// semantics on the built-in synthetic cases only. The decision is
// server-side; a visitor's opt-in cannot widen it.
test("privacy: demo trial scope gates paid semantics off for visitor uploads, consent flag or not", async () => {
  assert.equal(semanticConsentFor("case:voice", false, {}), true, "demo cases may use the model");
  assert.equal(semanticConsentFor("case:voice", true, { VM_SEMANTIC_AUDIENCE: "demo" }), true, "demo cases unaffected by trial scope");
  assert.equal(semanticConsentFor("ws:visitor1", false, {}), false, "no consent, no model");
  assert.equal(semanticConsentFor("ws:visitor1", true, {}), true, "outside trial scope, opt-in allows");
  assert.equal(
    semanticConsentFor("ws:visitor1", true, { VM_SEMANTIC_AUDIENCE: "demo" }),
    false,
    "trial scope: a client opt-in cannot widen the server gate",
  );
  // And the gate's output actually means zero egress on every rescue path,
  // even for a visitor who opted in.
  const bundle = identifiedBundle();
  const src = bundle.sources[0];
  const ev = {
    sourceId: src.id, title: src.title, hash: src.hash,
    start: 0, end: 120, quote: src.text.slice(0, 120),
  };
  const client = fakeClient((req) => {
    if (req.config.responseJsonSchema?.properties?.claims)
      return { text: JSON.stringify({ answerable: false, claims: [] }) };
    return { text: '{"intent":"LOOKUP","language":"en","tests":["Ferritin"],"subject":"","rewrite":""}' };
  });
  const gem = createGemini({ env: {}, client });
  const consent = semanticConsentFor("ws:visitor1", true, { VM_SEMANTIC_AUDIENCE: "demo" });
  for (const q of ["What is ferritin?", "Did the dose change?", "how much ferritin"])
    await semanticRescue({
      question: q, bundle, lead: null, raw: { evidence: [ev] },
      rerun: async () => null, validate: () => false, gemini: gem, consent, ctx: null,
    });
  assert.equal(
    client.calls.length,
    0,
    "demo trial scope: an opted-in upload still produces zero model calls",
  );
});
