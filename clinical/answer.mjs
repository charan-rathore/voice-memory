// Spoken and on-screen answers about lab results across reports.
// Safety decisions (units, patients, amendments, bounds) are made here and in
// observations.mjs; every sentence is rendered by explain.mjs in the language
// the question was asked in, in plain, supportive words. No diagnosis.
import {
  seriesFor,
  compare,
  testKey,
  subjectOf,
  markIdentityConflicts,
  MONTHS,
  packetSegments,
  extractSegment,
} from "./observations.mjs";
import {
  detectLang,
  explainOne,
  explainChange,
  PHRASES,
  aliasesFor,
  sayDate,
  words,
  nameOf,
  position,
  rangeOf,
  span,
  GLOSSARY,
  CRITICAL_FLAG,
  valueText,
  aboutSomeoneElse,
  thirdPerson,
} from "./explain.mjs";
import { GROUPS } from "./glossary-more.mjs";

const CHANGE_RE =
  /\b(chang\w*|increas\w*|decreas\w*|went (up|down)|go(ne)? (up|down)|higher|lower|ris(e|en)|rose|f[ae]ll|fallen|drop\w*|compar\w*|trend\w*|since|previous|last time|before|improv\w*|wors\w*|better|badl\w*|badh\w*|ghat\w*|pichhl\w*|pehle|tulna)\b|बदल|बढ़|घट|पिछल|पहले|तुलना/i;

// "Before the correction", "was it amended", "the original value": a
// question about a corrected record, answered from the superseded and the
// correcting rows of the same collection date. Never from the previous
// report, which is a different measurement (that was September's 0.5 ng/mL
// being read out as the pre-correction ferritin).
const CORRECTION_RE =
  /\b(correct(ed|ion|ions)?|amend\w*|revis(ed|ion)|re-?issued|original(ly)?|initial(ly)?|prelim\w*|first reported|sudh?aar\w*|sudhar\w*)\b|सुधार|संशोधन|प्रारंभिक/i;
const PRIOR_RE =
  /\b(before|prior|original(ly)?|initial(ly)?|first|prelim\w*|old|earlier|pehle|pahle)\b|पहले/i;
// A bare "before" with no other comparison word: after a corrected result it
// can mean either the pre-correction value or the previous report, so both
// are named, each with its own row, instead of guessing one.
// "What was the first / earliest ferritin?" asks for the earliest
// measurement in these reports, which is a different row from the value a
// correction replaced ("first reported as" stays a correction question).
const EARLIEST_RE =
  /\b(earliest|oldest|very first|first (?:\w+ )?(?:result|test|reading|measurement|report|value|level|check)|sabse pehl[aei]|pehl[ai] (?:baar|report|jaanch|test))\b|सबसे पहल|पहली (?:बार|रिपोर्ट|जांच)/i;
// A unit the caller names ("in mmol", "convert it to micromoles"): the
// engine never converts, and a value is never read out under a unit the lab
// did not print for it.
const UNIT_WORDS = [
  [/\bmmol(?:\/l| per l(?:it(?:re|er))?)?\b|\bmillimol\w*/i, "mmol/L"],
  [/\b(?:µ|u|micro ?)mol\w*(?:\/l| per l(?:it(?:re|er))?)?/i, "µmol/L"],
  [/\bmg\/?dl\b|\bmilligrams?(?: per decilit(?:re|er))?\b/i, "mg/dL"],
  [/\bng\/?ml\b|\bnanograms?(?: per millilit(?:re|er))?\b/i, "ng/mL"],
  [/\bg\/?dl\b|\bgrams? per decilit(?:re|er)\b/i, "g/dL"],
  [/\bmilli ?(?:international )?units?\b|\bmiu\/?l\b/i, "mIU/L"],
  [/\bmicro ?(?:international )?units?\b|\b(?:µ|u)iu\/?ml\b/i, "µIU/mL"],
];
// "convert", "mmol mein badlo", "mmol में बदलो"; never "बदला क्या?"
// ("has it changed?"), which is a change question.
const CONVERT_RE =
  /\bconver(?:t|sion)\w*\b|\b(?:mein|me|main) badal\w*|में बदल/i;
const UNIT_SAY = {
  en: (test, units, asked, o, date) =>
    [
      "I don't convert lab units.",
      asked ? `These reports don't give ${test} in ${asked}.` : "",
      units.length > 1 ? `They use ${units.join(" and ")}.` : "",
      `The ${date} result is ${valueText(o, "en")}, as the lab printed it.`,
    ]
      .filter(Boolean)
      .join(" "),
  hi: (test, units, asked, o, date) =>
    `मैं लैब की यूनिट नहीं बदलती। ${asked ? `इन रिपोर्ट्स में ${test} ${asked} में नहीं दिया गया है। ` : ""}${date} का नतीजा ${valueText(o, "hi")} है, जैसा लैब ने छापा है।`,
  hinglish: (test, units, asked, o, date) =>
    `Main lab ki units convert nahi karti. ${asked ? `In reports mein ${test} ${asked} mein nahi diya gaya hai. ` : ""}${date} ka result ${valueText(o, "hinglish")} hai, jaisa lab ne print kiya hai.`,
};
// "When was this test done?" asks for the report's dates, not a value.
export const DATE_ASK_RE =
  /\b(when|what date|which date|kab)\b.{0,40}\b(done|taken|collected|drawn|tested|reported|released|test|sample|report|blood)\b|\bdate of (?:the |this )?(?:test|report|sample|collection)\b|(?:जांच|टेस्ट|सैंपल|रिपोर्ट).{0,20}कब|कब.{0,20}(?:जांच|टेस्ट|सैंपल|रिपोर्ट)/i;
const YES_NO_RE =
  /^\s*(was|is|were|did|does|has|have|had|kya)\b|^\s*क्या|\bkya\s*$|क्या\s*[?।]?\s*$/i;
const BARE_BEFORE_RE = /\b(before|pehle|pahle)\b|पहले/i;
const OTHER_CHANGE_RE =
  /\b(chang\w*|increas\w*|decreas\w*|went|gone|go (up|down)|higher|lower|ris(e|en)|rose|f[ae]ll\w*|drop\w*|compar\w*|trend\w*|since|improv\w*|wors\w*|better|badl\w*|badh\w*|ghat\w*|tulna)\b|बदल|बढ़|घट|तुलना/i;

const norm = (s) =>
  ` ${String(s)
    .toLowerCase()
    .replace(/[^a-z0-9\u0900-\u097f]+/g, " ")
    .trim()} `;

// Short aliases ("na", "k", "cl") are ordinary words in speech and Hinglish;
// only these short ones are allowed to match a question.
const SHORT_OK = new Set(["hb", "t3", "t4"]);
function editDistance(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      best = Math.min(best, cur[j]);
    }
    if (best > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}
/** Does the question contain this phrase (as words, in order)? Misspellings of long words count. */
function phraseIn(qw, phrase) {
  const pw = words(phrase);
  if (!pw.length) return false;
  if (pw.length === 1 && pw[0].length <= 2 && !SHORT_OK.has(pw[0]))
    return false;
  for (let i = 0; i + pw.length <= qw.length; i++) {
    let ok = true;
    for (let k = 0; k < pw.length && ok; k++) {
      const a = qw[i + k],
        b = pw[k];
      if (a === b) continue;
      const tol = b.length >= 9 ? 2 : b.length >= 6 ? 1 : 0;
      ok = tol > 0 && /^[a-z]+$/.test(b) && editDistance(a, b, tol) <= tol;
    }
    if (ok) return true;
  }
  return false;
}

/**
 * Find the test(s) the question is about. A printed name beats an alias; an
 * alias that several printed tests share ("dengue": NS1, IgM, IgG) returns
 * all of them, so the answer covers the group.
 * @returns {null | {key, test, keys: string[], score}}
 */
export function findTest(question, reports) {
  const q = norm(question);
  const qw = words(question);
  const hits = [];
  // a named ratio, category or index is its own row: "BUN creatinine
  // ratio" must not answer with Creatinine
  const qualifier = /\b(ratio|category|index|percentage|absolute)\b/i.exec(
    question,
  )?.[1];
  for (const r of reports)
    for (const o of r.observations) {
      const n = norm(o.test).trim();
      if (n.length >= 2 && q.includes(` ${n} `)) {
        hits.push({ o, score: 1000 + n.length });
        continue;
      }
      let best = 0;
      for (const a of [...aliasesFor(o.key), ...aliasesFor(o.canon)]) {
        const an = norm(a).trim();
        if (an.length < 2) continue;
        if (q.includes(` ${an} `) || phraseIn(qw, a)) {
          const sc = 100 + words(a).length * 10 + an.length;
          if (sc > best) best = sc;
        }
      }
      if (best) hits.push({ o, score: best });
    }
  if (qualifier) {
    const kept = hits.filter((h) =>
      new RegExp(`\\b${qualifier}\\b`, "i").test(`${h.o.test} ${h.o.key}`),
    );
    hits.length = 0;
    hits.push(...kept);
  }
  if (!hits.length) return null;
  const top = Math.max(...hits.map((h) => h.score));
  const chosen = hits.filter((h) => h.score === top);
  const keys = [...new Set(chosen.map((h) => h.o.key))];
  return { key: keys[0], test: chosen[0].o.test, keys, score: top };
}

/** Name a subject for a question back to the user. */
export function subjectLabel(id, reports) {
  const r = reports.find((x) => subjectOf(x) === id);
  // an unlinked report is named by what it prints, plus its file, so two
  // "John Smith" reports read as two choices, not one person twice
  if (id.startsWith("doc:")) {
    const n = r?.meta.patient?.name?.replace(/\s*\(synthetic\)/i, "");
    const t = r?.title ?? id.slice(4);
    return n ? `${n} (${t})` : t;
  }
  const name = r?.meta.patient?.name?.replace(/\s*\(synthetic\)/i, "");
  // Synthetic demo reports are known by their ID; real reports by the name printed on them.
  if (id.startsWith("name:")) return name ?? id.slice(5);
  return /^SYN-/.test(id) || !name ? id : name;
}
/** Subjects with this test, narrowed to the one the question names, if any. */
export function subjectsFor(question, reports) {
  let ids = [...new Set(reports.map(subjectOf))];
  const named = ids.filter((id) => {
    const r = reports.find((x) => subjectOf(x) === id);
    const name = (r.meta.patient?.name ?? "")
      .replace(/\s*\(synthetic\)/i, "")
      .toLowerCase();
    return (
      (!/^(doc|name):/.test(id) && question.toUpperCase().includes(id)) ||
      (name.length > 2 && question.toLowerCase().includes(name))
    );
  });
  if (named.length) ids = named;
  return ids;
}

/**
 * @returns {null | {spoken, verdict, field:null, intent, lang, direction?, used}}
 */

// A question can anchor a report by its date ("the September report", "3
// September 2026"). An anchored question must be answered from that report,
// never silently with the latest value: the anchor IS the question.
const MONTH_NAME = Object.keys(MONTHS)
  .sort((a, b) => b.length - a.length)
  .join("|");
