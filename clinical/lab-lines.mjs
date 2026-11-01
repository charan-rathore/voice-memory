// Lab results from real-world report layouts (research prototype).
//
// observations.mjs reads tables whose header it recognises (Test | Result |
// Unit | Reference range | Flag). Real reports rarely cooperate: the header
// is a line of its own ("TEST NAME  RESULTS  UNIT  REFERENCE VALUES"), rows
// are split by method lines ("IFCC", "(Calculated)"), the reference range
// comes before the unit, a flag sits inside the range cell ("Low 13.0 -
// 17.0"), ranges are sex- or age-specific ("13-99 YRS,Male:13.5-18"), Indian
// digit grouping appears ("1,50,000"), and serology is qualitative
// ("POSITIVE" against an expected "NEGATIVE").
//
// So this reader works line by line on the canonical text and decides what
// each piece is from its content, not its column position:
//   result = the first value after the test name (number, bound or
//            qualitative word); unit = a token shaped like a unit;
//   range  = anything shaped like a reference interval; flag = H/L words.
// A line is only accepted as a result when it has a test name, a value and
// at least a unit or a range, so prose and headers do not become results.
//
// Same safety rules as observations.mjs: nothing is inferred. A unit that is
// not printed stays null; an ambiguous range (several sexes, patient's sex
// unknown; a lone number) is kept as text and never used to judge a value.

// ------------------------------------------------------------ tokens
const NUM = String.raw`\d{1,3}(?:,\d{2,3})+(?:\.\d+)?|\d+(?:\.\d+)?|\.\d+`;
const QUAL_WORDS = [
  "non[- ]?reactive",
  "reactive",
  "not detected",
  "detected",
  "negative",
  "positive",
  "absent",
  "present",
  "nil",
  "trace",
];
const QUAL_RE = new RegExp(
  `^(${QUAL_WORDS.join("|")})(\\s*\\([+-]+\\))?$`,
  "i",
);
const VALUE_RE = new RegExp(`^(<=|>=|<|>|≤|≥)?\\s*(${NUM})$`);
const FLAG_RE =
  /^(h|l|hh|ll|high|low|borderline|abnormal|critical|crit|panic|\*+|h■|l■|↑|↓)$/i;
// Units: a token with a slash, percent, power, or a known bare unit.
const BARE_UNITS =
  /^(%|fl|fL|pg|iu|u|miu|mu|sec|secs|seconds|s|mm|ratio|index|cells|lakhs?|million|mill|thou|cumm|cmm|µl|μl|ul|meq|mmol|umol|µmol|μmol|ng|mg|g|kg|ml|l|mm\/hr|mm\/1st hr|copies|titre|titer|bpm|mmhg)$/i;
const looksUnit = (s) => {
  const t = s.trim().replace(/\s*\/\s*/g, "/");
  if (!t || t.length > 18) return false;
  if (/^\d+(\.\d+)?$/.test(t)) return false;
  if (BARE_UNITS.test(t)) return true;
  if (/^(10|x10)\^?\d+\/?[a-zµμ]*l?$/i.test(t)) return true;
  if (/^\/[a-zµμ]+$/i.test(t)) return true; // "/Cmm", "/hpf"
  if (/^[a-zµμ%0-9^.*]+\/[a-zµμ0-9^.*]+$/i.test(t) && /[a-zµμ%]/i.test(t))
    return true;
  return false;
};
export const normUnit = (u) =>
  u == null
    ? null
    : String(u)
        .trim()
        .replace(/\s*\/\s*/g, "/")
        .replace(/μ/g, "µ");

