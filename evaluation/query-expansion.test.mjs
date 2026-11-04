import test from "node:test";
import assert from "node:assert/strict";
import { expandQuery } from "../dist/query-expand.mjs";
import { importBundle, answer } from "../dist/engine.mjs";
import { NORTHSTAR_DOCS } from "../examples/corpus-northstar.mjs";
import { retrieveFromRows } from "../dist/evaluation/baseline-entry.mjs";

const bundle = importBundle(NORTHSTAR_DOCS);
const PARAPHRASE = "What changed about the commercials after the kickoff?";

test("expansion never touches amounts, dates, IDs or negation", () => {
  for (const q of [
    "Is the $42,000 fee approved?",
    "Did the client not approve 22 November?",
    "What changed on 15 November 2026?",
  ]) {
    const e = expandQuery(q);
    for (const a of e.applied) {
      assert.ok(!/[0-9%$]/.test(a.from), `protected token expanded: ${a.from}`);
      assert.ok(!/^(not|no|never|without|didn't|hasn't)$/i.test(a.from));
    }
  }
});

test("expansion is visible: every addition recorded with kind", () => {
  const e = expandQuery(PARAPHRASE);
  assert.ok(e.applied.length > 0);
  assert.ok(
    e.applied.some((a) => a.kind === "dictionary" && a.from === "commercials"),
  );
  for (const a of e.applied) assert.ok(e.expanded.includes(a.to));
  assert.ok(e.expanded.startsWith(e.original));
});

test("timing question answered only by a condition is refused as unestablished", () => {
  const r = answer("When is signoff expected?", bundle);
  assert.equal(r.supported, false);
  assert.match(r.answer, /only as a condition|no timing/i);
});

test("who-question recovers same-authority synonym with disclosed transform", () => {
  const r = answer("Who gives the signoff?", bundle);
  assert.equal(r.evidenceStatus, "positive");
  assert.ok(r.queryTransform !== null);
  assert.ok(
    r.queryTransform.applied.some(
      (a) => a.from === "signoff" && a.to === "sign-off",
    ),
  );
  assert.ok(r.evidence.some((e) => e.title === "03_Commercial_Revision.md"));
  assert.match(
    r.evidence.map((e) => e.quote).join(" "),
    /client finance sign-off/i,
  );
});

test("partial grounding does not trigger expansion; paraphrase recall gap documented", () => {
  // Baseline grounds on the kickoff notes only, so the fallback never fires
  // and D3/D4 stay out of the answer despite ranking #2/#3 after expansion.
  // REMAINING ISSUE: answer-level paraphrase recall needs integration-level
  // pack/topK handling, not query expansion.
  const viaEngine = answer(PARAPHRASE, bundle);
  assert.equal(viaEngine.queryTransform, null);
  assert.deepEqual(
    viaEngine.evidence.map((e) => e.title),
    ["02_Client_Kickoff_Notes.md"],
  );
});

test("conflict question stays unresolved rather than inventing a split", () => {
  const r = answer("What payment split did we finally agree to?", bundle);
  assert.equal(
    r.unresolved || r.refused || /unresolved|review/i.test(r.answer),
    true,
  );
});

test("approval question surfaces the outstanding-authorization record, no invented approver", () => {
  const r = answer("Who approved the production launch?", bundle);
  assert.ok(r.evidence.some((e) => e.title === "07_Internal_Action_Log.md"));
  assert.ok(
    /not recorded|could not find|not supported/i.test(
      r.answer + " " + r.evidence.map((e) => e.quote).join(" "),
    ),
  );
});

// ---------- Guarded retention bridge (2026-11-04 review) ----------
// Measured miss: "How long do you keep the transcripts?" / "How long are
// transcripts retained?" abstained on the mariner corpus though the record
// states the authorized internal transcript retention period (30 days).
// Bridge fires only when a duration ask AND a keep/retain/store-transcripts
// target co-occur; the evidence gate decides the answer.

