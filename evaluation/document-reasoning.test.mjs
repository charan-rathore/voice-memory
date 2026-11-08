import test from "node:test";
import assert from "node:assert/strict";
import { importBundle } from "../dist/engine.mjs";
import {
  readDocumentQuestion as actualReadDocumentQuestion,
  DOCUMENT_CONTEXT_LIMIT,
} from "../src/semantic/document.mjs";
const text =
  "The board proposed a grant of $10 on 4 June. Approval remained pending. Alice was expected to become CEO next year, not during 2024.";
const bundle = importBundle([{ title: "Public synthetic notice", text }]);
const question = "Was the grant approved and was Alice already CEO in 2024?";
import { createDecomposition } from "../src/question-decomposition.mjs";
// Explicit fixture decomposition only. This helper tests the wire contract,
// not a production language parser. Compound coverage has a separate test.
const fixtureSegments = (q) => ({
  provenance: "explicit-source-validator-development-fixture",
  segments: [{ kind: "requirement", start: 0, end: q.length }],
});
const readDocumentQuestion = (opts) =>
  actualReadDocumentQuestion({
    ...opts,
    decomposition: createDecomposition({
      question: opts.question,
      ...fixtureSegments(opts.question),
    }),
  });
function fake(changes = {}) {
  const provider = {
    enabled: () => true,
    documentRead: async () => ({
      question,
      parts: [
        {
          request: "Grant status",
          status: "answered",
          claims: [
            {
              statement: "Approval remained pending.",
              evidence: [{ document: 0, quote: "Approval remained pending." }],
            },
          ],
        },
      ],
    }),
    documentAudit: async (q, p, ss) => ({
      question: q,
      complete: true,
      relevant: true,
      supported: true,
      items: ss.map((s, index) => ({ index, accept: true })),
    }),
    ...changes,
  };
  return {
    ...provider,
    documentRead: async (plan, documents, opts) => {
      const r = await provider.documentRead(
        plan.originalQuestion,
        documents,
        opts,
      );
      if (!r) return r;
      return {
        ...r,
        questionPlanKey: plan.key,
        scopeKey: plan.scopeKey,
        requirements: (r.parts ?? []).map((part, i) => ({
          ...plan.requirements[i],
          ...part,
          text: plan.requirements[i]?.text,
          id: plan.requirements[i]?.id,
        })),
      };
    },
    documentAudit: async (plan, p, ss, opts) => {
      const r = await provider.documentAudit(
        plan.originalQuestion,
        p,
        ss,
        opts,
      );
      return {
        ...r,
        questionPlanKey: plan.key,
        scopeKey: plan.scopeKey,
        items: r.items?.map((item) => ({
          ...item,
          requirementId: ss[item.index]?.requirementId,
        })),
      };
    },
  };
}
test("no consent or provider means no document disclosure", async () => {
  let calls = 0;
  const gemini = fake({
    documentRead: async () => {
      calls++;
    },
  });
  assert.equal(
    await readDocumentQuestion({ question, bundle, gemini, consent: false }),
    null,
  );
  assert.equal(calls, 0);
});
test("direct exact source checks and separate complete relevance/entailment audit", async () => {
  const r = await readDocumentQuestion({
    question,
    bundle,
    gemini: fake(),
    consent: true,
  });
  assert.match(r.text, /pending/);
  assert.equal(r.citations[0].quote, "Approval remained pending.");
  for (const failure of ["complete", "relevant", "supported"]) {
    const gemini = fake({
      documentAudit: async () => ({
        question,
        complete: true,
        relevant: true,
        supported: true,
        [failure]: false,
        items: [
          { index: 0, accept: true },
          { index: 1, accept: true },
        ],
      }),
    });
    assert.equal(
      await readDocumentQuestion({ question, bundle, gemini, consent: true }),
      null,
      failure,
    );
  }
});
test("changed question, invented quote, missing audit items and rejected meaning all fail closed", async () => {
  for (const gemini of [
    fake({ documentRead: async () => ({ question: "different", parts: [] }) }),
    fake({
      documentAudit: async () => ({
        question,
        complete: true,
        relevant: true,
        supported: true,
        items: [],
      }),
    }),
    fake({
      documentAudit: async () => ({
        question,
        complete: true,
        relevant: true,
        supported: true,
        items: [
          { index: 0, accept: false },
          { index: 1, accept: true },
        ],
      }),
    }),
  ])
    assert.equal(
      await readDocumentQuestion({ question, bundle, gemini, consent: true }),
      null,
    );
});
test("oversize context is explicitly refused without silent truncation/provider call", async () => {
  let calls = 0;
  const r = await readDocumentQuestion({
    question,
    bundle: { sources: [{ text: "x".repeat(DOCUMENT_CONTEXT_LIMIT + 1) }] },
    gemini: fake({
      documentRead: async () => {
        calls++;
      },
    }),
    consent: true,
  });
  assert.equal(calls, 0);
  assert.equal(r.origin, "document-limit");
});