const ANCHOR_ISO = /(\d{4})-(\d{2})-(\d{2})/;
const ANCHOR_DMY = new RegExp(
  `(?:^|[^\d])(\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${MONTH_NAME})\\s*,?\\s*(\\d{4})`,
  "i",
);
const ANCHOR_MDY = new RegExp(
  `(?<![\\p{L}])(${MONTH_NAME})\\s+(\\d{1,2})(?:st|nd|rd|th)?\\s*,?\\s*(\\d{4})`,
  "iu",
);
const ANCHOR_MY = new RegExp(
  `(?<![\\p{L}])(${MONTH_NAME})\\s*,?\\s*(\\d{4})(?![\\p{L}\\d])`,
  "iu",
);
const ANCHOR_M = new RegExp(`(?<![\\p{L}])(${MONTH_NAME})(?![\\p{L}])`, "iu");
// "may"/"march" (and the bare Hindi "मई"/"मार्च") are ordinary words; only
// with a day or year beside them do they anchor a report.
const BARE_MONTH_BLOCK = new Set(["may", "march", "मई", "मार्च"]);

function dateAnchor(question) {
  let m = ANCHOR_ISO.exec(question);
  if (m) return { y: +m[1], mo: +m[2], d: +m[3], said: m[0] };
  m = ANCHOR_DMY.exec(question);
  if (m)
    return { y: +m[3], mo: MONTHS[m[2].toLowerCase()], d: +m[1], said: m[0] };
  m = ANCHOR_MDY.exec(question);
  if (m)
    return { y: +m[3], mo: MONTHS[m[1].toLowerCase()], d: +m[2], said: m[0] };
  m = ANCHOR_MY.exec(question);
  if (m) return { y: +m[2], mo: MONTHS[m[1].toLowerCase()], said: m[0] };
  m = ANCHOR_M.exec(question);
  if (m && !BARE_MONTH_BLOCK.has(m[1].toLowerCase()))
    return { mo: MONTHS[m[1].toLowerCase()], said: m[0] };
  return null;
}

function anchorEntry(series, anchor) {
  const iso = series.filter((s) => /^\d{4}-\d{2}-\d{2}$/.test(s.date));
  if (anchor.d != null && anchor.y != null) {
    const want = `${anchor.y}-${String(anchor.mo).padStart(2, "0")}-${String(anchor.d).padStart(2, "0")}`;
    return iso.find((s) => s.date === want) ?? null;
  }
  const inMonth = iso.filter(
    (s) =>
      Number(s.date.slice(5, 7)) === anchor.mo &&
      (anchor.y == null || Number(s.date.slice(0, 4)) === anchor.y),
  );
  // a bare month names the most recent matching report
  return inMonth[inMonth.length - 1] ?? null;
}

function authorityConflictAnswer(used, lang = "en") {
  const spoken = {
    en: "These reports give conflicting values with equal report authority. I cannot identify a correction or choose a result from upload order. Please check the original reports with the lab.",
    hi: "इन रिपोर्ट्स में समान दर्जे के अलग नतीजे हैं। अपलोड के क्रम से मैं सुधार या सही नतीजा नहीं चुन सकती। कृपया लैब से मूल रिपोर्ट की जाँच करें।",
    hinglish:
      "In reports mein barabar authority ke alag results hain. Upload order se correction ya sahi result nahi chun sakti. Lab se original reports check kijiye.",
  }[lang];
  return {
    spoken,
    verdict: "NOT_COMPARABLE",
    field: null,
    intent: "LOOKUP",
    lang,
    used,
  };
}

export function clinicalTurn(question, reports) {
  if (!reports?.length) return null;
  const hit = findTest(question, reports);
  if (!hit) return null;
  if (hit.keys.length > 1) return groupAnswer(question, reports, hit.keys);
  const lang = detectLang(question);
  const t = PHRASES[lang];
  const withTest = reports.filter((r) =>
    r.observations.some((o) => o.key === hit.key),
  );
  const intent = CHANGE_RE.test(question) ? "COMPARE" : "LOOKUP";
  const base = { field: null, intent, lang, test: nameOf(hit) };
  // The question names a person whose reports don't have this test: say so.
  // Never fall back to someone else's value (that was SYN-0003's "ferritin"
  // being answered with SYN-0001's 50 ng/mL).
  const namedAll = subjectsFor(question, reports).filter(
    (id) => !/^(doc|name):/.test(id) || reports.length > 1,
  );
  const allIds = new Set(reports.map(subjectOf));
  if (namedAll.length && namedAll.length < allIds.size) {
    const haveIt = new Set(withTest.map(subjectOf));
    const missing = namedAll.filter((id) => !haveIt.has(id));
    if (missing.length === namedAll.length) {
      const who = missing.map((id) => subjectLabel(id, reports)).join(", ");
      const test = nameOf(hit);
      return {
        ...base,
        spoken: {
          en: `${who}'s reports don't include a ${test} result.`,
          hi: `${who} की रिपोर्ट्स में ${test} का कोई नतीजा नहीं है।`,
          hinglish: `${who} ki reports mein ${test} ka koi result nahi hai.`,
        }[lang],
        verdict: "NOT_IN_REPORT",
        used: [],
      };
    }
  }
  const patients = subjectsFor(question, withTest);
  if (patients.length > 1)
    return {
      ...base,
      spoken: t.which(
        nameOf(hit),
        patients.map((id) => subjectLabel(id, reports)),
      ),
      verdict: "AMBIGUOUS_PATIENT",
      used: [],
    };
  // Anonymous documents (no patient id or name anywhere) are never
  // attributed to the caller when other, also-unidentified documents are in
  // play: "your result" would assert an identity the records do not show.
  if (
    !patients.length ||
    (patients.length === 1 &&
      /^doc:/.test(patients[0]) &&
      reports.length > 1 &&
      new Set(reports.map(subjectOf)).size > 1)
  )
    return {
      ...base,
      spoken: t.unknownPatient,
      verdict: "NOT_COMPARABLE",
      used: [],
    };
  const series = seriesFor(withTest, hit.key, patients[0]);
  if (!series.length) return null;
  const uncertain = series.flatMap((entry) => entry.conflicts ?? []);
  if (uncertain.length) return authorityConflictAnswer(uncertain, lang);
  const latest = series[series.length - 1];
  const amended = latest.superseded.length
    ? { from: latest.superseded[0].raw, to: latest.current.raw }
    : null;

  // unit asks first: never read a value under a unit the lab did not print
  const askedUnit = UNIT_WORDS.find(([re]) => re.test(question))?.[1] ?? null;
  const units = [...new Set(series.map((x) => x.current.unit).filter(Boolean))];
  const anchorU =
    askedUnit || CONVERT_RE.test(question) ? dateAnchor(question) : null;
  const entryU = anchorU ? anchorEntry(series, anchorU) : latest;
  if (
    CONVERT_RE.test(question) ||
    (askedUnit && (!entryU || entryU.current.unit !== askedUnit))
  ) {
    if (!entryU)
      return {
        ...base,
        spoken: t.notInPeriod(nameOf(hit), anchorU.said),
        verdict: "NOT_IN_REPORT",
        used: [],
      };
    return {
      ...base,
      intent: "UNITS",
      spoken: (UNIT_SAY[lang] ?? UNIT_SAY.en)(
        nameOf(hit),
        units,
        askedUnit && !units.includes(askedUnit) ? askedUnit : null,
        entryU.current,
        sayDate(entryU.date, lang),
      ),
      verdict: "NOT_COMPARABLE",
      used: [entryU.current],
    };
  }
  const correctionAsk =
    CORRECTION_RE.test(question) &&
    !(
      EARLIEST_RE.test(question) &&
      !/first reported|correct|amend|sudh|सुधार/i.test(question)
    );
  if (!correctionAsk && EARLIEST_RE.test(question) && !dateAnchor(question)) {
    const first = series[0];
    const say = EARLIEST_SAY[lang] ?? EARLIEST_SAY.en;
    let spoken = say(nameOf(hit), first.current, sayDate(first.date, lang));
    if (first.superseded.length)
      spoken +=
        " " +
        t.amended(
          sayDate(first.date, lang),
          first.superseded[0].raw,
          first.current.raw,
        );
    return {
      ...base,
      intent: "EARLIEST",
      spoken,
      verdict: "VALUE",
      used: [first.current, ...first.superseded],
    };
  }
  const bareBefore =
    !correctionAsk &&
    BARE_BEFORE_RE.test(question) &&
    !OTHER_CHANGE_RE.test(question) &&
    !dateAnchor(question) &&
    latest.superseded.length > 0;
  if (correctionAsk || bareBefore)
    return correctionTurn(question, series, hit, base, lang, {
      bareBefore,
      prior: bareBefore || PRIOR_RE.test(question),
    });

  if (intent === "LOOKUP" || series.length === 1) {
    const anchor = intent === "LOOKUP" ? dateAnchor(question) : null;
    if (anchor) {
      const entry = anchorEntry(series, anchor);
      if (!entry)
        return {
          ...base,
          spoken: t.notInPeriod(nameOf(hit), anchor.said),
          verdict: "NOT_IN_REPORT",
          used: [],
        };
      const o = entry.current;
      let spoken = explainOne(o, entry.date, lang);
      if (entry.superseded.length)
        spoken +=
          " " +
          t.amended(
            sayDate(entry.date, lang),
            entry.superseded[0].raw,
            entry.current.raw,
          );
      return {
        ...base,
        spoken,
        verdict: o.unreadable ? "UNCLEAR" : "VALUE",
        used: [o, ...entry.superseded],
      };
    }
    const o = latest.current;
    const single = series.length === 1 && intent === "COMPARE";
    let spoken =
      (single ? t.single(o) + " " : "") + explainOne(o, latest.date, lang);
    if (amended)
      spoken +=
        " " + t.amended(sayDate(latest.date, lang), amended.from, amended.to);
    return {
      ...base,
      spoken,
      verdict: o.unreadable ? "UNCLEAR" : single ? "SINGLE" : "LATEST",
      used: [o, ...latest.superseded],
    };
  }

  const prevS = series[series.length - 2];
  const iso = (d) => /^\d{4}-\d{2}-\d{2}$/.test(d);
  if (!iso(prevS.date) || !iso(latest.date))
    return {
      ...base,
      spoken: t.undated(latest.current),
      verdict: "NOT_COMPARABLE",
      used: [latest.current, prevS.current],
    };
  const a = prevS.current;
  const b = latest.current;
  const c = compare(a, b);
  const used = [b, a, ...latest.superseded, ...prevS.superseded];
  if (!c.comparable) {
    const spoken =
      c.reason === "unit"
        ? t.noConvert(
            b,
            a,
            b,
            sayDate(prevS.date, lang),
            sayDate(latest.date, lang),
          )
        : t.unknown();
    // Missing unit, text result or unidentified test: never guess a comparison.
    return { ...base, spoken, verdict: "NOT_COMPARABLE", used };
  }
  return {
    ...base,
    spoken: explainChange(
      a,
      b,
      prevS.date,
      latest.date,
      c.direction,
      lang,
      amended,
    ),
    verdict: "COMPARED",
    direction: c.direction,
    used,
  };
}

