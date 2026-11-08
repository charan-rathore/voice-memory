// The picture behind an answer: what a person should see at a glance.
//
// Built only from typed observations (the same rows the spoken answer cites):
//   - each latest value placed on the lab's OWN printed range (no outside norms);
//   - each test's history across reports, with corrected values kept visible;
//   - unit changes drawn as a break, never as a line (no conversions);
//   - different people kept in separate groups.
// The narration is deterministic, in the language the person used, and says
// what the picture shows, not what it means for their health.
import { seriesFor, subjectOf, compare } from "../clinical/observations.mjs";
import {
  position,
  rangeOf,
  nameOf,
  sayDate,
  valueText,
  span,
  detectLang,
} from "../clinical/explain.mjs";
import { subjectLabel } from "../clinical/answer.mjs";

const ORDER = {
  below: 0,
  above: 0,
  qual_differs: 0,
  within: 2,
  unknown: 3,
};

// Decimal places a printed value carries ("12.9" -> 1), so a computed
// difference is never more precise than the reports themselves.
const places = (raw) =>
  (String(raw).split(".")[1] ?? "").replace(/\D.*/, "").length;
const fixedTo = (n, d) => Number(n.toFixed(d));
/**
 * What the drill-down may say about a test, computed with the engine's own
 * rules: the change since the previous reading only when compare() calls the
 * two readings comparable (same unit, both exact numbers; superseded values
 * never count), and the distance to the printed range only for an exact
 * value outside it. Everything else is reported as a reason, not a number.
 */
export function insightOf(series, o, r, pos) {
  const readings = series.length;
  const out = { readings, change: null, notCompared: null, distance: null };
  if (series.length > 1) {
    const prev = series[series.length - 2].current;
    const c = compare(prev, o);
    const exact = !prev.comparator && !o.comparator;
    if (
      c.comparable &&
      exact &&
      Number.isFinite(prev.value) &&
      Number.isFinite(o.value)
    ) {
      const d = Math.max(places(prev.raw), places(o.raw));
      const abs = fixedTo(o.value - prev.value, d);
      out.change = {
        from: prev.raw,
        to: o.raw,
        fromDate: series[series.length - 2].date,
        toDate: series[series.length - 1].date,
        abs,
        pct:
          prev.value !== 0
            ? fixedTo((100 * (o.value - prev.value)) / Math.abs(prev.value), 1)
            : null,
        direction: c.direction,
      };
    } else if (
      c.comparable &&
      (c.direction === "higher" || c.direction === "lower")
    )
      // "<0.05" then 0.30: the direction is certain (the same one the spoken
      // answer gives), the size of the change is not, so no number is shown.
      out.change = {
        from: prev.raw,
        to: o.raw,
        fromDate: series[series.length - 2].date,
        toDate: series[series.length - 1].date,
        abs: null,
        pct: null,
        direction: c.direction,
        bounded: true,
      };
    else out.notCompared = !c.comparable ? c.reason : "bound"; // "<0.05" vs 0.03: direction unknown
  }
  if (r && Number.isFinite(o.value) && !o.comparator) {
    const d = places(o.raw);
    if (/^below/.test(pos) && Number.isFinite(r.lowN))
      out.distance = {
        side: "below",
        by: fixedTo(r.lowN - o.value, d),
        bound: r.low ?? String(r.lowN),
      };
    else if (/^above/.test(pos) && Number.isFinite(r.highN))
      out.distance = {
        side: "above",
        by: fixedTo(o.value - r.highN, d),
        bound: r.high ?? String(r.highN),
      };
  }
  return out;
}

function testCard(reports, key, sid) {
  const allSeries = seriesFor(reports, key, sid);
  // A visual number carries the same authority as a spoken number.
  const safe = (s) => !s.current.unreadable && !s.conflicts?.length;
  if (allSeries.length && !safe(allSeries.at(-1))) return null;
  const series = allSeries.filter(safe);
  if (!series.length) return null;
  const last = series[series.length - 1];
  const o = last.current;
  const r = rangeOf(o);
  const pos = position(o);
  const history = series.map((s) => ({
    date: s.date,
    raw: s.current.raw,
    value: s.current.value,
    comparator: s.current.comparator ?? null,
    unit: s.current.unit ?? null,
    status: s.current.report?.meta?.status ?? "unknown",
    title: s.current.report?.title ?? null,
    range: rangeOf(s.current)
      ? { lowN: rangeOf(s.current).lowN, highN: rangeOf(s.current).highN }
      : null,
    superseded: s.superseded.map((x) => ({
      raw: x.raw,
      status: x.report?.meta?.status ?? "unknown",
    })),
  }));
  const units = [...new Set(history.map((h) => h.unit ?? "?"))];
  let trend = null;
  if (series.length > 1) {
    const c = compare(series[series.length - 2].current, o);
    trend = c.comparable ? c.direction : `not_comparable:${c.reason}`;
  }
  const fixed = [...series].reverse().find((s) => s.superseded.length);
  const insight = insightOf(series, o, r, pos);
  return {
    key,
    name: nameOf(o),
    unit: o.unit ?? null,
    latest: {
      date: last.date,
      raw: o.raw,
      value: o.value,
      comparator: o.comparator ?? null,
      qual: o.qual ?? null,
      flag: o.flag ?? null,
      status: o.report?.meta?.status ?? "unknown",
      position: pos,
      range: r
        ? {
            low: r.low ?? (Number.isFinite(r.lowN) ? String(r.lowN) : null),
            high: r.high ?? (Number.isFinite(r.highN) ? String(r.highN) : null),
            lowN: Number.isFinite(r.lowN) ? r.lowN : null,
            highN: Number.isFinite(r.highN) ? r.highN : null,
          }
        : null,
      printedRange: o.range ?? null,
    },
    history,
    trend,
    unitChanged: units.length > 1,
    insight,
    corrected: fixed
      ? {
          date: fixed.date,
          from: fixed.superseded[0].raw,
          to: fixed.current.raw,
        }
      : null,
  };
}

