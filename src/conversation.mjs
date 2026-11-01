// Conversation layer for the voice call: the turns that are about the call
// itself rather than the records ("can you hear me", "hello", "what can I
// ask", "I can't see the screen", "say that again", "Hindi mein bolo"),
// language choice, and the repairs that let a caller phrase a question any
// way they like. Nothing here states a fact from the records: replies are
// fixed sentences about the call, and record answers still come only from
// the engine (spoken.mjs / clinical / extractive).
import { detectLang } from "../clinical/explain.mjs";

// ------------------------------------------------------------ language
const ASK_HINDI =
  /\b(hindi\s+(me|mein|mai|mien|main)|in\s+hindi|speak\s+hindi|hindi\s+please)\b|हिंदी\s*में|हिन्दी\s*में/i;
const ASK_ENGLISH =
  /\b(in\s+english|speak\s+english|english\s+(me|mein|please)|angrezi)\b|अंग्रेज़ी\s*में|इंग्लिश\s*में/i;

/**
 * The language to answer in: an explicit request anywhere in this call's
 * own history wins (latest first); otherwise the language of the latest
 * utterance. Returns "hi" | "hinglish" | "en".
 */
export function callLanguage(latest, history = []) {
  for (const t of [latest, ...[...history].reverse()]) {
    if (ASK_HINDI.test(t)) return "hi";
    if (ASK_ENGLISH.test(t)) return "en";
  }
  return langOfText(latest);
}
const HINGLISH_WORDS =
  /\b(kya|kyaa|hai|hain|hua|hui|ho|gaya|gayi|gaye|tha|thi|mera|meri|mere|aap|aapka|kitna|kitni|batao|bataiye|bataye|samjhao|pe|par|mein|sehmati|nahi|nahin|kab|kaun|kyun|wala|wali|abhi|bhi|toh)\b/gi;
/** "hi" (Devanagari), "hinglish" (romanised Hindi) or "en". */
export function langOfText(text) {
  const t = String(text ?? "");
  if (/[ऀ-ॿ]/.test(t)) return "hi";
  return (t.match(HINGLISH_WORDS) ?? []).length >= 2
    ? "hinglish"
    : detectLang(t);
}
export const isHindi = (lang) => lang === "hi" || lang === "hinglish";

// ------------------------------------------------------------ social turns
const DOMAIN =
  /\b(ferritin|creatin\w*|creatine|tsh|thyroid|h(a)?emoglobin|hba1c|sugar|urea|iron|kidney|syn|report\w*|result\w*|test\w*|lab|value|level|fee\w*|price|cost|deadline|date|contract|agreement|sign\w*|payment\w*|split|northstar|meridian|kapoor|proposal|revision|approv\w*|finance|scope|region\w*|pilot|steering|committee|open|decided|deal)\b|फेरिटिन|क्रिएटिनिन|थायरॉइड|रिपोर्ट|नतीजा|नतीजे|फीस|अनुबंध|कॉन्ट्रैक्ट|भुगतान|समय\s*सीमा|डेडलाइन|मंज़ूर|हस्ताक्षर/i;

