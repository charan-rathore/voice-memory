// Records and facts: what each record in a document states, with its
// authority, as source-anchored label -> value pairs.
//
// A record is one packet segment (clinical/observations.mjs packetSegments)
// or, for an ordinary file, the whole file. Its authority comes from the
// status words printed in its header: "SIGNED / FINAL", "FINAL POSTED",
// "AMENDED" are authoritative; "ESTIMATE ONLY", "DRAFT / NOT APPROVED",
// "PRELIMINARY", "PENDING" are provisional. Provisional words win, so
// "DRAFT / NOT APPROVED" is never read as approved.
//
// Facts come from the record's tables only (label | value rows, stacked
// label-over-value headers, and multi-column rows keyed by their first
// cell), never from prose, and each keeps the exact character span it was
// read from. Lab result tables are left to the clinical layer.
//
// Used by the fact answers (factAnswer), the evidence graph and the reading
// view's digest, so all three show the same grounded structure.
import { packetSegments } from "../clinical/observations.mjs";
import { stemToken } from "./rag-tokens.mjs";

const PROVISIONAL =
  /\b(ESTIMATE[SD]?|DRAFT|NOT APPROVED|UNSIGNED|PRELIMINARY|PENDING|PROPOSED|PROVISIONAL|WORKING|TENTATIVE|UNVERIFIED)\b/;
const AUTHORITATIVE =
  /\b(SIGNED|FINAL|POSTED|AMENDED|CORRECTED|APPROVED|EXECUTED|ISSUED|SETTLED)\b/;
const STATUS_WORDS =
  /\b(NOT APPROVED|ESTIMATE ONLY|ESTIMATE|DRAFT|UNSIGNED|PRELIMINARY|PENDING|PROPOSED|PROVISIONAL|SIGNED|FINAL|POSTED|UNPAID|PAID|AMENDED|CORRECTED|APPROVED|HISTORICAL|OPEN)\b/g;

