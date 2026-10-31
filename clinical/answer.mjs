// Spoken and on-screen answers about lab results across reports.
// Safety decisions (units, patients, amendments, bounds) are made here and in
// observations.mjs; every sentence is rendered by explain.mjs in the language
// the question was asked in, in plain, supportive words. No diagnosis.
import { seriesFor, compare, testKey } from "./observations.mjs";
import {
  detectLang,
  explainOne,
  explainChange,
  PHRASES,
  aliasesFor,
  sayDate,
} from "./explain.mjs";

const CHANGE_RE =
  /\b(chang\w*|increas\w*|decreas\w*|went (up|down)|go(ne)? (up|down)|higher|lower|ris(e|en)|rose|f[ae]ll|fallen|drop\w*|compar\w*|trend\w*|since|previous|last time|before|improv\w*|wors\w*|better|badl\w*|badh\w*|ghat\w*|pichhl\w*|pehle|tulna)\b|बदल|बढ़|घट|पिछल|पहले|तुलना/i;

const norm = (s) =>
  ` ${String(s)
    .toLowerCase()
    .replace(/[^a-z0-9\u0900-\u097f]+/g, " ")
    .trim()} `;

/** Find the test the question is about: the longest name or alias it contains. */
function findTest(question, reports) {
  const q = norm(question);
  let best = null;
  for (const r of reports)
    for (const o of r.observations)
      for (const name of [o.test, ...aliasesFor(o.key)]) {
        const n = norm(name).trim();
        if (
          n.length >= 2 &&
          q.includes(` ${n} `) &&
          (!best || n.length > best.n.length)
        )
          best = { n, key: o.key, test: o.test };
      }
  return best;
}

/**
 * @returns {null | {spoken, verdict, field:null, intent, lang, direction?, used}}
 */
export function clinicalTurn(question, reports) {
  if (!reports?.length) return null;
  const hit = findTest(question, reports);
  if (!hit) return null;
  const lang = detectLang(question);
  const t = PHRASES[lang];
  const withTest = reports.filter((r) =>
    r.observations.some((o) => o.key === hit.key),
  );
  const unidentified = withTest.filter((r) => !r.meta.patient?.id);
  let patients = [
    ...new Set(
      withTest.filter((r) => r.meta.patient?.id).map((r) => r.meta.patient.id),
    ),
  ];
  const named = patients.filter((id) => {
    const r = withTest.find((x) => x.meta.patient?.id === id);
    const name = (r.meta.patient.name ?? "")
      .replace(/\s*\(synthetic\)/i, "")
      .toLowerCase();
    return (
      question.toUpperCase().includes(id) ||
      (name && question.toLowerCase().includes(name))
    );
  });
  if (named.length) patients = named;
  const intent = CHANGE_RE.test(question) ? "COMPARE" : "LOOKUP";
  const base = { field: null, intent, lang };
  if (patients.length > 1)
    return {
      ...base,
      spoken: t.which(hit.test, patients),
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
      return e.clinical.observations.length
        ? { sourceId: src.id, title: src.title, ...e.clinical }
        : null;
    })
    .filter(Boolean);
}
