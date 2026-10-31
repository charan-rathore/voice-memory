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
  const ids = [
    ...new Set(reports.map((r) => r.meta.patient?.id).filter(Boolean)),
  ];
  const upper = question.toUpperCase();
  let pid = ids.find((id) => upper.includes(id));
  if (!pid) {
    const multi = ids.filter(
      (id) => reports.filter((r) => r.meta.patient?.id === id).length > 1,
    );
    if (!/\b(my|mine|patient|syn)\b/i.test(question) && !multi.length)
      return null;
    if (multi.length !== 1) return null;
    pid = multi[0];
  }
  const own = reports.filter((r) => r.meta.patient?.id === pid);
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
      reports,
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
  const parts = [`For ${pid}, comparing the latest report with the one before`];
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
