// Replays real call transcripts (Bolna execution logs, the recogniser's own
// words) against the production-shaped voice corpus: every fictional record
// bound to the fixed credential, exactly as server.mjs does at boot. Used by
// evaluation/call-replay.test.mjs and by hand:
//   node evaluation/call-replay.mjs   -> prints each turn and what was spoken
import { createLocalServer } from "../src/server.mjs";

const CAP = "replay" + "7".repeat(58);
export async function startVoice() {
  process.env.VM_VOICE_CAPABILITY = CAP;
  process.env.VM_VOICE_HARD_EXPIRES_AT ??= new Date(
    Date.now() + 3600e3,
  ).toISOString();
  process.env.VM_DENSE = "off";
  const srv = createLocalServer({ port: 0 });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  await srv.loadPublicCases({ bindVoice: true });
  await new Promise((r) => setTimeout(r, 300));
  const base = `http://127.0.0.1:${srv.address().port}`;
  async function say(history) {
    const res = await fetch(base + "/v1/chat/completions", {
      method: "POST",
      headers: {
        authorization: "Bearer " + CAP,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "voice-memory-local",
        stream: true,
        messages: [{ role: "system", content: "Voice Memory" }, ...history],
      }),
    });
    const raw = await res.text();
    return [...raw.matchAll(/^data: (.*)$/gm)]
      .map((m) => m[1])
      .filter((d) => d !== "[DONE]")
      .map((d) => JSON.parse(d).choices?.[0]?.delta?.content ?? "")
      .join("");
  }
  async function call(turns) {
    const history = [];
    const out = [];
    for (const t of turns) {
      history.push({ role: "user", content: t });
      const spoken = await say(history);
      history.push({ role: "assistant", content: spoken });
      out.push({ said: t, spoken });
    }
    return out;
  }
  return { call, close: () => srv.close() };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const v = await startVoice();
  // Bolna execution c3d94af6 (2 Nov 2026), the recogniser's final words.
  const out = await v.call([
    "मेरा ferritin कितना है and exactly north star deal में क्या change हुआ था",
    "और आप मुझे कैसे मदद कर सकते मतलब और मैं क्या सवाल पुछ सकता हूं यहां से जिससे आप मेरी मदद कर सकते हैं",
    "आप s y n zero zero one की post देखिए और कुछ critical चीज़ें हैं उसमें तो वह मुझे clearly बताइए",
    "ठीक है धन्यवाद",
    "नहीं मेरे सवाल ख़त्म हो गए हैं thank you",
    "how do I upload my own reports?",
  ]);
  for (const t of out) console.log("> " + t.said + "\n< " + t.spoken + "\n");
  v.close();
  process.exit(0);
}
