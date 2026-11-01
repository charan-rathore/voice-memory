// Plain-language, supportive explanations of lab results, in the language the
// question was asked in (English, Hindi in Devanagari, or romanized Hinglish).
//
// Rules (each has a test in clinical/explain.test.mjs):
//  1. The person's numbers come only from their report (typed observations).
//  2. "What this test measures" comes only from GLOSSARY, each entry cited to
//     MedlinePlus, and is phrased as general information, never as a finding.
//  3. Position vs range uses the lab's own printed range. No outside thresholds.
//  4. Tone: supportive and realistic. A value just outside the range is put in
//     perspective (ranges are built so ~1 in 20 people without disease fall
//     outside); a value far outside is called that, with "talk to your doctor
//     soon"; a result the lab printed as critical gets "contact your doctor
//     today". Never a diagnosis, a disease name, or reassurance about health.

import { MORE_GLOSSARY, MORE_SOURCES } from "./glossary-more.mjs";

export const SOURCES = {
  range: "https://www.hc.u-tokyo.ac.jp/en/checkupresult/explanation/criteria",
  tsh: "https://medlineplus.gov/labtests/tshthyroidstimulatinghormonetest.html",
  hemoglobin: "https://medlineplus.gov/lab-tests/hemoglobin-test/",
  ferritin: "https://medlineplus.gov/lab-tests/ferritin-blood-test/",
  hba1c: "https://medlineplus.gov/lab-tests/hemoglobin-a1c-hba1c-test/",
  creatinine: "https://medlineplus.gov/lab-tests/creatinine-test/",
  urea: "https://medlineplus.gov/lab-tests/bun-blood-urea-nitrogen/",
  potassium: "https://medlineplus.gov/lab-tests/potassium-blood-test/",
};

// General information only. Paraphrased from the cited MedlinePlus pages.
export const GLOSSARY = {
  tsh: {
    en: "TSH is a hormone that tells your thyroid how much thyroid hormone to make, so it's used to check how the thyroid is working.",
    hi: "TSH एक हार्मोन है जो थायरॉइड को बताता है कि कितना हार्मोन बनाना है, इसलिए इससे थायरॉइड के काम की जांच की जाती है।",
    hinglish:
      "TSH ek hormone hai jo thyroid ko batata hai ki kitna hormone banana hai, isliye isse thyroid ke kaam ki jaanch hoti hai.",
    aliases: [
      "thyroid stimulating hormone",
      "tsh",
      "ultrasensitive tsh",
      "टीएसएच",
    ],
  },
  hemoglobin: {
    en: "Hemoglobin is the protein in red blood cells that carries oxygen around the body.",
    hi: "हीमोग्लोबिन लाल रक्त कोशिकाओं में एक प्रोटीन है जो शरीर में ऑक्सीजन पहुंचाता है।",
    hinglish:
      "Hemoglobin red blood cells mein ek protein hai jo body mein oxygen pahunchata hai.",
    aliases: [
      "hemoglobin",
      "haemoglobin",
      "हीमोग्लोबिन",
      "hb",
      "hgb",
      "hemoglobin percentage",
    ],
  },
  ferritin: {
    en: "Ferritin shows how much iron your body has stored.",
    hi: "फेरिटिन से पता चलता है कि शरीर में कितना आयरन जमा है।",
    hinglish: "Ferritin se pata chalta hai ki body mein kitna iron store hai.",
    aliases: [
      "ferritin",
      "serum ferritin",
      "iron stores",
      "stored iron",
      "फेरिटिन",
    ],
  },
  hba1c: {
    en: "HbA1c reflects your average blood sugar over roughly the past two to three months.",
    hi: "HbA1c पिछले लगभग दो से तीन महीनों के औसत ब्लड शुगर को दिखाता है।",
    hinglish:
      "HbA1c pichhle lagbhag do se teen mahine ki average blood sugar dikhata hai.",
    aliases: [
      "hba1c",
      "a1c",
      "hemoglobin a1c",
      "glycated hemoglobin",
      "glycosylated hemoglobin",
      "average sugar",
      "एचबीए1सी",
    ],
  },
  creatinine: {
    en: "Creatinine is a waste product from muscles that the kidneys filter out, so it's used to check how the kidneys are working. Muscle mass, diet, activity and some medicines can affect it.",
    hi: "क्रिएटिनिन मांसपेशियों से बनने वाला एक अपशिष्ट है जिसे किडनी छानती है, इसलिए इससे किडनी के काम की जांच होती है। मांसपेशियां, खान-पान, व्यायाम और कुछ दवाएं इस पर असर डाल सकती हैं।",
    hinglish:
      "Creatinine muscles se banne wala waste hai jise kidney filter karti hai, isliye isse kidney ke kaam ki jaanch hoti hai. Muscle, diet, exercise aur kuch dawaiyan iss par asar daal sakti hain.",
    aliases: ["creatinine", "serum creatinine", "क्रिएटिनिन"],
  },
  urea: {
    en: "Urea is a waste product made when the body breaks down protein; it's one of the ways kidney function is checked.",
    hi: "यूरिया प्रोटीन टूटने पर बनने वाला अपशिष्ट है; यह किडनी के काम की जांच का एक तरीका है।",
    hinglish:
      "Urea protein tootne par banne wala waste hai; yeh kidney ke kaam ki jaanch ka ek tareeka hai.",
    aliases: [
      "urea",
      "blood urea",
      "bun",
      "blood urea nitrogen",
      "urea nitrogen blood",
      "यूरिया",
    ],
  },
  potassium: {
    en: "Potassium is a mineral in the blood that helps muscles and nerves, including the heart, work properly.",
    hi: "पोटैशियम खून में एक खनिज है जो मांसपेशियों और नसों, जिनमें दिल भी शामिल है, को ठीक से काम करने में मदद करता है।",
    hinglish:
      "Potassium khoon mein ek mineral hai jo muscles aur nerves, dil samet, ko theek se kaam karne mein madad karta hai.",
    aliases: ["potassium", "k", "serum potassium", "पोटैशियम"],
  },
};