const STATUS_WORD = {
  en: {
    preliminary: "preliminary",
    amended: "amended",
    corrected: "corrected",
    final: "final",
  },
  hi: {
    preliminary: "प्रारंभिक",
    amended: "संशोधित",
    corrected: "सुधारी गई",
    final: "अंतिम",
  },
  hinglish: {
    preliminary: "preliminary",
    amended: "amended",
    corrected: "corrected",
    final: "final",
  },
};
const CORRECTION_SAY = {
  en: {
    report: (o) => {
      const st = STATUS_WORD.en[o.report.meta.status];
      const on = /^\d{4}-\d{2}-\d{2}$/.test(o.report.meta.reported ?? "")
        ? ` of ${sayDate(o.report.meta.reported, "en")}`
        : "";
      return st ? `the ${st} report${on}` : `the report${on}`;
    },
    prior: (test, date, oldO, newO, r) =>
      `Before the correction, the ${date} ${test} result was ${valueText(oldO, "en")}, on ${r(oldO)}. ${cap(r(newO))} corrected it to ${valueText(newO, "en")}, and that is the value to use.`,
    yes: (test, date, oldO, newO, r) =>
      `Yes. The ${date} ${test} result was first reported as ${valueText(oldO, "en")} on ${r(oldO)}, then corrected to ${valueText(newO, "en")} on ${r(newO)}. ${valueText(newO, "en")} is the value to use.`,
    both: (test, date, oldO, newO, prevDate, prevO, r) =>
      `Two earlier values, depending on what you mean: before the correction, the ${date} ${test} result was ${valueText(oldO, "en")} on ${r(oldO)}; and on the earlier report, from ${prevDate}, it was ${valueText(prevO, "en")}. The current, corrected value is ${valueText(newO, "en")}.`,
    stated: (test, date, oldO, newO, r) =>
      `The ${date} ${test} result was corrected from ${valueText(oldO, "en")} on ${r(oldO)} to ${valueText(newO, "en")} on ${r(newO)}. ${valueText(newO, "en")} is the value to use.`,
    noneOn: (test, o, date) =>
      `The ${date} ${test} result was not corrected in these reports. It is ${valueText(o, "en")}.`,
    none: (test, latestO, date) =>
      `These reports show no correction to your ${test}. The latest result is ${valueText(latestO, "en")}, from ${date}.`,
  },
  hi: {
    report: (o) => {
      const st = STATUS_WORD.hi[o.report.meta.status];
      const on = /^\d{4}-\d{2}-\d{2}$/.test(o.report.meta.reported ?? "")
        ? `${sayDate(o.report.meta.reported, "hi")} की `
        : "";
      return `${on}${st ? st + " " : ""}रिपोर्ट`;
    },
    prior: (test, date, oldO, newO, r) =>
      `सुधार से पहले, ${date} की ${test} जांच का नतीजा ${valueText(oldO, "hi")} था (${r(oldO)})। ${r(newO)} में इसे सुधारकर ${valueText(newO, "hi")} किया गया, और वही नतीजा मान्य है।`,
    yes: (test, date, oldO, newO, r) =>
      `हां। ${date} की ${test} जांच पहले ${valueText(oldO, "hi")} बताई गई थी (${r(oldO)}), फिर ${r(newO)} में सुधारकर ${valueText(newO, "hi")} की गई। ${valueText(newO, "hi")} ही मान्य नतीजा है।`,
    both: (test, date, oldO, newO, prevDate, prevO, r) =>
      `आपके मतलब के हिसाब से दो पुराने नतीजे हैं: सुधार से पहले, ${date} का ${test} ${valueText(oldO, "hi")} था (${r(oldO)}); और ${prevDate} की पिछली रिपोर्ट में यह ${valueText(prevO, "hi")} था। अभी का, सुधरा हुआ नतीजा ${valueText(newO, "hi")} है।`,
    stated: (test, date, oldO, newO, r) =>
      `${date} की ${test} जांच ${valueText(oldO, "hi")} (${r(oldO)}) से सुधारकर ${valueText(newO, "hi")} (${r(newO)}) की गई। ${valueText(newO, "hi")} ही मान्य नतीजा है।`,
    noneOn: (test, o, date) =>
      `${date} की ${test} जांच में इन रिपोर्ट्स में कोई सुधार नहीं हुआ। नतीजा ${valueText(o, "hi")} है।`,
    none: (test, latestO, date) =>
      `इन रिपोर्ट्स में आपके ${test} में कोई सुधार नहीं दिखता। सबसे नया नतीजा ${valueText(latestO, "hi")} है, ${date} का।`,
  },
  hinglish: {
    report: (o) => {
      const st = STATUS_WORD.hinglish[o.report.meta.status];
      const on = /^\d{4}-\d{2}-\d{2}$/.test(o.report.meta.reported ?? "")
        ? `${sayDate(o.report.meta.reported, "hinglish")} ki `
        : "";
      return `${on}${st ? st + " " : ""}report`;
    },
    prior: (test, date, oldO, newO, r) =>
      `Correction se pehle, ${date} ka ${test} result ${valueText(oldO, "hinglish")} tha (${r(oldO)}). ${cap(r(newO))} mein isse sudhaar kar ${valueText(newO, "hinglish")} kiya gaya, aur wahi result maanya hai.`,
    yes: (test, date, oldO, newO, r) =>
      `Haan. ${date} ka ${test} result pehle ${valueText(oldO, "hinglish")} bataya gaya tha (${r(oldO)}), phir ${r(newO)} mein sudhaar kar ${valueText(newO, "hinglish")} kiya gaya. ${valueText(newO, "hinglish")} hi maanya result hai.`,
    both: (test, date, oldO, newO, prevDate, prevO, r) =>
      `Aapke matlab ke hisaab se do purane results hain: correction se pehle, ${date} ka ${test} ${valueText(oldO, "hinglish")} tha (${r(oldO)}); aur ${prevDate} ki pichhli report mein yeh ${valueText(prevO, "hinglish")} tha. Abhi ka, sudhra hua result ${valueText(newO, "hinglish")} hai.`,
    stated: (test, date, oldO, newO, r) =>
      `${date} ka ${test} result ${valueText(oldO, "hinglish")} (${r(oldO)}) se sudhaar kar ${valueText(newO, "hinglish")} (${r(newO)}) kiya gaya. ${valueText(newO, "hinglish")} hi maanya result hai.`,
    noneOn: (test, o, date) =>
      `${date} ke ${test} result mein in reports mein koi correction nahi hua. Result ${valueText(o, "hinglish")} hai.`,
    none: (test, latestO, date) =>
      `In reports mein aapke ${test} mein koi correction nahi dikhta. Sabse naya result ${valueText(latestO, "hinglish")} hai, ${date} ka.`,
  },
};
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const EARLIEST_SAY = {
  en: (test, o, date) =>
    `The earliest ${test} result in these reports is ${valueText(o, "en")}, from ${date}.`,
  hi: (test, o, date) =>
    `इन रिपोर्ट्स में ${test} का सबसे पहला नतीजा ${valueText(o, "hi")} है, ${date} का।`,
  hinglish: (test, o, date) =>
    `In reports mein ${test} ka sabse pehla result ${valueText(o, "hinglish")} hai, ${date} ka.`,
};

/**
 * A question about a corrected record. The corrected entry is the dated
 * entry the question anchors to, else the latest entry that has a
 * superseded row. Values, units and statuses come only from those rows.
 */
function correctionTurn(
  question,
  series,
  hit,
  base,
  lang,
  { bareBefore, prior },
) {
  const say = CORRECTION_SAY[lang] ?? CORRECTION_SAY.en;
  const test = nameOf(hit);
  const anchor = dateAnchor(question);
  const anchored = anchor ? anchorEntry(series, anchor) : null;
  // A date the reports do not have stays absent: never answer about the
  // correction on some other date instead.
  if (anchor && !anchored)
    return {
      ...base,
      intent: "CORRECTION",
      spoken: PHRASES[lang].notInPeriod(test, anchor.said),
      verdict: "NOT_IN_REPORT",
      used: [],
    };
  const entry =
    anchored ?? [...series].reverse().find((s) => s.superseded.length > 0);
  if (!entry || !entry.superseded.length) {
    const last = anchored ?? series[series.length - 1];
    return {
      ...base,
      intent: "CORRECTION",
      spoken: (anchored ? say.noneOn : say.none)(
        test,
        last.current,
        sayDate(last.date, lang),
      ),
      verdict: "VALUE",
      used: [last.current],
    };
  }
  const oldO = entry.superseded[0];
  const newO = entry.current;
  const date = sayDate(entry.date, lang);
  const idx = series.indexOf(entry);
  const prevEntry = idx > 0 ? series[idx - 1] : null;
  if (bareBefore && prevEntry) {
    return {
      ...base,
      intent: "CORRECTION",
      spoken: say.both(
        test,
        date,
        oldO,
        newO,
        sayDate(prevEntry.date, lang),
        prevEntry.current,
        say.report,
      ),
      verdict: "VALUE",
      used: [newO, oldO, prevEntry.current],
    };
  }
  return {
    ...base,
    intent: "CORRECTION",
    spoken: (prior
      ? say.prior
      : YES_NO_RE.test(question)
        ? say.yes
        : say.stated)(test, date, oldO, newO, say.report),
    verdict: "VALUE",
    used: [newO, oldO],
  };
}

/** Evidence object (engine shape) for an observation's source row. */
export function observationEvidence(o, bundle) {
  const src = bundle.sources.find((s) => s.id === o.report.sourceId);
  if (!src || typeof o.source.start !== "number") return null;
  const { start, end } = o.source;
  return {
    sourceId: src.id,
    title: src.title,
    hash: src.hash,
    start,
    end,
    quote: src.text.slice(start, end),
    firstLine: src.text.slice(0, start).split("\n").length,
    lastLine: src.text.slice(0, end).split("\n").length,
  };
}

