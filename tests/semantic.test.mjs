// Semantic layer: intent, redaction, claim verification, budgets, the bounded
// Gemini client (with an injected fake - no network, no key), the router's
// rescue paths and the final audit.
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyIntent, termOf } from "../src/semantic/intent.mjs";
import { verifyClaims, auditLead } from "../src/semantic/verify.mjs";
import { createGemini, createBudget, redact } from "../src/semantic/gemini.mjs";
import { semanticRescue } from "../src/semantic/route.mjs";
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
    consent: false,
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
    consent: false,
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