Object.assign(GLOSSARY, MORE_GLOSSARY);
Object.assign(SOURCES, MORE_SOURCES);

// ------------------------------------------------------------ test identity
// Printed names vary ("HAEMOGLOBIN PERCENTAGE", "Hemoglobin (Hb)", "HGB").
// canonOf maps a printed name to one glossary key by its words: the most
// specific alias whose words all appear, provided the name adds only generic
// words ("total", "count", "serum"...). "Hb A2" stays unmatched: A2 is not
// generic, so it is not hemoglobin.
const GENERIC = new Set([
  "total",
  "count",
  "serum",
  "plasma",
  "blood",
  "level",
  "levels",
  "percentage",
  "percent",
  "value",
  "test",
  "estimation",
  "absolute",
  "segmented",
  "calculated",
  "automated",
  "whole",
  "random",
  "fasting",
  "auto",
  "s",
  "b",
  "of",
]);
export const words = (s) =>
  String(s)
    .toLowerCase()
    .replace(/haem/g, "hem")
    .replace(/oe/g, "e")
    .replace(/[^a-z0-9\u0900-\u097f]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => (w.length > 4 && /[^s]s$/.test(w) ? w.slice(0, -1) : w));
const ALIAS_INDEX = [];
for (const [key, g] of Object.entries(GLOSSARY))
  for (const a of new Set([key, ...(g.aliases ?? [])])) {
    const w = words(a);
    if (w.length) ALIAS_INDEX.push({ key, w, len: a.length });
  }