const R = {
  hear: /\b(can|could|are|r|do)\s+(you|u)\b[^.?]{0,24}\b(hear|listen)|\bhear\s+me\b|\bam\s+i\s+audible\b|\bis\s+(this|it)\s+working\b|\btesting\b|\bmic\s+check\b|sun\s*(pa\s*)?rah[ei]|sunai\s+de|aawaz|awaaz|आवाज़|सुन\s*(पा\s*)?रह/i,
  screen:
    /(\b(can'?t|cannot|don'?t|do\s+not|not)\s+(see|seeing)\b)|\bnothing\s+(is\s+)?(on|showing)\b|\bwhere\s+(is|are)\s+the\s+(source|screen)\b|(nahi|nahin|नहीं|नही)\s*(दिख|dikh)|(दिख|dikh)\w*\s*(नहीं|नही|nahi)/i,
  repeat:
    /\b(repeat|say\s+(that|it)\s+again|once\s+more|come\s+again|pardon|didn'?t\s+(get|catch)\s+(that|it)|dobara|phir\s+se\s+bol)\b|फिर\s*से|दोबारा/i,
  help: /\b(what\s+(can|should|do)\s+i\s+ask|what\s+can\s+you\s+(do|tell)|how\s+does\s+(this|it)\s+work|what\s+do\s+you\s+know|help\s+me|kya\s+pooch|kya\s+kar\s+sakt)\b|क्या\s+पूछ|आप\s+क्या\s+कर/i,
  who: /^\s*(who|what)\s+are\s+you\b|\baap\s+kaun\b|आप\s+कौन/i,
  thanks:
    /^\s*(ok(ay)?\s+)?(thanks|thank\s+you|thank\s+u|dhanyavaad|dhanyawad|shukriya)\b|धन्यवाद|शुक्रिया/i,
  bye: /^\s*(ok(ay)?\s+)?(bye|goodbye|good\s+bye|that'?s\s+all|alvida|chalo\s+bye)\b|अलविदा/i,
  greet:
    /^\s*(hi|hello|hey|hii+|namaste|namaskar|good\s+(morning|afternoon|evening)|hello\s+voice\s+memory)[\s,.!?]*(there|voice\s+memory|ji)?[\s,.!?]*$|^\s*नमस्ते/i,
  switch: new RegExp(`${ASK_HINDI.source}|${ASK_ENGLISH.source}`, "i"),
};

const SAY = {
  en: {
    hear: "Yes, I can hear you clearly. Ask me about the lab reports for S Y N zero zero zero one, or the Northstar deal.",
    greet:
      "Hi! I'm Voice Memory. You can ask things like: what is S Y N zero zero zero one's ferritin, has creatinine gone up since September, or was the forty two thousand dollar revision finalized?",
    help: "I answer only from these fictional records, and I check what changed. Try: what is the ferritin result, has creatinine gone up, what is the TSH, is there a signed contract, or did they agree on the payment split?",
    who: "I'm Voice Memory, a voice agent that answers from the records themselves and tells you when a value was corrected, is only proposed, or can't be compared.",
    screen:
      "The cited line opens on the Voice Memory web page, under the call button, as I answer. If you're on a phone, open voice memory beige dot vercel dot app to see it.",
    thanks:
      "You're welcome. Ask me anything else about these records whenever you like.",
    bye: "Thanks for calling Voice Memory. Goodbye!",
    nothing:
      "I haven't answered anything yet. Ask me about a lab result or the Northstar deal.",
    hindi:
      "ज़रूर, अब मैं हिंदी में जवाब दूँगी। आप लैब रिपोर्ट या Northstar डील के बारे में पूछिए।",
    english: "Sure, I'll answer in English. Go ahead and ask.",
  },
  hi: {
    hear: "हाँ, मैं आपको साफ़ सुन पा रही हूँ। आप S Y N zero zero zero one की लैब रिपोर्ट या Northstar डील के बारे में पूछिए।",
    greet:
      "नमस्ते! मैं Voice Memory हूँ। आप पूछ सकते हैं: ferritin कितना है, क्या creatinine सितंबर से बढ़ा है, या क्या forty two thousand dollar वाला revision final हुआ?",
    help: "मैं सिर्फ़ इन काल्पनिक रिकॉर्ड्स से जवाब देती हूँ और बताती हूँ कि क्या बदला। पूछिए: ferritin कितना है, creatinine बढ़ा या नहीं, TSH कितना है, क्या contract साइन हुआ, या payment split पर सहमति हुई?",
    who: "मैं Voice Memory हूँ, एक voice agent जो सीधे रिकॉर्ड से जवाब देती है और बताती है कि कोई value सुधारी गई है, सिर्फ़ प्रस्ताव है, या तुलना नहीं की जा सकती।",
    screen:
      "जवाब के साथ, जिस लाइन से जवाब आया वह Voice Memory वेब पेज पर call बटन के नीचे खुलती है। फ़ोन पर हैं तो voice memory beige dot vercel dot app खोलिए।",
    thanks:
      "आपका स्वागत है। इन रिकॉर्ड्स के बारे में कुछ और पूछना हो तो पूछिए।",
    bye: "Voice Memory को call करने के लिए धन्यवाद। नमस्ते!",
    nothing:
      "मैंने अभी तक कोई जवाब नहीं दिया है। किसी लैब result या Northstar डील के बारे में पूछिए।",
    hindi:
      "ज़रूर, अब मैं हिंदी में जवाब दूँगी। आप लैब रिपोर्ट या Northstar डील के बारे में पूछिए।",
    english: "Sure, I'll answer in English. Go ahead and ask.",
  },
};

/** True when the utterance names something in the records (a test, a deal term). */
export const hasSubject = (text) =>
  DOMAIN.test(repairDealTerms(stripPreamble(text)));

/** Strip a leading greeting or hear-check so "hey, can you hear me, what is the TSH" asks about TSH. */
export function stripPreamble(text) {
  return String(text)
    .replace(/^\s*(hi|hello|hey|namaste|ok(ay)?|so|um+|uh+)\b[\s,.!?]*/i, "")
    .replace(
      /^\s*(can|could|are)\s+(you|u)\s+(able\s+to\s+)?hear\s+me(\s+(now|clearly|out))?[\s,.!?]*/i,
      "",
    )
    .trim();
}

/**
 * A reply for a turn that is about the call, or null when the turn asks
 * about the records (those go to the engine). `last` is this call's
 * previous spoken answer, for "say that again".
 */
export function socialTurn(text, { lang = "en", last = null } = {}) {
  const t = String(text ?? "").trim();
  if (!t) return null;
  const say = SAY[isHindi(lang) ? "hi" : "en"];
  const domain = DOMAIN.test(stripPreamble(t));
  if (R.switch.test(t) && !domain)
    return {
      intent: "LANGUAGE",
      spoken: ASK_HINDI.test(t) ? say.hindi : say.english,
    };
  if (R.repeat.test(t) && !domain)
    return { intent: "REPEAT", spoken: last || say.nothing };
  // "I can't see it on the screen" (even mid-question about a result)
  if (
    R.screen.test(t) &&
    (/screen|स्क्रीन|page|पेज|source/i.test(t) || !domain)
  )
    return { intent: "SCREEN", spoken: say.screen };
  if (domain) return null;
  for (const k of ["hear", "help", "who", "thanks", "bye", "greet"])
    if (R[k].test(t)) return { intent: k.toUpperCase(), spoken: say[k] };
  return null;
}

// ------------------------------------------------------------ phrasing repairs
// Recogniser spellings of the deal's names, seen in real Bolna transcripts
// ("north state", "north street", "nursery") and their neighbours.
const DEAL_TERMS = [
  [
    /\b(north\s*(state|street|side|star|start|stair|stat)s?|nor\s*star|nursery|northstar)\b/gi,
    "Northstar",
  ],
  [/\b(meridi[ae]n|maridian|meridien|mary\s*dian)\b/gi, "Meridian"],
  [/\b(kapur|kapoor|kappor)\b/gi, "Kapoor"],
  [
    /\b(steering|steer\s*ing|stirring)\s+(committee|comity|commity)\b/gi,
    "steering committee",
  ],
];
export function repairDealTerms(text) {
  let s = String(text ?? "");
  for (const [re, to] of DEAL_TERMS) s = s.replace(re, to);
  return s;
}

const HINGLISH_CUE =
  /[ऀ-ॿ]|\b(kya|hai|hain|hua|hui|kitn[ai]|batao|bataiye|mein|tha|thi|kab|kaun)\b/i;
// Hindi / Hinglish deal questions map to the English question the engine
// already answers, by what they ask about (not word-by-word), so word order
// and particles ("bataiye", "zara", "kya") don't matter.
const HAS = (re) => (t) => re.test(t);
const FEE = HAS(
  /फ़ीस|फीस|शुल्क|कीमत|दाम|\bfees?\b|\bprice\b|\bcost\b|\bpaisa\b/i,
);
const DEADLINE = HAS(
  /समय\s*सीमा|आख़िरी\s*तारीख|आखिरी\s*तारीख|डेडलाइन|तारीख|\bdeadline\b|\bdate\b|\btareekh\b|\bkab\s+tak\b/i,
);
const CONTRACT = HAS(
  /अनुबंध|कॉन्ट्रैक्ट|करार|एग्रीमेंट|\bcontract\b|\bagreement\b/i,
);
const SIGNED = HAS(/हस्ताक्षर|साइन|\bsign\w*\b/i);
const PAYMENT = HAS(
  /भुगतान|पेमेंट|किस्त|\bpayment\b|\bsplit\b|बँटवारा|बंटवारा/i,
);
const AGREE = HAS(/सहमति|सहमत|तय|\bagree\w*\b|\bsehmat\w*\b|\btay\b/i);
const APPROVED = HAS(
  /मंज़ूर|मंजूर|अप्रूव|स्वीकार|\bapprov\w*\b|\bmanzoor\b|\bfinal\b/i,
);
const OPEN = HAS(
  /बाक़ी|बाकी|खुला|खुले|अधूरा|\bpending\b|\bopen\b|\bbaaki\b|\bbaki\b/i,
);
const SCOPE = HAS(/क्षेत्र|इलाक़े|\bregion\w*\b|\bscope\b|\bkshetra\b/i);
const CHANGE = HAS(/बदल|\bbadal\w*\b|\bchange\w*\b|क्या\s+हुआ|\bkya\s+hua\b/i);

/** The English question a Hindi / Hinglish deal question asks, or null. */
export function glossHindi(text) {
  const t = String(text ?? "");
  if (!HINGLISH_CUE.test(t)) return null;
  if (CONTRACT(t) && SIGNED(t)) return "Is there a signed contract?";
  if (CONTRACT(t)) return "Is there a signed contract?";
  if (PAYMENT(t) && (AGREE(t) || APPROVED(t)))
    return "Did they agree on the payment split?";
  if (PAYMENT(t)) return "What is the payment split?";
  if (FEE(t) && APPROVED(t)) return "Was the fee approved?";
  if (FEE(t) && CHANGE(t)) return "What happened to the fee?";
  if (FEE(t)) return "What is the engagement fee?";
  if (DEADLINE(t)) return "What is the deadline?";
  if (SCOPE(t)) return "What is the scope?";
  if (OPEN(t)) return "What's still open?";
  return null;
}

const DEAL_WORD =
  /\b(northstar|meridian|kapoor|fees?|price|cost|deadline|contract|agreement|payment|split|proposal|revision|scope|regions?|pilot|steering|committee|finance|deal|signed)\b|फ़ीस|फीस|अनुबंध|कॉन्ट्रैक्ट|भुगतान|डेडलाइन|समय\s*सीमा/i;
/** True when a question is about the deal, so it is never read as a lab question. */
export const isDealQuestion = (text) => DEAL_WORD.test(repairDealTerms(text));

// ------------------------------------------------------------ compound questions
const QUESTION_START =
  /^(and\s+)?(what|how|has|have|had|did|does|do|is|was|were|are|which|when|who|can|could|kya|kitna|kitni)\b/i;
/**
 * Split "what is my ferritin and has creatinine gone up since September"
 * into its questions. Only splits at "and" / "also" / "aur" / "?" when the
 * second half starts like a question, so "the North and South regions"
 * stays whole.
 */
export function splitCompound(text) {
  const parts = String(text ?? "")
    .split(/\?\s+|\s+(?:and|also|aur|और)\s+(?=\S)/i)
    .map((p) => p.trim().replace(/[?.!]+$/, ""))
    .filter(Boolean);
  if (parts.length < 2) return [String(text ?? "").trim()];
  const out = [parts[0]];
  for (const p of parts.slice(1)) {
    if (QUESTION_START.test(p) && p.split(/\s+/).length >= 3) out.push(p);
    else out[out.length - 1] += " and " + p;
  }
  return out.slice(0, 2);
}

// ------------------------------------------------------------ vague lab questions
const LAB_WORD =
  /\b(result|results|report|reports|test|level|value|blood\s*work|lab|gone\s+up|gone\s+down|changed|increased|decreased)\b|नतीजा|नतीजे|रिपोर्ट|बढ़/i;
const TEST_NAME =
  /\b(ferritin|iron|creatin\w*|creatine|tsh|thyroid|h(a)?emoglobin|hb\b|hba1c|sugar|urea)\b|फेरिटिन|क्रिएटिनिन|थायरॉइड/i;
export function isVagueLab(text) {
  const t = String(text ?? "");
  return (
    LAB_WORD.test(t) &&
    !TEST_NAME.test(t) &&
    !/\b(fee|deadline|contract|payment|northstar|proposal)\b/i.test(t)
  );
}
export function clarifyLab(lang) {
  return isHindi(lang)
    ? "कौन सा नतीजा: ferritin, creatinine, TSH, hemoglobin, HbA1c या urea? जैसे पूछिए: क्या creatinine सितंबर से बढ़ा है?"
    : "Which result would you like: ferritin, creatinine, TSH, hemoglobin, HbA1c or urea? For example: has creatinine gone up since September?";
}
export function fragmentReply(lang) {
  return isHindi(lang)
    ? "माफ़ कीजिए, मैं पूरा नहीं सुन पाई। आप पूछ सकते हैं: ferritin कितना है, क्या creatinine बढ़ा है, या क्या forty two thousand dollar वाला revision final हुआ?"
    : null;
}

// ------------------------------------------------------------ Hindi rendering
// The deal's spoken answers come from fixed English templates in spoken.mjs;
// these render the same templates in Hindi. Values, dates and quoted record
// text are kept exactly as the engine produced them.
const HI = [
  [
    /^(.+) is the latest proposal, and it is not approved\.$/,
    "$1 सबसे नया प्रस्ताव है, और यह अभी मंज़ूर नहीं हुआ है।",
  ],
  [
    /^(.+) is the current proposal; approval is not recorded\.$/,
    "$1 मौजूदा प्रस्ताव है; मंज़ूरी दर्ज नहीं है।",
  ],
  [
    /^That is still open: (.+) are both on record, and it is not approved\.$/,
    "यह अभी तय नहीं हुआ है: $1, दोनों रिकॉर्ड में हैं, और कुछ भी मंज़ूर नहीं हुआ।",
  ],
  [
    /^That is still open: (.+) are both on record\.$/,
    "यह अभी तय नहीं हुआ है: $1, दोनों रिकॉर्ड में हैं।",
  ],
  [
    /^(.+) is the only record, and it is not approved\.$/,
    "$1 ही एकमात्र रिकॉर्ड है, और यह मंज़ूर नहीं हुआ है।",
  ],
  [/^(.+) is approved, per (.+)\.$/, "$1 मंज़ूर है, $2 के अनुसार।"],
  [/^(.+) is approved\.$/, "$1 मंज़ूर है।"],
  [
    /^Yes, the earlier record was (.+)\. It was superseded by (.+), which is still not approved\.$/,
    "हाँ, पहले का रिकॉर्ड $1 था। उसकी जगह $2 आया, जो अभी भी मंज़ूर नहीं है।",
  ],
  [
    /^The terms need (.+) sign-off, and that sign-off is not recorded yet\.$/,
    "इन शर्तों के लिए $1 की मंज़ूरी चाहिए, और वह अभी दर्ज नहीं है।",
  ],
  [/^The current working scope is (.+)\.$/, "अभी का काम का दायरा $1 है।"],
  [
    /^I don't see that in these documents\.?$/,
    "मुझे यह इन दस्तावेज़ों में नहीं मिला।",
  ],
  [
    /^I don't see (.+) in these documents\.$/,
    "मुझे $1 इन दस्तावेज़ों में नहीं दिखा।",
  ],
  [
    /^I could not find supporting evidence in these documents\.$/,
    "मुझे इन दस्तावेज़ों में इसका कोई सबूत नहीं मिला।",
  ],
  [/^No\. Per (.+?): (.+)$/, "नहीं। $1 के अनुसार: $2"],
  [/^Yes\. (.+) records the approval(.*)\.$/, "हाँ। $1 में मंज़ूरी दर्ज है$2।"],
  [/^Still open, per (.+?): (.+)$/, "अभी खुले मुद्दे, $1 के अनुसार: $2"],
];
/**
 * Hindi for an English template answer; record quotes stay verbatim. Falls
 * back to "the record says:" + the English sentence, never a free
 * translation of record text.
 */
export function toHindi(spoken) {
  const s = String(spoken ?? "").trim();
  if (!s || /[ऀ-ॿ]/.test(s)) return s;
  const one = (x) => {
    for (const [re, to] of HI) if (re.test(x)) return x.replace(re, to);
    return null;
  };
  // sentence by sentence, so joined answers render too
  const parts = s.split(/(?<=[.?!])\s+(?=[A-Z$0-9])/);
  const out = parts.map((p) => one(p));
  if (out.every((x) => x === null)) return `रिकॉर्ड में लिखा है: ${s}`;
  return out.map((x, i) => x ?? `रिकॉर्ड में लिखा है: ${parts[i]}`).join(" ");
}
