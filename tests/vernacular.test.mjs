import { test } from "node:test";
import assert from "node:assert/strict";
import {
  cleanUtterance,
  canonicalHinglish,
  hindiNumbers,
  spokenIds,
  normalizeVernacular,
  adviceKind,
  declineLead,
  toHinglish,
  noAnswerLead,
} from "../src/vernacular.mjs";
import { detectLang } from "../clinical/explain.mjs";
import { glossHindi, toHindi } from "../src/conversation.mjs";
import { repairTestNames } from "../src/spoken-repair.mjs";

test("self-corrections keep what came after, in the question's frame", () => {
  assert.equal(
    cleanUtterance("uh what's the fee, no sorry, the deadline"),
    "what's the deadline",
  );
  assert.equal(
    cleanUtterance("um mera fertin kitna aaya"),
    "mera fertin kitna aaya",
  );
  assert.equal(
    cleanUtterance("ferritin nahi nahi creatinine kitna hai"),
    "creatinine kitna hai",
  );
  assert.equal(cleanUtterance("the the ferritin"), "the ferritin");
  // nothing to correct: untouched
  assert.equal(
    cleanUtterance("Has creatinine gone up?"),
    "Has creatinine gone up?",
  );
});

test("romanised spelling variants collapse to one form", () => {
  assert.equal(
    canonicalHinglish("pichli baar se jyada"),
    "pichhli baar se zyada",
  );
  assert.equal(
    canonicalHinglish("kya manjoor hua, kyu?"),
    "kya manzoor hua, kyun?",
  );
  assert.equal(canonicalHinglish("42 hajar"), "42 hazaar");
  // Devanagari-only text is left alone
  assert.equal(canonicalHinglish("क्या मंजूर हुआ"), "क्या मंजूर हुआ");
});

test("Hindi number words, romanised or Devanagari, become digits", () => {
  assert.equal(hindiNumbers("bayalis hazaar dollar"), "42000 dollar");
  assert.equal(hindiNumbers("42 hazaar wala"), "42000 wala");
  assert.equal(hindiNumbers("बयालीस हज़ार वाला"), "42000 वाला");
  assert.equal(hindiNumbers("अड़तालीस हजार"), "48000");
  assert.equal(
    hindiNumbers("ferritin pehle paanch tha"),
    "ferritin pehle 5 tha",
  );
  assert.equal(hindiNumbers("४२,०००"), "42,000");
  // "do" is also English: never rewritten on its own
  assert.equal(hindiNumbers("do tha"), "do tha");
});

test("spoken patient IDs", () => {
  assert.equal(spokenIds("syn zero zero zero three ka TSH"), "SYN-0003 ka TSH");
  assert.equal(spokenIds("sin double zero zero one"), "SYN-0001");
  assert.equal(spokenIds("s y n 0 0 0 1"), "SYN-0001");
  assert.equal(spokenIds("syn shunya shunya shunya teen"), "SYN-0003");
  // too few digits: not an ID
  assert.equal(spokenIds("syn one"), "syn one");
});

test("the whole front-end composes (IDs survive stutter removal)", () => {
  assert.equal(
    normalizeVernacular("syn zero zero zero three ka TSH kitna hai"),
    "SYN-0003 ka TSH kitna hai",
  );
  assert.equal(
    normalizeVernacular("kya 42 hajar wala final hua?"),
    "kya 42000 wala final hua?",
  );
});

test("language: one Hindi cue is enough when the rest is names", () => {
  assert.equal(detectLang("SYN-0001 ka TSH"), "hinglish");
  assert.equal(detectLang("ferrite in result batao"), "hinglish");
  assert.equal(detectLang("sugar wala test kitna aaya, HbA1c"), "hinglish");
  assert.equal(detectLang("Mera TSH kitna hai?"), "hinglish");
  assert.equal(detectLang("What is the TSH for SYN-0003?"), "en");
  assert.equal(detectLang("Is there a signed contract?"), "en");
  assert.equal(detectLang("Did they agree on the payment split?"), "en");
  assert.equal(detectLang("What is SYN-0001's ferritin result?"), "en");
  assert.equal(detectLang("क्या फीस मंजूर हुई?"), "hi");
});

