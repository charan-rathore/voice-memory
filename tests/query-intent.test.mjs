import { test } from "node:test";
import assert from "node:assert/strict";
import {
  importBundle,
  answer,
  questionFields,
  validateEvidence,
} from "../dist/engine.mjs";
import { expandQuery } from "../dist/query-expand.mjs";
import { createVoiceAdapter } from "../src/voice-adapter.mjs";
const question =
  "Does missing one rehearsal automatically cost the actor their part?";
const text =
  "Missing one rehearsal does not automatically remove an actor from the cast. The director first discusses attendance and agrees a recovery plan.";
const bundle = () => importBundle([{ title: "Theatre attendance", text }]);
test("figurative cost asks about the source consequence, with validated evidence", () => {
  const b = bundle();
  const r = answer(question, b);
  assert.deepEqual(questionFields(question), []);
  assert.equal(r.refused, false);
  assert.ok(r.evidence.length);
  assert.match(r.answer, /does not automatically remove an actor/);
  for (const e of r.evidence) assert.equal(validateEvidence(e, b), true);
  assert.ok(
    !expandQuery(question).applied.some(
      (t) => t.from === "cost" && /fee|price/.test(t.to),
    ),
  );
});
test("financial uses and absent prices stay guarded, including mixed financial/figurative clauses", () => {
  const b = bundle();
  for (const q of [
    "How much does the rehearsal cost?",
    "What is the rehearsal fee?",
    "What is the ticket price?",
    "What money could the actor lose if this costs their job?",
  ]) {
    assert.ok(questionFields(q).includes("fee"));
    const r = answer(q, b);
    assert.equal(r.refused, true, q);
    assert.equal(r.evidence.length, 0);
  }
});
test("nonmonetary cost does not expand to prices for jobs, time or reputation", () => {
  for (const q of [
    "Will this cost her job?",
    "Does reprocessing cost us time?",
    "Will missing rehearsal cost their reputation?",
  ]) {
    assert.deepEqual(questionFields(q), []);
    assert.ok(
      !expandQuery(q).applied.some(
        (t) => t.from === "cost" && /fee|price/.test(t.to),
      ),
    );
  }
});
test("Bolna-compatible consumer preserves the scoped figurative answer evidence", async () => {
  const a = createVoiceAdapter();
  const token = a.bind(bundle());
  const r = await a.handle(
    new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { authorization: "Bearer " + token },
      body: JSON.stringify({
        stream: true,
        messages: [{ role: "user", content: question }],
      }),
    }),
  );
  assert.equal(r.status, 200);
  assert.match(await r.text(), /\[DONE\]/);
  const turn = a.lastTurn(token);
  assert.equal(turn.result.refused, false);
  assert.ok(turn.result.evidence.length);
  a.revoke(token);
});
