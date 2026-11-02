// Vernacular front-end: what an English, Hindi or Hinglish speaker actually
// types or says, turned into the notation the engine reads, before any
// retrieval. Deterministic and dictionary-based, so every rewrite is
// explainable and testable; nothing here calls a model.
//
//   cleanUtterance()       fillers and self-corrections ("the fee, no sorry,
//                          the deadline" -> "the deadline")
//   canonicalHinglish()    one spelling per romanised word (pichli/pichle ->
//                          pichhli, jyada -> zyada, manjoor -> manzoor)
//   hindiNumbers()         Hindi number words, romanised or Devanagari, to
//                          digits ("bayalis hazaar" -> 42000, "पचास" -> 50)
//   spokenIds()            "syn zero zero zero three" -> SYN-0003
//   normalizeVernacular()  all of the above, in that order
//   adviceKind()           a treatment / diagnosis / decision question the
//                          assistant must decline, whatever the language
//   declineLead()          the friendly, clear "no" for those questions
//   toHinglish()           romanised Hindi for the engine's fixed English
//                          templates (record text and values stay verbatim)
//
// Why a front-end and not a translation model: the engine's verdicts hang on
// exact values, IDs and status words. Rewriting only notation keeps every
// downstream check (exact span, unit, patient, approval) working on the
// visitor's own words. Code-switching-aware RAG systems route by the query's
// linguistic profile for the same reason (see docs/COMPANION.md).

// ------------------------------------------------------------ fillers + self-corrections
const FILLERS =
  /\b(?:um+|uh+|erm+|hmm+|uhh+|umm+|you know|haan+ ?toh|matlab ki|basically|accha so)\b[,.]?\s*/gi;
const CORRECTION =
  /^(.*?)(?:,?\s*\b(?:no+,?\s*(?:wait,?\s*)?i mean|no+,?\s*sorry|sorry,?\s*i mean|actually,?\s*no|scratch that|nahi nahi|nahin nahin|matlab nahi|मतलब नहीं|नहीं नहीं)\b,?\s*)(.+)$/i;
