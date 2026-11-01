// Clinical observation model (research prototype, synthetic data only).
//
// Deliberately separate from the commercial claim graph: a lab result is not
// a "decision". Fields follow the shape of FHIR R4 Observation (code, value +
// comparator, unit, referenceRange, interpretation, subject, effective/issued,
// status) without claiming FHIR conformance or LOINC/UCUM coding.
//
// Safety rules enforced here (each has a test):
//  - a unit is never inferred; a missing unit stays null;
//  - tests are equated only by identical normalized names (no synonyms);
//  - values in different units are never compared (no conversions are
//    validated in this build);
//  - results from different or unidentified patients are never combined;
//  - an amended report supersedes the preliminary/final one for the same
//    collection, and the superseded value stays visible;
//  - "<0.05" stays a bound: direction is only reported when certain.
//
// Real-world layouts (header on its own line, method lines between rows,
// sex-specific ranges, qualitative serology) are read by lab-lines.mjs and
// merged in with the same shape and the same rules.
import {
  readLabText,
  genericMeta,
  flatHeader,
  parseReference,
  parseResult,
  normUnit,
} from "./lab-lines.mjs";
import { locate } from "../ingest/canonical.mjs";
import { canonOf } from "./explain.mjs";

const MONTHS = {
  january: 1,
  february: 2,
  march: 3,
  april: 4,
  may: 5,
  june: 6,
  july: 7,
  august: 8,
  september: 9,
  october: 10,
  november: 11,
  december: 12,
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  sept: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};
const DATE = String.raw`(\d{1,2})\s+([A-Za-z]{3,9})\.?\s+(\d{4})`;

function isoDate(d, m, y) {
  const mm = MONTHS[m.toLowerCase()];
  if (!mm) return null;
  return `${y}-${String(mm).padStart(2, "0")}-${String(Number(d)).padStart(2, "0")}`;
}

export function reportMeta(full) {
  const text = flatHeader(full.slice(0, 6000)) + full.slice(6000);
  // The synthetic header: "Patient: Test Person A (synthetic), ID SYN-0001".
  const patient =
    /\b[Pp]atient:\s*([^\n,|]+?)\s*,\s*\bID\b\s*:?\s*([A-Z0-9][A-Z0-9-]{2,})/.exec(
      text,
    );
  const collected = new RegExp(`Collected:?\\s*(?:on\\s*)?${DATE}`, "i").exec(
    text,
  );
  const reported = new RegExp(`Reported:?\\s*(?:on\\s*)?${DATE}`, "i").exec(
    text,
  );
  const status =
    /Report status\s*:?\s*(final|preliminary|provisional|interim|partial|amended|corrected|revised)/i.exec(
      text,
    );
  const g = genericMeta(text);
  const st = status?.[1].toLowerCase();
  return {
    patient: patient
      ? {
          name: patient[1].trim(),
          id: patient[2].toUpperCase(),
          sex: g.patient?.sex ?? null,
          age: g.patient?.age ?? null,
        }
      : g.patient,
    collected: collected
      ? isoDate(collected[1], collected[2], collected[3])
      : g.collected,
    reported: reported
      ? isoDate(reported[1], reported[2], reported[3])
      : g.reported,
    dateRaw: g.dateRaw,
    status: st
      ? ({
          provisional: "preliminary",
          interim: "preliminary",
          partial: "preliminary",
          revised: "amended",
        }[st] ?? st)
      : "unknown",
    amendmentNotes: (text.match(/^.*\bamended\b.*$/gim) ?? [])
      .filter((l) => !/Report status/i.test(l))
      .map((l) => l.trim()),
  };
}

const COLS = {
  test: /^(test|tests|analyte|investigation|investigations|parameter|parameters|component|test name|test description|description)$/i,
  result: /^(result|results|value|observed value|your result|result value)$/i,
  unit: /^(unit|units)$/i,
  range:
    /^(reference|ref\.?|normal|biological|bio\.?)?\s*(ref\.?\s*)?(range|interval|reference range|reference interval|values?)$|^reference$/i,
  flag: /^(flag|flags|abnormal|h\/l)$/i,
};

export function parseValue(raw) {
  const s = String(raw ?? "").trim();
  const m = /^(<=|>=|<|>|≤|≥)?\s*([0-9]+(?:[.,][0-9]+)?)$/.exec(s);
  if (!m)
    return { comparator: null, value: null, notation: s ? "text" : "empty" };
  let num = m[2];
  let notation = "decimal-point";
  if (/^\d{1,3},\d{3}$/.test(num)) {
    num = num.replace(",", "");
    notation = "thousands-comma";
  } else if (num.includes(",")) {
    num = num.replace(",", ".");
    notation = "decimal-comma";
  }
  const comparator = { "≤": "<=", "≥": ">=" }[m[1]] ?? m[1] ?? null;
  return { comparator, value: Number(num), notation };
}