ALIAS_INDEX.sort((a, b) => b.w.length - a.w.length || b.len - a.len);
const memo = new Map();
export function canonOf(name) {
  if (memo.has(name)) return memo.get(name);
  const w = words(name);
  const set = new Set(w);
  let key = null;
  for (const a of ALIAS_INDEX) {
    if (!a.w.every((x) => set.has(x))) continue;
    const extra = w.filter((x) => !a.w.includes(x) && !GENERIC.has(x));
    // extra specific words are fine when they are another alias of the
    // same test ("ASPARTATE AMINOTRANSFERASE AST (SGOT)")
    const own = new Set(
      ALIAS_INDEX.filter((b) => b.key === a.key).flatMap((b) => b.w),
    );
    if (extra.every((x) => own.has(x))) {
      key = a.key;
      break;
    }
  }
  memo.set(name, key);
  return key;
}
/** A printed name as it is spoken: shouting capitals become sentence case, abbreviations stay. */
const ABBREV = new Set(
  "WBC RBC HB HGB AST ALT ALP GGT GGTP MCV MCH MCHC RDW PCV HCT TSH CRP ESR LDL HDL VLDL TLC DLC NS1 IGG IGM IGE SGOT SGPT LFT KFT RFT HBA1C T3 T4 FT3 FT4 PSA B12 ABO RH CBC BUN EGFR INR PT APTT TIBC LH FSH AEC MPV PDW CV SD".split(
    " ",
  ),
);
export function nameOf(o) {
  const t = String(o.test ?? o)
    .replace(/\s+/g, " ")
    .trim();
  if (t !== t.toUpperCase() || !/[A-Z]{5}/.test(t)) return t;
  return t
    .split(" ")
    .map((x) => {
      const bare = x.replace(/[^A-Z0-9]/g, "");
      return ABBREV.has(bare) || /\d/.test(bare) || /[.]/.test(x)
        ? x
        : x.toLowerCase();
    })
    .join(" ")
    .replace(/\bIGG\b/g, "IgG")
    .replace(/\bIGM\b/g, "IgM")
    .replace(/\bIGE\b/g, "IgE");
}

const HINGLISH =
  /\b(kya|kyaa|mera|meri|mere|hai|hain|kitna|kitni|badla|badli|badha|badhi|ghata|ghati|pichhl\w*|pehle|batao|bataiye|samjhao|report\s+(me|mein)|kaisa|kaisi|theek)\b/i;
export function detectLang(text) {
  if (/[ऀ-ॿ]/.test(text)) return "hi";
  const hits = (text.match(new RegExp(HINGLISH.source, "gi")) ?? []).length;
  return hits >= 2 ? "hinglish" : "en";
}

const MONTHS = {
  en: [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
  ],
  hi: [
    "जनवरी",
    "फ़रवरी",
    "मार्च",
    "अप्रैल",
    "मई",
    "जून",
    "जुलाई",
    "अगस्त",
    "सितंबर",
    "अक्टूबर",
    "नवंबर",
    "दिसंबर",
  ],
  hinglish: [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
  ],
};
export const sayDate = (iso, lang = "en") => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(iso)))
    return /^raw:/.test(iso)
      ? String(iso).slice(4)
      : { en: "this report", hi: "इस रिपोर्ट", hinglish: "is report" }[lang];
  const [y, m, d] = iso.split("-").map(Number);
  return `${d} ${MONTHS[lang][m - 1]} ${y}`;
};

const COMP = {
  en: {
    "<": "less than ",
    "<=": "at most ",
    ">": "more than ",
    ">=": "at least ",
  },
  hi: { "<": "", "<=": "", ">": "", ">=": "" },
  hinglish: { "<": "", "<=": "", ">": "", ">=": "" },
};
const COMP_SUFFIX = {
  hi: {
    "<": " से कम",
    "<=": " या उससे कम",
    ">": " से ज़्यादा",
    ">=": " या उससे ज़्यादा",
  },
  hinglish: {
    "<": " se kam",
    "<=": " ya usse kam",
    ">": " se zyada",
    ">=": " ya usse zyada",
  },
};
export function valueText(o, lang = "en") {
  const n = o.raw.replace(/^(<=|>=|<|>|≤|≥)\s*/, "");
  const unit = o.unit ? " " + o.unit : "";
  if (lang === "en") return `${COMP.en[o.comparator] ?? ""}${n}${unit}`;
  return `${n}${unit}${o.comparator ? COMP_SUFFIX[lang][o.comparator] : ""}`;
}

