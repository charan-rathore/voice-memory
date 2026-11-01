// The voice call as callers actually speak: real Bolna transcripts from
// 31 Oct / 1 Nov 2026 (mis-heard names, hear-checks, Hindi, two questions in
// one breath), replayed over HTTP against the production entry point with
// the public cases bound, as Bolna would send them.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  socialTurn,
  splitCompound,
  repairDealTerms,
  glossHindi,
  callLanguage,
  toHindi,
  isVagueLab,
} from "../conversation.mjs";

// ------------------------------------------------------------ unit
test("hear-checks, greetings and screen questions are answered as such", () => {
  for (const t of [
    "are you able to clearly hear me out",
    "are you able to clearly hear me now",
    "hey yes i'm on the line stay on the line please are you able to clearly hear me out",
    "can you hear me",
    "kya aap mujhe sun pa rahe ho",
  ])
    assert.equal(socialTurn(t)?.intent, "HEAR", t);
  assert.equal(socialTurn("hello")?.intent, "GREET");
  assert.equal(socialTurn("नमस्ते")?.intent, "GREET");
  assert.equal(
    socialTurn(
      "screen पर तो मुझे अभी कुछ नहीं दिख रहा क्या आप उसको दिखा सकते हैं",
      { lang: "hi" },
    )?.intent,
    "SCREEN",
  );
  assert.match(
    socialTurn("say that again", { last: "Previous answer." }).spoken,
    /Previous answer/,
  );
  // a record question is never swallowed by small talk
  assert.equal(socialTurn("hi, what is the ferritin result"), null);
  assert.equal(socialTurn("can you hear me, has creatinine gone up"), null);
});

test("the deal's names are repaired as the recogniser spells them", () => {
  assert.match(
    repairDealTerms("what was the north state north state exactly"),
    /Northstar/,
  );
  assert.match(repairDealTerms("what was the nursery exactly"), /Northstar/);
  assert.match(repairDealTerms("the north street deal"), /Northstar deal/);
  assert.doesNotMatch(
    repairDealTerms("the North and South regions"),
    /Northstar/,
  );
});

test("two questions in one breath are split; region lists are not", () => {
  assert.deepEqual(
    splitCompound(
      "what is my ferritin and has creatinine gone up since September",
    ),
    ["what is my ferritin", "has creatinine gone up since September"],
  );
  assert.equal(splitCompound("is the scope North and South").length, 1);
  assert.equal(
    splitCompound("what changed between the proposal and the revision").length,
    1,
  );
});

test("language follows the caller, and an explicit request sticks", () => {
  assert.equal(callLanguage("what is the fee"), "en");
  assert.equal(callLanguage("फीस कितनी है"), "hi");
  assert.equal(
    callLanguage("what is the fee", ["please speak in hindi"]),
    "hi",
  );
  assert.equal(
    callLanguage("फीस कितनी है", ["hindi mein bolo", "in english please"]),
    "en",
  );
  assert.match(glossHindi("फीस कितनी है") ?? "", /fee/);
  assert.match(glossHindi("kya contract sign hua") ?? "", /contract/);
});

test("Hindi rendering keeps values and quotes verbatim", () => {
  assert.equal(
    toHindi("$42,000 is the latest proposal, and it is not approved."),
    "$42,000 सबसे नया प्रस्ताव है, और यह अभी मंज़ूर नहीं हुआ है।",
  );
  const q =
    "No. Per the internal action log from October 9: no signed commercial agreement exists for the revised terms.";
  assert.match(toHindi(q), /no signed commercial agreement exists/);
  assert.match(
    toHindi("Something new."),
    /^रिकॉर्ड में लिखा है: Something new\.$/,
  );
  assert.ok(isVagueLab("how exactly has it gone up since september"));
  assert.ok(!isVagueLab("has creatinine gone up since september"));
});