const RETENTION_POSITIVES = [
  "How long do you keep the transcripts?",
  "How long are transcripts retained?",
  "For what period do we retain call transcripts?",
];
const RETENTION_NEGATIVES = [
  "Keep the deadline unchanged",
  "How long must we keep the deadline unchanged?",
  "How long do we keep the deadline mentioned in the transcripts?",
  "Who keeps meeting notes?",
  "How do we keep transcripts confidential?",
  "How long do we keep transcripts confidential?",
  "How long are transcripts kept private?",
  "Keep the deadline unchanged.",
  "How long are expense receipts retained?",
  "Is the 90-day period still authorized?",
];

test("retention bridge is context-bound: duration ask + transcript target", () => {
  for (const q of RETENTION_POSITIVES) {
    const e = expandQuery(q);
    assert.ok(
      e.applied.some((a) => a.to === "retention"),
      `expected retention bridge: ${q}`,
    );
  }
  for (const q of RETENTION_NEGATIVES) {
    const e = expandQuery(q);
    assert.ok(
      !e.applied.some((a) => a.to === "retention"),
      `unexpected retention bridge: ${q}`,
    );
  }
});

test("mariner: keep-transcripts paraphrase retrieves the 30-day record, not an abstain", async () => {
  const { MARINER_DOCS } = await import("../examples/corpus-mariner.mjs");
  const mb = importBundle(MARINER_DOCS);
  const r = answer("How long do you keep the transcripts?", mb);
  const hay = r.answer + " " + r.evidence.map((e) => e.quote).join(" ");
  assert.match(hay, /30[ -]days?/i, "30-day record missing");
  assert.doesNotMatch(r.answer, /could not find supporting passages/i);
});

test("mariner: retained-transcripts paraphrase answers the 30-day record via a disclosed rewrite", async () => {
  // Was a RESIDUAL GAP on main 6edac74 (this test then accepted an abstain):
  // the appended expansion kept the caller's "retained", which the evidence
  // gate counted as uncovered because the record says "retention". A
  // verified query-equivalent rewrite now retries once with the record's
  // term in place of the caller's, disclosed in queryTransform. Thresholds
  // are unchanged, so only the guarded transcript-retention phrase can use it.
  const { MARINER_DOCS } = await import("../examples/corpus-mariner.mjs");
  const mb = importBundle(MARINER_DOCS);
  const r = answer("How long are transcripts retained?", mb);
  const hay = r.answer + " " + r.evidence.map((e) => e.quote).join(" ");
  assert.doesNotMatch(r.answer, /could not find supporting passages/i);
  assert.match(hay, /retention period is 30 days/i);
  assert.equal(
    r.queryTransform?.original,
    "How long are transcripts retained?",
  );
  assert.ok(
    r.queryTransform.applied.some(
      (a) => a.from === "transcripts retained" && /retention/.test(a.to),
    ),
    JSON.stringify(r.queryTransform),
  );
});

test("mariner: only the guarded retention phrase is ever rewritten", async () => {
  const { equivalentRewrite } = await import("../dist/query-expand.mjs");
  assert.ok(equivalentRewrite("How long are transcripts retained?"));
  assert.ok(equivalentRewrite("How long do you keep the transcripts for?"));
  for (const q of RETENTION_NEGATIVES)
    assert.equal(equivalentRewrite(q), null, q);
  const { MARINER_DOCS } = await import("../examples/corpus-mariner.mjs");
  const mb = importBundle(MARINER_DOCS);
  for (const q of [
    "How long do we keep transcripts confidential?",
    "Who keeps meeting notes?",
    "How long are expense receipts retained?",
    "Keep the deadline unchanged.",
  ]) {
    const r = answer(q, mb);
    assert.ok(
      !r.queryTransform?.applied?.some((a) => /retention/.test(a.to)),
      `retention transform applied to: ${q}`,
    );
    assert.doesNotMatch(
      r.answer,
      /30[ -]days?/i,
      `retention leaked into: ${q}`,
    );
  }
  // a policy period is not evidence that anything was deleted
  const del = answer("Have the transcripts been deleted?", mb);
  assert.ok(!del.queryTransform?.applied?.some((a) => /retention/.test(a.to)));
});