export function parseRange(range) {
  const m = /^\s*([0-9]+(?:\.[0-9]+)?)\s*[-–]\s*([0-9]+(?:\.[0-9]+)?)\s*$/.exec(
    range ?? "",
  );
  // low/high keep the lab's printed strings for speech ("0.40", not 0.4);
  // lowN/highN are the numbers used for arithmetic.
  return m
    ? { low: m[1], high: m[2], lowN: Number(m[1]), highN: Number(m[2]) }
    : null;
}

export const CRITICAL_FLAG = /^(hh|ll|c|crit\w*|panic|!+|\*+)$/i;

/** The interval to judge a value by: the parsed printed range, if any. */
export function rangeOf(o) {
  if (o.ref?.adultOnly) return null;
  if (o.ref && o.ref.lowN != null && o.ref.highN != null) return o.ref;
  return parseRange(o.range);
}
const NEGATIVE = new Set([
  "negative",
  "non reactive",
  "not detected",
  "absent",
  "nil",
]);
const sameQual = (a, b) => a === b || (NEGATIVE.has(a) && NEGATIVE.has(b));
/** How a range reads aloud, including open ones ("up to 200"). */
export function span(r, lang = "en") {
  const lo = r.low ?? (Number.isFinite(r.lowN) ? String(r.lowN) : null);
  const hi = r.high ?? (Number.isFinite(r.highN) ? String(r.highN) : null);
  if (lo != null && hi != null)
    return {
      en: `${lo} to ${hi}`,
      hi: `${lo} से ${hi}`,
      hinglish: `${lo} se ${hi}`,
    }[lang];
  if (hi != null)
    return { en: `up to ${hi}`, hi: `${hi} तक`, hinglish: `${hi} tak` }[lang];
  return {
    en: `${lo} or more`,
    hi: `${lo} या उससे ज़्यादा`,
    hinglish: `${lo} ya usse zyada`,
  }[lang];
}

/**
 * Where a value sits against its printed range.
 * @returns {"within"|"below_slightly"|"below_clearly"|"above_slightly"|"above_clearly"|"unknown"}
 */
export function position(o) {
  if (o.qual) {
    if (!o.ref?.expected) return "unknown";
    return sameQual(o.qual, o.ref.expected) ? "within" : "qual_differs";
  }
  const r = rangeOf(o);
  if (!r || o.value == null) return "unknown";
  if (r.lowN == null || r.highN == null) return "unknown";
  // A bound ("<0.05") occupies an interval; it is only "within" if the whole
  // interval is, and it is never "slightly" outside (its true value is unknown).
  const lo =
    o.comparator === "<" || o.comparator === "<=" ? -Infinity : o.value;
  const hi = o.comparator === ">" || o.comparator === ">=" ? Infinity : o.value;
  // "Slightly" = within 10% of the limit that was crossed (relative, so it
  // means the same for ferritin in the hundreds and TSH below one).
  const near = (limit) =>
    !o.comparator &&
    Number.isFinite(limit) &&
    Math.abs(o.value - limit) <= 0.1 * Math.abs(limit);
  if (hi < r.lowN) return near(r.lowN) ? "below_slightly" : "below_clearly";
  if (lo > r.highN) return near(r.highN) ? "above_slightly" : "above_clearly";
  if (lo >= r.lowN && hi <= r.highN) return "within";
  return "unknown";
}