/** Clinical reports for a bundle built from library entries (same order). */
export function clinicalReportsFor(bundle, entries, extract) {
  // identity is decided over the whole set, once (see subjectOf)
  return markIdentityConflicts(reportsOf(bundle, entries, extract));
}
function reportsOf(bundle, entries, extract) {
  return bundle.sources.flatMap((src, i) => {
    const e = entries[i];
    if (!e?.doc) return [];
    // A consolidated packet holds several records; each is read as a
    // report of its own (own patient, own date, own status) so an
    // amendment later in the same file supersedes the preliminary value,
    // exactly as it would across two files.
    if (e.clinical === undefined) {
      const parts = packetSegments(e.doc);
      e.clinical = parts
        ? {
            parts: parts.map((seg) => ({
              seg,
              ...extractSegment(e.doc, seg),
              haystack: ` ${words(e.doc.text.slice(seg.start, seg.end)).join(" ")} `,
            })),
          }
        : extract(e.doc);
    }
    e.haystack ??= ` ${words(e.doc.text ?? "").join(" ")} `;
    if (e.clinical.parts)
      return e.clinical.parts
        .filter((p) => p.observations.length)
        .map((p) => ({
          sourceId: src.id,
          title: `${src.title} · p.${p.seg.pages.length > 1 ? `${p.seg.pages[0]}-${p.seg.pages[p.seg.pages.length - 1]}` : p.seg.pages[0]}`,
          segment: p.seg.index,
          haystack: p.haystack,
          meta: p.meta,
          observations: p.observations,
        }));
    return e.clinical.observations.length
      ? [
          {
            sourceId: src.id,
            title: src.title,
            haystack: e.haystack,
            ...e.clinical,
          },
        ]
      : [];
  });
}

const OVERVIEW_RE =
  /\b(results?|reports?|post|tests?|labs?|blood|levels?|values?|numbers?|gone up|go up|went up|changed?|since|mean|means|meaning|explain|summary|summari[sz]e|overview|how am i|everything|critical|important|serious|concerning|abnormal|flagged|gambhir|zaroori|badl\w*|badal\w*)\b|रिपोर्ट|क्रिटिकल|ज़रूरी|जरूरी|गंभीर|सब\s+ठीक|बदल/i;

/**
 * A question about a patient's results as a whole ("what does SYN-0001's
 * result mean, has it gone up since September?"): one short summary built
 * from the same per-test comparisons, corrections first. Null when the
 * question names a test (clinicalTurn answers it) or is not about labs.
 */
export function clinicalOverview(question, reports) {
  if (!reports?.length || !OVERVIEW_RE.test(question)) return null;
  const ids = [...new Set(reports.map(subjectOf))];
  const upper = question.toUpperCase();
  const lang = detectLang(question);
  let pid = ids.find((id) => !/^(doc|name):/.test(id) && upper.includes(id));
  if (!pid) {
    // More than one person and the question names neither: never silently
    // pick one. Answer for each person separately, each under their own
    // label, so no value is ever attributed to the wrong person.
    if (ids.length > 1)
      return (
        eachSubject(question, reports, (q, own) => {
          const id = subjectOf(own[0]);
          const named = `${q} for ${id}`;
          return clinicalOverview(named, own) ?? oneReportNote(id, own, lang);
        }) ?? {
          spoken: SAY[lang].which(ids.map((id) => subjectLabel(id, reports))),
          verdict: "AMBIGUOUS_PATIENT",
          field: null,
          lang,
          used: [],
        }
      );
    const multi = ids.filter(
      (id) => reports.filter((r) => subjectOf(r) === id).length > 1,
    );
    if (!/\b(my|mine|patient|syn)\b/i.test(question) && !multi.length)
      return null;
    pid = ids[0];
  }
  const own = reports.filter((r) => subjectOf(r) === pid);
  const ch = changesFor(pid, own);
  if (
    !ch.corrected.length &&
    !ch.up.length &&
    !ch.down.length &&
    !ch.notComparable.length
  )
    return null;
  const O = OVERVIEW_SAY[lang] ?? OVERVIEW_SAY.en;
  const parts = [];
  if (ch.corrected.length) parts.push(O.corrected(ch.corrected));
  if (ch.up.length) parts.push(O.up(ch.up));
  if (ch.down.length) parts.push(O.down(ch.down));
  if (ch.same.length) parts.push(O.same(ch.same));
  if (ch.notComparable.length)
    parts.push(O.notComparable(ch.notComparable.map((x) => x.test)));
  return {
    spoken: O.head(subjectLabel(pid, reports)) + parts.join("; ") + O.tail,
    verdict: "OVERVIEW",
    field: null,
    intent: "COMPARE",
    lang,
    used: [...new Set(ch.used)],
  };
}

/**
 * Per test, the latest report against the one before, for one person:
 * which values were corrected (a fix to the report, not a change in the
 * body), which went up or down, and which cannot be compared. Built from
 * the same comparison the single-test answer gives, so the two never differ.
 */
export function changesFor(pid, own) {
  const tests = [];
  for (const r of own)
    for (const o of r.observations)
      if (!tests.some((t) => t.key === o.key)) tests.push(o);
  const out = {
    corrected: [],
    up: [],
    down: [],
    same: [],
    notComparable: [],
    used: [],
  };
  for (const o of tests) {
    const t = clinicalTurn(
      `Did ${o.test} change since the last report for ${pid}?`,
      own,
    );
    if (!t) continue;
    if (/corrected from/i.test(t.spoken)) {
      const m = /corrected from ([^ ]+) to ([^ ,.]+)/i.exec(t.spoken);
      out.corrected.push({
        test: o.test,
        from: m?.[1] ?? null,
        to: m?.[2] ?? null,
        unit: o.unit ?? null,
        used: t.used ?? [],
      });
      out.used.push(...(t.used ?? []));
    }
    if (t.verdict === "NOT_COMPARABLE") {
      out.notComparable.push({ test: o.test, used: t.used ?? [] });
      out.used.push(...(t.used ?? []));
    } else if (t.verdict === "COMPARED") {
      const d =
        t.direction ??
        (/higher/i.test(t.spoken)
          ? "higher"
          : /lower/i.test(t.spoken)
            ? "lower"
            : "same");
      (d === "higher" ? out.up : d === "lower" ? out.down : out.same).push(
        o.test,
      );
    }
  }
  return out;
}

const listOf = (a, and) =>
  a.length > 1 ? a.slice(0, -1).join(", ") + ` ${and} ` + a.at(-1) : a[0];
const OVERVIEW_SAY = {
  en: {
    head: (who) =>
      `For ${who}, comparing the latest report with the one before: `,
    corrected: (c) =>
      `${listOf(
        c.map((x) =>
          x.from
            ? `${x.test} was corrected from ${x.from} to ${x.to}`
            : `${x.test} was corrected`,
        ),
        "and",
      )}. That is a fix to the report, not a change in the body, and I use the corrected value`,
    up: (a) => `${listOf(a, "and")} went up`,
    down: (a) => `${listOf(a, "and")} went down`,
    same: (a) => `${listOf(a, "and")} stayed about the same`,
    notComparable: (a) =>
      `${listOf(a, "and")} can't be compared because the units changed`,
    tail: ". Ask about any one test for the numbers.",
    one: (who) =>
      `${who} has only one report here, so there is nothing to compare yet.`,
  },
  hi: {
    head: (who) => `${who} के लिए, ताज़ा रिपोर्ट की पिछली रिपोर्ट से तुलना: `,
    corrected: (c) =>
      `${listOf(
        c.map((x) =>
          x.from
            ? `${x.test} को ${x.from} से ${x.to} में सुधारा गया`
            : `${x.test} को सुधारा गया`,
        ),
        "और",
      )}। यह रिपोर्ट का सुधार है, शरीर में बदलाव नहीं, और मैं सुधरा हुआ मान लेती हूँ`,
    up: (a) => `${listOf(a, "और")} बढ़ा`,
    down: (a) => `${listOf(a, "और")} घटा`,
    same: (a) => `${listOf(a, "और")} लगभग वैसा ही रहा`,
    notComparable: (a) =>
      `${listOf(a, "और")} की तुलना नहीं हो सकती क्योंकि यूनिट बदल गई`,
    tail: "। संख्याओं के लिए किसी एक जांच के बारे में पूछिए।",
    one: (who) =>
      `${who} की यहाँ सिर्फ़ एक रिपोर्ट है, इसलिए अभी तुलना करने को कुछ नहीं है।`,
  },
  hinglish: {
    head: (who) => `${who} ke liye, latest report ki pichhli report se tulna: `,
    corrected: (c) =>
      `${listOf(
        c.map((x) =>
          x.from
            ? `${x.test} ko ${x.from} se ${x.to} mein sudhara gaya`
            : `${x.test} ko sudhara gaya`,
        ),
        "aur",
      )}. Yeh report ka sudhaar hai, body mein badlav nahi, aur main sudhara hua value leti hoon`,
    up: (a) => `${listOf(a, "aur")} badha`,
    down: (a) => `${listOf(a, "aur")} ghata`,
    same: (a) => `${listOf(a, "aur")} lagbhag waisa hi raha`,
    notComparable: (a) =>
      `${listOf(a, "aur")} ki tulna nahi ho sakti kyunki unit badal gayi`,
    tail: ". Numbers ke liye kisi ek test ke baare mein poochiye.",
    one: (who) =>
      `${who} ki yahan sirf ek report hai, isliye abhi tulna karne ko kuch nahi hai.`,
  },
};

function oneReportNote(pid, own, lang) {
  const O = OVERVIEW_SAY[lang] ?? OVERVIEW_SAY.en;
  return {
    spoken: O.one(subjectLabel(pid, own)),
    verdict: "OVERVIEW",
    field: null,
    intent: "COMPARE",
    lang,
    used: [],
  };
}

// First person ("my", "mera", "मेरा"): after a per-person answer, ask which
// one is the caller rather than assume.
const FIRST_PERSON_RE =
  /\b(my|mine|me|i|mera|meri|mere|mujhe|main)\b|मेरा|मेरी|मेरे|मुझे|मैं/i;
const EACH_SAY = {
  en: {
    head: (n) =>
      `These reports are for ${n} people, so I keep their results apart. `,
    which: " Tell me which of these is you, and I'll stay on that report.",
  },
  hi: {
    head: (n) =>
      `ये रिपोर्ट्स ${n} लोगों की हैं, इसलिए मैं उनके नतीजे अलग-अलग रखती हूँ। `,
    which: " बताइए इनमें से आप कौन हैं, फिर मैं उसी रिपोर्ट पर रहूँगी।",
  },
  hinglish: {
    head: (n) =>
      `Yeh reports ${n} logon ki hain, isliye main unke results alag rakhti hoon. `,
    which:
      " Bataiye inmein se aap kaun hain, phir main usi report par rahungi.",
  },
};

/**
 * A whole-report question when the reports hold several people and the
 * question names none: answer for each person, separately and labelled.
 * Null when there is one person, or too many to read out.
 */
export function eachSubject(question, reports, fn) {
  const ids = subjectsFor(question, reports);
  if (ids.length < 2 || ids.length > 4) return null;
  const lang = detectLang(question);
  const parts = [];
  for (const id of ids) {
    const own = reports.filter((r) => subjectOf(r) === id);
    const a = own.length ? fn(question, own) : null;
    if (a?.spoken) parts.push({ id, ...a });
  }
  if (!parts.length) return null;
  const E = EACH_SAY[lang] ?? EACH_SAY.en;
  const verdicts = parts.map((p) => p.verdict);
  return {
    spoken: (
      E.head(ids.length) +
      parts.map((p) => p.spoken).join(" ") +
      (FIRST_PERSON_RE.test(question) ? E.which : "")
    )
      .replace(/\s+/g, " ")
      .trim(),
    verdict: verdicts.includes("FLAGGED") ? "FLAGGED" : verdicts[0],
    field: null,
    intent: parts[0].intent ?? "SUMMARY",
    lang,
    subjects: parts.map((p) => p.id),
    used: parts.flatMap((p) => p.used ?? []),
  };
}

