// Answers to "why" and "what is" questions about lab reports.
//
// A "why" question must get a reason or an honest "the report doesn't say
// why" - never the latest value in its place (the live smoke test asked "Why
// is creatinine in different units?" and heard the creatinine result).
// Every answer keeps three things apart, in this order:
//   1. what the reports state          (cited rows and notes, verbatim numbers)
//   2. general background               (vetted glossary text with its source URL,
//                                        labelled as general, never about the person)
//   3. what cannot be concluded         (no unit conversion, no cause, no diagnosis)
import { seriesFor, subjectOf } from "./observations.mjs";
import {
  GLOSSARY,
  SOURCES,
  canonOf,
  nameOf,
  rangeOf,
  sayDate,
  span,
  valueText,
  position,
} from "./explain.mjs";
import { findTest, subjectsFor, subjectLabel } from "./answer.mjs";

const UNITS_RE =
  /\b(units?|mg\/dl|umol|µmol|mmol|si units?|measur\w* in)\b|यूनिट|इकाई|unit/i;
const CORRECTED_RE =
  /\b(correct\w*|amend\w*|revis\w*|wrong|mistake|error|chang\w*|sudhar\w*|sudhaar\w*|galat|badl\w*)\b|सुधार|गलत|ग़लत|संशोधित|बदल/i;
const FLAG_RE =
  /\b(low|high|flag\w*|mark\w*|abnormal|out of range|outside|below|above|kam|zyada|jyada|bahar)\b|\b(?:marked|flagged|shows?)\s+[LH]\b|कम|ज़्यादा|ज्यादा|बाहर/i;

// General background, paraphrased from the cited page; general information only.
export const UNIT_BACKGROUND = {
  source: "https://medlineplus.gov/ency/article/003475.htm",
  en: "Labs can report the same test in different units: conventional units such as mg/dL, or international (SI) units such as µmol/L. A change of unit comes from how the lab reports the result, and the two numbers can't be compared directly without a validated conversion.",
  hi: "लैब एक ही जांच को अलग-अलग यूनिट में दे सकती हैं: पारंपरिक यूनिट जैसे mg/dL, या अंतरराष्ट्रीय (SI) यूनिट जैसे µmol/L. यूनिट का बदलना लैब के नतीजा लिखने के तरीके से होता है, और दोनों संख्याओं की सीधे तुलना नहीं की जा सकती।",
  hinglish:
    "Lab ek hi test ko alag units mein de sakti hai: conventional units jaise mg/dL, ya international (SI) units jaise µmol/L. Unit badalna lab ke result likhne ke tareeke se hota hai, aur dono numbers ki seedhe tulna nahi ho sakti.",
};

