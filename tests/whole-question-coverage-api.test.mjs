// Whole-question coverage through the real HTTP upload/ask API and the real
// voice (custom-LLM) call path. Provider-disabled cases make no provider
// calls. Provider-enabled cases replay SCRIPTED provider-shaped responses
// (tests/fixtures/whole-question) or ACTUAL saved provider content
// (tests/fixtures/document-disagreement); nothing here makes a paid call.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createLocalServer } from "../src/server.mjs";
import { coverageNotice } from "../src/whole-question-coverage.mjs";

const scripted = JSON.parse(
  readFileSync(
    new URL("./fixtures/whole-question/policy-scripted.json", import.meta.url),
  ),
);
const NOTICE = coverageNotice("en");
const ASSERTING = new Set(["answered", "partial", "quoted"]);

async function withServer(opts, fn) {
  const saved = {
    byo: process.env.VM_BYO_VOICE,
    counters: process.env.VM_COUNTERS_ALLOW_FILE,
    wq: process.env.VM_WHOLE_QUESTION_COVERAGE,
  };
  process.env.VM_BYO_VOICE = "on";
  process.env.VM_COUNTERS_ALLOW_FILE = "on";
  if (opts.wholeQuestion) process.env.VM_WHOLE_QUESTION_COVERAGE = opts.wholeQuestion;
  else delete process.env.VM_WHOLE_QUESTION_COVERAGE;
  const server = createLocalServer({ port: 0, gemini: opts.gemini });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}/api/public`;
  const post = (path, body) =>
    fetch(base + path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const upload = async (name, text) => {
    const ws = await post("/workspace", {}).then((r) => r.json());
    const r = await fetch(`${base}/workspace/${ws.id}/upload`, {
      method: "POST",
      headers: { "x-file-name": name },
      body: text,
    });
    assert.equal(r.status, 202);
    for (let i = 0; i < 300; i++) {
      const s = await fetch(`${base}/workspace/${ws.id}`).then((r) => r.json());
      if (s.ready && s.documents[0]?.status === "ready")
        return { id: ws.id, generation: s.bundleGeneration };
      await new Promise((r) => setTimeout(r, 20));
    }
    throw Error("upload not ready");
  };
  const ask = async (ws, question, consent = false) => {
    const r = await post("/ask", {
      case: ws.id,
      question,
      semantic: consent,
      documentConsent: consent
        ? { generation: ws.generation, model: null, provider: "Google Gemini" }
        : undefined,
    });
    assert.equal(r.status, 200);
    return r.json();
  };
  const say = async (ws, question) => {
    const key = (await post("/llm/key", { case: ws.id }).then((r) => r.json()))
      .apiKey;
    const r = await fetch(base + "/llm/v1/chat/completions", {
      method: "POST",
      headers: { authorization: "Bearer " + key, "content-type": "application/json" },
      body: JSON.stringify({ stream: true, messages: [{ role: "user", content: question }] }),
    });
    assert.equal(r.status, 200);
    return [...(await r.text()).matchAll(/^data: (.+)$/gm)]
      .filter((m) => m[1] !== "[DONE]")
      .map((m) => JSON.parse(m[1]).choices?.[0]?.delta?.content || "")
      .join("");
  };
  try {
    await fn({ upload, ask, say });
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    for (const [k, env] of [
      ["byo", "VM_BYO_VOICE"],
      ["counters", "VM_COUNTERS_ALLOW_FILE"],
      ["wq", "VM_WHOLE_QUESTION_COVERAGE"],
    ])
      if (saved[k] === undefined) delete process.env[env];
      else process.env[env] = saved[k];
  }
}

const disabled = { enabled: () => false, searchEnabled: () => false };

// The invariant the screen and the call must hold for every response.
function assertHonest(body, label) {
  const kind = body.final.kind;
  const certified =
    !!body.requirementCoverage || body.questionPlan?.coverageEstablished === true;
  assert.ok(body.wholeQuestion, `${label}: coverage provenance present`);
  if (ASSERTING.has(kind) && !certified) {
    assert.equal(body.final.complete, false, `${label}: never complete`);
    assert.equal(body.wholeQuestion.state, "unverified", label);
    assert.equal(body.wholeQuestion.unaddressedPartsNamed, false, label);
    assert.ok(body.final.text.includes(NOTICE), `${label}: discloses on screen`);
    assert.doesNotMatch(body.final.text, /Not established from these documents/, label);
  }
  if (!ASSERTING.has(kind))
    assert.equal(body.wholeQuestion.state, "not_applicable", label);
}

test("ORIGINAL FAILURE (provider disabled): compounds carry unverified coverage and do not present as fully answered", () =>
  withServer({ gemini: disabled }, async ({ upload, ask, say }) => {
    const ws = await upload(scripted.fileName, scripted.document);
    for (const q of [
      "Who owns the security review, and what is the retention window?",
      "Who owns the security review, and what is the lunar permit code?",
    ]) {
      const b = await ask(ws, q);
      // Before this change: status "answered", no coverage, no disclosure.
      assert.equal(b.questionPlan.coverageEstablished, false);
      assert.equal(b.questionPlan.unresolvedRemainder, q);
      assert.equal(b.final.complete, false);
      assert.equal(b.wholeQuestion.state, "unverified");
      assert.equal(b.wholeQuestion.source, "opaque-plan");
      assert.ok(b.final.text.endsWith(NOTICE));
      assert.doesNotMatch(b.final.text, /lunar|retention/i, "no guessed remainder");
      assertHonest(b, q);
      // The call says the same thing (same lead, same disclosure).
      const spoken = await say(ws, q);
      assert.ok(spoken.includes(NOTICE), `voice discloses: ${spoken}`);
      assert.match(spoken, /Maya/);
    }
    const absent = await ask(ws, "What is the lunar permit code?");
    assert.equal(absent.final.kind, "abstained");
    assert.equal(absent.wholeQuestion.state, "not_applicable");
    assert.ok(!absent.final.text.includes(NOTICE));
    const single = await ask(ws, "What is the retention window?");
    assert.equal(single.final.kind, "answered", "single answers still answer");
    assert.match(single.final.text, /17 days/);
    assert.equal(single.status, "answered", "status value unchanged (additive)");
    assertHonest(single, "single");
  }));

test("ADVERSARIAL (provider disabled, unfamiliar documents): no response over-claims whole coverage", () =>
  withServer({ gemini: disabled }, async ({ upload, ask, say }) => {
    const ws = await upload(
      "vendor-memo.txt",
      "Priya Raman approved the Q3 vendor budget of 48,000 rupees. Priya Menon drafted the travel policy. The data export request was not approved. The backup interval changed from 6 hours to 12 hours on 4 March.",
    );
    const questions = [
      // all parts answerable
      "Who approved the Q3 vendor budget and what is the backup interval now?",
      // some answerable
      "Who drafted the travel policy and what is the parking fee?",
      // none answerable
      "What is the parking fee and who signs the office lease?",
      // paraphrase
      "Which Priya wrote up the rules for business trips?",
      // namesake owners
      "What did Priya approve?",
      // negation and status change
      "Was the data export request approved?",
      "Did the backup interval stay at 6 hours?",
      // absent half phrased as one sentence
      "What is the Q3 vendor budget in dollars?",
    ];
    for (const q of questions) {
      const b = await ask(ws, q);
      assertHonest(b, q);
      if (ASSERTING.has(b.final.kind)) {
        const spoken = await say(ws, q);
        assert.ok(spoken.includes(NOTICE), `voice discloses for: ${q} -> ${spoken}`);
      }
    }
  }));

// Scripted provider: answers come only from the fixture; the model cannot
// author requirement ids/text (bound from the caller-owned plan by index).
function scriptedProvider(c, calls) {
  const bind = (plan, docs) => ({
    question: plan.originalQuestion,
    questionPlanKey: plan.key,
    scopeKey: plan.scopeKey,
    requirements: plan.requirements.map((r, i) => {
      const part = c.read[i];
      return {
        id: r.id,
        text: r.text,
        owners: [...r.owners],
        status: part.status,
        ...(part.claims
          ? {
              claims: part.claims.map((cl) => ({
                statement: cl.statement,
                evidence: cl.evidence.map((e) => ({
                  ...e,
                  sourceId: docs[e.document].sourceId,
                })),
              })),
            }
          : {}),
      };
    }),
  });
  return {
    enabled: () => true,
    searchEnabled: () => false,
    interpret: async () => null,
    planClaims: async () => null,
    questionRequirements: async (question, { pass }) => {
      calls.push("questionRequirements:" + pass);
      return {
        question,
        requirements: pass === "proposal" ? c.proposal : c.reconstruction,
      };
    },
    documentRead: async (plan, docs) => {
      calls.push("documentRead");
      return bind(plan, docs);
    },
    documentCoverage: async (plan, docs) => {
      calls.push("documentCoverage");
      return bind(plan, docs);
    },
    documentAudit: async (plan, merged, statements, opts) => {
      calls.push("documentAudit");
      return {
        question: plan.originalQuestion,
        questionPlanKey: plan.key,
        scopeKey: plan.scopeKey,
        complete: c.audit === "accept",
        relevant: true,
        supported: true,
        items: statements.map((s, index) => ({
          index,
          requirementId: s.requirementId,
          accept: true,
        })),
        coverageItems: opts.independentPlan.requirements.flatMap((r) =>
          r.status === "answered"
            ? r.claims.map((_, i) => ({ requirementId: r.id, claimIndex: i, accept: true }))
            : [{ requirementId: r.id, claimIndex: null, accept: true }],
        ),
      };
    },
  };
}

for (const [name, c] of Object.entries(scripted.cases))
  test(`QUALIFIED PATH (scripted replay) ${name}: expected ${c.expect}`, async () => {
    const calls = [];
    await withServer(
      { gemini: scriptedProvider(c, calls) },
      async ({ upload, ask }) => {
        const ws = await upload(scripted.fileName, scripted.document);
        const b = await ask(ws, c.question, true);
        assert.equal(b.wholeQuestion.state, c.expect, JSON.stringify(b.wholeQuestion));
        if (c.expect === "established") {
          assert.equal(b.final.complete, true);
          assert.equal(b.final.verdict, "DOCUMENT_ANSWER");
          assert.equal(b.requirementCoverage.source, "qualified-decomposition");
          assert.deepEqual(
            b.requirementCoverage.outcomes.map((o) => o.status),
            ["answered", "answered"],
          );
          assert.match(b.final.text, /Maya/);
          assert.match(b.final.text, /17 days/);
          assert.ok(!b.final.text.includes(NOTICE));
          for (const cite of b.final.citations)
            assert.ok(scripted.document.includes(cite.quote), "exact source quote");
        } else if (c.expect === "incomplete") {
          assert.equal(b.final.complete, false);
          assert.equal(b.final.verdict, "PARTIAL_DOCUMENT");
          assert.equal(b.final.kind, "partial");
          for (const span of c.unestablished)
            assert.ok(b.final.text.includes(span.trim()), "names the exact span");
          assert.match(b.final.text, /Maya/);
        } else {
          // Either proof missing: honest unverified, deterministic lead kept.
          assertHonest(b, name);
          assert.equal(b.final.complete, false);
          assert.equal(b.requirementCoverage, null);
          assert.doesNotMatch(b.final.text, /30 days/, "unproven claim never shown");
        }
        if (name === "reconstructionDisagrees")
          assert.ok(!calls.includes("documentRead"), "no document disclosure");
      },
    );
  });

test("QUALIFIED PATH respects consent and the kill switch: zero provider calls", async () => {
  const c = scripted.cases.ownerRetention;
  for (const variant of ["no-consent", "switch-off"]) {
    const calls = [];
    await withServer(
      {
        gemini: scriptedProvider(c, calls),
        wholeQuestion: variant === "switch-off" ? "off" : undefined,
      },
      async ({ upload, ask }) => {
        const ws = await upload(scripted.fileName, scripted.document);
        const b = await ask(ws, c.question, variant !== "no-consent");
        assertHonest(b, variant);
        assert.equal(b.wholeQuestion.state, "unverified");
        assert.ok(
          !calls.some((x) => x.startsWith("document")),
          `${variant}: ${calls.join(",")}`,
        );
      },
    );
  }
});

test("QUALIFIED PATH (actual saved provider content): real disagreement stays incomplete and names its span", async () => {
  const fixture = JSON.parse(
    readFileSync(
      new URL(
        "./fixtures/document-disagreement/saved-gemini-disagreement.json",
        import.meta.url,
      ),
    ),
  );
  const text = readFileSync(
    new URL("./fixtures/document-disagreement/constitution-transcript.txt", import.meta.url),
    "utf8",
  );
  const rebind = (original, plan, docs) => {
    const value = structuredClone(original);
    value.questionPlanKey = plan.key;
    value.scopeKey = plan.scopeKey;
    for (const r of value.requirements)
      for (const cl of r.claims ?? [])
        for (const ref of cl.evidence ?? []) ref.sourceId = docs[ref.document].sourceId;
    return value;
  };
  const gemini = {
    enabled: () => true,
    searchEnabled: () => false,
    interpret: async () => null,
    planClaims: async () => null,
    questionRequirements: async () => structuredClone(fixture.interpretation),
    documentRead: async (p, d) => rebind(fixture.primary, p, d),
    documentCoverage: async (p, d) => rebind(fixture.blind, p, d),
    // Scripted acceptance: the saved fixture has no captured audit.
    documentAudit: async (p, merged, statements, opts) => ({
      question: p.originalQuestion,
      questionPlanKey: p.key,
      scopeKey: p.scopeKey,
      complete: true,
      relevant: true,
      supported: true,
      items: statements.map((s, index) => ({ index, requirementId: s.requirementId, accept: true })),
      coverageItems: opts.independentPlan.requirements.flatMap((r) =>
        r.status === "answered"
          ? r.claims.map((_, i) => ({ requirementId: r.id, claimIndex: i, accept: true }))
          : [{ requirementId: r.id, claimIndex: null, accept: true }],
      ),
    }),
  };
  await withServer({ gemini }, async ({ upload, ask }) => {
    const ws = await upload("constitution.txt", text);
    const b = await ask(ws, fixture.question, true);
    assert.equal(b.wholeQuestion.state, "incomplete");
    assert.equal(b.final.complete, false);
    assert.deepEqual(
      b.requirementCoverage.outcomes.map((o) => o.status),
      ["answered", "answered", "clarify"],
    );
    assert.ok(b.final.text.includes(fixture.interpretation.requirements[2]));
    assert.match(b.final.text, /two-thirds/);
  });
});