// "What should I ask my doctor?": questions to bring, each built from a line
// in these reports. Questions, never advice or a diagnosis.
const DOCTOR_RE =
  /\b(?:ask|tell|discuss|mention|bring up|raise|questions? for)\b[^?.]{0,30}\b(?:doctor|dr|physician|clinician|gp)\b|\bdoctor se\b[^?.]{0,25}\b(?:kya|kaun|puch|pooch|baat)\w*|(?:डॉक्टर|डाक्टर) से[^?।]{0,25}(?:क्या|कौन|पूछ|बात)/i;
const DOCTOR_SAY = {
  en: {
    head: (who) =>
      `Questions you could bring to your doctor${who ? ` about ${who}'s report` : ""}, each from a line in these reports: `,
    flagged: (item) => `${item}: what does that mean for me?`,
    corrected: (x) =>
      `${x.test} was corrected${x.from ? ` from ${x.from} to ${x.to}` : ""} in an amended report: which value should we go by?`,
    unclear: (t, p) =>
      `${t}${p ? ` on page ${p}` : ""} was too unclear to read on the scan: what is the exact value?`,
    units: (t) =>
      `${t} was printed in different units in two reports: has it actually changed?`,
    noRange: (n) =>
      `${n} result${n === 1 ? " has" : "s have"} no printed range: should any of them be looked at?`,
    none: (who) =>
      `${who ? `For ${who}, n` : "N"}othing here is outside the lab's printed ranges and nothing was corrected, so a good question is what these results mean for you, given your history.`,
    tail: " These are questions to ask, not a diagnosis.",
  },
  hi: {
    head: (who) =>
      `${who ? `${who} की रिपोर्ट के बारे में ` : ""}डॉक्टर से पूछने लायक सवाल, हर एक इन रिपोर्ट्स की किसी लाइन से: `,
    flagged: (item) => `${item}: मेरे लिए इसका क्या मतलब है?`,
    corrected: (x) =>
      `${x.test} को संशोधित रिपोर्ट में ${x.from ? `${x.from} से ${x.to} ` : ""}सुधारा गया: हमें कौन-सा मान मानना चाहिए?`,
    unclear: (t, p) =>
      `${t}${p ? ` (पेज ${p})` : ""} स्कैन पर साफ़ नहीं पढ़ा गया: इसका सही मान क्या है?`,
    units: (t) =>
      `${t} दो रिपोर्ट्स में अलग यूनिट में छपा: क्या सच में बदला है?`,
    noRange: (n) =>
      `${n} नतीजों की सीमा नहीं छपी: क्या इनमें से किसी को देखना चाहिए?`,
    none: (who) =>
      `${who ? `${who} के लिए: ` : ""}यहाँ कुछ भी लैब की छपी सीमा से बाहर नहीं है और कुछ सुधारा नहीं गया, इसलिए एक अच्छा सवाल है कि आपके इतिहास को देखते हुए इन नतीजों का आपके लिए क्या मतलब है।`,
    tail: " ये पूछने के सवाल हैं, निदान नहीं।",
  },
  hinglish: {
    head: (who) =>
      `${who ? `${who} ki report ke baare mein ` : ""}doctor se poochne layak sawaal, har ek in reports ki kisi line se: `,
    flagged: (item) => `${item}: mere liye iska kya matlab hai?`,
    corrected: (x) =>
      `${x.test} ko amended report mein ${x.from ? `${x.from} se ${x.to} ` : ""}sudhara gaya: kaunsa value maanna chahiye?`,
    unclear: (t, p) =>
      `${t}${p ? ` (page ${p})` : ""} scan par saaf nahi padha gaya: iska sahi value kya hai?`,
    units: (t) =>
      `${t} do reports mein alag unit mein chhapa: kya sach mein badla hai?`,
    noRange: (n) =>
      `${n} results ki range nahi chhapi: kya inmein se kisi ko dekhna chahiye?`,
    none: (who) =>
      `${who ? `${who} ke liye: ` : ""}Yahan kuch bhi lab ki range se bahar nahi hai aur kuch sudhara nahi gaya, isliye accha sawaal hai ki aapki history dekhte hue in results ka aapke liye kya matlab hai.`,
    tail: " Yeh poochne ke sawaal hain, diagnosis nahi.",
  },
};

export function doctorQuestions(question, reports, { tail = true } = {}) {
  if (!reports?.length || !DOCTOR_RE.test(question)) return null;
  const ids = subjectsFor(question, reports);
  const lang = detectLang(question);
  const D = DOCTOR_SAY[lang] ?? DOCTOR_SAY.en;
  if (ids.length > 1) {
    // one disclaimer for the whole answer, not one per person
    const all = eachSubject(question, reports, (q, own) =>
      doctorQuestions(`${q} ${subjectOf(own[0])}`, own, { tail: false }),
    );
    return all ? { ...all, spoken: (all.spoken + D.tail).trim() } : null;
  }
  const S = SAY[lang] ?? SAY.en;
  const pid = ids[0];
  const own = reports.filter((r) => subjectOf(r) === pid);
  const obs = latestFor(own, pid);
  if (obs.some((o) => o.authorityConflict))
    return authorityConflictAnswer(
      obs.flatMap((o) => o.conflicts ?? []),
      lang,
    );
  if (!obs.length) return null;
  const flagged = obs.filter((o) => SEVERITY[position(o)] != null);
  const unjudged = obs.filter(
    (o) => position(o) === "unknown" && !o.ref?.adultOnly,
  ).length;
  const ch = changesFor(pid, own);
  const qs = [
    ...ch.corrected.map((x) => D.corrected(x)),
    ...flagged
      .slice(0, 3)
      .map((o) =>
        D.flagged(o.qual ? S.qual(o) : S.item(o, S[position(o)], rangeOf(o))),
      ),
    ...ch.notComparable.map((x) => D.units(x.test)),
    ...obs
      .filter((o) => o.unreadable)
      .map((o) => D.unclear(o.test, o.unreadable.page)),
    ...(unjudged ? [D.noRange(unjudged)] : []),
  ].slice(0, 5);
  const lab = pid.startsWith("doc:") ? null : subjectLabel(pid, own);
  const end = tail ? D.tail : "";
  const spoken = qs.length
    ? D.head(lab) + qs.map((q, i) => `${i + 1}) ${q}`).join(" ") + end
    : D.none(lab) + end;
  return {
    spoken: spoken.replace(/\s+/g, " ").trim(),
    verdict: "OVERVIEW",
    field: null,
    intent: "ASK_DOCTOR",
    lang,
    used: [
      ...new Set([
        ...ch.corrected.flatMap((x) => x.used),
        ...flagged.slice(0, 3),
        ...ch.notComparable.flatMap((x) => x.used),
      ]),
    ].slice(0, 12),
  };
}