const SAY = {
  en: {
    unitsDoc: (name, rows) =>
      `The reports print ${name} in two different units: ${rows.join("; ")}.`,
    unitsNoReason: `The reports don't say why the unit changed.`,
    unitsCannot: (name) =>
      `So I won't say whether ${name} went up or down: I don't convert between units. Your doctor or the lab can compare them properly.`,
    unitsSame: (name, unit) =>
      `Every ${name} result in these reports is printed in ${unit}, so the unit didn't change.`,
    correctedDoc: (date, from, to, unit) =>
      `The ${date} ${unit} result was first printed as ${from} and later corrected to ${to}.`,
    correctedReason: (note) => `The amended report gives the reason: “${note}”`,
    correctedNoReason: `The reports record the correction but don't say why it was made.`,
    correctedUse: `I use the corrected value.`,
    noCorrection: (name) =>
      `None of these reports corrects a ${name} result, so there is no correction to explain.`,
    flagDoc: (o, date, r, dir) =>
      `${nameOf(o)} is ${valueText(o, "en")} on ${date}, which is ${dir} this lab's printed range of ${span(r, "en")}${o.flag ? `, so the report marks it ${o.flag}` : ""}.`,
    flagWithin: (o, date, r) =>
      `${nameOf(o)} is ${valueText(o, "en")} on ${date}, inside this lab's printed range of ${span(r, "en")}; the report doesn't flag it.`,
    flagCannot: `The report doesn't say what caused it; a lab report shows results, not causes. Your doctor can interpret it with your history.`,
    dir: { below: "below", above: "above" },
    generic: (name) =>
      `These reports don't record a reason for that${name ? ` about ${name}` : ""}. I can tell you what they state, but not why.`,
    background: (t) => `General background: ${t}`,
    termIs: (t) => `${t}`,
    termHere1: (name, who, val, date) =>
      `In these reports, ${who}'s latest ${name} is ${val}, from ${date}.`,
    termHereMany: (name, ids) =>
      `These reports have ${name} results for ${ids.join(" and ")}; name one and I'll read that value.`,
    termNotHere: (name) => `There is no ${name} result in these reports.`,
  },
  hi: {
    unitsDoc: (name, rows) =>
      `रिपोर्ट्स में ${name} दो अलग यूनिट में छपा है: ${rows.join("; ")}।`,
    unitsNoReason: `रिपोर्ट्स में यह नहीं लिखा कि यूनिट क्यों बदली।`,
    unitsCannot: (name) =>
      `इसलिए मैं नहीं कहूंगी कि ${name} बढ़ा या घटा: मैं यूनिट नहीं बदलती। आपके डॉक्टर या लैब इनकी सही तुलना कर सकते हैं।`,
    unitsSame: (name, unit) =>
      `इन रिपोर्ट्स में ${name} का हर नतीजा ${unit} में छपा है, यानी यूनिट नहीं बदली।`,
    correctedDoc: (date, from, to) =>
      `${date} का नतीजा पहले ${from} छपा था और बाद में सुधारकर ${to} किया गया।`,
    correctedReason: (note) => `संशोधित रिपोर्ट में कारण लिखा है: “${note}”`,
    correctedNoReason: `रिपोर्ट्स में सुधार दर्ज है, पर उसका कारण नहीं लिखा।`,
    correctedUse: `मैं सुधरा हुआ नतीजा इस्तेमाल करती हूं।`,
    noCorrection: (name) =>
      `इनमें से किसी रिपोर्ट में ${name} का नतीजा सुधारा नहीं गया है।`,
    flagDoc: (o, date, r, dir) =>
      `${date} को ${nameOf(o)} ${valueText(o, "hi")} है, जो इस लैब की छपी सीमा (${span(r, "hi")}) से ${dir} है${o.flag ? `, इसलिए रिपोर्ट ने इसे ${o.flag} लिखा है` : ""}।`,
    flagWithin: (o, date, r) =>
      `${date} को ${nameOf(o)} ${valueText(o, "hi")} है, जो लैब की सीमा (${span(r, "hi")}) के अंदर है; रिपोर्ट ने इसे फ़्लैग नहीं किया।`,
    flagCannot: `रिपोर्ट यह नहीं बताती कि ऐसा क्यों हुआ; लैब रिपोर्ट नतीजे बताती है, कारण नहीं। आपके डॉक्टर इसे आपकी हिस्ट्री के साथ समझा सकते हैं।`,
    dir: { below: "कम", above: "ज़्यादा" },
    generic: () =>
      `इन रिपोर्ट्स में इसका कारण दर्ज नहीं है। मैं बता सकती हूं कि इनमें क्या लिखा है, पर क्यों, यह नहीं।`,
    background: (t) => `सामान्य जानकारी: ${t}`,
    termIs: (t) => t,
    termHere1: (name, who, val, date) =>
      `इन रिपोर्ट्स में ${who} का सबसे नया ${name} ${val} है, ${date} का।`,
    termHereMany: (name, ids) =>
      `इन रिपोर्ट्स में ${ids.join(" और ")} के ${name} नतीजे हैं; किसी एक का नाम लें तो मैं वह नतीजा पढ़ दूं।`,
    termNotHere: (name) => `इन रिपोर्ट्स में ${name} का कोई नतीजा नहीं है।`,
  },
  hinglish: {
    unitsDoc: (name, rows) =>
      `Reports mein ${name} do alag units mein chhapa hai: ${rows.join("; ")}.`,
    unitsNoReason: `Reports mein yeh nahi likha ki unit kyun badli.`,
    unitsCannot: (name) =>
      `Isliye main nahi kahungi ki ${name} badha ya ghata: main units convert nahi karti. Aapke doctor ya lab inki sahi tulna kar sakte hain.`,
    unitsSame: (name, unit) =>
      `In reports mein ${name} ka har result ${unit} mein chhapa hai, yaani unit nahi badli.`,
    correctedDoc: (date, from, to) =>
      `${date} ka result pehle ${from} chhapa tha aur baad mein sudhaar kar ${to} kiya gaya.`,
    correctedReason: (note) =>
      `Amended report mein kaaran likha hai: “${note}”`,
    correctedNoReason: `Reports mein correction darj hai, par uska kaaran nahi likha.`,
    correctedUse: `Main sudhra hua result use karti hoon.`,
    noCorrection: (name) =>
      `In mein se kisi report mein ${name} ka result sudhaara nahi gaya hai.`,
    flagDoc: (o, date, r, dir) =>
      `${date} ko ${nameOf(o)} ${valueText(o, "hinglish")} hai, jo is lab ki chhapi range (${span(r, "hinglish")}) se ${dir} hai${o.flag ? `, isliye report ne ise ${o.flag} likha hai` : ""}.`,
    flagWithin: (o, date, r) =>
      `${date} ko ${nameOf(o)} ${valueText(o, "hinglish")} hai, jo lab ki range (${span(r, "hinglish")}) ke andar hai; report ne ise flag nahi kiya.`,
    flagCannot: `Report yeh nahi batati ki aisa kyun hua; lab report results batati hai, kaaran nahi. Aapke doctor ise aapki history ke saath samjha sakte hain.`,
    dir: { below: "kam", above: "zyada" },
    generic: () =>
      `In reports mein iska kaaran darj nahi hai. Main bata sakti hoon ki inmein kya likha hai, par kyun, yeh nahi.`,
    background: (t) => `General jaankari: ${t}`,
    termIs: (t) => t,
    termHere1: (name, who, val, date) =>
      `In reports mein ${who} ka sabse naya ${name} ${val} hai, ${date} ka.`,
    termHereMany: (name, ids) =>
      `In reports mein ${ids.join(" aur ")} ke ${name} results hain; kisi ek ka naam lein to main woh result padh doon.`,
    termNotHere: (name) => `In reports mein ${name} ka koi result nahi hai.`,
  },
};