// Words that start metadata lines, never test names.
const META_RE =
  /^(patient|name|age|sex|gender|date|dob|uhid|mrn|mr\s*#|mr\s*no|lab\s*#|lab\s*no|bill|ref|referred|ref\.? by|contact|phone|mobile|email|address|page|reported|report status|report date|collected|collection|sampled|sample|specimen|registered|received|printed|print|department|pid|id|visit|ward|bed|consultant|doctor|dr\.?|verified|approved|generated|time|primary sample|a\/c status|processed|barcode|accession|order|location|branch|client|interpretation|note|comment|method|instrument|technique|remarks?)\b/i;

// ------------------------------------------------------------ values
export function parseResult(raw) {
  const s = String(raw ?? "")
    .trim()
    .replace(/[■]/g, "");
  const q = QUAL_RE.exec(s);
  if (q)
    return {
      comparator: null,
      value: null,
      qual: q[1].toLowerCase().replace(/[- ]+/g, " "),
      notation: "qualitative",
    };
  const m = VALUE_RE.exec(s);
  if (!m) return null;
  const grouped = m[2].includes(",");
  const n = Number(m[2].replace(/,/g, ""));
  if (!Number.isFinite(n)) return null;
  return {
    comparator: { "≤": "<=", "≥": ">=" }[m[1]] ?? m[1] ?? null,
    value: n,
    qual: null,
    notation: grouped ? "grouped" : "decimal-point",
  };
}

// ------------------------------------------------------------ reference ranges
const QUAL_REF =
  /^(negative|non[- ]?reactive|not detected|absent|nil|normal)\b/i;
const AGE_SPAN =
  /\b\d+\s*(?:-|–|to)\s*\d+\s*(?:yrs?|years?|y|days?|d|months?|mo|m)\b\.?\s*,?/gi;
const CHILD_LABEL =
  /(new\s*born|newborn|neonat\w*|infant\w*|child\w*|paed\w*|ped\w*|upto\s*\d+\s*month\w*|\d+\s*month\w*\s*-\s*\d+\s*y\w*|\d+\s*-\s*\d+\s*y(?:rs?|ears?)?\b|premature|full\s*term|\d+\s*-\s*\d+\s*days?|cord)/i;
const SEX_LABEL =
  /\b(male|female|men|women|m\/f|m|f)\s*[:=\s-]*(?=[<>≤≥]?\s*\d)/gi;

const n = (s) => Number(String(s).replace(/,/g, ""));
// "01" reads as "1"; "0.30" keeps its printed precision.
const said = (s) => String(s).replace(/^0+(?=\d)/, "");
/** One interval from a fragment like "13.5-18", "< 5.0", "up to 40", "32.5 +/- 2.5". */
function interval(frag) {
  const s = frag
    .replace(/^[\s:=,;(]+|[\s,;)]+$/g, "")
    .replace(/(\d)\s*:\s*1\b/g, "$1"); // "1.5:1-2.5:1" ratios
  let m;
  if ((m = new RegExp(`^(${NUM})\\s*\\+/-\\s*(${NUM})`).exec(s)))
    return {
      lowN: n(m[1]) - n(m[2]),
      highN: n(m[1]) + n(m[2]),
      low: String(+(n(m[1]) - n(m[2])).toFixed(4)),
      high: String(+(n(m[1]) + n(m[2])).toFixed(4)),
    };
  if (
    (m = new RegExp(
      `^(<=|<|≤|up\\s*to|upto|below)\\s*(${NUM})\\s*[-–]\\s*(${NUM})`,
      "i",
    ).exec(s))
  )
    return { lowN: -Infinity, highN: n(m[3]), low: null, high: said(m[3]) };
  if ((m = new RegExp(`^(${NUM})\\s*(?:-|–|to)\\s*(${NUM})`, "i").exec(s)))
    return n(m[1]) <= n(m[2])
      ? { lowN: n(m[1]), highN: n(m[2]), low: said(m[1]), high: said(m[2]) }
      : null;
  if (
    (m = new RegExp(
      `^(<=|<|≤|up\\s*to|upto|below|less than)\\s*(${NUM})`,
      "i",
    ).exec(s))
  )
    return { lowN: -Infinity, highN: n(m[2]), low: null, high: said(m[2]) };
  if (
    (m = new RegExp(
      `^(>=|>|≥|above|more than|greater than)\\s*(${NUM})`,
      "i",
    ).exec(s))
  )
    return { lowN: n(m[2]), highN: Infinity, low: said(m[2]), high: null };
  return null;
}

/**
 * Parse a printed reference range for a patient of known (or unknown) sex.
 * @returns {null | {lowN, highN, low, high, expected?: string, text}}
 *   low/high are the printed strings (null when the side is open);
 *   expected is set for qualitative references ("negative").
 */
export function parseReference(text, sex = null, age = null) {
  if (!text) return null;
  let s = String(text).replace(/\s+/g, " ").trim();
  // A child's result is never judged against an adult range: sex-specific
  // and "Adults" ranges are adult ranges. (Age bands are not interpreted.)
  if (
    age != null &&
    age < 16 &&
    /\b(adults?|male|female|men|women|m\/f|m|f)\b\s*[:=(]?|\(adults?\)/i.test(s)
  )
    return { lowN: null, highN: null, adultOnly: true, text: s };
  s = s.replace(
    /^(low|high|borderline|normal|abnormal|h|l)\s+(?=[<>≤≥\d])/i,
    "",
  );
  s = s
    .replace(/^\((.*)\)$/, "$1")
    .replace(
      /^(normal\s*range|reference\s*range|ref\.?\s*range)\s*[:=-]?\s*/i,
      "",
    );
  const q = QUAL_REF.exec(s);
  if (q)
    return { expected: q[1].toLowerCase().replace(/[- ]+/g, " "), text: s };
  // Decision thresholds with several categories ("Low: <40, High: >60",
  // "Borderline: 150-199 High: 200-499") are not one reference interval.
  if (
    (
      s.match(
        /\b(desirable|optimal|borderline|near|low|high|very high|risk)\s*[:=]/gi,
      ) ?? []
    ).length >= 2
  )
    return null;
  // Sex-labelled segments ("M:13-17 F:12.0-15.0", "Male:35-104 Female: 35-104").
  const labels = [...s.matchAll(SEX_LABEL)];
  if (labels.length) {
    const segs = labels.map((m, i) => ({
      who: m[1].toLowerCase(),
      body: s.slice(m.index + m[0].length, labels[i + 1]?.index ?? s.length),
    }));
    const fits = (who) =>
      who === "m/f" ||
      (sex === "male" && /^(male|m|men)$/.test(who)) ||
      (sex === "female" && /^(female|f|women)$/.test(who));
    const pick = segs.filter((g) => fits(g.who));
    const all = segs
      .map((g) => interval(g.body.replace(AGE_SPAN, "")))
      .filter(Boolean);
    const same =
      all.length &&
      all.every((r) => r.lowN === all[0].lowN && r.highN === all[0].highN);
    const r = pick.length
      ? interval(pick[0].body.replace(AGE_SPAN, ""))
      : same
        ? all[0]
        : null;
    return r ? { ...r, text: s } : null;
  }
  // Age-labelled alternatives ("Adult:0-1  Premature:..."): adult/unlabelled only.
  const parts = s
    .split(/\s{2,}|;|\|/)
    .flatMap((p) => p.split(/(?<=\d)\s+(?=[A-Za-z][A-Za-z ]*\s*:)/));
  const adult = parts.find((p) => /^adults?\s*[:-]/i.test(p.trim()));
  if (adult) {
    const r = interval(
      adult.replace(/^adults?\s*[:-]/i, "").replace(AGE_SPAN, ""),
    );
    return r ? { ...r, text: s } : null;
  }
  const plain = parts
    .map((p) => p.trim())
    .filter((p) => p && !CHILD_LABEL.test(p));
  if (!plain.length) return null;
  const body = plain[0]
    .replace(AGE_SPAN, "")
    .replace(/^[A-Za-z ]{1,20}:\s*/, "")
    .replace(/\((adults?|adult male|adult female)\)/i, "");
  const r = interval(body);
  return r ? { ...r, text: s } : null;
}

// ------------------------------------------------------------ one line -> one result
const splitCells = (line) =>
  line
    .replace(/^\s*\|/, "")
    .replace(/\|\s*$/, "")
    .split("|")
    .map((c) => c.trim());

const RANGE_SHAPE = new RegExp(
  `(${NUM})\\s*(?:-|–|to)\\s*(${NUM})|^[<>≤≥]\\s*(${NUM})|up\\s*to\\s*(${NUM})|\\+/-|^(negative|non[- ]?reactive|not detected|absent|nil)\\b`,
  "i",
);

// A range starts like one: optional labels ("Low", "Male:", "13-99 YRS,",
// "Adults:"), then a number, a bound or a qualitative word. Prose that merely
// contains "5 to 50" somewhere is not a range.
const RANGE_START =
  /^(?:(?:low|high|borderline)\s+)?(?:[A-Za-z][A-Za-z/ ]{0,14}\s*[:=-]\s*)?(?:\d+\s*-\s*\d+\s*(?:yrs?|years?)\s*,?\s*)?(?:[A-Za-z/]{1,6}\s*[:=]\s*)?(?:[<>≤≥]|up\s*to|upto|\d|\.\d|negative|non[- ]?reactive|not\s+detected|absent|nil)/i;

/** Split the text after the result into flag, unit and range, by shape. */
function tail(rest) {
  let flag = null,
    unit = null,
    range = null;
  let s = rest.trim();
  const f =
    /^(H|L|HH|LL|High|Low|Borderline|Abnormal|Critical|\*+|↑|↓)(?=\s|$)/.exec(
      s,
    );
  if (f) {
    flag = f[1];
    s = s.slice(f[0].length).trim();
  }
  // unit first ("g/dl 13-99 YRS,Male:13.5-18") or last ("13.0 - 17.0 g/dL")
  const toks = s.split(/\s+/).filter(Boolean);
  if (toks.length) {
    // try the longest unit prefix (handles "mg / dL", "U/ L")
    for (let k = Math.min(3, toks.length); k >= 1; k--) {
      const cand = toks.slice(0, k).join(" ");
      if (looksUnit(cand)) {
        unit = cand;
        s = toks.slice(k).join(" ");
        break;
      }
    }
    if (!unit)
      for (let k = Math.min(3, toks.length); k >= 1; k--) {
        const cand = toks.slice(-k).join(" ");
        if (looksUnit(cand) && toks.length > k) {
          unit = cand;
          s = toks.slice(0, -k).join(" ");
          break;
        }
      }
  }
  s = s
    .trim()
    .replace(/^\((.*)\)$/, "$1")
    .replace(
      /^(normal\s*range|normal|reference\s*range|reference|ref\.?\s*range|bio\.?\s*ref\.?\s*(?:interval|range)?|range)\s*[:=-]?\s*/i,
      "",
    )
    .trim();
  if (s && s.length <= 80) {
    const f2 = /^(Low|High|Borderline)\s+/i.exec(s);
    if (f2 && !flag) flag = f2[1];
    if (RANGE_START.test(s) && (RANGE_SHAPE.test(s) || QUAL_REF.test(s)))
      range = s;
  }
  return { flag, unit: normUnit(unit), range };
}

/**
 * Read one line as a lab result, or null.
 * @param {string} line
 * @returns {null | {test, raw, comparator, value, qual, unit, range, flag}}
 */
export function readLabLine(line) {
  const isRow = /^\s*\|/.test(line);
  if (isRow && /^\s*\|\s*-{3}/.test(line)) return null;
  let test, raw, rest;
  if (isRow) {
    const cells = splitCells(line);
    const ti = cells.findIndex((c) => /[A-Za-z]{2}/.test(c));
    if (ti < 0) return null;
    test = cells[ti];
    const ri = cells.findIndex(
      (c, i) => i > ti && c && parseResult(firstToken(c)),
    );
    if (ri < 0) return null;
    const first = firstToken(cells[ri]);
    raw = first;
    rest = [
      cells[ri].slice(cells[ri].indexOf(first) + first.length),
      ...cells.slice(ri + 1),
    ]
      .filter((c) => c && c.trim())
      .join("  ");
  } else {
    const m = new RegExp(
      `^\\s*([A-Za-z(][^|]*?[A-Za-z)%.\\]])\\s*:?\\s+(?:(H|L|High|Low)\\s+)?((?:<=|>=|<|>|≤|≥)?\\s*(?:${NUM})|${QUAL_WORDS.join("|")})(?:\\s*\\([+-]+\\))?(%?)(?=\\s|$)(.*)$`,
      "i",
    ).exec(line);
    if (!m) return null;
    let pre, pct;
    [, test, pre, raw, pct, rest] = m;
    if (pct) rest = "%" + rest;
    if (pre) rest = pre + " " + rest;
  }
  test = test
    .replace(/\s+/g, " ")
    .replace(/[}:]+$/, "")
    .trim();
  if (!validTest(test)) return null;
  const v = parseResult(raw);
  if (!v) return null;
  const t = tail(rest ?? "");
  // A number with neither a unit nor a range is too weak to call a result
  // ("Age 23", "Bill 189455"); a qualitative result needs no unit.
  if (v.qual == null && !t.unit && !t.range) return null;
  if (v.qual == null && t.range == null && !/[a-z]/i.test(t.unit ?? ""))
    return null;
  return {
    test,
    raw: raw.replace(/\s+/g, ""),
    comparator: v.comparator,
    value: v.value,
    qual: v.qual,
    notation: v.notation,
    unit: t.unit,
    range: t.range,
    flag: t.flag,
  };
}
const firstToken = (c) =>
  /^((?:<=|>=|<|>|≤|≥)?\s*[\d.,]+|[A-Za-z]+(?:[- ](?:reactive|detected))?(?:\s*\([+-]+\))?)/.exec(
    c.trim(),
  )?.[1] ?? "";

function validTest(t) {
  if (t.length < 2 || t.length > 70) return false;
  if (
    /^(values?|results?|levels?|ranges?|notes?|total|count|unit|units|method|sample|specimen|page)$/i.test(
      t,
    )
  )
    return false;
  if ((t.match(/[A-Za-z]/g) ?? []).length < 2) return false;
  if (META_RE.test(t)) return false;
  if (/[:#]$/.test(t)) return false;
  if (t.split(/\s+/).length > 9) return false; // prose, not a test name
  if (/[.!?]\s+[A-Z]/.test(t)) return false;
  if (
    /^(child|children|adult|adults|new\s*born|newborn|infant|male|female|men|women|desirable|optimal|borderline|high|low|very high|near)\b/i.test(
      t,
    )
  )
    return false;
  if (
    (
      t.match(
        /\b(that|which|is|are|was|were|the|and|of|to|in|for|with|suggesting)\b/gi,
      ) ?? []
    ).length >= 2
  )
    return false;
  if (/\b(is|are|was|were)\b/i.test(t)) return false;
  return true;
}

// ------------------------------------------------------------ whole document
const HEADING_RE = /^#{0,4}\s*([A-Z][A-Z0-9 ,;:&()/.+'-]{2,70})$/;
/**
 * All lab results in a canonical text, with character offsets and the
 * section heading each sits under ("LIVER FUNCTION TEST- LFT").
 */
export function readLabText(text) {
  const out = [];
  let section = null,
    pos = 0,
    prev = null;
  for (const line of text.split("\n")) {
    const start = pos;
    pos += line.length + 1;
    // Bullets and list numbers ("\uf0b7 Hemoglobin:", "1. Urea:") are not part of the name.
    const trimmed = line
      .trim()
      .replace(
        /^(?:[\u2022\uf0b7\u25aa\u25ba\u00b7*•▪►-]+|\d{1,2}[.)])\s+(?=[A-Za-z(])/,
        "",
      );
    if (!trimmed) continue;
    const r = readLabLine(trimmed);
    if (r) {
      const lead = line.indexOf(trimmed);
      out.push({
        ...r,
        section,
        start: start + lead,
        end: start + lead + trimmed.length,
      });
      prev = out.at(-1);
      continue;
    }
    // "IFCC | | | Female : 35-104" or "Female : 35-104": the range continues.
    if (
      prev &&
      /\b(male|female|m\/f)\s*:/i.test(trimmed) &&
      !/[a-z]{3,}\s+\d/i.test(trimmed.replace(/(male|female)\s*:/gi, ""))
    ) {
      const extra = isRowLine(trimmed)
        ? splitCells(trimmed)
            .filter((c) => /(male|female)/i.test(c))
            .join(" ")
        : trimmed;
      if (extra) prev.range = [prev.range, extra].filter(Boolean).join(" ");
      continue;
    }
    const h = HEADING_RE.exec(trimmed.replace(/^#+\s*/, ""));
    if (
      h &&
      !/\d{2,}/.test(h[1]) &&
      h[1].split(/\s+/).length <= 8 &&
      (h[1].split(/\s+/).length > 1 || h[1].length >= 6) &&
      !/^(TEST|INVESTIGATION|PARAMETER|CALCULATED|IFCC|NOTE|PAGE)\b/.test(h[1])
    )
      section = h[1].replace(/[-:\s]+$/, "").trim();
    else if (
      /^#{1,4}\s+\S/.test(trimmed) &&
      trimmed.length < 70 &&
      !/\d{3,}/.test(trimmed)
    )
      section = trimmed.replace(/^#+\s*/, "");
  }
  return out;
}
const isRowLine = (l) => /^\s*\|/.test(l);

// ------------------------------------------------------------ report metadata
const DMY = String.raw`(\d{1,2})[\/.-](\d{1,2}|[A-Za-z]{3,9})[\/.-](\d{2,4})`;
const MONTHS = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  sept: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};
const pad = (x) => String(x).padStart(2, "0");
/** Numeric dates are ambiguous (11/06/2026). Decide the order once per document. */
export function dateOrder(text) {
  let dmy = 0,
    mdy = 0;
  for (const m of text.matchAll(/\b(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})\b/g)) {
    if (+m[1] > 12 && +m[2] <= 12) dmy++;
    if (+m[2] > 12 && +m[1] <= 12) mdy++;
  }
  return dmy && !mdy ? "dmy" : mdy && !dmy ? "mdy" : null;
}
function toIso(d, m, y, order) {
  let year = Number(y);
  if (year < 100) year += 2000;
  if (/^[A-Za-z]/.test(m)) {
    const mm =
      MONTHS[m.slice(0, 4).toLowerCase()] ??
      MONTHS[m.slice(0, 3).toLowerCase()];
    return mm ? `${year}-${pad(mm)}-${pad(d)}` : null;
  }
  let [a, b] = [Number(d), Number(m)];
  if (a > 12 && b <= 12) return `${year}-${pad(b)}-${pad(a)}`;
  if (b > 12 && a <= 12) return `${year}-${pad(a)}-${pad(b)}`;
  if (order === "dmy") return `${year}-${pad(b)}-${pad(a)}`;
  if (order === "mdy") return `${year}-${pad(a)}-${pad(b)}`;
  return null; // honest: cannot tell 11 June from 6 November
}
function dateAfter(label, text, order) {
  const re = new RegExp(
    `(?:${label})[^\\n\\d]{0,24}?(?:\\d{1,2}:\\d{2}(?::\\d{2})?\\s*(?:AM|PM)?\\s*)?(${DMY}|\\d{1,2}\\s+[A-Za-z]{3,9},?\\s+\\d{4}|\\d{4}-\\d{2}-\\d{2})`,
    "i",
  );
  const m = re.exec(text);
  if (!m) return null;
  const s = m[1];
  let x;
  if ((x = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s))) return { iso: s, raw: s };
  if ((x = /^(\d{1,2})\s+([A-Za-z]{3,9}),?\s+(\d{4})$/.exec(s)))
    return { iso: toIso(x[1], x[2], x[3], order), raw: s };
  if ((x = new RegExp(`^${DMY}$`).exec(s)))
    return { iso: toIso(x[1], x[2], x[3], order), raw: s };
  return null;
}

export const flatHeader = (t) =>
  t
    .replace(/^\s*\|\s*-{3}.*$/gm, "")
    .replace(/\s*\|\s*(?=[:.-]\s)/g, " ")
    .replace(/\s*\|\s*/g, "   ");

/** Patient and dates from common report headers (not just the synthetic one). */
export function genericMeta(text) {
  // Key-value headers often arrive as table cells ("| Name | : DUMMY |").
  const head = flatHeader(text.slice(0, 2500));
  const order = dateOrder(text);
  const id =
    /\b(UHID|MRN|MR\s*#|MR\s*No\.?|Patient\s*ID|Pt\.?\s*ID|PID|Reg(?:istration)?\.?\s*No\.?|Lab\s*No\.?|Lab\s*#|Patient\s*No\.?|NRIC[^:]*)\s*[:#.-]?\s*(?:\|\s*)?([A-Z0-9][A-Z0-9\/-]{2,})/i.exec(
      head,
    );
  const name =
    /\b(?:Patient(?:'s)?\s*Name|Full name of patient|Name)\s*[:.-]\s*(?:\|\s*)?(?:(?:Mr|Mrs|Ms|Miss|Master|Baby|Dr)\.?\s+)?([A-Za-z][A-Za-z.' ]{1,40}?)(?=\s*(?:\||\n|$|\s{2,}|\b(?:Age|Date|Sex|Gender|UHID|Bill|Lab|Reg|ID|Ref|MR|PID|Email|DOB)\b))/i.exec(
      head,
    );
  const sexM =
    /\b(?:Sex|Gender)\s*[:.-]?\s*(?:\|\s*)?(Male|Female|M|F)\b/i.exec(head) ??
    /\bAge\s*\/\s*Sex\s*[:.-]?\s*[^\n]{0,20}?\/\s*(M|F|Male|Female)\b/i.exec(
      head,
    );
  const age =
    /\bAge\s*[:.-]?\s*(?:\|\s*)?(\d{1,3})\s*(?:Y|Yrs?|Years?)\b/i.exec(head);
  const sex = sexM ? (/^m/i.test(sexM[1]) ? "male" : "female") : null;
  const collected = dateAfter(
    "Collected|Collection|Sampled|Sample\\s*(?:collected|date|drawn)|Drawn|Registered|Received",
    head,
    order,
  );
  const reported = dateAfter(
    "Reported|Report(?:ed)?\\s*(?:on|date)|Result\\s*Reported|Authori[sz]ed",
    head,
    order,
  );
  const plain = dateAfter("\\bDate", head, order);
  let nameStr = name?.[1]?.trim().replace(/\s+/g, " ") ?? null;
  if (nameStr && /^(of|the|patient)$/i.test(nameStr)) nameStr = null;
  return {
    patient:
      id || nameStr
        ? {
            name: nameStr,
            id: id ? id[2].toUpperCase() : null,
            sex,
            age: age ? Number(age[1]) : null,
          }
        : sex
          ? { name: null, id: null, sex, age: age ? Number(age[1]) : null }
          : null,
    collected: collected?.iso ?? plain?.iso ?? null,
    reported: reported?.iso ?? null,
    dateRaw: collected?.raw ?? plain?.raw ?? reported?.raw ?? null,
  };
}