test("advice questions are recognised in three languages, lookups are not", () => {
  assert.equal(adviceKind("Should I take iron tablets?"), "treatment");
  assert.equal(adviceKind("kya mujhe iron ki goli leni chahiye?"), "treatment");
  assert.equal(adviceKind("क्या मुझे थायरॉइड की दवा लेनी चाहिए?"), "treatment");
  assert.equal(adviceKind("how much thyroxine should I take"), "treatment");
  assert.equal(
    adviceKind("can I stop my medicine now that ferritin is fine"),
    "treatment",
  );
  assert.equal(adviceKind("Do I have diabetes?"), "diagnosis");
  assert.equal(adviceKind("kya mujhe anemia hai?"), "diagnosis");
  assert.equal(
    adviceKind("kya hume ye deal sign kar leni chahiye?"),
    "decision",
  );
  for (const q of [
    "What is SYN-0001's ferritin result?",
    "Do I have a ferritin result?",
    "Has creatinine gone up since September?",
    "kya mera ferritin theek hai?",
    "What is iron?",
    "Was the $42,000 revision finalized?",
    "Is my hemoglobin low?",
  ])
    assert.equal(adviceKind(q), null, q);
});

test("declines are clear, warm, cite nothing and name the doctor", () => {
  for (const lang of ["en", "hi", "hinglish"]) {
    const l = declineLead("treatment", lang);
    assert.equal(l.verdict, "DECLINE_ADVICE");
    assert.deepEqual(l.citations, []);
    assert.match(l.text, lang === "hi" ? /डॉक्टर/ : /doctor/);
    // no numbers: a decline never states a value
    assert.doesNotMatch(l.text, /\d/);
  }
  assert.match(declineLead("decision", "en").text, /yours/);
  assert.match(noAnswerLead("hinglish").text, /nahi mila/);
});

test("Hinglish rendering is romanised and keeps values verbatim", () => {
  assert.equal(
    toHinglish("$42,000 is the latest proposal, and it is not approved."),
    "$42,000 sabse naya proposal hai, aur yeh abhi manzoor nahi hua hai.",
  );
  assert.equal(
    toHinglish(
      "No. Per the internal action log from October 9: no signed commercial agreement exists for the revised terms.",
    ),
    "Nahi. the internal action log from October 9 ke hisaab se: no signed commercial agreement exists for the revised terms.",
  );
  assert.doesNotMatch(
    toHinglish("That is still open: 40/60 versus 50/50 are both on record."),
    /[ऀ-ॿ]/,
  );
  // "No. Per ..." is one template, not two sentences, in Hindi too
  assert.match(
    toHindi("No. Per the action log: nothing signed."),
    /^नहीं। the action log के अनुसार/,
  );
});

test("Hindi deal questions with spoken amounts map to the engine's question", () => {
  assert.equal(
    glossHindi("kya 42,000 wala final hua?"),
    "Was the $42,000 revision finalized?",
  );
  assert.equal(
    glossHindi("kya 42000 wala manzoor hua"),
    "Was the $42,000 revision finalized?",
  );
  assert.equal(glossHindi("sign off kiska chahiye?"), "Who needs to sign off?");
  assert.equal(glossHindi("fee kitni hai?"), "What is the engagement fee?");
});

test("ordinary English words are not snapped to test names", () => {
  const v = new Map([
    ["ferritin", "Ferritin"],
    ["creatinine", "Creatinine"],
  ]);
  assert.equal(
    repairTestNames("Why was the ferritin corrected?", v),
    "Why was the ferritin corrected?",
  );
  assert.equal(repairTestNames("creative", v), "creative");
  assert.equal(repairTestNames("creatnine", v), "Creatinine");
  assert.equal(repairTestNames("fertin", v), "Ferritin");
});

test("cross-lingual bridge adds English search terms only for Hindi domain words", async () => {
  const { bridgeToEnglish } = await import("../src/vernacular.mjs");
  assert.equal(
    bridgeToEnglish("भुगतान की आखिरी तारीख क्या है?"),
    "payment deadline date",
  );
  assert.equal(
    bridgeToEnglish("contract pe hastakshar hua?"),
    "signed signature",
  );
  assert.equal(bridgeToEnglish("What is the engagement fee?"), "");
});
