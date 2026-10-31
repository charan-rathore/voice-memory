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

export function reportMeta(text) {
  const patient =
    /Patient:?\s*([^\n,]+?)\s*,?\s*ID\s*:?\s*([A-Z0-9][A-Z0-9-]{2,})/i.exec(
      text,
    );
  const collected = new RegExp(`Collected:?\\s*(?:on\\s*)?${DATE}`, "i").exec(
    text,
  );
  const reported = new RegExp(`Reported:?\\s*(?:on\\s*)?${DATE}`, "i").exec(
    text,
  );
  const status =
    /Report status:?\s*(final|preliminary|amended|corrected)/i.exec(text);
  return {
    patient: patient
      ? { name: patient[1].trim(), id: patient[2].toUpperCase() }
      : null,
    collected: collected
      ? isoDate(collected[1], collected[2], collected[3])
      : null,
    reported: reported ? isoDate(reported[1], reported[2], reported[3]) : null,
    status: status ? status[1].toLowerCase() : "unknown",
    amendmentNotes: (text.match(/^.*\bamended\b.*$/gim) ?? [])
      .filter((l) => !/Report status/i.test(l))
      .map((l) => l.trim()),
  };
}

const COLS = {
  test: /^(test|tests|analyte|investigation|parameter|component|test name)$/i,
  result: /^(result|results|value|observed value|your result)$/i,
  unit: /^(unit|units)$/i,
  range:
    /^(reference|ref\.?|normal|biological)?\s*(range|interval|reference range|reference interval)$|^reference$/i,
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
  if (/^h/i.test(flag)) return v.value <= hi;
  if (/^l/i.test(flag)) return v.value >= lo;
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
        if (col[k] === undefined && re.test(h.trim())) col[k] = i;
    });
    if (col.test === undefined || col.result === undefined) continue; // not a results table
    for (const row of doc.elements.filter(
      (e) => e.parent === t.id && e.type === "table-row",
    )) {
      const cell = (k) =>
        col[k] === undefined ? null : (row.cells[col[k]] ?? "").trim() || null;
      const test = cell("test");
      const raw = cell("result");
      if (!test || raw == null) continue;
      const v = parseValue(raw);
      observations.push({
        test,
        key: testKey(test),
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
        flag: cell("flag"),
        flagConflict: flagConflict(v, cell("range"), cell("flag")),
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
export function seriesFor(reports, key, patientId) {
  const byDate = new Map();
  for (const r of reports) {
    if (r.meta.patient?.id !== patientId || !r.meta.collected) continue;
    for (const o of r.observations) {
      if (o.key !== key) continue;
      const list = byDate.get(r.meta.collected) ?? [];
      list.push({ ...o, report: r });
      byDate.set(r.meta.collected, list);
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
