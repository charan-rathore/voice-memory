// Spoken and on-screen answers about lab results across reports.
// Levels covered (from the plan): 1 evidence extraction ("what was printed"),
// 3 historical comparison ("what changed"). No diagnosis, no reassurance,
// no clinical significance: every comparison ends by pointing to a clinician.
import { seriesFor, compare, testKey } from "./observations.mjs";

const CHANGE_RE =
  /\b(chang\w*|increas\w*|decreas\w*|went (up|down)|go(ne)? (up|down)|higher|lower|ris(e|en)|rose|f[ae]ll|fallen|drop\w*|compar\w*|trend\w*|since|previous|last time|before|improv\w*|wors\w*|better)\b/i;

const MONTH = [
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
];
const say = (iso) => {
  const [y, m, d] = iso.split("-").map(Number);
  return `${d} ${MONTH[m - 1]} ${y}`;
};
const COMP = {
  "<": "less than ",
  "<=": "at most ",
  ">": "more than ",
  ">=": "at least ",
};
const valueText = (o) =>
  `${COMP[o.comparator] ?? ""}${o.raw.replace(/^(<=|>=|<|>|≤|≥)\s*/, "")}${o.unit ? " " + o.unit : ""}`;
const who = (o) =>
  o.report.meta.patient?.name
    ? o.report.meta.patient.name.replace(/\s*\(synthetic\)/i, "")
    : "this patient";

/** Find the test the question is about: the longest test name it contains. */
function findTest(question, reports) {
  const q = ` ${question.toLowerCase().replace(/[^a-z0-9]+/g, " ")} `;
  let best = null;
  for (const r of reports)
    for (const o of r.observations) {
      const name = o.test
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, " ")
        .trim();
      if (
        name.length >= 2 &&
        q.includes(` ${name} `) &&
        (!best || name.length > best.name.length)
      )
        best = { name, key: o.key };
    }
  return best;
}

/**
 * @param {string} question
 * @param {Array<{sourceId:string,title:string,meta:object,observations:object[]}>} reports
 * @returns {null | {spoken:string, verdict:string, field:null, intent:string, used:object[]}}
 *   `used` = observations whose source rows back the answer (current first).
 */
export function clinicalTurn(question, reports) {
  if (!reports?.length) return null;
  const hit = findTest(question, reports);
  if (!hit) return null;
  const withTest = reports.filter((r) =>
    r.observations.some((o) => o.key === hit.key),
  );
  const unidentified = withTest.filter((r) => !r.meta.patient?.id);
  let patients = [
    ...new Set(
      withTest.filter((r) => r.meta.patient?.id).map((r) => r.meta.patient.id),
    ),
  ];
  // A patient named or identified in the question narrows the set.
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
  if (patients.length > 1)
    return {
      spoken: `These documents have ${withTest[0].observations.find((o) => o.key === hit.key).test} results for more than one patient (${patients.join(", ")}). Which patient do you mean?`,
      verdict: "AMBIGUOUS_PATIENT",
      field: null,
      intent,
      used: [],
    };
  if (!patients.length)
    return {
      spoken:
        "I can't tell which patient these results belong to, so I won't compare or summarize them. The reports are on screen.",
      verdict: "NOT_COMPARABLE",
      field: null,
      intent,
      used: [],
    };
  const series = seriesFor(withTest, hit.key, patients[0]);
  if (!series.length) return null;
  const latest = series[series.length - 1];
  const amendedNote = (s) =>
    s.superseded.length
      ? ` The ${say(s.date)} result was amended from ${s.superseded[0].raw} to ${s.current.raw}; this uses the amended value.`
      : "";
  const skipped = unidentified.length
    ? " A report without a patient ID was left out."
    : "";

  if (intent === "LOOKUP" || series.length === 1) {
    const o = latest.current;
    const extra = [
      o.flag ? `flagged ${o.flag}` : null,
      o.range ? `reference range ${o.range}` : null,
    ]
      .filter(Boolean)
      .join(", ");
    return {
      spoken:
        (series.length === 1 && intent === "COMPARE"
          ? `There's only one ${o.test} result on record for ${who(o)}, so there's nothing to compare: `
          : `The latest ${o.test} result for ${who(o)} is `) +
        `${valueText(o)}, collected ${say(latest.date)}${extra ? ` (${extra})` : ""}.` +
        amendedNote(latest) +
        (o.flagConflict
          ? ` The report's ${o.flag} flag doesn't match its own reference range; check the original.`
          : "") +
        skipped,
      verdict:
        series.length === 1 && intent === "COMPARE" ? "SINGLE" : "LATEST",
      field: null,
      intent,
      used: [o, ...latest.superseded],
    };
  }

  const prevS = series[series.length - 2];
  const a = prevS.current;
  const b = latest.current;
  const c = compare(a, b);
  const used = [b, a, ...latest.superseded, ...prevS.superseded];
  if (!c.comparable) {
    const why = {
      unit: `${say(prevS.date)} is in ${a.unit} and ${say(latest.date)} is in ${b.unit}, and I don't convert units`,
      missing_unit:
        "one of the results has no unit printed, and I won't assume one",
      non_numeric: "one of the results isn't a number",
      test: "they aren't the same test",
    }[c.reason];
    return {
      spoken:
        `I can't compare the two ${b.test} results for ${who(b)}: ${why}. Both values are on screen.` +
        amendedNote(latest),
      verdict: "NOT_COMPARABLE",
      field: null,
      intent,
      used,
    };
  }
  const dir = {
    higher: "the later result is higher",
    lower: "the later result is lower",
    same: "the value is the same",
    undetermined:
      "I can't tell which is higher, because a result reported only as a bound overlaps the other",
  }[c.direction];
  return {
    spoken:
      `${b.test} for ${who(b)} went from ${valueText(a)} on ${say(prevS.date)} to ${valueText(b)} on ${say(latest.date)}: ${dir}.` +
      amendedNote(latest) +
      (c.rangeChanged
        ? " The two reports use different reference ranges."
        : "") +
      skipped +
      " Whether that matters is a question for your clinician.",
    verdict: "COMPARED",
    field: null,
    intent,
    direction: c.direction,
    used,
  };
}

export { testKey };

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
