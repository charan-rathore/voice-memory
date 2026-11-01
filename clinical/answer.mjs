// Spoken and on-screen answers about lab results across reports.
// Safety decisions (units, patients, amendments, bounds) are made here and in
// observations.mjs; every sentence is rendered by explain.mjs in the language
// the question was asked in, in plain, supportive words. No diagnosis.
import { seriesFor, compare, testKey, subjectOf } from "./observations.mjs";
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
} from "./explain.mjs";
import { GROUPS } from "./glossary-more.mjs";

const CHANGE_RE =
  /\b(chang\w*|increas\w*|decreas\w*|went (up|down)|go(ne)? (up|down)|higher|lower|ris(e|en)|rose|f[ae]ll|fallen|drop\w*|compar\w*|trend\w*|since|previous|last time|before|improv\w*|wors\w*|better|badl\w*|badh\w*|ghat\w*|pichhl\w*|pehle|tulna)\b|बदल|बढ़|घट|पिछल|पहले|तुलना/i;

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
function findTest(question, reports) {
  const q = norm(question);
  const qw = words(question);
  const hits = [];
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
  if (!hits.length) return null;
  const top = Math.max(...hits.map((h) => h.score));
  const chosen = hits.filter((h) => h.score === top);
  const keys = [...new Set(chosen.map((h) => h.o.key))];
  return { key: keys[0], test: chosen[0].o.test, keys, score: top };
}

/** Name a subject for a question back to the user. */
function subjectLabel(id, reports) {
  const r = reports.find((x) => subjectOf(x) === id);
  if (id.startsWith("doc:")) return r?.title ?? id.slice(4);
  const name = r?.meta.patient?.name?.replace(/\s*\(synthetic\)/i, "");
  // Synthetic demo reports are known by their ID; real reports by the name printed on them.
  if (id.startsWith("name:")) return name ?? id.slice(5);
  return /^SYN-/.test(id) || !name ? id : name;
}
/** Subjects with this test, narrowed to the one the question names, if any. */
function subjectsFor(question, reports) {
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
  const patients = subjectsFor(question, withTest);
  const intent = CHANGE_RE.test(question) ? "COMPARE" : "LOOKUP";
  const base = { field: null, intent, lang };
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
  if (!patients.length)
    return {
      ...base,
      spoken: t.unknownPatient,
      verdict: "NOT_COMPARABLE",
      used: [],
    };
  const series = seriesFor(withTest, hit.key, patients[0]);
  if (!series.length) return null;
  const latest = series[series.length - 1];
  const amended = latest.superseded.length
    ? { from: latest.superseded[0].raw, to: latest.current.raw }
    : null;

  if (intent === "LOOKUP" || series.length === 1) {
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
      verdict: single ? "SINGLE" : "LATEST",
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
  return bundle.sources
    .map((src, i) => {
      const e = entries[i];
      if (!e?.doc) return null;
      e.clinical ??= extract(e.doc);
      e.haystack ??= ` ${words(e.doc.text ?? "").join(" ")} `;
      return e.clinical.observations.length
        ? {
            sourceId: src.id,
            title: src.title,
            haystack: e.haystack,
            ...e.clinical,
          }
        : null;
    })
    .filter(Boolean);
}

const OVERVIEW_RE =
  /\b(results?|reports?|tests?|labs?|blood|levels?|values?|numbers?|gone up|go up|went up|changed?|since|mean|means|meaning|explain|summary|summari[sz]e|overview|how am i|everything)\b/i;

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
  let pid = ids.find((id) => !/^(doc|name):/.test(id) && upper.includes(id));
  if (!pid) {
    const multi = ids.filter(
      (id) => reports.filter((r) => subjectOf(r) === id).length > 1,
    );
    if (!/\b(my|mine|patient|syn)\b/i.test(question) && !multi.length)
      return null;
    if (multi.length !== 1) return null;
    pid = multi[0];
  }
  const own = reports.filter((r) => subjectOf(r) === pid);
  const tests = [];
  for (const r of own)
    for (const o of r.observations)
      if (!tests.some((t) => t.key === o.key)) tests.push(o);
  const corrected = [],
    up = [],
    down = [],
    same = [],
    notComparable = [];
  const used = [];
  for (const o of tests) {
    const t = clinicalTurn(
      `Did ${o.test} change since the last report for ${pid}?`,
      own,
    );
    if (!t) continue;
    if (/corrected from/i.test(t.spoken)) {
      const m = /corrected from ([^ ]+) to ([^ ,.]+)/i.exec(t.spoken);
      corrected.push(
        m
          ? `${o.test} was corrected from ${m[1]} to ${m[2]}`
          : `${o.test} was corrected`,
      );
      used.push(...(t.used ?? []));
    }
    if (t.verdict === "NOT_COMPARABLE") {
      notComparable.push(o.test);
      used.push(...(t.used ?? []));
    } else if (t.verdict === "COMPARED") {
      const d =
        t.direction ??
        (/higher/i.test(t.spoken)
          ? "higher"
          : /lower/i.test(t.spoken)
            ? "lower"
            : "same");
      (d === "higher" ? up : d === "lower" ? down : same).push(o.test);
    }
  }
  if (!corrected.length && !up.length && !down.length && !notComparable.length)
    return null;
  const list = (a) =>
    a.length > 1 ? a.slice(0, -1).join(", ") + " and " + a.at(-1) : a[0];
  const parts = [
    `For ${subjectLabel(pid, reports)}, comparing the latest report with the one before`,
  ];
  if (corrected.length)
    parts.push(
      `one correction matters first: ${list(corrected)}, and I use the corrected value`,
    );
  if (up.length) parts.push(`${list(up)} went up`);
  if (down.length) parts.push(`${list(down)} went down`);
  if (same.length) parts.push(`${list(same)} stayed about the same`);
  if (notComparable.length)
    parts.push(
      `${list(notComparable)} can't be compared because the units changed`,
    );
  return {
    spoken:
      parts[0] +
      ": " +
      parts.slice(1).join("; ") +
      ". Ask about any one test for the numbers.",
    verdict: "OVERVIEW",
    field: null,
    intent: "COMPARE",
    lang: "en",
    used: [...new Set(used)],
  };
}