test("fabricated evidence and ambiguous repeated quotation never pass exact source checks", async () => {
  for (const quote of [
    "The board approved a grant of $10.",
    "Approval remained pending.",
  ]) {
    const repeated = quote === "Approval remained pending.";
    const b = repeated
      ? importBundle([
          {
            title: "Repeated notice",
            text: text + " Approval remained pending.",
          },
        ])
      : bundle;
    const gemini = fake({
      documentRead: async () => ({
        question,
        parts: [
          {
            request: "Grant status",
            status: "answered",
            claims: [
              {
                statement: "The grant was approved.",
                evidence: [{ document: 0, quote }],
              },
            ],
          },
        ],
      }),
    });
    assert.equal(
      await readDocumentQuestion({
        question,
        bundle: b,
        gemini,
        consent: true,
      }),
      null,
    );
  }
});

test("actual public upload API requires consent and audits a strong lexical answer before emitting it", async () => {
  const { createLocalServer } = await import("../src/server.mjs");
  const oldFlag = process.env.VM_DOCUMENT_REASONING,
    oldCounter = process.env.VM_COUNTERS_ALLOW_FILE;
  process.env.VM_DOCUMENT_REASONING = "on";
  process.env.VM_COUNTERS_ALLOW_FILE = "on";
  const calls = [];
  let throwRead = false,
    badAudit = false;
  const gemini = fake({
    enabled: () => true,
    searchEnabled: () => false,
    interpret: async () => null,
    planClaims: async () => null,
    documentRead: async (q, documents) => {
      calls.push({ kind: "read", q, documents });
      if (throwRead) throw Error("fake provider outage");
      return {
        question: q,
        parts: [
          {
            request: "Grant status",
            status: "answered",
            claims: [
              {
                statement: "Approval remained pending.",
                evidence: [
                  { document: 0, quote: "Approval remained pending." },
                ],
              },
            ],
          },
        ],
      };
    },
    documentAudit: async (q, p, statements, opts) => {
      calls.push({ kind: "audit", q, opts });
      return {
        question: q,
        complete: !badAudit,
        relevant: true,
        supported: true,
        items: statements.map((x, index) => ({ index, accept: true })),
      };
    },
  });
  const s = createLocalServer({
    port: 0,
    gemini,
    resolveDocumentDecomposition: fixtureSegments,
  });
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${s.address().port}/api/public`;
  try {
    const ws = await fetch(base + "/workspace", { method: "POST" }).then((r) =>
      r.json(),
    );
    assert.equal(
      (
        await fetch(`${base}/workspace/${ws.id}/upload`, {
          method: "POST",
          headers: { "x-file-name": "public-synthetic-notice.txt" },
          body: text,
        })
      ).status,
      202,
    );
    let state;
    for (let i = 0; i < 300; i++) {
      state = await fetch(`${base}/workspace/${ws.id}`).then((r) => r.json());
      if (state.ready && state.documents[0]?.status === "ready") break;
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.ok(state.ready);
    const ask = async (question, semantic) => {
      const r = await fetch(base + "/ask", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          case: ws.id,
          question,
          semantic,
          documentConsent: semantic
            ? {
                generation: state.bundleGeneration,
                model: null,
                provider: "Google Gemini",
              }
            : undefined,
        }),
      });
      assert.equal(r.status, 200);
      return r.json();
    };
    await ask("Was the grant approved?", false);
    assert.equal(calls.length, 0, "no consent means no document calls");
    const a = await ask("Was the grant approved?", true);
    assert.equal(a.final.verdict, "DOCUMENT_ANSWER");
    assert.match(a.final.text, /Approval remained pending/);
    assert.equal(a.final.citations[0].quote, "Approval remained pending.");
    assert.equal(calls.length, 2);
    assert.ok(
      calls[1].opts.documents[0].text.includes("next year"),
      "auditor receives full context, not selected snippets",
    );
    badAudit = true;
    const b = await ask(
      "Was the grant approved or still awaiting approval?",
      true,
    );
    assert.equal(b.final.kind, "abstained");
    assert.deepEqual(b.final.citations, []);
    throwRead = true;
    const c = await ask("Is the board grant finally approved?", true);
    assert.equal(c.final.kind, "abstained");
    assert.deepEqual(c.final.citations, []);
    assert.doesNotMatch(c.final.text, /proposed a grant of \$10/);
  } finally {
    await new Promise((r) => s.close(r));
    if (oldFlag === undefined) delete process.env.VM_DOCUMENT_REASONING;
    else process.env.VM_DOCUMENT_REASONING = oldFlag;
    if (oldCounter === undefined) delete process.env.VM_COUNTERS_ALLOW_FILE;
    else process.env.VM_COUNTERS_ALLOW_FILE = oldCounter;
  }
});

test("repeated quotations may use explicit exact spans but never guessed offsets or wrong source IDs", async () => {
  const quote = "Approval remained pending.";
  const b = importBundle([
    {
      title: "Repeated synthetic source",
      text: quote + " Interim note. " + quote,
    },
  ]);
  const start = b.sources[0].text.lastIndexOf(quote),
    end = start + quote.length;
  for (const [ref, allowed] of [
    [{ document: 0, sourceId: b.sources[0].id, start, end, quote }, true],
    [
      { document: 0, sourceId: b.sources[0].id, start: start + 1, end, quote },
      false,
    ],
    [{ document: 0, sourceId: "different-source", start, end, quote }, false],
    [{ document: 0, start, end: end + 1, quote }, false],
    [{ document: 0, start, quote }, false],
    [{ document: 0, quote }, false],
  ]) {
    const gemini = fake({
      documentRead: async () => ({
        question,
        parts: [
          {
            request: "Grant status",
            status: "answered",
            claims: [{ statement: quote, evidence: [ref] }],
          },
        ],
      }),
    });
    const answer = await readDocumentQuestion({
      question,
      bundle: b,
      gemini,
      consent: true,
    });
    assert.equal(!!answer, allowed);
    if (allowed) {
      assert.equal(answer.citations[0].start, start);
      assert.equal(answer.citations[0].end, end);
    }
  }
});

test("opaque default makes no provider call and fake audit cannot assert semantic coverage", async () => {
  let calls = 0;
  const result = await actualReadDocumentQuestion({
    question,
    bundle,
    consent: true,
    gemini: fake({
      documentRead: async () => {
        calls++;
        throw Error("must not disclose");
      },
    }),
  });
  assert.equal(calls, 0);
  assert.equal(result.origin, "document-unqualified-question");
  assert.equal(result.requestPlan.coverageEstablished, false);
  assert.equal(result.verdict, "UNKNOWN");
});

test("actual reader rejects omitted, duplicated or replaced caller requirements before a favorable audit", async () => {
  const q = "Was the launch approved, and who paid the deposit?";
  const b = importBundle([
    {
      title: "Exposed development fixture",
      text: "The launch was approved. Mina paid the deposit.",
    },
  ]);
  const cut = q.indexOf(", and ");
  const decomposition = createDecomposition({
    question: q,
    provenance: "explicit-compound-development-fixture",
    segments: [
      { kind: "requirement", start: 0, end: cut },
      { kind: "glue", start: cut, end: cut + 6 },
      { kind: "requirement", start: cut + 6, end: q.length },
    ],
  });
  for (const mutate of [
    (r) => r.requirements.pop(),
    (r) => (r.requirements[1] = r.requirements[0]),
    (r) => (r.requirements[1].text = "Who approved?"),
  ]) {
    let audits = 0;
    const result = await actualReadDocumentQuestion({
      question: q,
      bundle: b,
      decomposition,
      consent: true,
      gemini: {
        enabled: () => true,
        documentRead: async (p) => {
          const r = {
            question: q,
            questionPlanKey: p.key,
            scopeKey: p.scopeKey,
            requirements: p.requirements.map((x) => ({
              ...x,
              status: "not_established",
              claims: [],
            })),
          };
          mutate(r);
          return r;
        },
        documentAudit: async () => {
          audits++;
          return { complete: true, relevant: true, supported: true };
        },
      },
    });
    assert.equal(result, null);
    assert.equal(audits, 0);
  }
});

test("reader rejects changed source generation and missing or mislabeled audit judgments", async () => {
  for (const mutate of [
    (r) => (r.items = []),
    (r) => (r.items[0].requirementId = "wrong-requirement"),
    (r) => (r.questionPlanKey = "stale-plan"),
    (r) => r.items.push(r.items[0]),
  ]) {
    const provider = fake();
    const audit = provider.documentAudit;
    provider.documentAudit = async (...args) => {
      const r = await audit(...args);
      mutate(r);
      return r;
    };
    assert.equal(
      await readDocumentQuestion({
        question,
        bundle,
        gemini: provider,
        consent: true,
      }),
      null,
    );
  }
  let current = true;
  const provider = fake();
  const audit = provider.documentAudit;
  provider.documentAudit = async (...args) => {
    const r = await audit(...args);
    current = false;
    return r;
  };
  assert.equal(
    await readDocumentQuestion({
      question,
      bundle,
      gemini: provider,
      consent: true,
      isCurrent: () => current,
    }),
    null,
  );
});
