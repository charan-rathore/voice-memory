// RED-first regressions found by the voice-notes browser check: on the
// in-app fictional sample, two plain questions got wrong spoken answers.
//   1. "Who owns the security review?" -> "No. Per ... the pilot launch is not
//      approved ..." (a negative about one subject cited for another, because
//      the negative and the field cue were matched in DIFFERENT sentences).
//   2. "Was the budget approved?" -> refused by the quantity gate (it asks
//      about a status, not an amount), and once answered, the launch sentence
//      outscored "Budget approval is unchanged." because approved != approval.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createLocalServer } from "../src/server.mjs";

const DOCS = [
  {
    title: "Fictional · client review.md",
    text: "# Fictional client review\n\nPilot launch is proposed for Tuesday. Security sign-off is still pending. Maya owns the security review.\n\n## Decisions\n- Budget of ₹50,000 approved by Maya.\n\n## Actions\n- Maya to send security review by Friday.",
  },
  {
    title: "Fictional · next meeting.md",
    text: "# Fictional next meeting\n\nThe pilot launch is not approved. Security sign-off remains pending. Budget approval is unchanged. Next discussion will review security findings.",
  },
];
let server, base, h;
before(async () => {
  server = createLocalServer({ port: 0 });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
  const s = await fetch(base + "/api/session");
  h = {
    cookie: s.headers.get("set-cookie").split(";")[0],
    origin: base,
    "x-csrf-token": (await s.json()).csrf,
    "content-type": "application/json",
  };
  await fetch(base + "/api/import", {
    method: "POST",
    headers: h,
    body: JSON.stringify({ documents: DOCS }),
  });
});
after(() => new Promise((r) => server.close(r)));
const ask = (question) =>
  fetch(base + "/api/query", {
    method: "POST",
    headers: h,
    body: JSON.stringify({ question, context: null }),
  }).then((r) => r.json());

test("a negative about the launch is never cited as the answer to who owns the review", async () => {
  const r = await ask("Who owns the security review?");
  const said = r.lead?.text ?? "";
  assert.doesNotMatch(said, /launch is not approved/i, said);
  assert.doesNotMatch(said, /^No\b/, said);
  assert.match(said, /Maya owns the security review/, said);
});

test("'Was the budget approved?' is answered from the budget sentence, not refused", async () => {
  const r = await ask("Was the budget approved?");
  assert.equal(r.refused, false, r.answer);
  const said = r.lead?.text ?? "";
  // The spoken sentence is about the budget, never the launch sentence that
  // merely shares the word "approved".
  assert.match(said, /^Budget/, said);
  assert.doesNotMatch(said, /launch/i, said);
});

test("the explicit launch negative still answers the launch question", async () => {
  const r = await ask("Is the pilot launch approved?");
  assert.match(r.lead?.text ?? "", /^No\. .*pilot launch is not approved\.$/);
});
