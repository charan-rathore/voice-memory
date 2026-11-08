import test from "node:test";
import assert from "node:assert/strict";
import { importBundle } from "../dist/engine.mjs";
import {
  readDocumentQuestion,
  DOCUMENT_CONTEXT_LIMIT,
} from "../src/semantic/document.mjs";
const text =
  "The board proposed a grant of $10 on 4 June. Approval remained pending. Alice was expected to become CEO next year, not during 2024.";
const bundle = importBundle([{ title: "Public synthetic notice", text }]);
const question = "Was the grant approved and was Alice already CEO in 2024?";
function fake(changes = {}) {
  return {
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
        {
          request: "CEO timing",
          status: "not_established",
          reason:
            "The supplied evidence does not establish a completed appointment.",
          claims: [],
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
  const gemini = {
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
  };
  const s = createLocalServer({ port: 0, gemini });
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
        body: JSON.stringify({ case: ws.id, question, semantic }),
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
