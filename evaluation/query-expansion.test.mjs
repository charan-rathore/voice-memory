import test from "node:test";
import assert from "node:assert/strict";
import { expandQuery } from "../dist/query-expand.mjs";
import { importBundle, answer } from "../dist/engine.mjs";
import { NORTHSTAR_DOCS } from "../corpus-northstar.mjs";
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