test("mariner: unrelated keep/deadline questions never ground in the retention policy", async () => {
  const { MARINER_DOCS } = await import("../examples/corpus-mariner.mjs");
  const mb = importBundle(MARINER_DOCS);
  for (const q of [
    "How long must we keep the deadline unchanged?",
    "Who keeps meeting notes?",
  ]) {
    const r = answer(q, mb);
    assert.doesNotMatch(
      r.answer,
      /30[ -]days?/i,
      `retention policy leaked into: ${q}`,
    );
  }
});

test("mariner: spoken layer speaks the 30-day record for keep-transcripts via disclosed transform", async () => {
  // The voice/web spoken path: spokenTurn abstains (no claim-graph field for
  // this phrasing), then extractiveSpoken may speak one verbatim sentence
  // from the engine's validated evidence. Passage scoring must use the
  // engine's disclosed expanded query (result.queryTransform) - the same
  // vocabulary that grounded the chunks - while every question-shape gate
  // keeps reading the caller's original question.
  const { MARINER_DOCS } = await import("../examples/corpus-mariner.mjs");
  const { spokenTurn } = await import("../src/spoken.mjs");
  const { extractiveSpoken } = await import("../src/spoken-extract.mjs");
  const mb = importBundle(MARINER_DOCS);
  const spoken = (q) => {
    const result = answer(q, mb);
    const t = spokenTurn(q, mb, null);
    if (t && t.reason !== "no_field") return t.spoken;
    const quoted = extractiveSpoken(
      q,
      result,
      mb,
      () => null,
      result?.queryTransform?.expanded ?? undefined,
    );
    return quoted?.spoken ?? t?.spoken ?? null;
  };
  const keep = spoken("How long do you keep the transcripts?");
  assert.match(
    keep ?? "",
    /30[ -]days?/i,
    "keep-question lost the 30-day record",
  );
  assert.doesNotMatch(
    keep ?? "",
    /\b90[ -]days?\b(?![^.\n]*\bnot 90)/i,
    "90-day distractor spoken as the answer",
  );
  assert.doesNotMatch(keep ?? "", /couldn't establish/i);
  const control = spoken("What is the retention period?");
  assert.match(control ?? "", /30[ -]days?/i);
  const retained = spoken("How long are transcripts retained?");
  assert.match(
    retained ?? "",
    /retention period is 30 days/i,
    "retained-variant lost the 30-day record",
  );
  assert.doesNotMatch(
    retained ?? "",
    /\b90[ -]days?\b(?![^.\n]*\bnot 90)/i,
    "retained-variant spoke the 90-day distractor",
  );
  for (const q of [
    "How long do we keep transcripts confidential?",
    "Who keeps meeting notes?",
    "How long are expense receipts retained?",
    "Have the transcripts been deleted?",
  ])
    assert.doesNotMatch(
      spoken(q) ?? "",
      /30[ -]days?/i,
      `retention spoken for: ${q}`,
    );
  assert.match(
    spoken("Is the 90-day period still authorized?") ?? "",
    /not authorized|rejected/i,
  );
});

test("extractiveSpoken scores the original question when no transform is disclosed", async () => {
  // Without a disclosed transform the scoring vocabulary is unchanged:
  // evidence whose terms bind only expansion vocabulary must NOT be spoken.
  const { extractiveSpoken } = await import("../src/spoken-extract.mjs");
  const fakeResult = {
    supported: true,
    refused: false,
    unresolved: false,
    evidence: [
      {
        title: "t",
        quote:
          "Lena: The authorized internal transcript retention period is 30 days, not 90.",
      },
    ],
  };
  const mb = importBundle([
    { title: "t", text: fakeResult.evidence[0].quote + "\n" },
  ]);
  const q = "How long do you keep the transcripts?";
  assert.equal(extractiveSpoken(q, fakeResult, mb), null);
  const quoted = extractiveSpoken(
    q,
    fakeResult,
    mb,
    () => null,
    "How long do you keep the transcripts? retention transcript",
  );
  assert.match(quoted?.spoken ?? "", /30[ -]days?/i);
});