const T = {
  en: {
    value: (o, date) =>
      `Your ${nameOf(o)} result is ${valueText(o, "en")}, from ${date}.`,
    within: (r) => `That's within this lab's range of ${span(r, "en")}.`,
    below_slightly: (r) =>
      `That's a little below this lab's range of ${span(r, "en")}. Results just outside a range are common: ranges are set so that about 1 in 20 people without any illness land outside them.`,
    above_slightly: (r) =>
      `That's a little above this lab's range of ${span(r, "en")}. Results just outside a range are common: ranges are set so that about 1 in 20 people without any illness land outside them.`,
    below_clearly: (r) =>
      `That's clearly below this lab's range of ${span(r, "en")}, so it's worth talking it through with your doctor soon.`,
    above_clearly: (r) =>
      `That's clearly above this lab's range of ${span(r, "en")}, so it's worth talking it through with your doctor soon.`,
    unknown: () => `The report doesn't give a range I can compare it with.`,
    adultOnly: `The ranges printed for it are adult ranges and this report is for a child, so I won't judge it against them; a doctor can, using ranges for the child's age.`,
    qualValue: (o, date) =>
      `Your ${nameOf(o)} result is ${o.qual}, from ${date}.`,
    qual_differs: (o) =>
      `The lab's expected result for this test is ${o.ref.expected}, so this one is flagged as different from expected.`,
    qual_within: (o) => `That matches the lab's expected result.`,
    critical: `The lab marked this result as critical. Labs do that so it gets seen quickly, so please contact your doctor or clinic today.`,
    general: (g) => `Some general background: ${g}`,
    doctor: `Your doctor can read it alongside how you feel, your medicines and your other results.`,
    went: (o, a, b, da, db) =>
      `Your ${nameOf(o)} went from ${valueText(a, "en")} on ${da} to ${valueText(b, "en")} on ${db}.`,
    dir: {
      higher: "That's higher than before.",
      lower: "That's lower than before.",
      same: "That's the same as before.",
      undetermined:
        "I can't tell whether it went up or down, because one result is only reported as a bound.",
    },
    moved: {
      in: "It's now inside the lab's range.",
      out: "It has moved outside the lab's range.",
    },
    amended: (date, from, to) =>
      `The ${date} result was corrected from ${from} to ${to}, and I'm using the corrected value.`,
    noConvert: (o, a, b, da, db) =>
      `I can't compare your two ${nameOf(o)} results: the ${da} one is in ${a.unit} and the ${db} one is in ${b.unit}, and I don't convert between units. Both values are on screen, and your doctor or the lab can compare them properly.`,
    single: (o) =>
      `There's only one ${nameOf(o)} result in these reports, so there's nothing to compare yet.`,
    which: (test, ids) =>
      `These reports have ${test} results for more than one person (${ids.join(", ")}). Whose results should I look at?`,
    unknownPatient: `I can't tell whose results these are, so I won't compare or explain them. The reports are on screen.`,
    undated: (o) =>
      `I can't tell which of these reports is newer, because their dates aren't printed in a form I can read, so I won't call ${nameOf(o)} up or down. Both values are on screen.`,
    flagConflict: (o) =>
      `One thing to check: the report's ${o.flag} flag doesn't match its own range, so it's worth confirming with the lab.`,
  },
  hi: {
    value: (o, date) =>
      `आपका ${nameOf(o)} नतीजा ${valueText(o, "hi")} है, ${date} की जांच से।`,
    within: (r) => `यह इस लैब की सीमा (${span(r, "hi")}) के अंदर है।`,
    below_slightly: (r) =>
      `यह इस लैब की सीमा (${span(r, "hi")}) से थोड़ा कम है। सीमा से थोड़ा बाहर आना आम बात है: सीमा ऐसे तय की जाती है कि बिना किसी बीमारी वाले लगभग हर 20 में से 1 व्यक्ति का नतीजा भी इसके बाहर आता है।`,
    above_slightly: (r) =>
      `यह इस लैब की सीमा (${span(r, "hi")}) से थोड़ा ज़्यादा है। सीमा से थोड़ा बाहर आना आम बात है: सीमा ऐसे तय की जाती है कि बिना किसी बीमारी वाले लगभग हर 20 में से 1 व्यक्ति का नतीजा भी इसके बाहर आता है।`,
    below_clearly: (r) =>
      `यह इस लैब की सीमा (${span(r, "hi")}) से साफ़ तौर पर कम है, इसलिए इसके बारे में जल्द ही अपने डॉक्टर से बात करना अच्छा रहेगा।`,
    above_clearly: (r) =>
      `यह इस लैब की सीमा (${span(r, "hi")}) से साफ़ तौर पर ज़्यादा है, इसलिए इसके बारे में जल्द ही अपने डॉक्टर से बात करना अच्छा रहेगा।`,
    unknown: () =>
      `रिपोर्ट में ऐसी सीमा नहीं दी गई है जिससे मैं इसकी तुलना कर सकूं।`,
    adultOnly: `इसके लिए छपी सीमाएं वयस्कों की हैं और यह रिपोर्ट एक बच्चे की है, इसलिए मैं इसे उनसे नहीं आंकूंगी; डॉक्टर बच्चे की उम्र की सीमा से इसे देख सकते हैं।`,
    qualValue: (o, date) =>
      `आपका ${nameOf(o)} नतीजा ${QUAL_HI[o.qual] ?? o.qual} है, ${date} की जांच से।`,
    qual_differs: (o) =>
      `इस जांच का लैब का अपेक्षित नतीजा ${QUAL_HI[o.ref.expected] ?? o.ref.expected} है, इसलिए यह अपेक्षा से अलग है।`,
    qual_within: () => `यह लैब के अपेक्षित नतीजे से मेल खाता है।`,
    critical: `लैब ने इस नतीजे को क्रिटिकल बताया है। लैब ऐसा इसलिए करती है ताकि इसे जल्दी देखा जाए, इसलिए कृपया आज ही अपने डॉक्टर या क्लिनिक से संपर्क करें।`,
    general: (g) => `थोड़ी सामान्य जानकारी: ${g}`,
    doctor: `आपके डॉक्टर इसे आपकी तबीयत, दवाओं और बाकी जांचों के साथ देखकर सही मतलब समझा सकते हैं।`,
    went: (o, a, b, da, db) =>
      `आपका ${nameOf(o)} ${da} को ${valueText(a, "hi")} था और ${db} को ${valueText(b, "hi")} है।`,
    dir: {
      higher: "यह पहले से ज़्यादा है।",
      lower: "यह पहले से कम है।",
      same: "यह पहले जितना ही है।",
      undetermined:
        "मैं नहीं बता सकता कि यह बढ़ा या घटा, क्योंकि एक नतीजा सिर्फ़ एक सीमा के रूप में दिया गया है।",
    },
    moved: {
      in: "अब यह लैब की सीमा के अंदर है।",
      out: "अब यह लैब की सीमा से बाहर है।",
    },
    amended: (date, from, to) =>
      `${date} का नतीजा ${from} से सुधारकर ${to} किया गया था, और मैं सुधरा हुआ नतीजा इस्तेमाल कर रहा हूं।`,
    noConvert: (o, a, b, da, db) =>
      `मैं आपके दोनों ${nameOf(o)} नतीजों की तुलना नहीं कर सकता: ${da} वाला ${a.unit} में है और ${db} वाला ${b.unit} में, और मैं यूनिट नहीं बदलता। दोनों नतीजे स्क्रीन पर हैं, और आपके डॉक्टर या लैब इनकी सही तुलना कर सकते हैं।`,
    single: (o) =>
      `इन रिपोर्ट्स में ${nameOf(o)} का सिर्फ़ एक नतीजा है, इसलिए अभी तुलना के लिए कुछ नहीं है।`,
    which: (test, ids) =>
      `इन रिपोर्ट्स में एक से ज़्यादा लोगों के ${test} नतीजे हैं (${ids.join(", ")})। मैं किसके नतीजे देखूं?`,
    unknownPatient: `मैं नहीं बता सकता कि ये नतीजे किसके हैं, इसलिए मैं इनकी तुलना या व्याख्या नहीं करूंगा। रिपोर्ट्स स्क्रीन पर हैं।`,
    undated: (o) =>
      `मैं नहीं बता सकता कि इनमें से कौन सी रिपोर्ट नई है, क्योंकि तारीखें साफ़ नहीं छपी हैं, इसलिए मैं ${nameOf(o)} को बढ़ा या घटा नहीं कहूंगा। दोनों नतीजे स्क्रीन पर हैं।`,
    flagConflict: (o) =>
      `एक बात जांच लें: रिपोर्ट का ${o.flag} निशान उसकी अपनी सीमा से मेल नहीं खाता, इसलिए लैब से पुष्टि कर लेना अच्छा रहेगा।`,
  },
  hinglish: {
    value: (o, date) =>
      `Aapka ${nameOf(o)} result ${valueText(o, "hinglish")} hai, ${date} ki jaanch se.`,
    within: (r) => `Yeh is lab ki range (${span(r, "hinglish")}) ke andar hai.`,
    below_slightly: (r) =>
      `Yeh is lab ki range (${span(r, "hinglish")}) se thoda kam hai. Range se thoda bahar aana aam baat hai: range aise set hoti hai ki bina kisi bimari wale lagbhag har 20 mein se 1 insaan ka result bhi iske bahar aata hai.`,
    above_slightly: (r) =>
      `Yeh is lab ki range (${span(r, "hinglish")}) se thoda zyada hai. Range se thoda bahar aana aam baat hai: range aise set hoti hai ki bina kisi bimari wale lagbhag har 20 mein se 1 insaan ka result bhi iske bahar aata hai.`,
    below_clearly: (r) =>
      `Yeh is lab ki range (${span(r, "hinglish")}) se saaf taur par kam hai, isliye iske baare mein jaldi apne doctor se baat karna achha rahega.`,
    above_clearly: (r) =>
      `Yeh is lab ki range (${span(r, "hinglish")}) se saaf taur par zyada hai, isliye iske baare mein jaldi apne doctor se baat karna achha rahega.`,
    unknown: () =>
      `Report mein aisi range nahi di gayi jisse main iski tulna kar sakoon.`,
    adultOnly: `Iske liye chhapi ranges adults ki hain aur yeh report ek bachche ki hai, isliye main ise unse judge nahi karungi; doctor bachche ki umar ki range se ise dekh sakte hain.`,
    qualValue: (o, date) =>
      `Aapka ${nameOf(o)} result ${o.qual} hai, ${date} ki jaanch se.`,
    qual_differs: (o) =>
      `Is test ka lab ka expected result ${o.ref.expected} hai, isliye yeh expected se alag hai.`,
    qual_within: () => `Yeh lab ke expected result se match karta hai.`,
    critical: `Lab ne is result ko critical bataya hai. Lab aisa isliye karti hai taaki ise jaldi dekha jaye, isliye please aaj hi apne doctor ya clinic se baat karein.`,
    general: (g) => `Thodi general jaankari: ${g}`,
    doctor: `Aapke doctor ise aapki tabiyat, dawaiyon aur baaki tests ke saath dekhkar sahi matlab samjha sakte hain.`,
    went: (o, a, b, da, db) =>
      `Aapka ${nameOf(o)} ${da} ko ${valueText(a, "hinglish")} tha aur ${db} ko ${valueText(b, "hinglish")} hai.`,
    dir: {
      higher: "Yeh pehle se zyada hai.",
      lower: "Yeh pehle se kam hai.",
      same: "Yeh pehle jitna hi hai.",
      undetermined:
        "Main nahi bata sakta ki yeh badha ya ghata, kyunki ek result sirf ek seema ke roop mein diya gaya hai.",
    },
    moved: {
      in: "Ab yeh lab ki range ke andar hai.",
      out: "Ab yeh lab ki range se bahar hai.",
    },
    amended: (date, from, to) =>
      `${date} ka result ${from} se sudhaar kar ${to} kiya gaya tha, aur main sudhra hua result use kar raha hoon.`,
    noConvert: (o, a, b, da, db) =>
      `Main aapke dono ${nameOf(o)} results ki tulna nahi kar sakta: ${da} wala ${a.unit} mein hai aur ${db} wala ${b.unit} mein, aur main units convert nahi karta. Dono results screen par hain, aur aapke doctor ya lab inki sahi tulna kar sakte hain.`,
    single: (o) =>
      `In reports mein ${nameOf(o)} ka sirf ek result hai, isliye abhi tulna ke liye kuch nahi hai.`,
    which: (test, ids) =>
      `In reports mein ek se zyada logon ke ${test} results hain (${ids.join(", ")}). Main kiske results dekhoon?`,
    unknownPatient: `Main nahi bata sakta ki yeh results kiske hain, isliye main inki tulna ya explanation nahi karunga. Reports screen par hain.`,
    undated: (o) =>
      `Main nahi bata sakta ki in mein se kaunsi report nayi hai, kyunki dates saaf nahi chhapi hain, isliye main ${nameOf(o)} ko badha ya ghata nahi kahunga. Dono results screen par hain.`,
    flagConflict: (o) =>
      `Ek baat check kar lein: report ka ${o.flag} flag uski apni range se match nahi karta, isliye lab se confirm kar lena achha rahega.`,
  },
};
export const PHRASES = T;
const QUAL_HI = {
  positive: "पॉज़िटिव",
  negative: "नेगेटिव",
  reactive: "रिएक्टिव",
  "non reactive": "नॉन-रिएक्टिव",
  detected: "डिटेक्टेड",
  "not detected": "नॉट डिटेक्टेड",
  present: "मौजूद",
  absent: "मौजूद नहीं",
  nil: "शून्य",
  trace: "बहुत कम (ट्रेस)",
};

