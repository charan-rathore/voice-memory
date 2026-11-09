// The companion voice: how an answer opens when it is spoken, so it sounds
// like a friend who read the report carefully, not an instructor reading a
// verdict. Three rules keep it honest:
//   1. An opener never carries a fact: no digits, no test names, no status
//      words that could contradict the engine's sentence (tested).
//   2. It never cheers or alarms: "good news" over a flagged value, or "don't
//      worry", would be the assistant deciding what the result means.
//   3. Screen and voice stay the same words: the opener is shown before the
//      answer as well as spoken, so nothing is said that isn't on screen.
// Deterministic by verdict and language; picks one of a few variants by a
// stable hash of the answer so a conversation doesn't repeat itself, while
// the same answer always opens the same way (cacheable, testable).

const O = {
  value: {
    en: [
      "Here's what the report says.",
      "Okay, I found it.",
      "Got it. Here's the number.",
    ],
    hi: ["देखिए, रिपोर्ट में यह लिखा है।", "ठीक है, मिल गया।"],
    hinglish: ["Dekhiye, report mein yeh likha hai.", "Theek hai, mil gaya."],
  },
  found: {
    en: ["Here's the line I found.", "Okay, I found it."],
    hi: ["यह लाइन मिली।", "ठीक है, मिल गया।"],
    hinglish: ["Yeh line mili.", "Theek hai, mil gaya."],
  },
  corrected: {
    en: ["One thing worth knowing first: this result was corrected."],
    hi: ["पहले एक ज़रूरी बात: यह नतीजा बाद में सुधारा गया था।"],
    hinglish: ["Pehle ek zaroori baat: yeh result baad mein sudhara gaya tha."],
  },
  refuse: {
    en: ["I'll be straight with you.", "Honest answer:"],
    hi: ["सीधी बात बताऊँ:", "ईमानदारी से कहूँ तो:"],
    hinglish: ["Seedhi baat bataun:", "Sach kahun toh:"],
  },
  clarify: {
    en: ["Quick check before I answer."],
    hi: ["जवाब देने से पहले एक छोटी सी बात।"],
    hinglish: ["Jawab dene se pehle ek chhoti si baat."],
  },
  status: {
    en: ["Here's where it stands.", "Here's the honest status."],
    hi: ["अभी की स्थिति यह है।"],
    hinglish: ["Abhi ki sthiti yeh hai."],
  },
  absent: {
    en: ["I looked carefully.", "I checked every page."],
    hi: ["मैंने ध्यान से देखा।"],
    hinglish: ["Maine dhyan se dekha."],
  },
  explain: {
    en: ["Good question.", "Happy to explain."],
    hi: ["अच्छा सवाल है।"],
    hinglish: ["Achha sawaal hai."],
  },
};

const KIND = {
  LATEST: "value",
  VALUE: "value",
  COMPARED: "value",
  FLAGGED: "value",
  QUOTED: "found",
  CONFIRMED: "status",
  NOT_COMPARABLE: "refuse",
  UNCLEAR: "refuse",
  AMBIGUOUS_PATIENT: "clarify",
  CLARIFY: "clarify",
  PROPOSED: "status",
  OPEN: "status",
  "NO-RECORD": "status",
  APPROVED: "status",
  NOT_IN_REPORT: "absent",
  NOT_IN_DOCUMENTS: "absent",
  // UNKNOWN is uncertainty, not evidence that every page was checked.
  UNBOUND_OWNER: "refuse",
  NO_REASON: "absent",
  EXPLAINED: "explain",
  TERM: "explain",
  DEFINED: "explain",
};

const hash = (s) => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++)
    h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
};

/**
 * The spoken opener for a lead, or null (declines and anything unknown
 * already open in their own words).
 */
export function openerFor(lead, lang = "en") {
  if (!lead?.text || !lead.verdict) return null;
  if (lead.verdict === "DECLINE_ADVICE") return null;
  let kind = KIND[lead.verdict];
  if (!kind) return null;
  const l = ["en", "hi", "hinglish"].includes(lang) ? lang : "en";
  // An answer that already opens with the correction (the question was
  // about it) needs no opener saying so: answer first, nothing repeated.
  if (
    /^(Before the correction|Two earlier values|Yes\. The \d|The \d{1,2} \w+ \d{4} .* was corrected|These reports show no correction|सुधार से पहले|आपके मतलब के हिसाब से|हां। \d|इन रिपोर्ट्स में आपके .* कोई सुधार नहीं|Correction se pehle|Aapke matlab ke hisaab se|Haan\. \d|In reports mein aapke .* koi correction nahi)/.test(
      lead.text,
    )
  )
    return null;
  if (kind === "value" && /corrected|sudhaar|sudhar|सुधार/i.test(lead.text))
    kind = "corrected";
  const options = O[kind][l];
  return options[hash(lead.text) % options.length];
}

/** Opener + answer: exactly the words shown on screen and spoken. */
export function spokenText(lead, lang = "en") {
  const o = openerFor(lead, lang);
  return o ? `${o} ${lead.text}` : (lead?.text ?? "");
}

// Sentence split shared with the client (decimals stay inline, so "1.1
// mg/dL" is one sentence). Same pattern as the narration split.
export const splitSentences = (text) =>
  String(text)
    .match(/.+?(?:[.!?।:]+(?!\d)(?=\s|$)|$)\s*/g)
    ?.filter((s) => s.trim()) ?? [String(text)];

export const OPENERS = O;