// ------------------------------------------------------------ whole reports and body systems
// "What is this report suggesting?", "anything abnormal?", "how is my liver?"
// Built from the same per-test positions as single answers: the lab's own
// printed ranges, qualitative results against the lab's expected result, no
// outside thresholds and no diagnosis.
const SUMMARY_RE =
  /\b(summar\w*|overview|overall|abnormal\w*|out of (the )?range|out-of-range|outside|(?:high|low)(?: or | and |\/)(?:high|low)|elevated|unusual|high|low|range se bahar|bahar|upar neeche|zyada ya kam|flag\w*|wrong|concern\w*|critical|serious|problem\w*|issues?|normal|okay|ok|fine|healthy|suggest\w*|indicat\w*|interpret\w*|explain\w*|findings?|symptoms?|highlights?|anything|everything|all (my|the) (results|values|tests)|what does (this|the|my) (report|test|result)|what('s| is) (this|the|my) report|kya (dikha|bata|keh)\w*|sab theek|theek hai|gadbad|kharab|dikkat|kuch galat|matlab)\b|सब ठीक|ठीक है|सामान्य|नॉर्मल|गड़बड़|खराब|समस्या|दिक्कत|क्या दिखा|क्या बता|मतलब|सारांश|कुछ गलत|असामान्य|रेंज से बाहर|सीमा से बाहर|बाहर|ज़्यादा या कम|ज्यादा या कम/i;
const SYMPTOM_RE = /\b(symptoms?|lakshan)\b|लक्षण/i;

/** The latest value of every test this subject has, one per test. */
function latestFor(reports, pid, keys = null) {
  const out = [];
  const seen = new Set();
  for (const r of reports)
    for (const o of r.observations) {
      if (subjectOf(r) !== pid || seen.has(o.key)) continue;
      if (keys && !keys.includes(o.key)) continue;
      seen.add(o.key);
      const series = seriesFor(reports, o.key, pid);
      const last = series[series.length - 1];
      if (last)
        out.push({
          ...last.current,
          date: last.date,
          superseded: last.superseded,
          conflicts: last.conflicts ?? [],
        });
    }
  return out;
}

const SAY = {
  en: {
    above: "above",
    below: "below",
    item: (o, where, r) =>
      `${nameOf(o)} ${valueOf(o)} (${rangeWords(where, r, "en")})`,
    qual: (o) =>
      `${nameOf(o)} is ${o.qual}, where the lab expects ${o.ref.expected}`,
    list: (a) =>
      a.length > 1 ? a.slice(0, -1).join("; ") + "; and " + a.at(-1) : a[0],
    who: (label) => (label ? `In ${label}'s report, ` : "In this report, "),
    count: (n) =>
      `${n} result${n === 1 ? " is" : "s are"} printed with a range I can check`,
    out: (k) =>
      k === 1
        ? `one is outside the lab's range: `
        : `${k} are outside the lab's range: `,
    allIn: (n) =>
      n === 2
        ? "both are within the lab's printed ranges."
        : n === 1
          ? "it is within the lab's printed range."
          : `all ${n} are within the lab's printed ranges.`,
    rest: (m) => `The other ${m} ${m === 1 ? "is" : "are"} within range.`,
    more: (m) => ` and ${m} more, all listed on screen`,
    qualOnly: (a) => `${a}.`,
    noRange: (m) =>
      ` ${m} other result${m === 1 ? " has" : "s have"} no printed range, so I haven't judged ${m === 1 ? "it" : "them"}.`,
    qualified: (m) =>
      ` ${m} other result${m === 1 ? " has" : "s have"} a printed reference with a qualification I can't judge, so I haven't judged ${m === 1 ? "it" : "them"}.`,

    symptoms:
      "A lab report shows test results, not symptoms, so I can only tell you what the numbers say. ",
    child: (age, m) =>
      ` This report is for a child (age ${age}), and ${m} of the printed ranges are adult ranges, so I haven't judged those results against them.`,
    missing: (what, have) =>
      // "an HbA1c", "an LDL": a spelled-out letter that starts with a vowel sound
      `I don't see ${String(what)
        .replace(/^a (?=[FHLMNRSX][A-Z0-9])/, "an ")
        .replace(
          /^a (?=[aeiou])/i,
          "an ",
        )} in these reports. They include ${have}.`,
    critical: (o) =>
      ` The lab marked ${nameOf(o)} as critical, so please contact your doctor or clinic today.`,
    gentle:
      " I can't diagnose from a report; your doctor can read these alongside how you feel and your history.",
    calm: " Your doctor can read them alongside how you feel and your history.",
    group: (label, items) =>
      `${label ? `For your ${label}` : "For these tests"}: ${items}.`,
    gWithin: (o, r) =>
      `${nameOf(o)} ${valueOf(o)}, ${rangeWords("within", r, "en")}`,
    gOut: (o, where, r) =>
      `${nameOf(o)} ${valueOf(o)}, ${rangeWords(where, r, "en")}`,
    gQual: (o) =>
      `${nameOf(o)} ${o.qual}${o.ref?.expected ? (position(o) === "within" ? ", as expected" : `, where the lab expects ${o.ref.expected}`) : ""}`,
    gRaw: (o) =>
      `${nameOf(o)} ${valueOf(o)}, printed reference "${o.rangeRaw}" not compared`,
    gNoRange: (o) => `${nameOf(o)} ${valueOf(o)}, no range printed`,
    which: (ids) =>
      `These reports belong to more than one person (${ids.join(", ")}). Whose report should I look at?`,
  },
  hi: {
    above: "ज़्यादा",
    below: "कम",
    item: (o, where, r) =>
      `${nameOf(o)} ${valueOf(o)} (सीमा ${span(r, "hi")} से ${where})`,
    qual: (o) =>
      `${nameOf(o)} ${QUAL_HI[o.qual] ?? o.qual} है, जबकि लैब ${QUAL_HI[o.ref.expected] ?? o.ref.expected} की उम्मीद करती है`,
    list: (a) =>
      a.length > 1 ? a.slice(0, -1).join("; ") + "; और " + a.at(-1) : a[0],
    who: (label) => (label ? `${label} की रिपोर्ट में ` : "इस रिपोर्ट में "),
    count: (n) => `${n} नतीजे ऐसे हैं जिनकी सीमा छपी है`,
    out: (k) => `${k} लैब की सीमा से बाहर हैं: `,
    allIn: (n) => `सभी ${n} लैब की छपी सीमा के अंदर हैं।`,
    rest: (m) => `बाकी ${m} सीमा के अंदर हैं।`,
    more: (m) => ` और ${m} और, सब स्क्रीन पर`,
    qualOnly: (a) => `${a}।`,
    noRange: (m) =>
      ` ${m} नतीजों की सीमा नहीं छपी है, इसलिए मैंने उन्हें नहीं आंका।`,
    qualified: (m) =>
      ` ${m} अन्य नतीजे ऐसे संदर्भ के साथ छपे हैं जिसे मैं नहीं आंक सकती, इसलिए मैंने उन्हें नहीं आंका है।`,

    symptoms:
      "लैब रिपोर्ट में जांच के नतीजे होते हैं, लक्षण नहीं, इसलिए मैं सिर्फ़ यह बता सकती हूं कि नंबर क्या कहते हैं। ",
    child: (age, m) =>
      ` यह रिपोर्ट एक बच्चे (उम्र ${age}) की है, और ${m} छपी सीमाएं वयस्कों की हैं, इसलिए मैंने उन नतीजों को उनसे नहीं आंका।`,
    missing: (what, have) =>
      `इन रिपोर्ट्स में मुझे ${what} नहीं दिखा। इनमें ये जांचें हैं: ${have}।`,
    critical: (o) =>
      ` लैब ने ${nameOf(o)} को क्रिटिकल बताया है, कृपया आज ही अपने डॉक्टर से संपर्क करें।`,
    gentle:
      " मैं रिपोर्ट से निदान नहीं कर सकती; आपके डॉक्टर इन्हें आपकी तबीयत और इतिहास के साथ देख सकते हैं।",
    calm: " आपके डॉक्टर इन्हें आपकी तबीयत और इतिहास के साथ देख सकते हैं।",
    group: (label, items) =>
      `${label ? `आपके ${label} के नतीजे` : "इन जांचों के नतीजे"}: ${items}।`,
    gWithin: (o, r) =>
      `${nameOf(o)} ${valueOf(o)}, सीमा ${span(r, "hi")} के अंदर`,
    gOut: (o, where, r) =>
      `${nameOf(o)} ${valueOf(o)}, सीमा ${span(r, "hi")} से ${where}`,
    gQual: (o) => `${nameOf(o)} ${QUAL_HI[o.qual] ?? o.qual}`,
    gRaw: (o) =>
      `${nameOf(o)} ${valueOf(o)}, छपा संदर्भ "${o.rangeRaw}" से तुलना नहीं की`,
    gNoRange: (o) => `${nameOf(o)} ${valueOf(o)}, सीमा नहीं छपी`,
    which: (ids) =>
      `ये रिपोर्ट्स एक से ज़्यादा लोगों की हैं (${ids.join(", ")})। मैं किसकी रिपोर्ट देखूं?`,
  },
  hinglish: {
    above: "zyada",
    below: "kam",
    item: (o, where, r) =>
      `${nameOf(o)} ${valueOf(o)} (range ${span(r, "hinglish")} se ${where})`,
    qual: (o) =>
      `${nameOf(o)} ${o.qual} hai, jabki lab ${o.ref.expected} expect karti hai`,
    list: (a) =>
      a.length > 1 ? a.slice(0, -1).join("; ") + "; aur " + a.at(-1) : a[0],
    who: (label) => (label ? `${label} ki report mein ` : "Is report mein "),
    count: (n) => `${n} results ki range chhapi hai`,
    out: (k) => `${k} lab ki range se bahar hain: `,
    allIn: (n) => `saare ${n} lab ki range ke andar hain.`,
    rest: (m) => `Baaki ${m} range ke andar hain.`,
    more: (m) => ` aur ${m} aur, sab screen par`,
    qualOnly: (a) => `${a}.`,
    noRange: (m) =>
      ` ${m} results ki range nahi chhapi, isliye maine unhe judge nahi kiya.`,
    qualified: (m) =>
      ` ${m} aur results ke saath aisa reference chhapa hai jise main judge nahi kar sakti, isliye maine unhe judge nahi kiya hai.`,

    symptoms:
      "Lab report mein test results hote hain, symptoms nahi, isliye main sirf yeh bata sakti hoon ki numbers kya kehte hain. ",
    child: (age, m) =>
      ` Yeh report ek bachche (umar ${age}) ki hai, aur ${m} chhapi ranges adults ki hain, isliye maine un results ko unse judge nahi kiya.`,
    missing: (what, have) =>
      `In reports mein mujhe ${what} nahi dikha. Inmein yeh tests hain: ${have}.`,
    critical: (o) =>
      ` Lab ne ${nameOf(o)} ko critical bataya hai, please aaj hi apne doctor se baat karein.`,
    gentle:
      " Main report se diagnosis nahi kar sakti; aapke doctor inhe aapki tabiyat aur history ke saath dekh sakte hain.",
    calm: " Aapke doctor inhe aapki tabiyat aur history ke saath dekh sakte hain.",
    group: (label, items) =>
      `${label ? `Aapke ${label} ke results` : "In tests ke results"}: ${items}.`,
    gWithin: (o, r) =>
      `${nameOf(o)} ${valueOf(o)}, range ${span(r, "hinglish")} ke andar`,
    gOut: (o, where, r) =>
      `${nameOf(o)} ${valueOf(o)}, range ${span(r, "hinglish")} se ${where}`,
    gQual: (o) => `${nameOf(o)} ${o.qual}`,
    gRaw: (o) =>
      `${nameOf(o)} ${valueOf(o)}, printed reference "${o.rangeRaw}" se compare nahi kiya`,
    gNoRange: (o) => `${nameOf(o)} ${valueOf(o)}, range nahi chhapi`,
    which: (ids) =>
      `Yeh reports ek se zyada logon ki hain (${ids.join(", ")}). Main kiski report dekhoon?`,
  },
};
const CANON_LABEL = {
  glucose: "blood sugar",
  wbc: "white cell",
  rbc: "red cell",
  t3: "T3",
  t4: "T4",
  tsh: "TSH",
  hdl: "HDL",
  ldl: "LDL",
  crp: "CRP",
  esr: "ESR",
  alt: "ALT",
  ast: "AST",
  alp: "ALP",
  ggt: "GGT",
  mcv: "MCV",
  mch: "MCH",
  mchc: "MCHC",
  rdw: "RDW",
  hba1c: "HbA1c",
  totalprotein: "protein",
  uricacid: "uric acid",
  vitamind: "vitamin D",
  vitaminb12: "vitamin B12",
};
const QUAL_HI = {
  positive: "पॉज़िटिव",
  negative: "नेगेटिव",
  reactive: "रिएक्टिव",
  "non reactive": "नॉन-रिएक्टिव",
  detected: "डिटेक्टेड",
  "not detected": "नॉट डिटेक्टेड",
};
const GROUP_LABEL = {
  en: {
    liver: "liver tests",
    kidney: "kidney tests",
    thyroid: "thyroid tests",
    sugar: "blood sugar tests",
    lipids: "cholesterol tests",
    blood: "blood count",
    infection: "infection-related tests",
    iron: "iron and red cell tests",
    vitamins: "vitamin tests",
  },
  hi: {
    liver: "लिवर",
    kidney: "किडनी",
    thyroid: "थायरॉइड",
    sugar: "शुगर",
    lipids: "कोलेस्ट्रॉल",
    blood: "ब्लड काउंट",
    infection: "संक्रमण से जुड़ी जांचों",
    iron: "आयरन",
    vitamins: "विटामिन",
  },
  hinglish: {
    liver: "liver",
    kidney: "kidney",
    thyroid: "thyroid",
    sugar: "sugar",
    lipids: "cholesterol",
    blood: "blood count",
    infection: "infection wale tests",
    iron: "iron",
    vitamins: "vitamin",
  },
};
// "above the 40 to 75 range", "above the lab's limit of 140", "within the limit of 200"
function rangeWords(where, r, lang) {
  if (lang !== "en") return `${where} ${span(r, lang)}`;
  const open = r.low == null ? "limit" : r.high == null ? "minimum" : null;
  if (where === "within")
    return open === "limit"
      ? `under the limit of ${r.high}`
      : open === "minimum"
        ? `at or above ${r.low}`
        : `within ${span(r, "en")}`;
  if (open === "limit") return `${where} the lab's limit of ${r.high}`;
  if (open === "minimum") return `${where} the lab's minimum of ${r.low}`;
  return `${where} the ${span(r, "en")} range`;
}
const valueOf = (o) =>
  o.qual ? o.qual : `${o.raw}${o.unit ? " " + o.unit : ""}`;
// Which results to list as outside the printed range. Not a severity: the
// order is the lab's own (qualitative mismatch first), never a distance.
const SEVERITY = {
  qual_differs: 0,
  above: 1,
  below: 1,
};

/** Pick the subject to talk about, or ask which. */
function oneSubject(question, reports, lang) {
  const ids = subjectsFor(question, reports);
  if (ids.length === 1) return { pid: ids[0] };
  return {
    ask: {
      spoken: SAY[lang].which(ids.map((id) => subjectLabel(id, reports))),
      verdict: "AMBIGUOUS_PATIENT",
      field: null,
      intent: "LOOKUP",
      lang,
      used: [],
    },
  };
}

/** Several tests at once: a body system, a section, or one alias shared by several rows. */
export function groupAnswer(question, reports, keys, label = null) {
  const lang = detectLang(question);
  const S = SAY[lang];
  const withAny = reports.filter((r) =>
    r.observations.some((o) => keys.includes(o.key)),
  );
  if (!withAny.length) return null;
  const who = oneSubject(question, withAny, lang);
  if (who.ask) return who.ask;
  const obs = latestFor(withAny, who.pid, keys);
  if (obs.some((o) => o.authorityConflict))
    return authorityConflictAnswer(
      obs.flatMap((o) => o.conflicts ?? []),
      lang,
    );
  if (!obs.length) return null;
  const items = obs.map((o) => {
    const pos = position(o);
    const r = rangeOf(o);
    if (o.unreadable) return explainOne(o, o.date, lang);
    if (o.qual) return S.gQual(o);
    if (pos === "unknown" || !r) return o.rangeRaw ? S.gRaw(o) : S.gNoRange(o);
    if (pos === "within") return S.gWithin(o, r);
    return S.gOut(o, S[pos], r);
  });
  const flagged = obs.filter((o) => SEVERITY[position(o)] != null);
  // one alias shared by several rows ("dengue") names the group
  const canon = obs.every((o) => o.canon && o.canon === obs[0].canon)
    ? obs[0].canon
    : null;
  const shown = canon ? (CANON_LABEL[canon] ?? canon) : null;
  const name = label ?? (shown ? `${shown} tests` : null);
  let spoken = S.group(lang === "en" ? name : (label ?? shown), S.list(items));
  const g = canon
    ? GLOSSARY[canon]
    : keys.length > 1
      ? null
      : GLOSSARY[obs[0].canon ?? obs[0].key];
  if (g) spoken += " " + PHRASES[lang].general(g[lang]);
  if (flagged.length) spoken += S.gentle;
  return {
    spoken,
    verdict: flagged.length ? "FLAGGED" : "LATEST",
    field: null,
    intent: "LOOKUP",
    lang,
    used: obs,
  };
}

/** A whole report: what is outside the lab's range, what is not, no diagnosis. */
export function reportSummary(question, reports) {
  const lang = detectLang(question);
  const S = SAY[lang];
  const who = oneSubject(question, reports, lang);
  if (who.ask) return eachSubject(question, reports, reportSummary) ?? who.ask;
  const own = reports.filter((r) => subjectOf(r) === who.pid);
  const obs = latestFor(own, who.pid);
  if (obs.some((o) => o.authorityConflict))
    return authorityConflictAnswer(
      obs.flatMap((o) => o.conflicts ?? []),
      lang,
    );
  if (!obs.length) return null;
  const judged = obs.filter((o) => position(o) !== "unknown");
  const flagged = judged
    .filter((o) => SEVERITY[position(o)] != null)
    .sort((a, b) => SEVERITY[position(a)] - SEVERITY[position(b)]);
  const critical = obs.find((o) => CRITICAL_FLAG.test(o.flag ?? ""));
  const lab = who.pid.startsWith("doc:") ? null : subjectLabel(who.pid, own);
  const label =
    lab && (/^SYN-/.test(lab) || /[a-z]{2}/i.test(lab)) ? lab : null;
  const child = own.find(
    (r) => r.meta.patient?.age != null && r.meta.patient.age < 16,
  );
  const adultOnly = obs.filter((o) => o.ref?.adultOnly).length;
  const shown = flagged
    .slice(0, 6)
    .map((o) => (o.qual ? S.qual(o) : S.item(o, S[position(o)], rangeOf(o))));
  let spoken = SYMPTOM_RE.test(question) ? S.symptoms : "";
  spoken +=
    S.who(label) +
    S.count(judged.length) +
    (lang === "en" ? "; " : lang === "hi" ? "; " : "; ");
  if (!judged.length)
    spoken += {
      en: "I cannot judge any result against a verified printed range. ",
      hi: "मैं किसी नतीजे को सत्यापित छपी सीमा से नहीं तौल सकती। ",
      hinglish:
        "Kisi result ko verified printed range se compare nahi kar sakti. ",
    }[lang];
  else if (!flagged.length) spoken += S.allIn(judged.length);
  else {
    spoken +=
      S.out(flagged.length) +
      S.list(shown) +
      (flagged.length > 6 ? S.more(flagged.length - 6) : "") +
      (lang === "hi" ? "। " : ". ");
    if (judged.length > flagged.length)
      spoken += S.rest(judged.length - flagged.length);
  }
  // Scanned values too unclear to read are named, with their page, and
  // never counted as "no printed range".
  const unclear = obs.filter((o) => o.unreadable);
  const unjudged = obs.length - judged.length - adultOnly - unclear.length;
  const qualified = obs.filter(
    (o) =>
      o.rangeRaw &&
      !o.unreadable &&
      position(o) === "unknown" &&
      !o.ref?.adultOnly,
  ).length;
  if (child && adultOnly) spoken += S.child(child.meta.patient.age, adultOnly);
  if (unclear.length)
    spoken += (UNCLEAR_SAY[lang] ?? UNCLEAR_SAY.en)(
      unclear.map((o) => o.test),
      [...new Set(unclear.map((o) => o.unreadable.page).filter(Boolean))],
    );
  if (unjudged - qualified > 0) spoken += S.noRange(unjudged - qualified);
  if (qualified > 0) spoken += S.qualified(qualified);
  if (critical) spoken += S.critical(critical);
  else if (flagged.length) spoken += S.gentle;
  else spoken += S.calm;
  return {
    spoken: spoken.replace(/\s+/g, " ").trim(),
    verdict: flagged.length ? "FLAGGED" : "WITHIN_RANGE",
    field: null,
    intent: "SUMMARY",
    lang,
    used: (flagged.length ? flagged : obs).slice(0, 8),
  };
}

const UNCLEAR_SAY = {
  en: (tests, pages) =>
    ` ${tests.join(" and ")} ${tests.length === 1 ? "is" : "are"} printed${pages.length ? ` on page ${pages.join(" and ")}` : ""} but the scan is too unclear to read safely, so check ${tests.length === 1 ? "it" : "them"} against the original.`,
  hi: (tests, pages) =>
    ` ${tests.join(" और ")}${pages.length ? ` पेज ${pages.join(" और ")} पर` : ""} छपे हैं पर स्कैन इतना साफ़ नहीं कि भरोसे से पढ़ा जा सके, इसलिए मूल रिपोर्ट से जाँच लें।`,
  hinglish: (tests, pages) =>
    ` ${tests.join(" aur ")}${pages.length ? ` page ${pages.join(" aur ")} par` : ""} chhape hain par scan itna saaf nahi ki bharose se padha ja sake, isliye original se check kar lijiye.`,
};

/** A body system or report section the question names ("liver", "dengue profile"). */
function findGroup(question, reports) {
  const qw = words(question);
  const q = ` ${qw.join(" ")} `;
  for (const [id, g] of Object.entries(GROUPS))
    if (
      g.words.some(
        (w) =>
          q.includes(` ${words(w).join(" ")} `) ||
          (/[ऀ-ॿ]/.test(w) && question.includes(w)),
      )
    ) {
      const keys = [];
      for (const r of reports)
        for (const o of r.observations)
          if (g.keys.includes(o.canon ?? o.key) && !keys.includes(o.key))
            keys.push(o.key);
      if (keys.length) return { id, keys };
    }
  // a section heading printed in the report ("SEROLOGY", "LIPID PROFILE")
  const GENERIC_SECTION = new Set([
    "test",
    "tests",
    "profile",
    "function",
    "count",
    "report",
    "panel",
    "serum",
    "blood",
    "complete",
    "total",
    "automated",
    "cell",
    "counter",
  ]);
  for (const r of reports)
    for (const o of r.observations) {
      if (!o.section) continue;
      const sw = words(o.section).filter(
        (w) => w.length >= 4 && !GENERIC_SECTION.has(w),
      );
      if (sw.length && sw.some((w) => qw.includes(w))) {
        const keys = [
          ...new Set(
            r.observations
              .filter((x) => x.section === o.section)
              .map((x) => x.key),
          ),
        ];
        return { id: null, label: nameOf(o.section), keys };
      }
    }
  return null;
}

/**
 * One entry point for screen and voice: a named test first, then a body
 * system or section, then the whole-report summary, then the longitudinal
 * overview across reports. Null leaves the question to the document engine.
 */

/**
 * A test-shaped question names something before a measure noun ("my X
 * level/result/reading/value/count"). When X is no test these reports hold
 * and not a generic word ("my blood levels", "my latest result"), the safe
 * answer is to name the confusion and list what IS here - never a generic
 * overview or summary that silently answers a different question. Genuine
 * overview requests ("how am I doing", "summarize my results") carry no
 * test-shaped candidate and are untouched.
 */
// Words that describe results rather than name a test. A candidate made of
// them is a summary question ("what are the abnormal results?"), never a
// lookup of a test called "abnormal".
const QUALIFIER_RE =
  /^(?:(?:abnormal|unusual|odd|high|low|higher|lower|elevated|raised|bad|worrying|concerning|flagged|important|key|main|normal|changed|different|wrong|critical|serious|other|all|any|out of range|outside|out-of-range|off|borderline|latest|recent)\b[\s,/-]*(?:or|and|\/)?[\s]*)+$/i;

const TEST_SHAPED_RE =
  /\b(?:my|the)\s+([a-z][a-z' -]{1,28}?)\s+(?:level|levels|result|results|reading|readings|value|values|count|counts)\b/i;
const GENERIC_MEASURE = new Set([
  "blood",
  "test",
  "tests",
  "lab",
  "labs",
  "report",
  "reports",
  "health",
  "body",
  "overall",
  "final",
  "latest",
  "new",
  "old",
  "first",
  "last",
  "recent",
  "current",
  "full",
  "complete",
]);
function unmatchedTestCandidate(question, reports) {
  const m = TEST_SHAPED_RE.exec(question);
  if (!m) return null;
  const cand = m[1].trim().replace(/\s+/g, " ").toLowerCase();
  if (!cand || GENERIC_MEASURE.has(cand)) return null;
  // "the abnormal results", "my high values": a qualifier, not a test name.
  if (QUALIFIER_RE.test(cand)) return null;
  if (findTest(question, reports) || findTest(cand, reports)) return null;
  return cand;
}

// "How far above the limit is the LDL?" asks for a distance: answer it
// first, then the usual reading.
const HOW_FAR_RE =
  /\bhow (?:far|much) (?:above|below|over|under|higher|lower|out(?:side)?|off)\b|\bby how much\b|kitna (?:zyada|jyada|kam|upar|neeche)|कितना (?:ज़्यादा|ज्यादा|कम|ऊपर|नीचे)/i;
function howFar(t, question) {
  const o = t?.used?.length === 1 ? t.used[0] : null;
  if (!HOW_FAR_RE.test(question) || !o || typeof o.value !== "number") return t;
  // No distance math against a limit a stamp may be covering.
  if (o.suspectObscured) return t;
  const { lowN = null, highN = null } = o.ref ?? {};
  const dp = (x) => (String(x).split(".")[1] ?? "").length;
  const places = Math.max(dp(o.raw ?? o.value), dp(highN ?? lowN ?? 0));
  const fmt = (x) => x.toFixed(places);
  const u = o.unit ? ` ${o.unit}` : "";
  const lang = t.lang ?? "en";
  const embed = o.stampedCopy
    ? {
        en: "By the report's embedded text, ",
        hi: "रिपोर्ट के एम्बेडेड टेक्स्ट के मुताबिक, ",
        hinglish: "Report ke embedded text ke mutabik, ",
      }[lang]
    : "";
  let lead = null;
  if (highN != null && o.value > highN) {
    const d = fmt(o.value - highN);
    lead = {
      en: `It's ${d}${u} above the lab's upper limit of ${fmt(highN)}.`,
      hi: `यह लैब की ऊपरी सीमा ${fmt(highN)} से ${d}${u} ज़्यादा है।`,
      hinglish: `Yeh lab ki upper limit ${fmt(highN)} se ${d}${u} zyada hai.`,
    }[lang];
  } else if (lowN != null && o.value < lowN) {
    const d = fmt(lowN - o.value);
    lead = {
      en: `It's ${d}${u} below the lab's lower limit of ${fmt(lowN)}.`,
      hi: `यह लैब की निचली सीमा ${fmt(lowN)} से ${d}${u} कम है।`,
      hinglish: `Yeh lab ki lower limit ${fmt(lowN)} se ${d}${u} kam hai.`,
    }[lang];
  } else if (highN != null || lowN != null) {
    lead = {
      en: "It isn't outside the lab's range at all.",
      hi: "यह लैब की रेंज से बाहर नहीं है।",
      hinglish: "Yeh lab ki range se bahar nahi hai.",
    }[lang];
  }
  if (lead && embed) lead = lead.charAt(0).toLowerCase() + lead.slice(1);
  return lead ? { ...t, spoken: `${embed}${lead} ${t.spoken}` } : t;
}

export function clinicalAnswer(question, reports) {
  return namedPatient(question, reports, clinicalAnswer0(question, reports));
}

/**
 * Reports holding more than one verified patient: an answer about one of
 * them says whose result it is, unless the question already named them
 * ("what's my B12?" in a file with two Ravi Kumars must not answer "Your
 * Vitamin B12 result is 180" when 180 is RB-30244's).
 */
function namedPatient(question, reports, out) {
  if (!out?.spoken || !out.used?.length) return out;
  // Only where identity can actually be confused: two verified patient IDs
  // that print the same name ("Ravi Kumar", RB-30211 and RB-30244).
  const idsByName = new Map();
  for (const r of reports ?? []) {
    const id = subjectOf(r);
    const name = r.meta?.patient?.name?.trim().toLowerCase();
    if (id.startsWith("doc:") || !name) continue;
    (idsByName.get(name) ?? idsByName.set(name, new Set()).get(name)).add(id);
  }
  const confusable = new Set(
    [...idsByName.values()]
      .filter((ids) => ids.size > 1)
      .flatMap((ids) => [...ids]),
  );
  if (!confusable.size) return out;
  const whose = new Set(
    out.used
      .map((u) => (u?.report ? subjectOf(u.report) : null))
      .filter(Boolean),
  );
  if (whose.size !== 1) return out;
  const pid = [...whose][0];
  if (!confusable.has(pid) || String(question).toUpperCase().includes(pid))
    return out;
  const lang = out.lang ?? detectLang(question);
  const spoken =
    lang === "en"
      ? /\bYour (\S[^.]*?) result is\b/.test(out.spoken)
        ? out.spoken.replace(
            /\bYour (\S[^.]*?) result is\b/,
            `${pid}'s $1 result is`,
          )
        : `For ${pid}: ${out.spoken}`
      : `${pid}: ${out.spoken}`;
  return { ...out, spoken, patient: pid };
}

function clinicalAnswer0(question, reports) {
  const out = answerFor(question, reports);
  // "What is his TSH?" after "I uploaded my dad's report": the results are
  // not the caller's, so the English answer says "The TSH result", never
  // "Your TSH result".
  if (
    out?.spoken &&
    (out.lang ?? detectLang(question)) === "en" &&
    aboutSomeoneElse(question)
  )
    return { ...out, spoken: thirdPerson(out.spoken) };
  return out;
}

function answerFor(question, reports) {
  if (!reports?.length) return null;
  const t = clinicalTurn(question, reports);
  if (t) return howFar(t, question);
  const lang = detectLang(question);
  if (DATE_ASK_RE.test(question)) return reportDates(reports, lang);
  // A test-shaped question whose test none of these reports holds ("what is
  // my heritage level"): say which tests ARE here and ask, instead of a
  // generic overview or summary that answers a different question.
  const unmatched = unmatchedTestCandidate(question, reports);
  if (unmatched) {
    const names = [
      ...new Set(reports.flatMap((r) => r.observations.map((o) => o.test))),
    ];
    return {
      spoken: {
        en: `I couldn't find a "${unmatched}" test in these reports. They have: ${names.join(", ")}. Which one did you mean?`,
        hi: `इन रिपोर्ट्स में "${unmatched}" नाम की कोई जांच नहीं है। इनमें हैं: ${names.join(", ")}। आप किस जांच के बारे में पूछ रहे हैं?`,
        hinglish: `In reports mein "${unmatched}" naam ki koi test nahi hai. Inmein hain: ${names.join(", ")}. Aap kis test ke baare mein pooch rahe hain?`,
      }[lang],
      verdict: "CLARIFY",
      field: null,
      lang,
      used: [],
    };
  }
  const change = CHANGE_RE.test(question);
  const g = findGroup(question, reports);
  if (g && !(change && multiReport(question, reports)))
    return groupAnswer(
      question,
      reports,
      g.keys,
      g.id ? GROUP_LABEL[lang][g.id] : g.label,
    );
  const doctor = doctorQuestions(question, reports);
  if (doctor) return doctor;
  if (SUMMARY_RE.test(question) && !(change && multiReport(question, reports)))
    return reportSummary(question, reports);
  return clinicalOverview(question, reports) ?? notInReport(question, reports);
}

/** When each report's sample was collected and when it was reported, as printed. */
function reportDates(reports, lang) {
  const day = (iso, raw) =>
    /^\d{4}-\d{2}-\d{2}$/.test(iso ?? "") ? sayDate(iso, lang) : (raw ?? null);
  const rows = reports.slice(0, 5).map((r) => ({
    c: day(r.meta?.collected, r.meta?.collectedRaw),
    p: day(r.meta?.reported, r.meta?.reportedRaw),
    st: r.meta?.status ?? null,
  }));
  if (!rows.some((x) => x.c || x.p)) return null;
  const one = (x) =>
    ({
      en: `${x.st && x.st !== "final" ? `the ${x.st} report: ` : ""}sample collected ${x.c ?? "on a date that isn't printed clearly"}${x.p ? `, reported ${x.p}` : ""}`,
      hi: `${x.c ? `सैंपल ${x.c} को लिया गया` : "सैंपल की तारीख़ साफ़ नहीं छपी है"}${x.p ? `, रिपोर्ट ${x.p} को आई` : ""}`,
      hinglish: `${x.c ? `sample ${x.c} ko liya gaya` : "sample ki date saaf nahi chhapi hai"}${x.p ? `, report ${x.p} ko aayi` : ""}`,
    })[lang] ?? "";
  const lead = {
    en:
      rows.length === 1
        ? "For this report: "
        : `There are ${rows.length} reports. `,
    hi:
      rows.length === 1 ? "इस रिपोर्ट में: " : `${rows.length} रिपोर्ट्स हैं। `,
    hinglish:
      rows.length === 1 ? "Is report mein: " : `${rows.length} reports hain. `,
  }[lang];
  return {
    spoken: lead + rows.map(one).join("; ") + (lang === "hi" ? "।" : "."),
    verdict: "VALUE",
    intent: "DATES",
    field: null,
    lang,
    used: [],
  };
}

/**
 * The question names a test or body system these reports don't contain at
 * all (not even as text the reader missed): say so, and say what is there.
 */
function notInReport(question, reports) {
  const qw = words(question);
  const q = ` ${qw.join(" ")} `;
  let what = null;
  for (const [key, g] of Object.entries(GLOSSARY))
    for (const a of [key, ...(g.aliases ?? [])]) {
      const aw = words(a);
      if (
        !aw.length ||
        (aw.length === 1 &&
          aw[0].length <= 2 &&
          !["hb", "t3", "t4"].includes(aw[0]))
      )
        continue;
      if (q.includes(` ${aw.join(" ")} `)) what ??= { key, said: a };
    }
  for (const [id, g] of Object.entries(GROUPS))
    if (!what && g.words.some((w) => q.includes(` ${words(w).join(" ")} `)))
      what = { group: id, said: g.words[0] };
  if (!what) return null;
  // printed somewhere the table reader could not follow: leave it to the
  // document search rather than say it is absent
  const hay = reports.map((r) => r.haystack ?? "").join(" ");
  if (hay.includes(` ${words(what.said).join(" ")} `)) return null;
  const lang = detectLang(question);
  const names = [
    ...new Set(reports.flatMap((r) => r.observations.map((o) => nameOf(o)))),
  ];
  const have =
    names.length > 8
      ? names.slice(0, 8).join(", ") + ` and ${names.length - 8} more`
      : names.join(", ");
  const said =
    what.said.length <= 4
      ? what.said.toUpperCase().replace("HBA1C", "HbA1c")
      : what.said
          .replace(/ ([a-z]\d?)$/, (m, c) => " " + c.toUpperCase())
          .replace(/\bhba1c\b/i, "HbA1c");
  const label = what.group
    ? `${said} results`
    : `${/^[aeiou]/i.test(said) && said.length > 4 ? "an" : "a"} ${said} result`;
  return {
    spoken: SAY[lang].missing(lang === "en" ? label : said, have),
    verdict: "NOT_IN_REPORT",
    field: null,
    intent: "LOOKUP",
    lang,
    used: [],
  };
}
const multiReport = (question, reports) => {
  const ids = subjectsFor(question, reports);
  return ids.some(
    (id) => reports.filter((r) => subjectOf(r) === id).length > 1,
  );
};