function subjectBlock(reports, sid, keys = null) {
  const mine = reports.filter((r) => subjectOf(r) === sid);
  const all = [
    ...new Set(mine.flatMap((r) => r.observations.map((o) => o.key))),
  ];
  const tests = (keys ?? all)
    .filter((k) => all.includes(k))
    .map((k) => testCard(reports, k, sid))
    .filter(Boolean)
    .sort(
      (a, b) =>
        (ORDER[a.latest.position] ?? 3) - (ORDER[b.latest.position] ?? 3) ||
        Number(!!b.corrected) - Number(!!a.corrected) ||
        Number(b.unitChanged) - Number(a.unitChanged),
    );
  const dates = [
    ...new Map(
      mine.map((r) => [
        r.title,
        {
          title: r.title,
          date: r.meta?.collected ?? r.meta?.reported ?? null,
          reported: r.meta?.reported ?? null,
          status: r.meta?.status ?? "unknown",
        },
      ]),
    ).values(),
  ].sort((a, b) => String(a.date).localeCompare(String(b.date)));
  return { id: sid, label: subjectLabel(sid, reports), reports: dates, tests };
}

// ------------------------------------------------------------ narration
const N = {
  en: {
    open: (who, n) =>
      `Here is ${who}'s picture across ${n === 1 ? "one report" : `${n} reports`}.`,
    outsideNone: (n) =>
      `All ${n} results with a printed range sit inside this lab's range.`,
    noRanges: (n) =>
      `The report prints ${n} values but no reference ranges, so I can't place them against a range.`,
    outside: (n, list) =>
      `${n === 1 ? "One result sits" : `${n} results sit`} outside this lab's printed range: ${list}.`,
    item: (t) =>
      `${t.name} at ${t.latest.raw} is ${t.latest.position === "below" ? "below" : "above"} ${t.latest.range.low} to ${t.latest.range.high}`,
    corrected: (t) =>
      `${t.name} was first printed as ${t.corrected.from} and corrected to ${t.corrected.to}${t.unit ? " " + t.unit : ""}, so I use ${t.corrected.to}.`,
    units: (t) =>
      `${t.name} changed units between reports, so those values are shown side by side but not compared.`,
    others: (labels) =>
      `${labels.join(" and ")} ${labels.length === 1 ? "is a separate person" : "are separate people"}; their results are kept apart.`,
    close: `This summarises what the reports print. It is not a diagnosis; your doctor can interpret it with your history.`,
  },
  hi: {
    open: (who, n) =>
      `यह ${who} की ${n} रिपोर्ट${n === 1 ? "" : "्स"} की तस्वीर है।`,
    outsideNone: (n) =>
      `छपी सीमा वाले सभी ${n} नतीजे इस लैब की सीमा के अंदर हैं।`,
    noRanges: (n) =>
      `रिपोर्ट में ${n} माप छपे हैं पर कोई सीमा नहीं, इसलिए मैं इन्हें किसी सीमा से नहीं आंक सकती।`,
    outside: (n, list) => `${n} नतीजे इस लैब की छपी सीमा से बाहर हैं: ${list}।`,
    item: (t) =>
      `${t.name} ${t.latest.raw} है, जो ${t.latest.range.low} से ${t.latest.range.high} की सीमा से ${/below/.test(t.latest.position) ? "कम" : "ज़्यादा"} है`,
    corrected: (t) =>
      `${t.name} पहले ${t.corrected.from} छपा था और सुधारकर ${t.corrected.to} किया गया, इसलिए मैं ${t.corrected.to} इस्तेमाल करती हूं।`,
    units: (t) =>
      `${t.name} की यूनिट रिपोर्ट्स के बीच बदली, इसलिए दोनों नतीजे साथ दिखाए हैं पर उनकी तुलना नहीं की।`,
    others: (labels) =>
      `${labels.join(" और ")} अलग व्यक्ति हैं; उनके नतीजे अलग रखे गए हैं।`,
    close: `यह सिर्फ़ इस बात का सार है कि रिपोर्ट्स में क्या छपा है। यह निदान नहीं है; आपके डॉक्टर इसे आपकी हिस्ट्री के साथ समझा सकते हैं।`,
  },
  hinglish: {
    open: (who, n) =>
      `Yeh ${who} ki ${n} report${n === 1 ? "" : "s"} ki tasveer hai.`,
    outsideNone: (n) =>
      `Printed range wale sabhi ${n} results is lab ki range ke andar hain.`,
    noRanges: (n) =>
      `Report mein ${n} readings chhapi hain par koi range nahi, isliye main inhe kisi range se judge nahi kar sakti.`,
    outside: (n, list) =>
      `${n} results is lab ki printed range se bahar hain: ${list}.`,
    item: (t) =>
      `${t.name} ${t.latest.raw} hai, jo ${t.latest.range.low} se ${t.latest.range.high} ki range se ${/below/.test(t.latest.position) ? "kam" : "zyada"} hai`,
    corrected: (t) =>
      `${t.name} pehle ${t.corrected.from} chhapa tha aur sudhaar kar ${t.corrected.to} kiya gaya, isliye main ${t.corrected.to} use karti hoon.`,
    units: (t) =>
      `${t.name} ki unit reports ke beech badli, isliye dono results saath dikhaye hain par unki tulna nahi ki.`,
    others: (labels) =>
      `${labels.join(" aur ")} alag vyakti hain; unke results alag rakhe gaye hain.`,
    close: `Yeh sirf is baat ka saar hai ki reports mein kya chhapa hai. Yeh diagnosis nahi hai; aapke doctor ise aapki history ke saath samjha sakte hain.`,
  },
};

