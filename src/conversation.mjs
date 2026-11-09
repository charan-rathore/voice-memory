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
  /\b(ferritin|creatin\w*|creatine|tsh|thyroid|h(a)?emoglobin|hba1c|sugar|urea|iron|kidney|syn|report\w*|result\w*|test\w*|lab|value|level|doctor|dr|physician|clinician|daktar|abnormal\w*|range|fee\w*|price|cost|deadline|date|contract|agreement|sign\w*|payment\w*|split|northstar|meridian|kapoor|proposal|revision|approv\w*|finance|scope|region\w*|pilot|steering|committee|open|decided|deal)\b|फेरिटिन|क्रिएटिनिन|थायरॉइड|रिपोर्ट|डॉक्टर|डाक्टर|रेंज|नतीजा|नतीजे|फीस|अनुबंध|कॉन्ट्रैक्ट|भुगतान|समय\s*सीमा|डेडलाइन|मंज़ूर|हस्ताक्षर/i;

const R = {
  hear: /\b(can|could|are|r|do)\s+(you|u)\b[^.?]{0,24}\b(hear|listen)|\bhear\s+me\b|\bam\s+i\s+audible\b|\bis\s+(this|it)\s+working\b|\btesting\b|\bmic\s+check\b|sun\s*(pa\s*)?rah[ei]|sunai\s+de|aawaz|awaaz|आवाज़|सुन\s*(पा\s*)?रह/i,
  screen:
    /(\b(can'?t|cannot|don'?t|do\s+not|not)\s+(see|seeing)\b)|\bnothing\s+(is\s+)?(on|showing)\b|\bwhere\s+(is|are)\s+the\s+(source|screen)\b|(nahi|nahin|नहीं|नही)\s*(दिख|dikh)|(दिख|dikh)\w*\s*(नहीं|नही|nahi)/i,
  repeat:
    /\b(repeat|say\s+(that|it)\s+again|once\s+more|come\s+again|pardon|didn'?t\s+(get|catch)\s+(that|it)|dobara|phir\s+se\s+bol)\b|फिर\s*से|दोबारा/i,
  help: /\b(what\s+(can|should|do)\s+i\s+ask|what\s+(questions|things)\s+can\s+i\s+ask|what\s+can\s+you\s+(do|tell)|how\s+(can|do)\s+you\s+help|how\s+does\s+(this|it)\s+work|what\s+do\s+you\s+(know|do)|help\s+me|kya\s+(kya\s+)?(sawaal\s+|sawal\s+)?(pooch|puch|pucch)\w*|kaise\s+(madad|help)|kya\s+kar\s+sakt\w*|madad\s+kar\s+sakt\w*)\b|क्या\s+(क्या\s+)?(सवाल\s+)?(पूछ|पुछ)|कैसे\s+मदद|मदद\s+कर\s+सकत|आप\s+क्या\s+कर|कैसे\s+काम\s+कर/i,
  // using one's own files: the page can show the way (see `action`)
  upload:
    /\b(upload\w*|my\s+own\s+(documents?|reports?|files?|records?|pdfs?)|(add|use|attach|bring|check|read)\s+(my|our)\s+(own\s+)?(documents?|reports?|files?|records?|pdfs?|contracts?))\b|\b(apn[aie]|apni|meri|mera|mere)\b.{0,25}\b(reports?|documents?|files?|pdfs?)\b.{0,25}\b(daal|dal|bhej|add|kaise|check|dikha)\w*|अपलोड|(अपनी|अपने|मेरी|मेरे).{0,25}(रिपोर्ट|दस्तावेज़|डॉक्यूमेंट|फ़ाइल|फाइल).{0,25}(डाल|भेज|कैसे|जोड़|दिखा)/i,
  done: /\b(no\s+more\s+questions|i'?m\s+done|that'?s\s+(all|it)|nothing\s+else|bas\s+(itna|ho\s+gaya)|aur\s+kuch\s+nahi|sawa?al\s+kh?at[a]?m)\b|सवाल\s*ख़?त्म|बस\s+इतना|और\s+कुछ\s+नहीं/i,
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
      "Hi, I'm Voice Memory. Ask about a lab result, like ferritin, or the Northstar deal, and the line I answer from will appear on your screen.",
    help: "I read records, like lab reports, contracts and meeting notes, and tell you what they say, what changed, and what was never approved, always with the exact line. You can ask about the sample records on the page, or use your own: open Your documents and drop in a PDF, Word file or a photo of a report. I've highlighted it for you.",
    upload:
      "To use your own records, open Your documents on the page, it's highlighted now, and drop in up to five PDFs, Word files or photos. They stay private to your browser tab and are deleted after thirty idle minutes. Then ask me anything about them, here or by typing.",
    who: "I'm Voice Memory, a voice agent that answers from the records themselves and tells you when a value was corrected, is only proposed, or can't be compared.",
    screen:
      "The cited line opens on the Voice Memory web page, under the call button, as I answer. If you're on a phone, open voice memory beige dot vercel dot app to see it.",
    thanks:
      "You're welcome. Ask me anything else about these records whenever you like.",
    bye: "Glad I could help. Your records stay on screen if you want another look. Goodbye!",
    nothing:
      "I haven't answered anything yet. Ask me about a lab result or the Northstar deal.",
    hindi:
      "ज़रूर, अब मैं हिंदी में जवाब दूँगी। आप लैब रिपोर्ट या Northstar डील के बारे में पूछिए।",
    english: "Sure, I'll answer in English. Go ahead and ask.",
  },
  hi: {
    hear: "हाँ, मैं आपको साफ़ सुन पा रही हूँ। आप S Y N zero zero zero one की लैब रिपोर्ट या Northstar डील के बारे में पूछिए।",
    greet:
      "नमस्ते, मैं Voice Memory हूँ। किसी लैब नतीजे, जैसे ferritin, या Northstar डील के बारे में पूछिए, जिस लाइन से जवाब आएगा वह आपकी स्क्रीन पर दिखेगी।",
    help: "मैं रिकॉर्ड पढ़ती हूँ, जैसे लैब रिपोर्ट, contract और meeting notes, और बताती हूँ कि उनमें क्या लिखा है, क्या बदला, और क्या कभी मंज़ूर नहीं हुआ, हमेशा सही लाइन के साथ। आप पेज पर दिए sample रिकॉर्ड्स के बारे में पूछ सकते हैं, या अपनी फ़ाइलें इस्तेमाल कर सकते हैं: Your documents खोलिए और PDF, Word फ़ाइल या रिपोर्ट की फ़ोटो डालिए। मैंने वह जगह highlight कर दी है।",
    upload:
      "अपने रिकॉर्ड इस्तेमाल करने के लिए पेज पर Your documents खोलिए, वह अभी highlight है, और पाँच तक PDF, Word फ़ाइल या फ़ोटो डालिए। वे सिर्फ़ आपके browser tab तक रहते हैं और तीस मिनट बाद मिट जाते हैं। फिर उनके बारे में कुछ भी पूछिए, बोलकर या लिखकर।",
    who: "मैं Voice Memory हूँ, एक voice agent जो सीधे रिकॉर्ड से जवाब देती है और बताती है कि कोई value सुधारी गई है, सिर्फ़ प्रस्ताव है, या तुलना नहीं की जा सकती।",
    screen:
      "जवाब के साथ, जिस लाइन से जवाब आया वह Voice Memory वेब पेज पर call बटन के नीचे खुलती है। फ़ोन पर हैं तो voice memory beige dot vercel dot app खोलिए।",
    thanks:
      "आपका स्वागत है। इन रिकॉर्ड्स के बारे में कुछ और पूछना हो तो पूछिए।",
    bye: "मदद करके अच्छा लगा। रिकॉर्ड स्क्रीन पर ही हैं, दोबारा देखना हो तो देख लीजिए। नमस्ते!",
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

// Uploaded sessions must not steer callers toward the fictional demo.
const UPLOADED_SAY = {
  en: {
    hear: "Yes, I can hear you. Ask about the documents you uploaded.",
    greet:
      "Hi! I'm Voice Memory. Ask about your uploaded documents and I'll look for the supporting passage.",
    help: "Ask a question about your uploaded documents. I can find relevant passages and show their exact source. If the documents do not support an answer, I'll say so.",
    nothing:
      "I haven't given a document answer yet. Ask about the documents you uploaded.",
    hindi:
      "ज़रूर, अब मैं हिंदी में जवाब दूँगी। अपने अपलोड किए हुए दस्तावेज़ों के बारे में पूछिए।",
  },
  hi: {
    hear: "हाँ, मैं आपको सुन पा रही हूँ। अपने अपलोड किए हुए दस्तावेज़ों के बारे में पूछिए।",
    greet:
      "नमस्ते! मैं Voice Memory हूँ। अपने अपलोड किए हुए दस्तावेज़ों के बारे में पूछिए; मैं उनका स्रोत खोजूँगी।",
    help: "अपने अपलोड किए हुए दस्तावेज़ों के बारे में सवाल पूछिए। मैं संबंधित अंश और उनका स्रोत दिखा सकती हूँ। अगर जवाब दस्तावेज़ों में नहीं है, तो मैं बता दूँगी।",
    nothing:
      "मैंने अभी दस्तावेज़ों से कोई जवाब नहीं दिया है। अपने अपलोड किए हुए दस्तावेज़ों के बारे में पूछिए।",
    hindi:
      "ज़रूर, अब मैं हिंदी में जवाब दूँगी। अपने अपलोड किए हुए दस्तावेज़ों के बारे में पूछिए।",
  },
};

/**
 * A reply for a turn that is about the call, or null when the turn asks
 * about the records (those go to the engine). `last` is this call's
 * previous spoken answer, for "say that again".
 */
export function socialTurn(
  text,
  {
    lang = "en",
    last = null,
    uploaded = false,
    repeatUnavailable = false,
  } = {},
) {
  const t = String(text ?? "").trim();
  if (!t) return null;
  const language = isHindi(lang) ? "hi" : "en";
  const say = uploaded
    ? { ...SAY[language], ...UPLOADED_SAY[language] }
    : SAY[language];
  const domain = DOMAIN.test(stripPreamble(t));
  if (R.switch.test(t) && !domain)
    return {
      intent: "LANGUAGE",
      spoken: ASK_HINDI.test(t) ? say.hindi : say.english,
    };
  if (R.repeat.test(t) && !domain) {
    // "say that again, but shorter": the first sentence of the same answer,
    // never a new or reinterpreted one
    const short =
      last &&
      /\b(short(?:er)?|brief(?:ly)?|quick(?:ly)?|in short|chhota|chhote mein)\b/i.test(
        t,
      )
        ? shorterOf(last)
        : last;
    return {
      intent: "REPEAT",
      spoken:
        short ||
        (repeatUnavailable
          ? language === "hi"
            ? "दोहराने के लिए कोई सत्यापित जवाब उपलब्ध नहीं है। कृपया अपना सवाल फिर से पूछिए।"
            : "I don't have a verified reply available to repeat. Please ask your question again."
          : say.nothing),
    };
  }
  // "I can't see it on the screen" (even mid-question about a result)
  if (
    R.screen.test(t) &&
    (/screen|स्क्रीन|page|पेज|source/i.test(t) || !domain)
  )
    return { intent: "SCREEN", spoken: say.screen };
  // "How do I use my own reports?" names a report but asks about the page:
  // answer it, and show the way (the landing highlights the upload panel).
  // "I just uploaded my dad's report, is anything wrong?" already did it and
  // asks about the report: that is a question for the records, not for help.
  const alreadyUploaded =
    /\b(uploaded|upload kar (?:diya|di|chuka|chuki)|daal diya|bhej diya)\b|अपलोड कर (?:दी|दिया)/i.test(
      t,
    ) && !/\bhow\b|\bwhere\b|kaise|kahan|कैसे|कहां/i.test(t);
  if (
    R.upload.test(t) &&
    !alreadyUploaded &&
    !/\b(ferritin|creatin\w*|tsh|h(a)?emoglobin|hba1c|urea|fee|deadline|contract|payment|northstar|proposal|revision)\b/i.test(
      t,
    )
  )
    return { intent: "UPLOAD", spoken: say.upload, action: { type: "upload" } };
  if (domain) return null;
  // "Thanks. Didn't they quote 48,000 earlier?" is a question with a
  // thank-you in front: the question gets answered, not a sign-off.
  if (asksAfterCourtesy(t)) return null;
  if (R.done.test(t)) return { intent: "BYE", spoken: say.bye };
  for (const k of ["hear", "help", "who", "thanks", "bye", "greet"])
    if (R[k].test(t))
      return {
        intent: k.toUpperCase(),
        spoken: say[k],
        ...(k === "help" && !uploaded
          ? { action: { type: "upload", soft: true } }
          : {}),
      };
  // a thank-you at the end of a longer sentence ("no more, thank you")
  if (
    /\b(thank\s*(you|u)|thanks|shukriya|dhanyavaad)\b|धन्यवाद|शुक्रिया/i.test(t)
  )
    return { intent: "THANKS", spoken: say.thanks };
  return null;
}

// The opening of an answer, long enough to stand alone: "No." alone is not a
// shorter version of "No. Per the action log: no signed agreement exists".
function shorterOf(text) {
  const parts = String(text).match(/[^.!?।]+[.!?।]+(?=\s|$)|[^.!?।]+$/g) ?? [
    text,
  ];
  let out = "";
  for (const p of parts) {
    out = (out + " " + p.trim()).trim();
    if (out.split(/\s+/).length >= 4) break;
  }
  return out;
}

const COURTESY =
  /^\s*(?:ok(?:ay)?[\s,.!]+)?(?:thanks|thank\s+(?:you|u)|cheers|great|perfect|got\s+it|dhanyavaad|dhanyawad|shukriya)\b[\s,.!-]*/i;
function asksAfterCourtesy(t) {
  const m = COURTESY.exec(t);
  if (!m) return false;
  const rest = t.slice(m[0].length).trim();
  if (rest.split(/\s+/).length < 3) return false;
  return (
    /\?/.test(rest) ||
    /^(what|when|who|which|how|why|where|is|was|were|are|did|didn'?t|does|do|has|have|had|can|could|tell|and|kya|kab|kaun|kitna)\b/i.test(
      rest,
    )
  );
}

/**
 * True for a fixed reply about the call itself (greeting, hear-check,
 * thanks, help...), in any language. "Say that again" repeats the last
 * answer about the records, never one of these.
 */
export function isSocialReply(text) {
  const t = String(text ?? "").trim();
  if (!t) return false;
  for (const lang of [...Object.values(SAY), ...Object.values(UPLOADED_SAY)])
    for (const v of Object.values(lang))
      if (typeof v === "string" && v.trim() === t) return true;
  return false;
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
  /[ऀ-ॿ]|\b(kya|hai|hain|hua|hui|kitn[ai]|batao|bataiye|mein|tha|thi|kab|kaun|kiska|kiski|chahiye|baaki|wala|wali)\b/i;
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
  /मंज़ूर|मंजूर|अप्रूव|स्वीकार|फ़ाइनल|फाइनल|पक्का|\bapprov\w*\b|\bmanzoor\w*\b|\bfinal\w*\b|\bpakka\b|\bpass\b|\bfix\b/i,
);
// A dollar figure as typed or heard after the vernacular front-end
// ("42 hazaar" -> 42000 -> 42,000): "$42,000", "42,000", "42000".
const AMOUNT_OF = (t) => {
  const m = /\$?\b(\d{2,3}),?(\d{3})\b/.exec(t);
  return m ? `$${m[1]},${m[2]}` : null;
};
const OPEN = HAS(
  /बाक़ी|बाकी|खुला|खुले|अधूरा|\bpending\b|\bopen\b|\bbaaki\b|\bbaki\b/i,
);
const SCOPE = HAS(/क्षेत्र|इलाक़े|\bregion\w*\b|\bscope\b|\bkshetra\b/i);
const CHANGE = HAS(/बदल|\bbadal\w*\b|\bchange\w*\b|क्या\s+हुआ|\bkya\s+hua\b/i);

/** The English question a Hindi / Hinglish deal question asks, or null. */
export function glossHindi(text) {
  const t = String(text ?? "");
  if (!HINGLISH_CUE.test(t)) return null;
  const amount = AMOUNT_OF(t);
  if (amount && (APPROVED(t) || SIGNED(t)))
    return `Was the ${amount} revision finalized?`;
  if (
    /sign[\s-]?off|साइन[\s-]?ऑफ़?|मंज़ूरी|मंजूरी/i.test(t) &&
    /\b(kiska|kiski|kiske|kaun|kisko)\b|किसकी|किसका|किसके|कौन/i.test(t)
  )
    return "Who needs to sign off?";
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
    /^(?:I don't see that in these documents|I couldn't establish that from these documents)\.?$/,
    "मुझे यह इन दस्तावेज़ों में नहीं मिला।",
  ],
  [
    /^I don't see (.+) in these documents\.$/,
    "मुझे $1 इन दस्तावेज़ों में नहीं दिखा।",
  ],
  [
    /^These documents don't record an invoice\.$/,
    "इन दस्तावेज़ों में कोई इनवॉइस दर्ज नहीं है।",
  ],
  [
    /^These documents don't record a payment\.$/,
    "इन दस्तावेज़ों में कोई भुगतान दर्ज नहीं है।",
  ],
  [
    /^These documents don't record an invoice number\.$/,
    "इन दस्तावेज़ों में कोई इनवॉइस नंबर दर्ज नहीं है।",
  ],
  [
    /^They do record (.+), proposed, not approved\.$/,
    "इनमें $1 दर्ज है, प्रस्तावित, मंज़ूर नहीं।",
  ],
  [/^They do record (.+), approved\.$/, "इनमें $1 दर्ज है, मंज़ूर।"],
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
  const parts = s.split(/(?<=[.?!])(?<!\b(?:No|Yes)\.)\s+(?=[A-Z$0-9])/);
  const out = parts.map((p) => one(p));
  if (out.every((x) => x === null)) return `रिकॉर्ड में लिखा है: ${s}`;
  return out.map((x, i) => x ?? `रिकॉर्ड में लिखा है: ${parts[i]}`).join(" ");
}

// ------------------------------------------------------------ mixed questions
// "मेरा ferritin कितना है and exactly Northstar deal में क्या change हुआ था":
// one breath, two subjects. Split where a connector sits between two
// different subjects, even when the second half doesn't start like a
// question, so each half reaches the renderer that can answer it.
const LAB_TOPIC =
  /\b(ferritin|iron|creatin\w*|tsh|thyroid|h(a)?emoglobin|hb|hba1c|sugar|urea|kidney|syn-?\d{4}|lab|reports?|results?)\b|फेरिटिन|क्रिएटिनिन|थायरॉइड|हीमोग्लोबिन|यूरिया|रिपोर्ट|नतीजा|नतीजे/i;
/** "lab" | "deal" | null: which records a piece of a question is about. */
export function domainOf(text) {
  const t = repairDealTerms(String(text ?? ""));
  if (DEAL_WORD.test(t)) return "deal";
  if (LAB_TOPIC.test(t)) return "lab";
  return null;
}
export function splitMixed(text) {
  const t = repairDealTerms(String(text ?? "").trim());
  const parts = t
    .split(/\s*(?:\?|,)?\s+(?:and(?:\s+also)?|also|aur|और|तथा|plus)\s+(?=\S)/i)
    .map((p) => p.trim().replace(/[?.!।]+$/, ""))
    .filter(Boolean);
  if (parts.length < 2) return [t];
  const out = [parts[0]];
  for (const p of parts.slice(1)) {
    const prev = out[out.length - 1];
    const a = domainOf(prev),
      b = domainOf(p);
    if (a && b && a !== b) out.push(p);
    else out[out.length - 1] = `${prev} and ${p}`;
  }
  return out;
}

// "tell me the critical things", "kuch serious hai?", "सब ठीक है?":
// a whole-report question, answered by the overview, never by one test.
export const SUMMARY_RE =
  /\b(critical|important|serious|concerning|worry\w*|abnormal|flag\w*|summar\w*|overview|everything|all\s+(my\s+)?results|kuch\s+(serious|gadbad|galat)|sab\s+theek|gambhir|zaroori)\b|क्रिटिकल|ज़रूरी|जरूरी|गंभीर|सब\s+ठीक|कुछ\s+(गड़बड़|ग़लत|गलत)|सारांश/i;