const QWORD =
  /^(?:what|what's|whats|how|is|are|did|does|do|has|have|was|were|when|which|who|can|kya|kitna|kitni|kab|kaun)\b/i;
/** Drop fillers and apply the speaker's last self-correction. */
export function cleanUtterance(raw) {
  let t = String(raw ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (!t) return "";
  for (let i = 0; i < 3; i++) {
    const m = CORRECTION.exec(t);
    if (!m) break;
    const before = m[1].replace(FILLERS, "").replace(/[,.]$/, "").trim();
    const after = m[2].trim();
    const bw = before.split(" ").filter(Boolean);
    const aw = after.split(" ");
    // "what's the fee, no sorry, the deadline": the correction replaces the
    // object of the question and keeps its frame ("what's").
    const q = QWORD.exec(before);
    if (q && !QWORD.test(after)) {
      const frame = before.match(
        /^(.*?\b(?:is|are|was|were|the|my|for|ka|ki|ke)\b)\s+/i,
      );
      t = frame ? `${frame[1]} ${after.replace(/^the\s+/i, "")}` : after;
    } else if (aw.length <= 2 && bw.length > 1) {
      bw.splice(bw.length - 1, 1, ...aw);
      t = bw.join(" ");
    } else t = after;
  }
  t = t
    .replace(FILLERS, "")
    .replace(/\b(\w+)(\s+\1\b)+/gi, "$1")
    .replace(/\s+([?.!,])/g, "$1")
    .replace(/^[,.\s]+/, "")
    .trim();
  return t;
}

// ------------------------------------------------------------ spelling variants
// Romanised Hindi has no standard spelling. One canonical form per word lets
// every downstream pattern match once instead of guessing every variant.
const VARIANTS = [
  [/\bpi(?:c|ch|cch)h?l(i|e|a)\b/gi, "pichhl$1"],
  [/\b(?:jy|zy)aa?da\b/gi, "zyada"],
  [/\bkit+naa?\b/gi, "kitna"],
  [/\bkit+nii?\b/gi, "kitni"],
  [/\bma(?:n|nj|nz)(?:oo|u)r\b/gi, "manzoor"],
  [/\bk(?:i)?yu(?:n|on|un)?\b/gi, "kyun"],
  [/\bkyon\b/gi, "kyun"],
  [/\bha(?:z|j)aa?r\b/gi, "hazaar"],
  [/\bbat(?:a|aa)o\b/gi, "batao"],
  [/\bsehm(?:a|)ti\b/gi, "sehmati"],
];
export function canonicalHinglish(text) {
  let t = String(text ?? "");
  if (/[ऀ-ॿ]/.test(t) && !/[a-z]{3}/i.test(t)) return t;
  for (const [re, to] of VARIANTS) t = t.replace(re, to);
  return t;
}

// ------------------------------------------------------------ Hindi numbers
// 1-99 have irregular names in Hindi, so they are listed, not composed.
const H1_99 = {
  ek: 1,
  do: 2,
  teen: 3,
  char: 4,
  chaar: 4,
  paanch: 5,
  panch: 5,
  chhe: 6,
  chhah: 6,
  che: 6,
  saat: 7,
  sat: 7,
  aath: 8,
  nau: 9,
  das: 10,
  gyarah: 11,
  barah: 12,
  terah: 13,
  chaudah: 14,
  pandrah: 15,
  solah: 16,
  satrah: 17,
  atharah: 18,
  unnis: 19,
  bees: 20,
  ikkis: 21,
  bais: 22,
  teis: 23,
  chaubis: 24,
  pachchis: 25,
  pachis: 25,
  chhabbis: 26,
  sattais: 27,
  atthais: 28,
  untis: 29,
  tees: 30,
  ikattis: 31,
  battis: 32,
  taintis: 33,
  chautis: 34,
  paintis: 35,
  chhattis: 36,
  saintis: 37,
  adtis: 38,
  untalis: 39,
  chalis: 40,
  chalees: 40,
  iktalis: 41,
  bayalis: 42,
  bayaalis: 42,
  tetalis: 43,
  chavalis: 44,
  paintalis: 45,
  chhiyalis: 46,
  saintalis: 47,
  adtalis: 48,
  artalis: 48,
  adtaalis: 48,
  unchas: 49,
  pachas: 50,
  pachaas: 50,
  ikyavan: 51,
  bavan: 52,
  tirpan: 53,
  chauvan: 54,
  pachpan: 55,
  chhappan: 56,
  sattavan: 57,
  athavan: 58,
  unsath: 59,
  saath: 60,
  ikshath: 61,
  basath: 62,
  tirsath: 63,
  chausath: 64,
  painsath: 65,
  chhiyasath: 66,
  sadsath: 67,
  adsath: 68,
  unhattar: 69,
  sattar: 70,
  ikhattar: 71,
  bahattar: 72,
  tihattar: 73,
  chauhattar: 74,
  pachhattar: 75,
  chhihattar: 76,
  satattar: 77,
  athattar: 78,
  unasi: 79,
  assi: 80,
  ikyasi: 81,
  bayasi: 82,
  tirasi: 83,
  chaurasi: 84,
  pachasi: 85,
  chhiyasi: 86,
  sattasi: 87,
  athasi: 88,
  navasi: 89,
  nabbe: 90,
  ikyanve: 91,
  baanve: 92,
  tiranve: 93,
  chauranve: 94,
  pachanve: 95,
  chhiyanve: 96,
  sattanve: 97,
  attanve: 98,
  ninyanve: 99,
  sau: 100,
};
const D1_99 = {
  एक: 1,
  दो: 2,
  तीन: 3,
  चार: 4,
  पांच: 5,
  पाँच: 5,
  छह: 6,
  छः: 6,
  सात: 7,
  आठ: 8,
  नौ: 9,
  दस: 10,
  बीस: 20,
  पच्चीस: 25,
  तीस: 30,
  चालीस: 40,
  बयालीस: 42,
  अड़तालीस: 48,
  अडतालीस: 48,
  पचास: 50,
  साठ: 60,
  सत्तर: 70,
  अस्सी: 80,
  नब्बे: 90,
  सौ: 100,
};
const MULT = {
  hazaar: 1000,
  हज़ार: 1000,
  हजार: 1000,
  lakh: 100000,
  लाख: 100000,
  sau: 100,
  सौ: 100,
};
const ROM = Object.keys(H1_99).join("|");
const DEV = Object.keys(D1_99).join("|");
// "42 hazaar", "bayalis hazaar", "बयालीस हज़ार", "डेढ़ लाख" is out of scope.
const AMOUNT = new RegExp(
  `(?<![\\wऀ-ॿ])(\\d{1,3}(?:\\.\\d)?|${ROM}|${DEV})\\s+(hazaar|lakh|हज़ार|हजार|लाख)(?![\\wऀ-ॿ])`,
  "gi",
);
const valueOf = (w) => {
  if (/^\d/.test(w)) return Number(w);
  return H1_99[w.toLowerCase()] ?? D1_99[w] ?? null;
};
/** Hindi number words with a multiplier, and lone Devanagari numerals, to digits. */
export function hindiNumbers(text) {
  let t = String(text ?? "");
  t = t.replace(AMOUNT, (m, n, mult) => {
    const v = valueOf(n);
    const k = MULT[mult.toLowerCase()] ?? MULT[mult];
    return v == null || !k ? m : String(Math.round(v * k));
  });
  // Devanagari digits (०-९) are digits.
  t = t.replace(/[०-९]/g, (d) => String("०१२३४५६७८९".indexOf(d)));
  // "pehle paanch tha": a lone romanised small number next to a value word.
  t = t.replace(
    new RegExp(`\\b(${ROM})\\b(?=\\s+(?:tha|thi|hai|ho|se|aaya|aayi))`, "gi"),
    (m, w) => (/^(do|sat|che)$/i.test(w) ? m : String(valueOf(w))),
  );
  return t;
}

// ------------------------------------------------------------ spoken IDs
const DIGIT = {
  zero: 0,
  oh: 0,
  o: 0,
  shunya: 0,
  one: 1,
  ek: 1,
  two: 2,
  to: 2,
  too: 2,
  three: 3,
  teen: 3,
  four: 4,
  for: 4,
  char: 4,
  five: 5,
  paanch: 5,
  six: 6,
  seven: 7,
  saat: 7,
  eight: 8,
  aath: 8,
  nine: 9,
  nau: 9,
};
/** "syn zero zero zero three", "sin double zero zero one", "s y n 0 0 0 3" -> SYN-000x. */
export function spokenIds(text) {
  return String(text ?? "").replace(
    /\b(?:s\s?y\s?n|sin|syn|cin)\s*[- ]?\s*((?:(?:double|triple)\s+)?(?:zero|oh|o|shunya|one|ek|two|to|too|three|teen|four|for|char|five|paanch|six|seven|saat|eight|aath|nine|nau|\d)(?:[\s-]+(?:(?:double|triple)\s+)?(?:zero|oh|o|shunya|one|ek|two|to|too|three|teen|four|for|char|five|paanch|six|seven|saat|eight|aath|nine|nau|\d)){2,5})\b/gi,
    (m, run) => {
      const out = [];
      let rep = 1;
      for (const w of run.toLowerCase().split(/[\s-]+/)) {
        if (w === "double") rep = 2;
        else if (w === "triple") rep = 3;
        else {
          const d = /^\d$/.test(w) ? Number(w) : DIGIT[w];
          if (d == null) return m;
          for (let i = 0; i < rep; i++) out.push(d);
          rep = 1;
        }
      }
      return out.length >= 3 && out.length <= 4
        ? `SYN-${out.join("").padStart(4, "0")}`
        : m;
    },
  );
}

/** The whole front-end, in order. Returns the rewritten text (same if nothing applied). */
export function normalizeVernacular(text) {
  const t0 = String(text ?? "");
  // IDs first: "zero zero zero three" must not be read as a stutter.
  let t = cleanUtterance(spokenIds(t0));
  t = canonicalHinglish(t);
  t = hindiNumbers(t);
  return t || t0;
}

// ------------------------------------------------------------ advice: say no clearly
// A treatment, dose, diagnosis or business decision is never the record's to
// make. These are declined in the visitor's language, warmly and without
// hedging, and point at who can answer.
const CONDITION =
  /\b(diabet\w*|prediabet\w*|an(a)?emi\w*|hypo\w*|hyper\w*|thyroid (?:disease|problem|issue)|kidney (?:disease|failure|problem)|ckd|cancer|infection|iron deficiency|pcos|sugar ki bimari|khoon ki kami|bimari)\b|डायबिटीज|मधुमेह|एनीमिया|खून की कमी|बीमारी|थायरॉइड की समस्या/i;
const MED =
  /\b(tablets?|pills?|medicines?|medication|meds|supplements?|thyroxine|levothyroxine|metformin|insulin|iron|vitamin|goli|goliyan|dawa|dawai|dawaai|injection|treatment)\b|गोली|दवा|दवाई|इंजेक्शन|इलाज/i;
const ADVICE = [
  // English: should I take / stop / start / how much ... should I
  /\b(should|can|could|must|do)\s+i\s+(take|stop|start|continue|increase|reduce|skip|quit|double|lower|raise|change)\b/i,
  /\bhow (?:much|many)\b.{0,30}\b(should|do|can)\s+i\b/i,
  /\b(dose|dosage|prescri\w+)\b/i,
  // Hinglish: leni chahiye / band kar doon / chhod doon
  /\b(leni|lena|lene|khani|khana|khaun|loon|lu|chhod\w*|band\s+kar\w*|shuru\s+kar\w*|badha\s+doon|kam\s+kar\w*)\b.{0,20}\b(chahiye|chahie|chaiye|doon|du|sakta|sakti)\b/i,
  // Hindi
  /(लेनी|लेना|लेने|खानी|खाना|छोड़|बंद\s*कर|शुरू\s*कर).{0,20}(चाहिए|दूं|दूँ|सकता|सकती)/,
];
const DIAGNOSIS = [
  /\b(do|did|could|might)\s+i\s+have\b/i,
  /\bam\s+i\s+(diabetic|an(a)?emic|sick|ill|prediabetic|hypothyroid)\b/i,
  /\bkya\s+(mujhe|mujhko|mere\s+ko)\b.{0,30}\b(hai|ho\s+gaya|ho\s+gayi|hua|hui)\b/i,
  /क्या\s+(मुझे|मुझको)\s.{0,30}(है|हो\s*गया|हो\s*गई|हुआ|हुई)/,
];
const DECISION =
  /\b(should\s+(we|i)\s+(sign|accept|approve|reject|agree|pay)|kya\s+(hume|humein|hamein|mujhe)\b.{0,30}\b(sign|accept|approve|manzoor|pay)\b.{0,20}\b(chahiye|kar\s+le\w*))|क्या\s+(हमें|मुझे).{0,30}(साइन|मंज़ूर|स्वीकार).{0,20}चाहिए/i;

/**
 * "treatment" | "diagnosis" | "decision" | null. A diagnosis question needs a
 * named condition ("do I have a ferritin result?" is a lookup, not advice).
 */
export function adviceKind(text) {
  const t = String(text ?? "");
  if (DECISION.test(t)) return "decision";
  if (
    ADVICE.some((re) => re.test(t)) &&
    (MED.test(t) || /\b(dose|dosage)\b|खुराक/i.test(t))
  )
    return "treatment";
  if (
    /\bstop\s+my\b|\bmy\s+(medicine|medication|tablets?)\b/i.test(t) &&
    /\b(can|should)\s+i\b/i.test(t)
  )
    return "treatment";
  if (DIAGNOSIS.some((re) => re.test(t)) && CONDITION.test(t))
    return "diagnosis";
  return null;
}

const DECLINE = {
  treatment: {
    en: "I can't tell you whether to take, stop or change a medicine; that's a call for your doctor, who knows your history. What I can do is show you exactly what your reports say, so you walk in with the right numbers.",
    hi: "दवा लेनी है, बंद करनी है या बदलनी है, यह मैं नहीं बता सकती; यह फ़ैसला आपके डॉक्टर का है, जो आपकी पूरी हिस्ट्री जानते हैं। मैं इतना कर सकती हूँ कि आपकी रिपोर्ट में जो लिखा है, वह ठीक-ठीक दिखा दूँ, ताकि आप सही नंबरों के साथ डॉक्टर से मिलें।",
    hinglish:
      "Dawa leni hai, band karni hai ya badalni hai, yeh main nahi bata sakti; yeh faisla aapke doctor ka hai, jo aapki poori history jaante hain. Main itna kar sakti hoon ki aapki report mein jo likha hai woh theek-theek dikha doon, taaki aap sahi numbers ke saath doctor se milein.",
  },
  diagnosis: {
    en: "I can't tell you whether you have a condition; a diagnosis needs your doctor, who can look at your symptoms and history too. I can show you each result next to the lab's printed range, which is a good place to start that conversation.",
    hi: "आपको कोई बीमारी है या नहीं, यह मैं नहीं बता सकती; इसके लिए आपके डॉक्टर चाहिए, जो आपके लक्षण और हिस्ट्री भी देखेंगे। मैं हर नतीजा लैब की छपी सीमा के साथ दिखा सकती हूँ, बात शुरू करने के लिए यह अच्छी जगह है।",
    hinglish:
      "Aapko koi bimari hai ya nahi, yeh main nahi bata sakti; iske liye aapke doctor chahiye, jo aapke symptoms aur history bhi dekhenge. Main har result lab ki chhapi range ke saath dikha sakti hoon, baat shuru karne ke liye yeh achhi jagah hai.",
  },
  decision: {
    en: "That decision is yours, not mine: I only report what the records say. Ask me what is approved, what is still open, or what was signed, and I'll show you the exact line.",
    hi: "यह फ़ैसला आपका है, मेरा नहीं: मैं सिर्फ़ बताती हूँ कि रिकॉर्ड में क्या लिखा है। मुझसे पूछिए कि क्या मंज़ूर हुआ, क्या अभी खुला है, या किस पर हस्ताक्षर हुए, और मैं ठीक वही लाइन दिखा दूँगी।",
    hinglish:
      "Yeh faisla aapka hai, mera nahi: main sirf batati hoon ki records mein kya likha hai. Mujhse poochiye ki kya manzoor hua, kya abhi open hai, ya kis par sign hua, aur main wahi line dikha doongi.",
  },
};
/** The decline lead for an advice question, in the visitor's language. */
export function declineLead(kind, lang = "en") {
  const k = DECLINE[kind] ? kind : "treatment";
  const l = ["en", "hi", "hinglish"].includes(lang) ? lang : "en";
  return {
    verdict: "DECLINE_ADVICE",
    text: DECLINE[k][l],
    field: null,
    citations: [],
    advice: k,
  };
}

// ------------------------------------------------------------ Hinglish rendering
// Same templates as toHindi() in conversation.mjs, romanised. Values, dates
// and quoted record text pass through untouched.
const HL = [
  [
    /^(.+) is the latest proposal, and it is not approved\.$/,
    "$1 sabse naya proposal hai, aur yeh abhi manzoor nahi hua hai.",
  ],
  [
    /^(.+) is the current proposal; approval is not recorded\.$/,
    "$1 abhi ka proposal hai; manzoori darj nahi hai.",
  ],
  [
    /^That is still open: (.+) are both on record, and it is not approved\.$/,
    "Yeh abhi tay nahi hua hai: $1, dono record mein hain, aur kuch bhi manzoor nahi hua.",
  ],
  [
    /^That is still open: (.+) are both on record\.$/,
    "Yeh abhi tay nahi hua hai: $1, dono record mein hain.",
  ],
  [
    /^(.+) is the only record, and it is not approved\.$/,
    "$1 hi akela record hai, aur yeh manzoor nahi hua hai.",
  ],
  [/^(.+) is approved, per (.+)\.$/, "$1 manzoor hai, $2 ke hisaab se."],
  [/^(.+) is approved\.$/, "$1 manzoor hai."],
  [
    /^Yes, the earlier record was (.+)\. It was superseded by (.+), which is still not approved\.$/,
    "Haan, pehle ka record $1 tha. Uski jagah $2 aaya, jo abhi bhi manzoor nahi hai.",
  ],
  [
    /^The terms need (.+) sign-off, and that sign-off is not recorded yet\.$/,
    "In terms ke liye $1 ka sign-off chahiye, aur woh abhi darj nahi hai.",
  ],
  [/^The current working scope is (.+)\.$/, "Abhi ka kaam ka scope $1 hai."],
  [
    /^I don't see that in these documents\.?$/,
    "Mujhe yeh in documents mein nahi mila.",
  ],
  [
    /^I don't see (.+) in these documents\.$/,
    "Mujhe $1 in documents mein nahi dikha.",
  ],
  [
    /^I could not find supporting evidence in these documents\.$/,
    "Mujhe in documents mein iska koi saboot nahi mila.",
  ],
  [/^No\. Per (.+?): (.+)$/, "Nahi. $1 ke hisaab se: $2"],
  [
    /^Yes\. (.+) records the approval(.*)\.$/,
    "Haan. $1 mein manzoori darj hai$2.",
  ],
  [/^Still open, per (.+?): (.+)$/, "Abhi open hai, $1 ke hisaab se: $2"],
];
/**
 * Romanised Hindi for an English template answer. Unknown sentences fall
 * back to "record mein likha hai:" + the English sentence, never a free
 * translation of record text.
 */
export function toHinglish(spoken) {
  const s = String(spoken ?? "").trim();
  if (!s || /[ऀ-ॿ]/.test(s)) return s;
  const one = (x) => {
    for (const [re, to] of HL) if (re.test(x)) return x.replace(re, to);
    return null;
  };
  const parts = s.split(/(?<=[.?!])(?<!\b(?:No|Yes)\.)\s+(?=[A-Z$0-9])/);
  const out = parts.map(one);
  if (out.every((x) => x === null)) return `Record mein likha hai: ${s}`;
  return out.map((x, i) => x ?? `Record mein likha hai: ${parts[i]}`).join(" ");
}

/** Localised "nothing supports an answer" for a question that got no lead. */
export function noAnswerLead(lang = "en") {
  const text = {
    en: "I don't see that in these documents, so I won't guess.",
    hi: "मुझे यह इन दस्तावेज़ों में नहीं मिला, इसलिए मैं अंदाज़ा नहीं लगाऊँगी।",
    hinglish:
      "Mujhe yeh in documents mein nahi mila, isliye main andaaza nahi lagaungi.",
  }[["en", "hi", "hinglish"].includes(lang) ? lang : "en"];
  return { verdict: "UNKNOWN", text, field: null, citations: [] };
}