function narrate(subjects, lang) {
  const t = N[lang] ?? N.en;
  if (!subjects.length) return "";
  const [main, ...rest] = subjects;
  const out = [t.open(main.label, main.reports.length)];
  const ranged = main.tests.filter(
    (x) => x.latest.range && x.latest.position !== "unknown",
  );
  const outside = ranged.filter((x) => /below|above/.test(x.latest.position));
  out.push(
    !ranged.length
      ? t.noRanges(main.tests.length)
      : outside.length
        ? t.outside(outside.length, outside.map((x) => t.item(x)).join("; "))
        : t.outsideNone(ranged.length),
  );
  for (const x of main.tests.filter((x) => x.corrected))
    out.push(t.corrected(x));
  for (const x of main.tests.filter((x) => x.unitChanged)) out.push(t.units(x));
  if (rest.length) out.push(t.others(rest.map((s) => s.label)));
  out.push(t.close);
  return out.join(" ");
}

const ranged = (s) => s.tests.filter((t) => t.latest.range).length;
/** Whole-case summary for the empty answer panel. */
export function caseVisual(bundle, lang = "en") {
  const reports = bundle?.clinical ?? [];
  if (!reports.length) return null;
  const ids = [...new Set(reports.map(subjectOf))];
  // The person with the most reports first: that is whose story it is.
  const subjects = ids
    .map((id) => subjectBlock(reports, id))
    .filter((s) => s.tests.length)
    .sort(
      (a, b) => b.reports.length - a.reports.length || ranged(b) - ranged(a),
    );
  if (!subjects.length) return null;
  return {
    kind: "labs",
    lang,
    subjects,
    narration: narrate(subjects, lang),
  };
}

/** The visual for one answer: the tests it used, for the subject it used. */
export function visualFor(question, bundle, lead) {
  const reports = bundle?.clinical ?? [];
  if (!reports.length || !lead) return null;
  const lang = detectLang(question);
  const used = (lead.used ?? []).filter((o) => o?.report);
  if (used.length) {
    const sid = subjectOf(used[0].report);
    const keys = [...new Set(used.map((o) => o.key))];
    const block = subjectBlock(reports, sid, keys);
    if (!block.tests.length) return null;
    return { kind: "labs", focus: "answer", lang, subjects: [block] };
  }
  if (["OVERVIEW", "FLAGGED", "SUMMARY"].includes(lead.verdict)) {
    const v = caseVisual(bundle, lang);
    return v && { ...v, focus: "overview" };
  }
  if (lead.verdict === "AMBIGUOUS_PATIENT") {
    const v = caseVisual(bundle, lang);
    return v && { ...v, focus: "patients", narration: null };
  }
  return null;
}

export { span, valueText, sayDate };