// ------------------------------------------------------------ over HTTP
const PORT = 4610 + Math.floor(Math.random() * 300);
const CAP = "conv" + "2".repeat(60);
let child;
before(async () => {
  child = spawn(process.execPath, ["server.mjs"], {
    cwd: new URL("..", import.meta.url).pathname,
    env: {
      ...process.env,
      PORT: String(PORT),
      VM_DENSE: "off",
      VM_VOICE_CAPABILITY: CAP,
      VM_VOICE_HARD_EXPIRES_AT: new Date(Date.now() + 3600e3).toISOString(),
    },
    stdio: "ignore",
  });
  for (let i = 0; i < 300; i++) {
    try {
      const s = await (
        await fetch(`http://127.0.0.1:${PORT}/api/public/status`)
      ).json();
      if (s.cases.health && s.cases.deal) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  throw Error("server did not load the cases");
});
after(() => child?.kill());

async function say(history) {
  const res = await fetch(`http://127.0.0.1:${PORT}/v1/chat/completions`, {
    method: "POST",
    headers: {
      authorization: "Bearer " + CAP,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "voice-memory-local",
      stream: true,
      messages: history,
    }),
  });
  assert.equal(res.status, 200);
  const raw = await res.text();
  return [...raw.matchAll(/^data: (.*)$/gm)]
    .map((m) => m[1])
    .filter((d) => d !== "[DONE]")
    .map((d) => JSON.parse(d).choices[0].delta.content ?? "")
    .join("");
}
const call = async (turns) => {
  const history = [{ role: "system", content: "Voice Memory evidence agent." }];
  const out = [];
  for (const t of turns) {
    history.push({ role: "user", content: t });
    const a = await say(history);
    history.push({ role: "assistant", content: a });
    out.push(a);
  }
  return out;
};

test("real call, 31 Oct: hear-check, compound question, Hindi, screen", async () => {
  const [a1, a2, a3, a4, a5] = await call([
    "hey can you actually tell me about the what is s y n zero zero zero one result mean and how exactly has it gone up since september",
    "are you able to clearly hear me out",
    "hey so has the creatine got gone up क्या अपना creatine ज़्यादा हो गया है",
    "screen पर तो मुझे अभी कुछ नहीं दिख रहा क्या आप उसको दिखा सकते हैं",
    "hey yes i'm on the line stay on the line please are you able to clearly hear me out",
  ]);
  assert.doesNotMatch(a1, /I don't see that/, a1);
  assert.match(a2, /hear you/i, a2);
  assert.match(a3, /mg\/dL/, a3); // the Hindi creatinine answer
  assert.match(a4, /वेब पेज/, a4);
  assert.doesNotMatch(a4, /Creatinine/, "does not repeat the last answer");
  assert.match(a5, /hear you/i, a5);
});

test("real call, 1 Nov: mis-heard Northstar is understood", async () => {
  const [a] = await call([
    "do you understand that what was the north state north state exactly and what exactly changed in those",
  ]);
  assert.doesNotMatch(a, /I don't see that|only caught part/, a);
});

test("the same questions phrased in Hindi get Hindi answers from the same records", async () => {
  const [fee, signed] = await call([
    "फीस कितनी है",
    "kya contract sign hua hai",
  ]);
  assert.match(fee, /42,000/, fee);
  assert.match(fee, /[ऀ-ॿ]/, fee);
  assert.match(signed, /[ऀ-ॿ]/, signed);
  assert.doesNotMatch(signed, /^हाँ/, "never says a contract was signed");
});

test("asking for Hindi switches the call, and 'repeat' repeats", async () => {
  const [sw, fee, again] = await call([
    "hindi mein baat karo",
    "what is the engagement fee",
    "say that again",
  ]);
  assert.match(sw, /हिंदी/);
  assert.match(fee, /42,000/);
  assert.match(fee, /[ऀ-ॿ]/, "the switch sticks for English questions");
  assert.equal(again, fee);
});