// A printed H/L flag that its own printed range contradicts (e.g. "H" on a
// value inside the range) is surfaced, never silently trusted either way.
function flagConflict(v, range, flag) {
  if (!flag || v.value == null || v.comparator) return false;
  const m = /^\s*([0-9]+(?:\.[0-9]+)?)\s*[-–]\s*([0-9]+(?:\.[0-9]+)?)\s*$/.exec(
    range ?? "",
  );
  if (!m) return false;
  const [lo, hi] = [Number(m[1]), Number(m[2])];
  if (/^h(igh)?$/i.test(flag)) return v.value <= hi;
  if (/^l(ow)?$/i.test(flag)) return v.value >= lo;
  return false;
}

export const testKey = (name) =>
  String(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
const unitKey = (u) =>
  u == null
    ? null
    : String(u).replace(/\s+/g, "").replace(/μ/g, "µ").toLowerCase();

/**
 * Extract a report from a canonical document (vm.document/1).
 * @returns {{meta, observations: object[]}}
 */
export function extractReport(doc) {
  const meta = reportMeta(doc.text);
  const observations = [];
  const tables = doc.elements.filter((e) => e.type === "table");
  for (const t of tables) {
    const header = doc.elements.find(
      (e) => e.parent === t.id && e.type === "table-header",
    );
    if (!header) continue;
    const col = {};
    header.cells.forEach((h, i) => {
      for (const [k, re] of Object.entries(COLS))
        if (col[k] === undefined && re.test(h.trim())) {
          col[k] = i;
          break; // one role per column ("Value" is the result, not a range)
        }
    });
    if (col.test === undefined || col.result === undefined) continue; // not a results table
    for (const row of doc.elements.filter(
      (e) => e.parent === t.id && e.type === "table-row",
    )) {
      const cell = (k) =>
        col[k] === undefined ? null : (row.cells[col[k]] ?? "").trim() || null;
      const test = cell("test");
      let raw = cell("result");
      // A flag printed inside the result cell ("H 141.0", "12.5 L").
      let inFlag = null;
      const fm = raw && /^(H|L|HH|LL)\s+(.+)$|^(.+?)\s+(H|L|HH|LL)$/.exec(raw);
      if (fm) {
        inFlag = fm[1] ?? fm[4];
        raw = fm[2] ?? fm[3];
      }
      if (!test || raw == null) continue;
      const v = parseValue(raw);
      const qual = v.value == null ? (parseResult(raw)?.qual ?? null) : null;
      // "Primary Sample Type : | Blood" is a label, not a result.
      if (
        v.value == null &&
        qual == null &&
        (/[:#]\s*$/.test(test) || raw.split(/\s+/).length > 3)
      )
        continue;
      observations.push({
        test,
        key: testKey(test),
        canon: canonOf(test),
        raw,
        comparator: v.comparator,
        value: v.value,
        notation: v.notation,
        // Never inferred. pdf.js NFKC-normalizes the micro sign (U+00B5) to
        // Greek mu (U+03BC); fold it back so "µmol/L" reads as printed. The
        // extracted string is kept as unitRaw.
        unit: cell("unit")?.replace(/\u03bc/g, "\u00b5") ?? null,
        unitRaw: cell("unit"),
        range: cell("range"),
        flag: cell("flag") ?? inFlag,
        flagConflict: flagConflict(v, cell("range"), cell("flag") ?? inFlag),
        qual,
        ref: parseReference(
          cell("range"),
          meta.patient?.sex ?? null,
          meta.patient?.age ?? null,
        ),
        section: null,
        source: {
          elementId: row.id,
          start: row.start,
          end: row.end,
          page: row.page ?? null,
          bbox: row.bbox ?? null,
          method: row.method,
          confidence: row.confidence ?? null,
        },
      });
    }
  }
  // Real-world layouts: every line the table reader did not already cover.
  const taken = observations.map((o) => [o.source.start, o.source.end]);
  const overlaps = (a, b) =>
    taken.some(([s, e]) => typeof s === "number" && s < b && e > a);
  for (const r of readLabText(doc.text)) {
    if (overlaps(r.start, r.end)) continue;
    const where = doc.elements?.length ? locate(doc, r.start, r.end) : null;
    const region = where?.regions?.[0];
    observations.push({
      test: r.test,
      key: testKey(r.test),
      canon: canonOf(r.test),
      raw: r.raw,
      comparator: r.comparator,
      value: r.value,
      notation: r.notation,
      unit: normUnit(r.unit),
      unitRaw: r.unit,
      range: r.range,
      flag: r.flag,
      flagConflict: flagConflict(r, r.range, r.flag),
      qual: r.qual,
      ref: parseReference(
        r.range,
        meta.patient?.sex ?? null,
        meta.patient?.age ?? null,
      ),
      section: r.section,
      source: {
        elementId: where?.elementIds?.[0] ?? null,
        start: r.start,
        end: r.end,
        page: region?.page ?? where?.pages?.[0] ?? null,
        bbox: region?.bbox ?? null,
        method: "lab-lines",
        confidence: where?.minConfidence ?? null,
      },
    });
  }
  return { meta, observations };
}

const STATUS_RANK = {
  amended: 4,
  corrected: 4,
  final: 3,
  preliminary: 1,
  unknown: 0,
};

/**
 * One value per collection: an amended/corrected report supersedes the
 * preliminary/final one collected the same day; the superseded stays listed.
 */
/**
 * Whose results these are: the printed patient ID, else the printed name,
 * else the document itself. Reports are only ever combined under the same
 * subject, so two unidentified uploads are never treated as one person.
 */
export function subjectOf(r) {
  const p = r.meta?.patient;
  if (p?.id) return p.id;
  if (p?.name)
    return (
      "name:" +
      p.name
        .toLowerCase()
        .replace(/[^a-z]+/g, " ")
        .trim()
    );
  return "doc:" + (r.sourceId ?? r.title);
}
/** When a report's sample was taken: ISO date, else the printed date, else the document. */
export const dateKeyOf = (r) =>
  r.meta?.collected ??
  r.meta?.reported ??
  (r.meta?.dateRaw
    ? "raw:" + r.meta.dateRaw
    : "doc:" + (r.sourceId ?? r.title));

export function seriesFor(reports, key, patientId) {
  const byDate = new Map();
  for (const r of reports) {
    if (subjectOf(r) !== patientId) continue;
    const date = dateKeyOf(r);
    for (const o of r.observations) {
      if (o.key !== key) continue;
      const list = byDate.get(date) ?? [];
      // the same test twice in one report (percent and absolute count) is
      // two rows, not a correction: keep the first, as printed
      if (list.some((x) => x.report === r)) continue;
      list.push({ ...o, report: r });
      byDate.set(date, list);
    }
  }
  return [...byDate.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, list]) => {
      list.sort(
        (a, b) =>
          STATUS_RANK[b.report.meta.status] -
            STATUS_RANK[a.report.meta.status] ||
          (b.report.meta.reported ?? "").localeCompare(
            a.report.meta.reported ?? "",
          ),
      );
      const [current, ...older] = list;
      return {
        date,
        current,
        superseded: older.filter((o) => o.raw !== current.raw),
      };
    });
}

function interval(o) {
  if (o.value == null) return null;
  if (o.comparator === "<" || o.comparator === "<=")
    return [-Infinity, o.value];
  if (o.comparator === ">" || o.comparator === ">=") return [o.value, Infinity];
  return [o.value, o.value];
}

/** @returns {{comparable: boolean, reason?: string, direction?: "higher"|"lower"|"same"|"undetermined", rangeChanged?: boolean}} */
export function compare(prev, curr) {
  if (prev.key !== curr.key) return { comparable: false, reason: "test" };
  if (!prev.unit || !curr.unit)
    return { comparable: false, reason: "missing_unit" };
  if (unitKey(prev.unit) !== unitKey(curr.unit))
    return { comparable: false, reason: "unit" };
  const a = interval(prev);
  const b = interval(curr);
  if (!a || !b) return { comparable: false, reason: "non_numeric" };
  let direction = "undetermined";
  if (
    a[1] < b[0] ||
    (a[1] === b[0] && (prev.comparator === "<" || curr.comparator === ">"))
  )
    direction = "higher";
  else if (
    b[1] < a[0] ||
    (b[1] === a[0] && (curr.comparator === "<" || prev.comparator === ">"))
  )
    direction = "lower";
  else if (a[0] === a[1] && b[0] === b[1] && a[0] === b[0]) direction = "same";
  return {
    comparable: true,
    direction,
    rangeChanged: (prev.range ?? "") !== (curr.range ?? ""),
  };
}
