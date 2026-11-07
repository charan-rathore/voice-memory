// One authoritative answer: the lead when there is one, else the cited
// passage, else an abstention. Never a lead saying "50 ng/mL" beside an
// answer field saying "unresolved".
import test from "node:test";
import assert from "node:assert/strict";
import { finalAnswer, ABSTAIN_TEXT } from "../src/answer-contract.mjs";
import { publicAnswer } from "../src/public-api.mjs";

const cite = { title: "a.pdf", quote: "| Ferritin | 50 | ng/mL |" };

test("a lead is the answer, whatever retrieval said underneath", () => {
  const shown = {
    question: "ferritin?",
    lead: {
      text: "Your Ferritin result is 50 ng/mL.",
      verdict: "LATEST",
      citations: [cite],
    },
    answer: "Several passages are relevant, but this remains unresolved.",
    status: "ambiguous",
    evidence: [cite],
  };
  const f = finalAnswer(shown);
  assert.equal(f.text, shown.lead.text);
  assert.equal(f.kind, "answered");
  assert.equal(f.from, "lead");
  const p = publicAnswer(shown);
  assert.equal(p.final.text, shown.lead.text);
  assert.equal(p.answer, shown.lead.text, "legacy field agrees with the lead");
  assert.equal(p.status, "answered");
  assert.match(p.retrieval.text, /unresolved/, "kept only as diagnostics");
});

test("clarifying questions and refusals are labelled as such", () => {
  for (const [verdict, kind] of [
    ["AMBIGUOUS_PATIENT", "clarify"],
    ["CLARIFY", "clarify"],
    ["NOT_COMPARABLE", "refused"],
    ["DECLINE_ADVICE", "refused"],
    ["NOT_IN_REPORT", "abstained"],
    ["UNKNOWN", "abstained"],
    ["HELP", "social"],
    ["OVERVIEW", "answered"],
    ["FLAGGED", "answered"],
  ]) {
    const lead = { text: "x", verdict };
    assert.equal(finalAnswer({ lead }).kind, kind, verdict);
  }
});

test("no lead: the cited passage, then an honest abstention", () => {
  const q = finalAnswer({ evidence: [cite, cite] });
  assert.equal(q.kind, "quoted");
  assert.match(q.text, /^From the document: “\| Ferritin \| 50/);
  assert.match(q.text, /and 1 more cited passage\)$/);
  const none = finalAnswer({ answer: "I could not find supporting passages." });
  assert.equal(none.kind, "abstained");
  assert.equal(none.text, ABSTAIN_TEXT);
  assert.deepEqual(none.citations, []);
});