/** Authority and the printed status words of a record's first lines. */
export function recordStatus(text) {
  // The record's own header: its title and the line under it, before any
  // table. Body text ("replaces the 22 Oct estimate") never sets a status.
  const lines = [];
  for (const raw of text.split("\n")) {
    const l = raw.replace(/^#+\s*/, "").trim();
    if (!l) continue;
    if (l.startsWith("|") || lines.length >= 2) break;
    lines.push(l);
  }
  const head = lines.join("\n");
  const words = [...new Set([...head.matchAll(STATUS_WORDS)].map((m) => m[1]))];
  const label = words.join(" / ").toLowerCase() || null;
  const authority = PROVISIONAL.test(head)
    ? "provisional"
    : AUTHORITATIVE.test(head)
      ? "authoritative"
      : "unknown";
  return { label, authority };
}

// Concepts link the same kind of fact across records ("Estimated patient
// share" on an estimate, "Shown patient balance" on the final bill). Order
// matters: the first match names the fact.
const CONCEPTS = [
  [
    "signatory",
    /signator|signed by|\bwho signed|\bsign(?:ed)? (?:the|this|it)\b/i,
  ],
  ["payment", /\b(pay|pays|payment|paid)\b/i],
  [
    "amount owed",
    /patient (share|responsibility|balance)|amount (owed|due)|balance due|\bowe/i,
  ],
  ["insurer", /insurer|insurance|\beob\b|adjudicat/i],
  [
    "total charges",
    /\btotal\b|hospital charges|final charges|charges? total|final bill|bill amount|how much (?:was|is) the bill/i,
  ],
  ["discharge", /discharg|disposition/i],
  ["admission", /\badmi(t|ssion)|arrival/i],
  ["medication", /prescri|medication|\biron\b|\bdrug/i],
  ["diagnosis", /diagnos|clinical status|assessment/i],
  ["follow-up", /follow-?up|appointment/i],
  ["invoice", /invoice|claim number|\bbill\b/i],
];
export const conceptOf = (label) =>
  CONCEPTS.find(([, re]) => re.test(label))?.[0] ?? null;
/** Every concept a question mentions ("a new prescription at discharge"). */
export const conceptsOf = (q) =>
  new Set(CONCEPTS.filter(([, re]) => re.test(q)).map(([c]) => c));

const LAB_HEADER =
  /\b(test|analyte|investigation|parameter)\b[\s\S]*\b(result|value)\b/i;
const isLabelRow = (cells) =>
  cells.length >= 2 &&
  cells.every((c) => !c || (!/\d/.test(c) && c === c.toUpperCase())) &&
  cells.some((c) => /[A-Z]{3}/.test(c));
const cellsOf = (line) =>
  line
    .replace(/^\s*\|\s*/, "")
    .replace(/\s*\|\s*$/, "")
    .split("|")
    .map((c) => c.trim());

/** Pipe tables in [start, end) of text: rows with their character spans. */
function tablesIn(text, start, end) {
  const tables = [];
  let cur = null;
  let pos = 0;
  for (const line of text.split("\n")) {
    const a = pos;
    pos += line.length + 1;
    if (a < start || a >= end) continue;
    if (/^\s*\|/.test(line)) {
      if (/^\s*\|\s*-{3}/.test(line)) continue;
      (cur ??= { rows: [] }).rows.push({
        cells: cellsOf(line),
        start: a,
        end: a + line.length,
      });
    } else if (line.trim()) {
      if (cur) tables.push(cur);
      cur = null;
    }
  }
  if (cur) tables.push(cur);
  return tables;
}

function factsOfTable(table) {
  const rows = table.rows;
  if (!rows.length) return [];
  const head = rows[0].cells;
  if (LAB_HEADER.test(head.join(" "))) return [];
  const out = [];
  const push = (label, value, row, columns = null) => {
    label = label.replace(/\s+/g, " ").trim();
    value = value.replace(/\s+/g, " ").trim();
    if (!label || !value || label.length > 80) return;
    out.push({ label, value, start: row.start, end: row.end, columns });
  };
  // Stacked: a label row over a value row, repeated ("PATIENT NAME |
  // PATIENT ID" over "Maya Sharma | HLG-P1047").
  if (
    rows.length >= 2 &&
    isLabelRow(rows[0].cells) &&
    !isLabelRow(rows[1].cells) &&
    rows.every((r, i) => (i % 2 === 0) === isLabelRow(r.cells))
  ) {
    for (let i = 0; i + 1 < rows.length; i += 2)
      rows[i].cells.forEach((l, k) => {
        const v = rows[i + 1].cells[k];
        if (l && v) push(l, v, rows[i + 1]);
      });
    return out;
  }
  // Header + rows keyed by their first cell.
  const hasHeader = isLabelRow(head);
  const body = hasHeader ? rows.slice(1) : rows;
  for (const r of body) {
    const [label, ...rest] = r.cells;
    if (!label || /^\d/.test(label)) continue;
    const parts = rest
      .map((c, i) => (c ? { c, h: hasHeader ? head[i + 1] : null } : null))
      .filter(Boolean);
    if (!parts.length) continue;
    // A currency-named column prefixes its number: "USD 400.00".
    const value = parts
      .map(({ c, h }) => {
        const cur = /\b(USD|INR|EUR|GBP|RS\.?|₹|\$)\b/i.exec(h ?? "");
        return cur && /^[\d,.]+$/.test(c) ? `${cur[1].toUpperCase()} ${c}` : c;
      })
      .join(" · ");
    push(label, value, r, hasHeader ? head.slice(1).filter(Boolean) : null);
  }
  return out;
}

const firstHeading = (text) =>
  /^#{1,4}\s+(.+)$/m.exec(text)?.[1]?.trim() ??
  text
    .split("\n")
    .find((l) => l.trim())
    ?.trim()
    .slice(0, 80) ??
  "";

/**
 * Records and facts for one indexed document.
 * @param {{text:string, pages?:any[], elements?:any[]}} doc
 */
export function recordsOf(doc) {
  const segs = packetSegments(doc) ?? [
    {
      index: 1,
      pages: (doc.pages ?? []).map((p) => p.number),
      start: 0,
      end: doc.text.length,
    },
  ];
  return segs.map((seg) => {
    const text = doc.text.slice(seg.start, seg.end);
    const st = recordStatus(text);
    const facts = tablesIn(doc.text, seg.start, seg.end)
      .flatMap(factsOfTable)
      .map((f, i) => ({
        id: `${seg.index}.${i + 1}`,
        record: seg.index,
        concept: conceptOf(f.label),
        ...f,
      }));
    return {
      index: seg.index,
      pages: seg.pages,
      start: seg.start,
      end: seg.end,
      title: firstHeading(text),
      status: st.label,
      authority: st.authority,
      facts,
    };
  });
}

const RANK = { authoritative: 2, unknown: 1, provisional: 0 };
const where = (r, many) =>
  `${r.title ? r.title.toLowerCase().replace(/^./, (c) => c.toUpperCase()) : "record"}` +
  (many && r.pages?.length
    ? ` (p.${r.pages[0]}${r.status ? `, ${r.status}` : ""})`
    : r.status
      ? ` (${r.status})`
      : "");

const STOP = new Set(
  "the a an of to in on for is was were be been did does do what when how much many which who whom whose this that it its patient patients record records document report say says said show shows".split(
    " ",
  ),
);
// The index's own stemmer (rag-tokens.mjs), so "discharged" and
// "discharge" are one word here exactly as they are in retrieval.
const stems = (s) =>
  (s.toLowerCase().match(/[a-z]+/g) ?? [])
    .filter((w) => w.length > 2 && !STOP.has(w))
    .map(stemToken);
const allStems = (s) =>
  (s.toLowerCase().match(/[a-z]+/g) ?? [])
    .filter((w) => w.length > 2)
    .map(stemToken);
const nums = (s) =>
  [...String(s).matchAll(/\d[\d,]*(?:\.\d+)?/g)].map((m) =>
    Number(m[0].replace(/,/g, "")),
  );
const MONEY =
  /\b(USD|INR|EUR|GBP|RS\.?)\s?[\d,]|[$₹]\s?\d|\b\d[\d,]*\.\d{2}\b/i;
const DATE_V =
  /\b\d{1,2}\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b|\b\d{4}-\d{2}-\d{2}\b/i;
// Same value, printed differently ("22 Oct 2026, 09:40 (local)" and
// "22 Oct 2026 09:40"): same numbers and month names in the same order.
const valueKey = (v) =>
  (
    String(v)
      .toLowerCase()
      .match(
        /\d+(?:\.\d+)?|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec/g,
      ) ?? []
  )
    .map((t) => (/^\d/.test(t) ? String(Number(t)) : t))
    .join(" ");
const sameValue = (a, b) => {
  const ka = valueKey(a);
  return !!ka && ka === valueKey(b);
};
const valueKind = (v) =>
  MONEY.test(v) ? "money" : DATE_V.test(v) ? "date" : null;
const MONTH =
  /\b(\d{1,2})\s*(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/i;

/**
 * A question about a recorded fact, answered from the most authoritative
 * record that states it, with any provisional record that states it
 * differently named as superseded. Null when no fact matches well.
 *   entries: [{ source, doc, records }] for each indexed document
 */
export function factAnswer(question, entries) {
  const qs = new Set(stems(question));
  const qConcepts = conceptsOf(question);
  const primary = conceptOf(question);
  const who = /^\s*who\b/i.test(question);
  if (!qs.size && !qConcepts.size) return null;
  const all = [];
  for (const en of entries)
    for (const r of en.records ?? [])
      for (const f of r.facts) all.push({ en, r, f });
  // An amount named in the question ("was the USD 600 paid?") points at the
  // fact that printed it; that fact's label says whose amount it is, and
  // those words steer the match ("patient" share -> "patient" payment).
  const asked = nums(question.replace(MONTH, "")).filter((n) => n >= 10);
  const anchor = asked.length
    ? all.find(({ f }) => asked.every((n) => nums(f.value).includes(n)))
    : null;
  const extra = new Set(anchor ? allStems(anchor.f.label) : []);
  const quantity =
    /how much|amount|total|cost|charge|\bbill\b|balance|\bowe|\bpay|paid/i.test(
      question,
    );
  const cands = [];
  for (const c of all) {
    if (c === anchor) continue;
    const ls = stems(c.f.label);
    const overlap = ls.filter((w) => qs.has(w)).length;
    const steer = allStems(c.f.label).filter(
      (w) => extra.has(w) && !qs.has(w),
    ).length;
    const concept = !!c.f.concept && qConcepts.has(c.f.concept);
    if (!overlap && !concept) continue;
    const money = quantity && MONEY.test(c.f.value) ? 3 : 0;
    const lead = c.f.concept && c.f.concept === primary ? 1 : 0;
    const person =
      who &&
      /\b(Dr|Mr|Mrs|Ms|Prof)\.?\s+[A-Z]|\b[A-Z][a-z]+\s+[A-Z][a-z]+\b/.test(
        c.f.value,
      )
        ? 3
        : 0;
    cands.push({
      ...c,
      score: overlap * 2 + (concept ? 3 : 0) + steer + money + lead + person,
    });
  }
  if (!cands.length) return null;
  const top = Math.max(...cands.map((c) => c.score));
  if (top < 3) return null;
  // Among the best-matching facts, the most authoritative record wins; then
  // the later record.
  const best = cands
    .filter((c) => c.score >= top - 1)
    .sort(
      (a, b) =>
        RANK[b.r.authority] - RANK[a.r.authority] ||
        b.score - a.score ||
        b.r.index - a.r.index,
    );
  const lead = best[0];
  const many = (lead.en.records?.length ?? 0) > 1;
  const concept = lead.f.concept;
  // Same concept, same kind of value (a date for a date, money for
  // money), lower authority, a different value: superseded.
  const kind = valueKind(lead.f.value);
  const older =
    concept && kind
      ? all.filter(
          (c) =>
            c.f !== lead.f &&
            c.f.concept === concept &&
            valueKind(c.f.value) === kind &&
            RANK[c.r.authority] < RANK[lead.r.authority] &&
            !sameValue(c.f.value, lead.f.value),
        )
      : [];
  // A yes/no question naming a number or a date the authoritative record
  // does not carry is answered "not according to" that record.
  const yesNo = /^\s*(was|were|is|are|did|does|do|has|have|had)\b/i.test(
    question,
  );
  const askedNums = nums(question.replace(MONTH, ""));
  const askedDay = MONTH.exec(question);
  let verdict = "";
  if (yesNo && (askedNums.length || askedDay)) {
    const v = lead.f.value;
    const hasNum = askedNums.every((n) => nums(v).includes(n));
    const hasDay =
      !askedDay ||
      new RegExp(`\\b0?${Number(askedDay[1])}\\s*${askedDay[2]}`, "i").test(v);
    verdict =
      hasNum && hasDay
        ? "Yes. "
        : "Not according to the most authoritative record. ";
  }
  const from =
    anchor && anchor.r !== lead.r
      ? ` The ${anchor.f.value.match(/\d+(?:,\d{3})*(?:\.\d+)?/)?.[0] ?? "amount"} you mention is from the ${where(anchor.r, many)}: ${anchor.f.label}: ${anchor.f.value}.`
      : "";
  const spoken =
    verdict +
    `${where(lead.r, many)} gives ${lead.f.label}: ${lead.f.value}.` +
    from +
    (older.length
      ? " " +
        older
          .slice(0, 2)
          .map(
            (c) =>
              `The earlier ${where(c.r, many)} said ${c.f.label}: ${c.f.value}; it is superseded.`,
          )
          .join(" ")
      : "");
  return {
    spoken,
    lead: lead.f,
    record: lead.r,
    superseded: older.map((c) => ({ fact: c.f, record: c.r })),
    sourceId: lead.en.source?.id ?? null,
    cites: [
      lead,
      ...older.slice(0, 2),
      ...(anchor && anchor.r !== lead.r ? [anchor] : []),
    ].map((c) => ({
      sourceId: c.en.source?.id ?? null,
      start: c.f.start,
      end: c.f.end,
    })),
  };
}

/**
 * bundle.records: per indexed source, its records and facts (cached on the
 * library entry; a replaced document drops the cache).
 */
export function attachRecords(bundle, entries) {
  bundle.records = bundle.sources.map((source, i) => {
    const e = entries[i];
    let records = [];
    try {
      records = e?.doc ? (e.records ??= recordsOf(e.doc)) : [];
    } catch {
      records = [];
    }
    return { source, records };
  });
  return bundle;
}

/** factAnswer over a bundle, with citations resolved against its sources. */
export function bundleFactAnswer(question, bundle, cite) {
  if (!bundle?.records?.some((r) => r.records.some((x) => x.facts.length)))
    return null;
  const a = factAnswer(question, bundle.records);
  if (!a) return null;
  const citations = [];
  for (const c of a.cites) {
    const src = bundle.sources.find((s) => s.id === c.sourceId);
    if (src && c.end <= src.text.length)
      citations.push(cite(src, { start: c.start, end: c.end }));
  }
  return citations.length ? { ...a, citations } : null;
}

/**
 * A question about what a record states (a prescription, a discharge, a
 * payment, a balance, a signature) rather than a lab value: answered from
 * the records' facts even when a lab answer is available ("was iron
 * prescribed?" is not a question about the ferritin level).
 */
export const recordIntent = (q) =>
  /prescri|medicat|discharg|admi(?:t|ssion)|\bpaid\b|\bpay\b|\bowe|\bbill\b|charges?\b|insur|\bsign(?:ed|atory)\b|follow-?up|appointment|invoice|balance|signature/i.test(
    q,
  ) && !/\b(result|level|value|range|reading|kitna|kitni|kitne)\b/i.test(q);
