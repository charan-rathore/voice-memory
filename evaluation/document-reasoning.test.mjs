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
