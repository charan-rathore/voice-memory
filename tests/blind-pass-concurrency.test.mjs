// Latency contract: the two blind question reconstructions and the two blind
// document reads are independent by design, so each pair must be in flight
// together. A sequential implementation deadlocks here and times out.
import test from "node:test";
import assert from "node:assert/strict";
import { importBundle } from "../dist/engine.mjs";
import { understandDocumentQuestion } from "../src/semantic/question-understanding.mjs";
import { readDocumentQuestion } from "../src/semantic/document.mjs";

const QUESTION =
  "Who owns the security review, and what is the retention window?";
const PARTS = [
  "Who owns the security review,",
  "and what is the retention window?",
];
const TEXT = "Maya owns the security review. The retention window is 17 days.";

// Resolves each call only after its sibling call has also started.
function rendezvous(n = 2, timeoutMs = 2000) {
  let arrived = 0,
    release;
  const all = new Promise((r) => (release = r));
  return async () => {
    if (++arrived === n) release();
    await Promise.race([
      all,
      new Promise((_, reject) =>
        setTimeout(
          () => reject(Error("blind passes ran sequentially")),
          timeoutMs,
        ),
      ),
    ]);
  };
}

test("blind question reconstructions run concurrently and still must agree", async () => {
  const meet = rendezvous();
  const decomposition = await understandDocumentQuestion({
    question: QUESTION,
    gemini: {
      questionRequirements: async (question) => {
        await meet();
        return { question, requirements: PARTS };
      },
    },
  });
  assert.equal(decomposition.coverageEstablished, true);
  assert.deepEqual(
    decomposition.requirements.map((r) => r.text.trim()),
    PARTS,
  );
  // Disagreement still fails closed.
  let pass = 0;
  const disagreeing = await understandDocumentQuestion({
    question: QUESTION,
    gemini: {
      questionRequirements: async (question) => ({
        question,
        requirements: pass++ === 0 ? PARTS : [QUESTION],
      }),
    },
  });
  assert.equal(disagreeing, null);
});

test("blind document reads run concurrently; the audit still gates the answer", async () => {
  const bundle = importBundle([{ title: "policy", text: TEXT }]);
  const meet = rendezvous();
  const read = async (plan, docs) => {
    await meet();
    const quotes = [
      "Maya owns the security review.",
      "The retention window is 17 days.",
    ];
    return {
      question: plan.originalQuestion,
      questionPlanKey: plan.key,
      scopeKey: plan.scopeKey,
      requirements: plan.requirements.map((r, i) => ({
        id: r.id,
        text: r.text,
        owners: [...r.owners],
        status: "answered",
        claims: [
          {
            statement: quotes[i],
            evidence: [
              { document: 0, sourceId: docs[0].sourceId, quote: quotes[i] },
            ],
          },
        ],
      })),
    };
  };
  const gemini = {
    enabled: () => true,
    questionRequirements: async (question) => ({
      question,
      requirements: PARTS,
    }),
    documentRead: read,
    documentCoverage: read,
    documentAudit: async (plan, merged, statements, opts) => ({
      question: plan.originalQuestion,
      questionPlanKey: plan.key,
      scopeKey: plan.scopeKey,
      complete: true,
      relevant: true,
      supported: true,
      items: statements.map((s, index) => ({
        index,
        requirementId: s.requirementId,
        accept: true,
      })),
      coverageItems: opts.independentPlan.requirements.flatMap((r) =>
        r.claims.map((_, i) => ({
          requirementId: r.id,
          claimIndex: i,
          accept: true,
        })),
      ),
    }),
  };
  const decomposition = await understandDocumentQuestion({
    question: QUESTION,
    gemini,
  });
  const answer = await readDocumentQuestion({
    question: QUESTION,
    bundle,
    gemini,
    consent: true,
    decomposition,
  });
  assert.equal(answer.verdict, "DOCUMENT_ANSWER");
  assert.match(answer.text, /Maya/);
  assert.match(answer.text, /17 days/);
  // A rejecting audit still yields no answer, concurrency notwithstanding.
  const rejected = await readDocumentQuestion({
    question: QUESTION,
    bundle,
    gemini: {
      ...gemini,
      documentAudit: async (...a) => ({
        ...(await gemini.documentAudit(...a)),
        complete: false,
      }),
    },
    consent: true,
    decomposition,
  });
  assert.equal(rejected, null);
});

test("a source invalidated synchronously by the first blind pass yields no decomposition", async () => {
  // The first provider callback flips the source generation before the
  // second callback starts (array elements evaluate in order): the result
  // must fail closed regardless of when the second pass begins.
  let current = true;
  const started = [];
  const decomposition = await understandDocumentQuestion({
    question: QUESTION,
    isCurrent: () => current,
    gemini: {
      questionRequirements: async (question, opts) => {
        started.push(opts?.pass);
        if (started.length === 1) current = false;
        return { question, requirements: PARTS };
      },
    },
  });
  assert.equal(decomposition, null);
  // The second provider call must not start after the source changed.
  assert.deepEqual(started, ["proposal"]);
});
