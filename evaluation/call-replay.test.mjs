// Real Bolna call turns that failed on 2 Nov 2026 (execution c3d94af6, the
// recogniser's own words), replayed against the production-shaped voice
// corpus. Each must now be answered, not deflected to the sample questions.
import { test } from "node:test";
import assert from "node:assert/strict";
import { startVoice } from "./call-replay.mjs";
import { splitMixed, domainOf, socialTurn } from "../src/conversation.mjs";

test("mixed, help, overview, thanks and goodbye turns from a real call", async () => {
  const v = await startVoice();
  try {
    const [mixed, help, overview, thanks, bye, upload] = await v.call([
      "मेरा ferritin कितना है and exactly north star deal में क्या change हुआ था",
      "और आप मुझे कैसे मदद कर सकते मतलब और मैं क्या सवाल पुछ सकता हूं यहां से जिससे आप मेरी मदद कर सकते हैं",
      "आप s y n zero zero one की post देखिए और कुछ critical चीज़ें हैं उसमें तो वह मुझे clearly बताइए",
      "ठीक है धन्यवाद",
      "नहीं मेरे सवाल ख़त्म हो गए हैं thank you",
      "how do I upload my own reports?",
    ]);
    // Post-exposure identity contract: the historical first-person ask has
    // no identity binding. The independent deal half remains answerable.
    assert.match(mixed.spoken, /SYN-0001/);
    assert.match(mixed.spoken, /SYN-0003/);
    assert.doesNotMatch(mixed.spoken, /50 ng\/mL/);
    // Preserve the original positive value independently under explicit identity.
    const [selected] = await v.call([
      "SYN-0001 का ferritin कितना है and exactly north star deal में क्या change हुआ था",
    ]);
    assert.match(selected.spoken, /Ferritin[^।]*50 ng\/mL/);
    assert.match(selected.spoken, /\$42,000/);
    assert.match(mixed.spoken, /\$42,000/);
    assert.match(mixed.spoken, /मंज़ूर नहीं/);
    assert.doesNotMatch(mixed.spoken, /I don't see/);
    // help explains what it does AND how to bring your own documents
    assert.match(help.spoken, /Your documents/);
    assert.match(help.spoken, /PDF/);
    // "critical" is a summary request, never misheard as Creatinine
    assert.match(overview.spoken, /SYN-0001/);
    assert.match(overview.spoken, /TSH/);
    assert.doesNotMatch(overview.spoken, /Creatinine/);
    assert.match(overview.spoken, /निदान नहीं/);
    // social turns close politely instead of offering sample questions
    assert.match(thanks.spoken, /स्वागत/);
    assert.match(bye.spoken, /नमस्ते/);
    assert.match(upload.spoken, /Your documents/);
    assert.match(upload.spoken, /thirty idle minutes/);
  } finally {
    v.close();
  }
});

test("splitMixed keeps one-domain questions whole and splits across domains", () => {
  assert.equal(domainOf("what is my ferritin"), "lab");
  assert.equal(domainOf("what happened to the fee"), "deal");
  assert.equal(domainOf("how are you"), null);
  assert.equal(splitMixed("ferritin and hemoglobin").length, 1);
  const parts = splitMixed("what is my ferritin and what happened to the fee");
  assert.equal(parts.length, 2);
  assert.deepEqual(parts.map(domainOf), ["lab", "deal"]);
});

test("upload and help turns carry a page action", () => {
  const up = socialTurn("how do I upload my own reports?");
  assert.equal(up?.intent, "UPLOAD");
  assert.equal(up.action.type, "upload");
  const help = socialTurn("what can you help me with", { lang: "en" });
  assert.equal(help?.action?.type, "upload");
  assert.equal(help.action.soft, true);
});