/** The subject a question is about, or null + the candidates when ambiguous. */
function oneSubject(question, reports, key) {
  const withTest = reports.filter((r) =>
    r.observations.some((o) => o.key === key),
  );
  const ids = subjectsFor(question, withTest);
  return { ids, withTest };
}

/** The amendment note line for an amended report, located in its source. */
function amendmentNote(report, bundle, needle) {
  const src = bundle?.sources?.find((s) => s.id === report.sourceId);
  if (!src) return null;
  // Read the lines from the source itself (the header reader flattens the
  // first block, so meta.amendmentNotes can miss a note printed there).
  const notes = src.text
    .split("\n")
    .map((l) => l.trim())
    .filter(
      (l) =>
        /\b(amended|corrected|correction|revised)\b/i.test(l) &&
        !/report status/i.test(l) &&
        !/^\|/.test(l),
    );
  const n =
    notes.find((x) => needle.test(x)) ??
    notes.find((x) => /\bcorrect|amend/i.test(x));
  if (!n) return null;
  const start = src.text.indexOf(n);
  if (start < 0) return null;
  return {
    text: n,
    evidence: {
      sourceId: src.id,
      title: src.title,
      hash: src.hash,
      start,
      end: start + n.length,
      quote: src.text.slice(start, start + n.length),
    },
  };
}
const reasonOf = (note) =>
  /\(([^)]{3,80})\)|\bdue to ([^.;]{3,80})|\bbecause ([^.;]{3,80})/i.exec(note);

/**
 * @returns {null | {spoken, verdict, field:null, intent:"WHY", lang, used, extra, parts}}
 *  parts = {stated: string[], background: {text, source}|null, cannot: string|null}
 */