// ------------------------------------------------------------ whole reports and body systems
// "What is this report suggesting?", "anything abnormal?", "how is my liver?"
// Built from the same per-test positions as single answers: the lab's own
// printed ranges, qualitative results against the lab's expected result, no
// outside thresholds and no diagnosis.
const SUMMARY_RE =
  /\b(summar\w*|overview|overall|abnormal\w*|out of (the )?range|outside|flag\w*|wrong|concern\w*|critical|serious|problem\w*|issues?|normal|okay|ok|fine|healthy|suggest\w*|indicat\w*|interpret\w*|explain\w*|findings?|symptoms?|highlights?|anything|everything|all (my|the) (results|values|tests)|what does (this|the|my) (report|test|result)|what('s| is) (this|the|my) report|kya (dikha|bata|keh)\w*|sab theek|theek hai|gadbad|kharab|dikkat|kuch galat|matlab)\b|सब ठीक|ठीक है|सामान्य|नॉर्मल|गड़बड़|खराब|समस्या|दिक्कत|क्या दिखा|क्या बता|मतलब|सारांश|कुछ गलत|असामान्य/i;
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
        });
    }
  return out;
}

const SAY = {
  en: {
    above_slightly: "a little above",
    above_clearly: "above",
    below_slightly: "a little below",
    below_clearly: "below",
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
    allIn: (n) => `all ${n} are within the lab's printed ranges.`,
    rest: (m) => `The other ${m} ${m === 1 ? "is" : "are"} within range.`,
    more: (m) => ` and ${m} more, all listed on screen`,
    qualOnly: (a) => `${a}.`,
    noRange: (m) =>
      ` ${m} other result${m === 1 ? " has" : "s have"} no printed range, so I haven't judged ${m === 1 ? "it" : "them"}.`,
    symptoms:
      "A lab report shows test results, not symptoms, so I can only tell you what the numbers say. ",
    child: (age, m) =>
      ` This report is for a child (age ${age}), and ${m} of the printed ranges are adult ranges, so I haven't judged those results against them.`,
    missing: (what, have) =>
      `I don't see ${what} in these reports. They include ${have}.`,
    critical: (o) =>
      ` The lab marked ${nameOf(o)} as critical, so please contact your doctor or clinic today.`,
    soon: (o) =>
      ` I can't diagnose from a report; please go over these with your doctor soon, especially ${nameOf(o)}.`,
    gentle:
      " Results a little outside a range are common; your doctor can read them alongside how you feel.",
    calm: " Your doctor can read them alongside how you feel and your history.",
    group: (label, items) =>
      `${label ? `For your ${label}` : "For these tests"}: ${items}.`,
    gWithin: (o, r) =>
      `${nameOf(o)} ${valueOf(o)}, ${rangeWords("within", r, "en")}`,
    gOut: (o, where, r) =>
      `${nameOf(o)} ${valueOf(o)}, ${rangeWords(where, r, "en")}`,
    gQual: (o) =>
      `${nameOf(o)} ${o.qual}${o.ref?.expected ? (position(o) === "within" ? ", as expected" : `, where the lab expects ${o.ref.expected}`) : ""}`,
    gNoRange: (o) => `${nameOf(o)} ${valueOf(o)}, no range printed`,
    which: (ids) =>
      `These reports belong to more than one person (${ids.join(", ")}). Whose report should I look at?`,
  },
  hi: {
    above_slightly: "थोड़ा ज़्यादा",
    above_clearly: "ज़्यादा",
    below_slightly: "थोड़ा कम",
    below_clearly: "कम",
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
    symptoms:
      "लैब रिपोर्ट में जांच के नतीजे होते हैं, लक्षण नहीं, इसलिए मैं सिर्फ़ यह बता सकती हूं कि नंबर क्या कहते हैं। ",
    child: (age, m) =>
      ` यह रिपोर्ट एक बच्चे (उम्र ${age}) की है, और ${m} छपी सीमाएं वयस्कों की हैं, इसलिए मैंने उन नतीजों को उनसे नहीं आंका।`,
    missing: (what, have) =>
      `इन रिपोर्ट्स में मुझे ${what} नहीं दिखा। इनमें ये जांचें हैं: ${have}।`,
    critical: (o) =>
      ` लैब ने ${nameOf(o)} को क्रिटिकल बताया है, कृपया आज ही अपने डॉक्टर से संपर्क करें।`,
    soon: (o) =>
      ` मैं रिपोर्ट से निदान नहीं कर सकती; कृपया इन्हें जल्द ही अपने डॉक्टर को दिखाएं, ख़ासकर ${nameOf(o)}।`,
    gentle:
      " सीमा से थोड़ा बाहर आना आम बात है; आपके डॉक्टर इसे आपकी तबीयत के साथ देखकर समझा सकते हैं।",
    calm: " आपके डॉक्टर इन्हें आपकी तबीयत और इतिहास के साथ देख सकते हैं।",
    group: (label, items) =>
      `${label ? `आपके ${label} के नतीजे` : "इन जांचों के नतीजे"}: ${items}।`,
    gWithin: (o, r) =>
      `${nameOf(o)} ${valueOf(o)}, सीमा ${span(r, "hi")} के अंदर`,
    gOut: (o, where, r) =>
      `${nameOf(o)} ${valueOf(o)}, सीमा ${span(r, "hi")} से ${where}`,
    gQual: (o) => `${nameOf(o)} ${QUAL_HI[o.qual] ?? o.qual}`,
    gNoRange: (o) => `${nameOf(o)} ${valueOf(o)}, सीमा नहीं छपी`,
    which: (ids) =>
      `ये रिपोर्ट्स एक से ज़्यादा लोगों की हैं (${ids.join(", ")})। मैं किसकी रिपोर्ट देखूं?`,
  },
  hinglish: {
    above_slightly: "thoda zyada",
    above_clearly: "zyada",
    below_slightly: "thoda kam",
    below_clearly: "kam",
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
    symptoms:
      "Lab report mein test results hote hain, symptoms nahi, isliye main sirf yeh bata sakti hoon ki numbers kya kehte hain. ",
    child: (age, m) =>
      ` Yeh report ek bachche (umar ${age}) ki hai, aur ${m} chhapi ranges adults ki hain, isliye maine un results ko unse judge nahi kiya.`,
    missing: (what, have) =>
      `In reports mein mujhe ${what} nahi dikha. Inmein yeh tests hain: ${have}.`,
    critical: (o) =>
      ` Lab ne ${nameOf(o)} ko critical bataya hai, please aaj hi apne doctor se baat karein.`,
    soon: (o) =>
      ` Main report se diagnosis nahi kar sakti; please inhe jaldi apne doctor ko dikhaiye, khaaskar ${nameOf(o)}.`,
    gentle:
      " Range se thoda bahar aana aam baat hai; aapke doctor ise aapki tabiyat ke saath dekh sakte hain.",
    calm: " Aapke doctor inhe aapki tabiyat aur history ke saath dekh sakte hain.",
    group: (label, items) =>
      `${label ? `Aapke ${label} ke results` : "In tests ke results"}: ${items}.`,
    gWithin: (o, r) =>
      `${nameOf(o)} ${valueOf(o)}, range ${span(r, "hinglish")} ke andar`,
    gOut: (o, where, r) =>
      `${nameOf(o)} ${valueOf(o)}, range ${span(r, "hinglish")} se ${where}`,
    gQual: (o) => `${nameOf(o)} ${o.qual}`,
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
const SEVERITY = {
  qual_differs: 0,
  above_clearly: 1,
  below_clearly: 1,
  above_slightly: 2,
  below_slightly: 2,
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
  if (!obs.length) return null;
  const items = obs.map((o) => {
    const pos = position(o);
    const r = rangeOf(o);
    if (o.qual) return S.gQual(o);
    if (pos === "unknown" || !r) return S.gNoRange(o);
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
  if (flagged.length) {
    const worst = [...flagged].sort(
      (a, b) => SEVERITY[position(a)] - SEVERITY[position(b)],
    )[0];
    spoken += SEVERITY[position(worst)] < 2 ? S.soon(worst) : S.gentle;
  }
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
  if (who.ask) return who.ask;
  const own = reports.filter((r) => subjectOf(r) === who.pid);
  const obs = latestFor(own, who.pid);
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
  if (!flagged.length) spoken += S.allIn(judged.length);
  else {
    spoken +=
      S.out(flagged.length) +
      S.list(shown) +
      (flagged.length > 6 ? S.more(flagged.length - 6) : "") +
      (lang === "hi" ? "। " : ". ");
    if (judged.length > flagged.length)
      spoken += S.rest(judged.length - flagged.length);
  }
  const unjudged = obs.length - judged.length - adultOnly;
  if (child && adultOnly) spoken += S.child(child.meta.patient.age, adultOnly);
  if (unjudged > 0) spoken += S.noRange(unjudged);
  if (critical) spoken += S.critical(critical);
  else if (flagged.length && SEVERITY[position(flagged[0])] < 2)
    spoken += S.soon(flagged[0]);
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
export function clinicalAnswer(question, reports) {
  if (!reports?.length) return null;
  const t = clinicalTurn(question, reports);
  if (t) return t;
  const lang = detectLang(question);
  const change = CHANGE_RE.test(question);
  const g = findGroup(question, reports);
  if (g && !(change && multiReport(question, reports)))
    return groupAnswer(
      question,
      reports,
      g.keys,
      g.id ? GROUP_LABEL[lang][g.id] : g.label,
    );
  if (SUMMARY_RE.test(question) && !(change && multiReport(question, reports)))
    return reportSummary(question, reports);
  return clinicalOverview(question, reports) ?? notInReport(question, reports);
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
      : what.said;
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
