import test from "node:test";
import assert from "node:assert/strict";
import { importBundle } from "../dist/engine.mjs";
import { readDocumentQuestion } from "../src/semantic/document.mjs";
import { understandDocumentQuestion } from "../src/semantic/question-understanding.mjs";

const source =
  "A pilot can start after funding. A pilot can also start after a recorded waiver. The fee is $500.";
const question = "When can the pilot start? What is the local phone number?";
const requirements = [
  "When can the pilot start?",
  "What is the local phone number?",
];
const bundle = importBundle(
  [{ title: "Synthetic development policy", text: source }],
  { scope: "model-coverage-test" },
);
async function run({
  missingAlternative = false,
  absentCoverageItem = false,
  rejectCoverage = false,
  mismatch = false,
  staleAfterCoverage = false,
} = {}) {
  let current = true,
    audits = 0,
    seenIndependent = null;
  const makePlan = (requestPlan, documents, independent) => ({
    question,
    questionPlanKey: requestPlan.key,
    scopeKey: requestPlan.scopeKey,
    requirements: requestPlan.requirements.map((r, index) => ({
      id: r.id,
      text: r.text,
      owners: r.owners,
      status: index === 0 ? "answered" : "not_established",
      claims:
        index === 0
          ? [
              {
                statement: "Funding permits the pilot to start.",
                evidence: [
                  {
                    document: 0,
                    sourceId: documents[0].sourceId,
                    quote: "A pilot can start after funding.",
                  },
                ],
              },
              ...(!missingAlternative || independent
                ? [
                    {
                      statement:
                        "A recorded waiver also permits the pilot to start.",
                      evidence: [
                        {
                          document: 0,
                          sourceId: documents[0].sourceId,
                          quote:
                            "A pilot can also start after a recorded waiver.",
                        },
                      ],
                    },
                  ]
                : []),
            ]
          : [],
    })),
  });
  const gemini = {
    enabled: () => true,
    questionRequirements: async () => ({ question, requirements }),
    documentRead: async (plan, documents) => makePlan(plan, documents, false),
    documentCoverage: async (plan, documents) => {
      const result = makePlan(plan, documents, true);
      if (mismatch) {
        result.requirements[0].status = "not_established";
        result.requirements[0].claims = [];
      }
      if (staleAfterCoverage) current = false;
      return result;
    },
    documentAudit: async (plan, proposal, statements, opts) => {
      audits++;
      seenIndependent = opts.independentPlan;
      const coverageItems = opts.independentPlan.requirements.flatMap((r) =>
        r.status === "answered"
          ? r.claims.map((_, i) => ({
              requirementId: r.id,
              claimIndex: i,
              accept: !rejectCoverage,
            }))
          : [{ requirementId: r.id, claimIndex: null, accept: true }],
      );
      if (absentCoverageItem) coverageItems.pop();
      return {
        question,
        questionPlanKey: plan.key,
        scopeKey: plan.scopeKey,
        complete: true,
        relevant: true,
        supported: true,
        items: statements.map((s, i) => ({
          index: i,
          requirementId: s.requirementId,
          accept: true,
        })),
        coverageItems,
      };
    },
  };
  const decomposition = await understandDocumentQuestion({ question, gemini });
  const result = await readDocumentQuestion({
    question,
    bundle,
    gemini,
    consent: true,
    decomposition,
    isCurrent: () => current,
  });
  return { result, audits, seenIndependent };
}

test("model-interpreted reader needs a blind full-source reconstruction plus per-claim coverage judgments", async () => {
  const { result, audits, seenIndependent } = await run();
  assert.equal(result.origin, "document-model-audited");
  assert.equal(result.verdict, "PARTIAL_DOCUMENT");
  assert.equal(audits, 1);
  assert.equal(seenIndependent.requirements[0].claims.length, 2);
  assert.match(result.text, /recorded waiver/);
  assert.match(result.text, /could not establish/);
  assert.equal(
    result.text.split(requirements[0]).length - 1,
    0,
    "answered statements do not repeat the long request label",
  );
});

test("an alternative found by blind reconstruction is retained and source-admitted before final audit", async () => {
  const { result, audits } = await run({ missingAlternative: true });
  assert.match(result.text, /recorded waiver/);
  assert.equal(
    audits,
    1,
    "retained alternative still needs separate entailment audit",
  );
  assert.equal(result.citations.length, 2);
});

test("self-certified true flags cannot replace missing/rejected blind claim judgments or status agreement", async () => {
  for (const options of [
    { absentCoverageItem: true },
    { rejectCoverage: true },
    { mismatch: true },
  ])
    assert.equal((await run(options)).result, null);
});

test("source replacement during blind reconstruction prevents any next audit disclosure", async () => {
  const { result, audits } = await run({ staleAfterCoverage: true });
  assert.equal(result, null);
  assert.equal(audits, 0);
});