export function clinicalWhy(question, reports, lang, bundle = null) {
  if (!reports?.length) return null;
  const t = SAY[lang] ?? SAY.en;
  const hit = findTest(question, reports);
  const base = { field: null, intent: "WHY", lang };
  const done = (parts, used, extra = [], verdict = "EXPLAINED") => ({
    ...base,
    verdict,
    used,
    extra,
    parts,
    spoken: [
      ...parts.stated,
      parts.background ? t.background(parts.background.text) : null,
      parts.cannot,
    ]
      .filter(Boolean)
      .join(" "),
  });
  if (!hit)
    return UNITS_RE.test(question) || CORRECTED_RE.test(question)
      ? null // a reason about something the reader couldn't place: leave it to search
      : null;
  const { ids, withTest } = oneSubject(question, reports, hit.key);
  const name = nameOf(hit);
  if (ids.length !== 1) {
    // Units can be explained for everyone at once only if it's the same story.
    if (!ids.length) return null;
    return {
      ...base,
      verdict: "AMBIGUOUS_PATIENT",
      used: [],
      extra: [],
      parts: null,
      spoken: {
        en: `These reports have ${name} results for more than one person (${ids.map((i) => subjectLabel(i, reports)).join(", ")}). Whose results should I look at?`,
        hi: `इन रिपोर्ट्स में एक से ज़्यादा लोगों के ${name} नतीजे हैं (${ids.map((i) => subjectLabel(i, reports)).join(", ")})। मैं किसके नतीजे देखूं?`,
        hinglish: `In reports mein ek se zyada logon ke ${name} results hain (${ids.map((i) => subjectLabel(i, reports)).join(", ")}). Main kiske results dekhoon?`,
      }[lang],
    };
  }
  const series = seriesFor(withTest, hit.key, ids[0]);
  if (!series.length) return null;

  if (UNITS_RE.test(question)) {
    const units = [...new Set(series.map((s) => s.current.unit ?? "?"))];
    const used = series.map((s) => s.current);
    if (units.length < 2)
      return done(
        {
          stated: [t.unitsSame(name, units[0])],
          background: null,
          cannot: null,
        },
        used,
      );
    const rows = series.map(
      (s) => `${sayDate(s.date, lang)}: ${valueText(s.current, lang)}`,
    );
    return done(
      {
        stated: [t.unitsDoc(name, rows), t.unitsNoReason],
        background: {
          text: UNIT_BACKGROUND[lang] ?? UNIT_BACKGROUND.en,
          source: UNIT_BACKGROUND.source,
        },
        cannot: t.unitsCannot(name),
      },
      used,
    );
  }

  if (CORRECTED_RE.test(question)) {
    const fixed = [...series].reverse().find((s) => s.superseded.length);
    // "why did it change?" with no correction on record: a change between
    // visits has no recorded reason either.
    if (
      !fixed &&
      !/correct|amend|revis|wrong|mistake|error|sudh|galat|सुधार|गलत|ग़लत/i.test(
        question,
      )
    )
      return done(
        { stated: [t.generic(name)], background: null, cannot: null },
        [],
        [],
        "NO_REASON",
      );
    if (!fixed)
      return done(
        { stated: [t.noCorrection(name)], background: null, cannot: null },
        [series[series.length - 1].current],
        [],
        "NO_REASON",
      );
    const from = fixed.superseded[0];
    const to = fixed.current;
    const note = amendmentNote(
      to.report,
      bundle,
      new RegExp(String(hit.test).split(/\s+/)[0], "i"),
    );
    const reason = note ? reasonOf(note.text) : null;
    const stated = [
      t.correctedDoc(sayDate(fixed.date, lang), from.raw, to.raw, name),
      note && reason ? t.correctedReason(note.text) : t.correctedNoReason,
      t.correctedUse,
    ];
    return done(
      { stated, background: null, cannot: null },
      [to, from],
      note ? [note.evidence] : [],
      note && reason ? "EXPLAINED" : "NO_REASON",
    );
  }

  if (FLAG_RE.test(question)) {
    const o = series[series.length - 1].current;
    const r = rangeOf(o);
    const pos = position(o);
    if (!r || pos === "unknown") return null;
    const date = sayDate(series[series.length - 1].date, lang);
    const stated = /^below/.test(pos)
      ? [t.flagDoc(o, date, r, t.dir.below)]
      : /^above/.test(pos)
        ? [t.flagDoc(o, date, r, t.dir.above)]
        : [t.flagWithin(o, date, r)];
    return done(
      {
        stated,
        background: null,
        cannot: pos === "within" ? null : t.flagCannot,
      },
      [o],
    );
  }

  return done(
    { stated: [t.generic(name)], background: null, cannot: null },
    [],
    [],
    "NO_REASON",
  );
}

/**
 * "What is ferritin?" -> the vetted definition, then where it appears in
 * these reports. Null when there is no vetted entry (the router may then use
 * grounded search for the general part).
 */
export function clinicalTerm(term, question, reports, lang) {
  const key = canonOf(term);
  const g = key ? GLOSSARY[key] : null;
  if (!g) return null;
  const t = SAY[lang] ?? SAY.en;
  const parts = {
    stated: [],
    background: { text: g[lang] ?? g.en, source: SOURCES[key] ?? null },
    cannot: null,
  };
  const used = [];
  const withTest = (reports ?? []).filter((r) =>
    r.observations.some((o) => o.canon === key || o.key === key),
  );
  const name =
    term.length <= 5 ? term.toUpperCase().replace("HBA1C", "HbA1c") : term;
  if (withTest.length) {
    const ids = [...new Set(withTest.map(subjectOf))];
    if (ids.length === 1) {
      const okey = withTest[0].observations.find(
        (o) => o.canon === key || o.key === key,
      ).key;
      const series = seriesFor(withTest, okey, ids[0]);
      const last = series[series.length - 1];
      if (last) {
        parts.stated.push(
          t.termHere1(
            nameOf(last.current),
            subjectLabel(ids[0], reports),
            valueText(last.current, lang),
            sayDate(last.date, lang),
          ),
        );
        used.push(last.current);
      }
    } else
      parts.stated.push(
        t.termHereMany(
          name,
          ids.map((i) => subjectLabel(i, reports)),
        ),
      );
  } else if (reports?.length) parts.stated.push(t.termNotHere(name));
  return {
    field: null,
    intent: "TERM",
    lang,
    verdict: "DEFINED",
    used,
    extra: [],
    parts,
    // General meaning first (that is what was asked), then the record.
    spoken: [t.background(parts.background.text), ...parts.stated].join(" "),
  };
}
