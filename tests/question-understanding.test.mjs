import test from "node:test";
import assert from "node:assert/strict";
import {
  sourceExactRequirements,
  understandDocumentQuestion,
} from "../src/semantic/question-understanding.mjs";

const question =
  "If funding arrives, may Jo approve the pilot, and who paid whom? Was it approved already?";
const parts = [
  "If funding arrives, may Jo approve the pilot,",
  "and who paid whom?",
  "Was it approved already?",
];
const proposal = (requirements = parts) => ({ question, requirements });

test("source-exact obligations keep every byte and never discard conditional/shared context as glue", () => {
  const segments = sourceExactRequirements(question, proposal());
  assert.equal(segments.length, 3);
  assert.equal(
    segments.map((s) => question.slice(s.start, s.end)).join(""),
    question,
  );
  assert.ok(segments.every((s) => s.kind === "requirement"));
  for (const invalid of [
    { question: question.toLowerCase(), requirements: parts },
    proposal([]),
    proposal(parts.slice(1)),
    proposal([parts[1], parts[0], parts[2]]),
    proposal([parts[0], parts[1], parts[1], parts[2]]),
    proposal([parts[0].replace("If funding arrives, ", ""), ...parts.slice(1)]),
    proposal([parts[0].slice(0, -1), ...parts.slice(1)]),
    proposal([question.replace("may Jo", "Jo did")]),
    proposal([question.replace("paid whom", "received funds")]),
    proposal([null]),
    { ...proposal(), complete: true, requirements: ["Who paid whom?"] },
  ])
    assert.equal(sourceExactRequirements(question, invalid), null);
});

test("two blind reconstructions must agree; server derives IDs and original source spans", async () => {
  const calls = [];
  const gemini = {
    questionRequirements: async (q, opts) => {
      calls.push({ q, opts });
      return proposal();
    },
  };
  const result = await understandDocumentQuestion({
    question,
    gemini,
    ip: "x",
  });
  assert.equal(result.requirements.length, 3);
  assert.equal(result.coverageEstablished, true);
  assert.match(result.provenance, /model-reconstruction/);
  assert.ok(Object.isFrozen(result));
  assert.ok(result.requirements.every((r) => /^r-[a-f0-9]+$/.test(r.id)));
  assert.deepEqual(
    calls.map((c) => c.opts),
    [
      { ip: "x", pass: "proposal" },
      { ip: "x", pass: "reconstruction" },
    ],
    "second invocation receives original only, never the first proposal",
  );
  assert.ok(calls.every((c) => c.q === question));
});

test("disagreement, omission, absent interpreter, or source change stays unresolved", async () => {
  for (const second of [
    proposal([question]),
    proposal(parts.slice(0, -1)),
    null,
  ]) {
    let calls = 0;
    assert.equal(
      await understandDocumentQuestion({
        question,
        gemini: {
          questionRequirements: async () =>
            ++calls === 1 ? proposal() : second,
        },
      }),
      null,
    );
  }
  assert.equal(
    await understandDocumentQuestion({ question, gemini: {} }),
    null,
  );
  // Reviewed update (docs/qualification/whole-question-coverage-2026-11-09.md):
  // the two blind passes now start together. The protected property is that
  // no provider call STARTS after the sources changed, and that a change
  // during the calls still discards their result.
  let current = true,
    startedAfterChange = 0;
  assert.equal(
    await understandDocumentQuestion({
      question,
      isCurrent: () => current,
      gemini: {
        questionRequirements: async () => {
          if (!current) startedAfterChange++;
          await Promise.resolve();
          current = false;
          return proposal();
        },
      },
    }),
    null,
  );
  assert.equal(
    startedAfterChange,
    0,
    "changed sources prevent any later provider call",
  );
  current = false;
  let calls = 0;
  assert.equal(
    await understandDocumentQuestion({
      question,
      isCurrent: () => current,
      gemini: { questionRequirements: async () => (calls++, proposal()) },
    }),
    null,
  );
  assert.equal(calls, 0, "no call at all once sources already changed");
});

test("unicode, punctuation and whitespace positions are derived from source, not provider offsets", () => {
  const q = "क्या मंजूरी मिली?  Who paid ₹500 to 李?\n";
  const result = sourceExactRequirements(q, {
    question: q,
    requirements: ["क्या मंजूरी मिली?", "Who paid ₹500 to 李?"],
  });
  assert.equal(result.length, 2);
  assert.equal(result.map((s) => q.slice(s.start, s.end)).join(""), q);
});
