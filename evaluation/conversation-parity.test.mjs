// One adversarial conversation per demo case, typed (the page's GET with the
// previous lead's field) and spoken (Bolna's message history), same server.
// Each expectation below failed on PR #49's first head (d771e0e):
//   context lost four turns back, a stale field answering about the wrong
//   test, a reply to "whose results?" ignored, a value read under a unit
//   the lab did not print, "first proposed fee" called the latest, a
//   rejection question answered as sign-off, a patient silently picked
//   from a clarification, and explanations repeated every turn.
import test from "node:test";
import assert from "node:assert/strict";
import { createLocalServer } from "../src/server.mjs";

const CAP = "convo" + "7".repeat(59);
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
    out.push({ q, typed: j.lead?.text ?? "", spoken });
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

test("lab conversation: context, clarifications, units, no silent patient pick", async () => {
  const [
    ferritin,
    ,
    ,
    normal,
    hb,
    improved,
    crea,
    convert,
    tsh,
    syn3,
    ,
    again,
    ,
    ,
    nov,
  ] = await run("health", [
    "What is SYN-0001's ferritin result?",
    "What was it before?",
    "And before that?",
    "Is that normal?",
    "What's the hemoglobin?",
    "Has it improved?",
    "Creatinine in September?",
    "Convert it to micromoles per litre",
    "TSH?",
    "SYN-0003",
    "Sorry, I meant SYN-0001's TSH",
    "Say that again",
    "What about vitamin D?",
    "मेरा ferritin पहले कितना था?",
    "What was ferritin on 20 November?",
  ]);
  both(ferritin, /50 ng\/mL/, "first answer");
  both(
    normal,
    /Ferritin result is 50 ng\/mL[^.]*\. That's within this lab's range/,
    "context four turns back",
  );
  assert.doesNotMatch(
    normal.spoken,
    /Some general background/,
    "explanation not repeated on the call",
  );
  both(hb, /more than one person/, "hemoglobin needs a patient");
  both(
    improved,
    /Hemoglobin results for more than one person/,
    "'it' is hemoglobin, still ambiguous",
  );
  neither(
    improved,
    /Ferritin|12\.9|went from/,
    "no stale test, no silent patient pick",
  );
  both(crea, /1\.2 mg\/dL, from 3 September 2026/, "dated lookup");
  both(
    convert,
    /^I don't convert lab units\..*3 September 2026 result is 1\.2 mg\/dL/,
    "conversion refused, dated value as printed",
  );
  neither(convert, /106/, "no value from another report under the asked unit");
  both(tsh, /more than one person/, "TSH needs a patient");
  both(syn3, /2\.10 mIU\/L/, "reply to the clarification answers it");
  assert.match(
    again.spoken,
    /0\.30 mIU\/L/,
    "repeat keeps the corrected subject",
  );
  both(nov, /no Ferritin result from November/, "absent month stays absent");
});

test("deal conversation: history, superseded figures, rejection vs missing approval", async () => {
  const [, , signoff, reject, original] = await run("deal", [
    "What is the engagement fee?",
    "Was it approved?",
    "Who needs to sign off?",
    "Did finance reject it?",
    "What was the original proposal?",
  ]);
  both(signoff, /client finance sign-off/, "sign-off");
  both(reject, /^No record shows a rejection\./, "rejection answered first");
  both(
    original,
    /^The earlier record was \$48,000\. It was superseded by \$42,000/,
    "original proposal",
  );
  const [first, cur48] = await run("deal", [
    "What was the first proposed fee?",
    "Is $48,000 the current fee?",
  ]);
  neither(
    first,
    /\$48,000 is the latest/,
    "a superseded figure is never called latest",
  );
  both(first, /superseded by \$42,000/, "first proposed fee");
  both(cur48, /^No\. \$42,000 is the latest proposal/, "No first");
  const [mmol] = await run("health", [
    "What is SYN-0001's creatinine in mmol?",
  ]);
  both(mmol, /don't give Creatinine in mmol\/L/, "unit not in the reports");
  neither(mmol, /106 mmol|is 106\b(?! µmol)/, "no value under the wrong unit");
});

test("third-person advice and diagnosis are declined on both paths; self-corrections keep the last test", async () => {
  const [statin, hypo, repaired, upload] = await run("health", [
    "Should my father start statins?",
    "Does he have hypothyroidism?",
    "What is SYN-0001's creatinine, sorry, the ferritin?",
    "I just uploaded my dad's report. Is anything wrong?",
  ]);
  both(statin, /medicine|doctor/i, "treatment declined");
  neither(statin, /Potassium|Creatinine|TSH result/, "no lab value for advice");
  both(hypo, /diagnos|condition/i, "diagnosis declined");
  neither(hypo, /Potassium/, "a condition is not repaired into a test name");
  both(repaired, /Ferritin/, "the corrected test is answered");
  neither(repaired, /Creatinine/, "the abandoned test is dropped");
  neither(
    upload,
    /upload (?:it|them|your)|how to upload|Your documents tab/i,
    "'already uploaded' is not a how-to",
  );
});
