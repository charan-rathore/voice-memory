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
  below_clearly: 0,
  above_clearly: 0,
  below_slightly: 1,
  above_slightly: 1,
  qual_differs: 1,
  within: 2,
  unknown: 3,
};

function testCard(reports, key, sid) {
  const series = seriesFor(reports, key, sid);
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
      `${t.name} at ${t.latest.raw} is ${/below/.test(t.latest.position) ? (t.latest.position === "below_slightly" ? "a little below" : "below") : t.latest.position === "above_slightly" ? "a little above" : "above"} ${t.latest.range.low} to ${t.latest.range.high}`,
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
    .sort(
      (a, b) => b.reports.length - a.reports.length || ranged(b) - ranged(a),
    );
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
