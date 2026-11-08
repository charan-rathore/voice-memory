import { validIso } from "./calendar.mjs";
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
  isMaskedIdentity,
} from "./lab-lines.mjs";
import { locate } from "../ingest/canonical.mjs";
import { OCR_REVIEW_CONFIDENCE } from "../ingest/errors.mjs";
import { canonOf, ocrFixName } from "./explain.mjs";

export const MONTHS = {
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
  जनवरी: 1,
  फ़रवरी: 2,
  फरवरी: 2,
  मार्च: 3,
  अप्रैल: 4,
  मई: 5,
  जून: 6,
  जुलाई: 7,
  अगस्त: 8,
  सितंबर: 9,
  सितम्बर: 9,
  अक्टूबर: 10,
  नवंबर: 11,
  नवम्बर: 11,
  दिसंबर: 12,
  दिसम्बर: 12,
};
const DATE = String.raw`(\d{1,2})\s+([A-Za-z]{3,9})\.?\s+(\d{4})`;

function isoDate(d, m, y) {
  const mm = MONTHS[m.toLowerCase()];
  if (!mm) return null;
  return validIso(y, mm, d);
}

const WITHHELD =
  /^(not released|not reported|not done|pending|to follow|cancelled|canceled|withheld)$/i;

const DOB_LABEL = /^(date of birth|dob|d\.o\.b\.?|birth date)$/i;
/** Date of birth as printed: "DOB: 04 Dec 1968", or a stacked table header. */
export function dobOf(full) {
  const head = full.slice(0, 6000);
  const inline =
    /\b(?:DOB|D\.O\.B\.?|Date of birth)\s*[:|]?\s*(\d{1,2}(?:st|nd|rd|th)?[ -](?:[A-Za-z]{3,9})\.?,?[ -]\d{4}|(?:[A-Za-z]{3,9})\.?\s+\d{1,2}(?:st|nd|rd|th)?,?\s+\d{4}|\d{4}-\d{2}-\d{2}|\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4})/i.exec(
      head,
    );
  if (inline) return inline[1];
  const lines = head.split("\n");
  for (let i = 0; i < lines.length - 1; i++) {
    if (!lines[i].startsWith("|")) continue;
    const cells = lines[i]
      .split("|")
      .slice(1, -1)
      .map((c) => c.trim());
    const at = cells.findIndex((c) => DOB_LABEL.test(c));
    if (at < 0) continue;
    let j = i + 1;
    if (/^\|\s*-{3}/.test(lines[j] ?? "")) j++;
    const v = (lines[j] ?? "").split("|").slice(1, -1)[at]?.trim();
    if (v && /\d{4}/.test(v)) return v;
  }
  return null;
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
  const g = genericMeta(text, full);
  // No "Report status:" field: a status printed as a capitalised label in
  // the first header lines ("PRELIMINARY", "AMENDED / FINAL"). Capitals
  // only and header lines only, so prose ("superseded by the amended
  // version") never sets a status.
  const label =
    status ??
    /\b(AMENDED|CORRECTED|REVISED|PRELIMINARY|PROVISIONAL|INTERIM|FINAL)\b/.exec(
      full
        .split("\n")
        .map((l) => l.replace(/^#+\s*/, "").trim())
        .filter(Boolean)
        .slice(0, 4)
        .join("\n"),
    );
  const st = label?.[1].toLowerCase();
  return {
    patient: patient
      ? {
          name: patient[1].trim(),
          id: patient[2].toUpperCase(),
          sex: g.patient?.sex ?? null,
          age: g.patient?.age ?? null,
        }
      : g.patient,
    dob: dobOf(full),
    accession: g.accession ?? null,
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
export function extractReport(doc, { metaText = doc.text } = {}) {
  const meta = reportMeta(metaText);
  const observations = [];
  const tables = doc.elements.filter((e) => e.type === "table");
  for (const t of tables) {
    const header = doc.elements.find(
      (e) => e.parent === t.id && e.type === "table-header",
    );
    if (!header) continue;
    const col = {};
    header.cells.forEach((h, i) => {
      // "TEST / ANALYTE", "FINAL RESULT", "PRINTED REFERENCE": a qualifier
      // or an alternative name still names the column's role.
      const names = [
        h.trim(),
        ...h
          .split(/\s*\/\s*/)
          .map((x) =>
            x
              .trim()
              .replace(
                /^(printed|final|reported|your|lab(?:oratory)?|corrected)\s+/i,
                "",
              ),
          ),
      ];
      for (const [k, re] of Object.entries(COLS))
        if (col[k] === undefined && names.some((n) => re.test(n))) {
          col[k] = i;
          break; // one role per column ("Value" is the result, not a range)
        }
    });
    if (col.test === undefined || col.result === undefined) continue; // not a results table
    const rowsOf = doc.elements.filter(
      (e) => e.parent === t.id && e.type === "table-row",
    );
    // A header OCR garbled ("Reference rang@lag") still leaves columns whose
    // cells say what they are. Only for columns the header did not name,
    // and only when most of the column agrees.
    const taken = new Set(Object.values(col));
    const RANGE_CELL = /^(?:[<>≤≥]\s*\d[\d.,]*|\d[\d.,]*\s*[-–]\s*\d[\d.,]*)$/;
    for (let i = 0; i < header.cells.length; i++) {
      if (taken.has(i)) continue;
      const cells = rowsOf
        .map((r) => (r.cells[i] ?? "").trim())
        .filter(Boolean);
      if (cells.length < 2) continue;
      const share = (re) =>
        cells.filter((c) => re.test(c)).length / cells.length;
      if (col.range === undefined && share(RANGE_CELL) >= 0.6) col.range = i;
      else if (col.flag === undefined && share(/^(H|L|HH|LL|\*)$/) >= 0.6)
        col.flag = i;
    }
    for (const row of rowsOf) {
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
      // A test the lab printed without releasing a number ("NOT RELEASED",
      // "PENDING"): kept, so "what is the ratio?" is answered with what the
      // report says instead of "not in these reports".
      if (test && raw == null) {
        const held = row.cells
          .map((c) => (c ?? "").trim())
          .find((c) => WITHHELD.test(c));
        if (held && !/^(test|analyte)/i.test(test))
          observations.push({
            test,
            key: testKey(test),
            canon: canonOf(test),
            raw: held,
            comparator: null,
            value: null,
            notation: "withheld",
            unit: null,
            unitRaw: null,
            range: null,
            flag: null,
            flagConflict: false,
            qual: "not released",
            notReleased: true,
            ref: null,
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
        continue;
      }
      if (!test || raw == null) continue;
      const v = parseValue(raw);
      const withheld = v.value == null && WITHHELD.test(raw);
      const qual = withheld
        ? "not released"
        : v.value == null
          ? (parseResult(raw)?.qual ?? null)
          : null;
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
        ...(withheld ? { notReleased: true } : {}),
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
      rangeRaw: r.rangeRaw ?? null,
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
  markUnreadable(observations);
  // A row an overlay-scale stamp crosses is suspected-covered: whatever
  // sits under the stamp (value, unit or range) comes from the embedded
  // text layer alone and cannot be confirmed from the page. Conservative
  // heuristic, fail-closed: axis-aligned boxes over-cover rotated stamp
  // text, so suspicion is flagged, never visibility or invisibility.
  const overlays = (doc.elements ?? []).filter(
    (e) => e.type === "overlay" && e.bbox && e.page != null,
  );
  if (overlays.length)
    for (const o of observations) {
      const b = o.source?.bbox;
      if (
        b &&
        overlays.some(
          (w) =>
            w.page === o.source.page &&
            w.bbox[0] < b[2] &&
            b[0] < w.bbox[2] &&
            w.bbox[1] < b[3] &&
            b[1] < w.bbox[3],
        )
      )
        o.suspectObscured = true;
    }
  // Declared watermark annotation on the page: the report is a stamped
  // copy, so any printed cell may be unreadable on the page itself.
  const stampedPages = new Set(
    (doc.pages ?? []).filter((pg) => pg.watermark).map((pg) => pg.number),
  );
  if (stampedPages.size)
    for (const o of observations) {
      // Unknown page: the stamp could be on the page the row came from.
      if (o.source?.page == null || stampedPages.has(o.source.page))
        o.stampedCopy = true;
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
/**
 * Two reports printing the same patient ID still describe different people
 * when the reports themselves disagree: a different printed sex, or ages that
 * cannot both be true given the collection dates (more than one year apart
 * after allowing for the time between collections).
 */
/**
 * Every date a printed DOB string could mean, as ISO keys. ISO
 * (2026-01-12) and alphabetic-month (12 Jan 1980) forms are unambiguous:
 * one interpretation. A numeric date with a 4-digit year is certain when
 * one number must be the day (15/03/1965), genuinely ambiguous when both
 * could be (03/07/1965: 3 July or 7 March) - then both interpretations are
 * returned, never a guess. Anything else (2-digit years, no 4-digit year)
 * is unparseable: []. Month names parse via the month table, never
 * Date.parse - its local-midnight result shifts the day under toISOString.
 */
/** Calendar-valid ISO key, or null: 2020-02-30 and 1980-00-00 are not dates. */

export function dobInterpretations(raw) {
  if (!raw) return [];
  const s = String(raw).trim();
  const isoFast = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (isoFast) {
    const k = validIso(isoFast[1], isoFast[2], isoFast[3]);
    return k ? [k] : [];
  }
  const yf = /^(\d{4})[/.](\d{1,2})[/.](\d{1,2})$/.exec(s);
  if (yf) {
    const k = validIso(yf[1], yf[2], yf[3]);
    return k ? [k] : [];
  }
  const num = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(s);
  if (num) {
    const [, a, b, y] = num;
    return [...new Set([validIso(y, b, a), validIso(y, a, b)].filter(Boolean))];
  }
  if (/^[\d\/.-]+$/.test(s)) return []; // e.g. 2-digit year: century unknown
  const ord =
    /^(\d{1,2})(?:st|nd|rd|th)\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})$/i.exec(s);
  if (ord) {
    const k = isoDate(ord[1], ord[2], ord[3]);
    return k ? [k] : [];
  }
  const m = new RegExp(`^${DATE}$`).exec(s);
  if (m) {
    const k = isoDate(m[1], m[2], m[3]);
    return k ? [k] : [];
  }
  const mf =
    /^([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})$/i.exec(s);
  if (mf) {
    const k = isoDate(mf[2], mf[1], mf[3]);
    return k ? [k] : [];
  }
  const y = /^(\d{4})[ -]([A-Za-z]{3,9})\.?[ -](\d{1,2})$/.exec(s);
  if (y) {
    const k = isoDate(y[3], y[2], y[1]);
    return k ? [k] : [];
  }
  return [];
}

/**
 * A confident date-of-birth key, or null when the printed form has more
 * than one reading (or none). Equivalent dates in different unambiguous
 * formats produce the same key, so a format change alone never splits one
 * person into two.
 */
export function dobKey(raw) {
  const ks = dobInterpretations(raw);
  return ks.length === 1 ? ks[0] : null;
}

/**
 * Do two printed DOB strings describe the same date? "same" only when every
 * reading of each agrees; "conflict" when no reading of one can match any
 * reading of the other (one of them certain, so they genuinely disagree);
 * "undecidable" when the readings overlap without certainly matching (a
 * genuinely ambiguous format against anything else); "unknown" when either
 * side never parsed. Undecidable is not a match: two reports that cannot be
 * shown to share a birth date are not silently combined.
 */
export function dobRelation(rawA, rawB) {
  if (!rawA || !rawB) return "unknown"; // a missing DOB proves nothing either way
  const ia = dobInterpretations(rawA);
  const ib = dobInterpretations(rawB);
  // Two different printed DOB strings neither side can parse are NOT
  // "unknown": they cannot be shown to match, so combining the reports
  // would rest on nothing. That is undecidable - abstain, never merge.
  if (!ia.length || !ib.length) return "undecidable";
  const overlap = ia.some((x) => ib.includes(x));
  if (!overlap)
    return ia.length === 1 || ib.length === 1 ? "conflict" : "undecidable";
  return ia.length === 1 && ib.length === 1 ? "same" : "undecidable";
}

export function identityConflict(a, b) {
  const pa = a.meta?.patient ?? {};
  const pb = b.meta?.patient ?? {};
  if (pa.sex && pb.sex && pa.sex !== pb.sex) return true;
  // One patient ID with two printed birth dates that disagree - certainly
  // or undecidably - is an identity conflict, the same as two sexes: never
  // a trend across them. The printed strings stay on meta.dob for review.
  const rel = dobRelation(a.meta?.dob, b.meta?.dob);
  if (rel === "conflict" || rel === "undecidable") return true;
  if (pa.age != null && pb.age != null) {
    const da = Date.parse(a.meta?.collected ?? "");
    const db = Date.parse(b.meta?.collected ?? "");
    const years =
      Number.isFinite(da) && Number.isFinite(db)
        ? Math.abs(da - db) / 31557600000
        : 0;
    if (Math.abs(pa.age - pb.age) > years + 1) return true;
  }
  return false;
}

/**
 * Marks reports whose shared patient ID is contradicted by the reports
 * themselves (identityConflict). Call once on the full report list; such
 * reports then stay separate in answers and graphs. Returns the list.
 */
export function markIdentityConflicts(reports) {
  for (const r of reports ?? []) {
    const p = r.meta?.patient;
    if (!p?.id) continue;
    // recomputed every time: cached reports may be re-used in a new set
    p.idConflict = reports.some(
      (x) => x !== r && x.meta?.patient?.id === p.id && identityConflict(r, x),
    );
    // Why, when a printed birth date drove it: "dob" when the dates
    // certainly disagree, "dob-undecidable" when they cannot be shown to
    // match. The printed strings themselves stay on meta.dob for review.
    const rel = reports
      .filter((x) => x !== r && x.meta?.patient?.id === p.id)
      .map((x) => dobRelation(r.meta?.dob, x.meta?.dob))
      .find((r2) => r2 === "conflict" || r2 === "undecidable");
    p.idConflictKind =
      rel === "conflict"
        ? "dob"
        : rel === "undecidable"
          ? "dob-undecidable"
          : undefined;
  }
  return reports;
}

export function subjectOf(r) {
  // Identity contract: only a printed PATIENT identifier links reports. A
  // shared printed name (two John Smiths) or lab/accession number never
  // does; such reports stay separate and the answer asks whose they are.
  const p = r.meta?.patient;
  if (p?.id && !isMaskedIdentity(p.id) && !p.idConflict) return p.id;
  // A record without an identifier is its own subject: per file, and per
  // record inside a consolidated packet.
  return "doc:" + (r.sourceId ?? r.title) + (r.segment ? "#" + r.segment : "");
}
/** When a report's sample was taken: ISO date, else the printed date, else the document. */
export const dateKeyOf = (r) =>
  r.meta?.collected ??
  r.meta?.reported ??
  (r.meta?.dateRaw
    ? "raw:" + r.meta.dateRaw
    : "doc:" + (r.sourceId ?? r.title) + (r.segment ? "#" + r.segment : ""));

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
      const [selected, ...older] = list;
      const rank = STATUS_RANK[selected.report.meta.status] ?? 0;
      const peers = list.filter(
        (o) => (STATUS_RANK[o.report.meta.status] ?? 0) === rank,
      );
      const distinct = new Set(
        peers.map((o) => JSON.stringify([o.raw, o.unit, o.comparator, o.qual])),
      );
      const conflicts = distinct.size > 1 ? peers : [];
      const current = conflicts.length
        ? { ...selected, authorityConflict: true }
        : selected;
      return {
        date,
        current,
        conflicts,
        superseded: conflicts.length
          ? []
          : older.filter((o) => o.raw !== current.raw),
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
  if (
    prev.unreadable ||
    curr.unreadable ||
    prev.authorityConflict ||
    curr.authorityConflict
  )
    return { comparable: false, reason: "source_uncertain" };
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

/**
 * A consolidated packet: several records (an intake note, a preliminary lab
 * report, its amendment, a discharge summary, a bill) printed into one PDF.
 * Returns one segment per record, or null when the file reads as a single
 * record (the usual case, left exactly as before).
 *
 * A page whose own header names a patient ID plus a date or a status starts
 * a record; consecutive pages with the same header continue it (a long
 * report repeating its header). The file is a packet only when at least two
 * DIFFERENT headers appear. Inside a packet, a page with no header of its
 * own is kept as its own record with no patient and no date, so a number in
 * a draft note can never join another record's results.
 */
export function packetSegments(doc) {
  if (!doc.elements?.length) return null;
  const span = new Map();
  for (const e of doc.elements) {
    if (e.page == null || !Number.isInteger(e.start)) continue;
    const r = span.get(e.page) ?? [Infinity, -1];
    span.set(e.page, [Math.min(r[0], e.start), Math.max(r[1], e.end)]);
  }
  const records = [];
  for (const n of [...span.keys()].sort((a, b) => a - b)) {
    const [a, b] = span.get(n);
    const pageText = doc.text.slice(a, b);
    // Explicit patient headers delimit independent records even on one page.
    // This is a bounded textual boundary, not a general visual-layout claim.
    const headers = [
      ...pageText.matchAll(/^Patient:[^\n]*\bID\b[^\n]*$/gim),
    ].map((m) => a + m.index);
    const starts = [
      a,
      ...headers.slice(1).map((at) => {
        const prior = doc.elements
          .filter((e) => e.page === n && e.type === "heading" && e.end <= at)
          .at(-1);
        return prior && prior.start > headers[headers.indexOf(at) - 1]
          ? prior.start
          : at;
      }),
    ];
    for (let i = 0; i < starts.length; i++) {
      const start = starts[i],
        end = starts[i + 1] ?? b;
      const m = reportMeta(doc.text.slice(start, end));
      const id = m.patient?.id;
      const own =
        !!id && !!(m.collected || m.reported || m.status !== "unknown");
      records.push({
        start,
        end,
        pages: [n],
        key: own ? [id, m.collected, m.reported, m.status].join("|") : null,
      });
    }
  }
  if (!records.some((r) => r.key)) return null;
  const segs = [];
  for (const r of records) {
    const last = segs.at(-1);
    // Only explicitly repeated ownership allows continuation across pages.
    if (r.key && last?.key === r.key && !last.pages.includes(r.pages[0])) {
      last.end = r.end;
      last.pages.push(...r.pages);
    } else segs.push({ ...r });
  }
  if (segs.length < 2) return null;
  return segs.map(({ key, ...seg }, i) => ({ ...seg, index: i + 1 }));
}

/**
 * One record of a packet as a document of its own. Offsets are preserved
 * (text outside the record is blanked, not removed) so every observation
 * still points at the exact characters of the original file; the header is
 * read from the record's own text.
 */
export function extractSegment(doc, seg) {
  if (
    !Number.isInteger(seg.start) ||
    !Number.isInteger(seg.end) ||
    seg.start < 0 ||
    seg.end > doc.text.length ||
    seg.start >= seg.end
  )
    throw new RangeError("Invalid record segment span");
  const inside = new Set(seg.pages ?? []);
  // A record boundary inside an extracted line does not prove that the
  // surviving label/value/unit fragment is a complete observation. Keep
  // whole lines within the supplied span, never synthesize a shorter row.
  const lineStart =
    seg.start === 0 || doc.text[seg.start - 1] === "\n"
      ? seg.start
      : doc.text.indexOf("\n", seg.start);
  const safeStart = lineStart < 0 ? seg.end : Math.min(lineStart, seg.end);
  const safeEnd =
    seg.end === doc.text.length || doc.text[seg.end] === "\n"
      ? seg.end
      : Math.max(seg.start, doc.text.lastIndexOf("\n", seg.end - 1));
  const contained = (e) =>
    Number.isInteger(e.start) &&
    Number.isInteger(e.end) &&
    e.start >= seg.start &&
    e.end <= seg.end &&
    e.start < e.end;
  const elements = doc.elements.filter(
    (e) => e.type !== "table" && e.type !== "table-header" && contained(e),
  );
  // A paragraph can contain several complete source lines. Keep location
  // metadata for those lines without copying any out-of-span text. Its
  // original bbox is only the containing region, not a new precise crop.
  for (const e of doc.elements) {
    if (
      e.type !== "paragraph" ||
      contained(e) ||
      !Number.isInteger(e.start) ||
      !Number.isInteger(e.end)
    )
      continue;
    const start = Math.max(e.start, safeStart);
    const end = Math.min(e.end, safeEnd);
    if (start < end)
      elements.push({ ...e, start, end, text: doc.text.slice(start, end) });
  }
  // Overlays deliberately have no indexed span. Keep their conservative
  // page-local obstruction signal; dropping them would certify stamped
  // values that the full-document reader treats as suspected-covered.
  const retainedPages = new Set(
    elements.map((e) => e.page).filter((p) => p != null),
  );
  elements.push(
    ...doc.elements.filter(
      (e) =>
        e.type === "overlay" && (e.page == null || retainedPages.has(e.page)),
    ),
  );
  // A table may straddle a supplied boundary. Only complete rows belong to
  // this segment. Its header describes column roles, not record identity;
  // retain that structural context even when the header precedes the span.
  // Never keep the original parent's rows payload: it can contain other
  // records' values. Observation source offsets remain the original row's.
  for (const table of doc.elements.filter((e) => e.type === "table")) {
    const rows = elements.filter(
      (e) => e.type === "table-row" && e.parent === table.id,
    );
    if (!rows.length) continue;
    const header = doc.elements.find(
      (e) => e.type === "table-header" && e.parent === table.id,
    );
    if (!header) continue;
    elements.push(
      {
        ...table,
        start: Math.max(seg.start, table.start),
        end: Math.min(seg.end, table.end),
        rows: undefined,
      },
      header,
    );
  }
  let text =
    " ".repeat(seg.start) +
    doc.text.slice(seg.start, seg.end) +
    " ".repeat(doc.text.length - seg.end);
  // A cut row must not re-enter through the text-line fallback with its
  // surviving fragment. Mask it without shifting any canonical offsets.
  for (const row of doc.elements.filter((e) => e.type === "table-row")) {
    if (contained(row) || !(row.start < seg.end && row.end > seg.start))
      continue;
    const a = Math.max(seg.start, row.start);
    const b = Math.min(seg.end, row.end);
    text = text.slice(0, a) + " ".repeat(b - a) + text.slice(b);
  }
  const mask = (a, b) => {
    if (a < b) text = text.slice(0, a) + " ".repeat(b - a) + text.slice(b);
  };
  mask(seg.start, safeStart);
  mask(Math.max(seg.start, safeEnd), seg.end);
  const part = {
    ...doc,
    text,
    elements,
    pages: (doc.pages ?? []).filter((p) => inside.has(p.number)),
  };
  return extractReport(part, { metaText: text.slice(seg.start, seg.end) });
}

// Units laboratories print. A scanned row whose unit is not one of these
// ("miv/t", "ng/mb") was misread somewhere along the row.
const LAB_UNIT =
  /^(?:%|fl|pg|[mµunp]?g\/(?:d?l|ml|l)|[mµunp]?mol\/l|m?eq\/l|[mµ]?i?u\/(?:m?l|l)|[mµu]iu\/(?:m?l|l)|iu\/(?:m?l|l)|u\/l|10[\^*]\d+\/[µu]?l|10[\^*]\d+\/mm3|lakhs?\/(?:cumm|µl|ul)|cells\/(?:µl|ul|cumm)|\/cumm|\/hpf|mm\/h(?:r|our)?|mm(?:hg)?|s(?:ec(?:onds?)?)?|ratio|index|ml\/min(?:\/1\.73\s*m2)?|kg\/m2|g\/24\s*h(?:rs?)?|mg\/24\s*h(?:rs?)?|ng\/ml\/h(?:r)?|copies\/ml|titre|titer|mosm\/kg)$/i;
const OCR_ROW = (o) =>
  o.source?.method === "ocr" ||
  (o.source?.method === "lab-lines" && o.source?.confidence != null);

/**
 * OCR uncertainty is evidence about the reading, never about whether a
 * measured result is clinically plausible. Preserve the raw value and
 * withhold weak readings; a reference range cannot supply missing digits.
 */
export function markUnreadable(observations) {
  for (const o of observations) {
    if (OCR_ROW(o)) {
      // "HbAlc" -> "HbA1c": the printed name as the lab meant it; the raw
      // OCR reading is kept for provenance.
      const fixed = ocrFixName(o.test);
      if (fixed !== o.test) {
        o.testRaw = o.test;
        o.test = fixed;
      }
    }
    if (!OCR_ROW(o) || o.qual || o.value == null) continue;
    const page = o.source?.page ?? null;
    const confidence = o.source?.confidence ?? null;
    if (confidence == null || confidence < OCR_REVIEW_CONFIDENCE)
      o.unreadable = { reason: "confidence", page, confidence, maybe: null };
    if (
      !o.unreadable &&
      o.unit &&
      !LAB_UNIT.test(String(o.unit).replace(/\s+/g, ""))
    )
      o.unreadable = { reason: "unit", page, confidence, maybe: null };
  }
  return observations;
}