/** Explain one observation: value, position, general meaning, next step. */
export function explainOne(o, date, lang) {
  const t = T[lang];
  const pos = position(o);
  if (o.qual) {
    const parts = [t.qualValue(o, sayDate(date, lang))];
    if (pos === "qual_differs") parts.push(t.qual_differs(o));
    else if (pos === "within") parts.push(t.qual_within(o));
    const g = GLOSSARY[o.canon ?? o.key];
    if (g) parts.push(t.general(g[lang]));
    if (pos !== "within") parts.push(t.doctor);
    return parts.join(" ");
  }
  const r = rangeOf(o);
  const parts = [t.value(o, sayDate(date, lang))];
  if (CRITICAL_FLAG.test(o.flag ?? "")) parts.push(t.critical);
  else if (o.ref?.adultOnly) parts.push(t.adultOnly);
  else parts.push(r && pos !== "unknown" ? t[pos](r) : t.unknown());
  if (o.flagConflict) parts.push(t.flagConflict(o));
  const g = GLOSSARY[o.canon ?? o.key];
  if (g) parts.push(t.general(g[lang]));
  if (pos !== "within") parts.push(t.doctor);
  return parts.join(" ");
}

/** Explain a change between two comparable observations. */
export function explainChange(prev, curr, da, db, direction, lang, amended) {
  const t = T[lang];
  const parts = [
    t.went(curr, prev, curr, sayDate(da, lang), sayDate(db, lang)),
    t.dir[direction],
  ];
  const wasIn = position(prev) === "within";
  const isIn = position(curr) === "within";
  if (
    position(prev) !== "unknown" &&
    position(curr) !== "unknown" &&
    wasIn !== isIn
  )
    parts.push(isIn ? t.moved.in : t.moved.out);
  if (amended)
    parts.push(t.amended(sayDate(db, lang), amended.from, amended.to));
  if (CRITICAL_FLAG.test(curr.flag ?? "")) parts.push(t.critical);
  else if (!isIn && position(curr) !== "unknown")
    parts.push(t[position(curr)](rangeOf(curr)));
  const g = GLOSSARY[curr.canon ?? curr.key];
  if (g) parts.push(t.general(g[lang]));
  parts.push(t.doctor);
  return parts.join(" ");
}

/** Test-name aliases (incl. Devanagari) for matching questions. */
export function aliasesFor(key) {
  return GLOSSARY[key]?.aliases ?? [];
}
