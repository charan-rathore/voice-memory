// Whole-report questions answered on screen and on a call: the same
// people, values, corrections and refusals in both, and the API's single
// `final` answer equal to what the screen shows.
import test from "node:test";
import assert from "node:assert/strict";
import { createLocalServer } from "../src/server.mjs";

const CAP = "summary" + "8".repeat(57);
let B, srv;
test.before(async () => {
  process.env.VM_VOICE_CAPABILITY = CAP;
  process.env.VM_VOICE_HARD_EXPIRES_AT = new Date(
    Date.now() + 3600e3,
  ).toISOString();
  process.env.VM_DENSE = "off";
  srv = createLocalServer({ port: 0 });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  await srv.loadPublicCases({ bindVoice: true });
  await new Promise((r) => setTimeout(r, 300));
  B = `http://127.0.0.1:${srv.address().port}`;
});
test.after(() => new Promise((r) => srv.close(() => r())));

async function run(c, qs) {
  let ctx = "";
  const hist = [];
  const out = [];
  for (const q of qs) {
    const j = await (
      await fetch(
        `${B}/api/public/answer?case=${c}&q=${encodeURIComponent(q)}` +
          (ctx ? `&context=${encodeURIComponent(ctx)}` : ""),
      )
    ).json();
    if (j.lead?.field) ctx = j.lead.field;
    hist.push({ role: "user", content: q });
    const r = await fetch(B + "/v1/chat/completions", {
      method: "POST",
      headers: {
        authorization: "Bearer " + CAP,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "x",
        stream: true,
        messages: [
          {
            role: "system",
            content: `Voice Memory evidence agent. Workspace: vm_ws=${c}. Answers come from the Voice Memory engine.`,
          },
          ...hist,
        ],
      }),
    });
    const spoken = [...(await r.text()).matchAll(/^data: (.*)$/gm)]
      .map((m) => m[1])
      .filter((d) => d !== "[DONE]")
      .map((d) => JSON.parse(d).choices?.[0]?.delta?.content ?? "")
      .join("")
      .trim();
    hist.push({ role: "assistant", content: spoken });
    out.push({ q, typed: j.lead?.text ?? "", final: j.final, spoken });
  }
  return out;
}
const both = (t, re, msg) => {
  assert.match(t.typed, re, `typed: ${msg}`);
  assert.match(t.spoken, re, `voice: ${msg}`);
};
const neither = (t, re, msg) => {
  assert.doesNotMatch(t.typed, re, `typed: ${msg}`);
  assert.doesNotMatch(t.spoken, re, `voice: ${msg}`);
};

const ONE_SAY = (t, re, msg) => both(t, re, msg);

test("summary questions: screen, voice and final agree", async () => {
  const turns = await run("health", [
    "What are the abnormal results?",
    "Which values changed?",
    "What should I ask my doctor?",
    "kya kuch abnormal hai?",
  ]);
  for (const t of turns) {
    assert.equal(t.final.text, t.typed, `final is the shown text: ${t.q}`);
    assert.notEqual(t.final.kind, "abstained", t.q);
  }
  const [abn, changed, doctor, hinglish] = turns;
  for (const re of [/SYN-0001/, /SYN-0003/, /Hemoglobin/, /HbA1c/, /TSH/])
    ONE_SAY(abn, re, `abnormal: ${re}`);
  neither(abn, /couldn't find a "abnormal" test/, "qualifier is not a test");
  ONE_SAY(changed, /Ferritin/, "correction named");
  ONE_SAY(changed, /Creatinine/, "unit change named");
  neither(changed, /Creatinine went (up|down)/, "never a direction across units");
  ONE_SAY(doctor, /not a diagnosis/, "questions, not a diagnosis");
  neither(doctor, /I read records, like lab reports/, "not the help reply");
  ONE_SAY(hinglish, /alag rakhti hoon/, "Hinglish kept apart");
});
