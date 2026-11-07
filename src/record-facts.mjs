import {
  recordOwnerIds,
  unboundRequestedOwner,
  recordPatientIds,
  namedRecordOwners,
} from "./requested-owner.mjs";
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
import { packetSegments, reportMeta } from "../clinical/observations.mjs";
import { locate } from "../ingest/canonical.mjs";
import { stemToken } from "./rag-tokens.mjs";

const PROVISIONAL =
  /\b(ESTIMATE[SD]?|DRAFT|NOT APPROVED|NOT FINAL|UNSIGNED|UNVERIFIED|NOT VERIFIED|PRELIMINARY|PENDING|PROPOSED|PROPOSAL|PROVISIONAL|WORKING|TENTATIVE|EXPECTED|FOR REVIEW|UNDER REVIEW|QUOTATION|QUOTE|INDICATIVE|IN-PRINCIPLE|IN PRINCIPLE|OFFER)\b/;
const AUTHORITATIVE =
  /\b(SIGNED|COUNTERSIGNED|FINAL|POSTED|AMENDED|CORRECTED|REVISED|APPROVED|EXECUTED|ISSUED|SETTLED|CONFIRMED|VERIFIED|OFFICIAL|CERTIFIED|PAID|SANCTIONED|CLOSED|COMPLETED)\b/;
const STATUS_WORDS =
  /\b(NOT APPROVED|NOT VERIFIED|NOT FINAL|ESTIMATE ONLY|ESTIMATE|DRAFT|UNSIGNED|PRELIMINARY|PENDING|PROPOSED|PROVISIONAL|TENTATIVE|SIGNED|COUNTERSIGNED|FINAL|POSTED|UNPAID|PAID IN PART|PAID|AMENDED|CORRECTED|REVISED|APPROVED|EXECUTED|CONFIRMED|VERIFIED|OFFICIAL|SANCTIONED|INDICATIVE|CLOSED|HISTORICAL|OPEN)\b/g;

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
  [
    "amount owed",
    /patient (share|responsibility|balance)|amount (owed|due|payable)|balance|\bowe|outstanding|remaining|still (?:have to |need to |to )?pay|left to pay|\bdue\b/i,
  ],
  ["payment", /\b(pay|pays|payment|paid)\b/i],
  ["insurer", /insurer|insurance|\beob\b|adjudicat/i],
  [
    "total charges",
    /\btotal\b|hospital charges|final charges|charges? total|final bill|bill amount|how much (?:was|is) the bill/i,
  ],
  [
    "discharge",
    /discharg|disposition|released (?:home|to)|(?:go|gone|went|sent|going) home|go-home/i,
  ],
  ["approval", /approv|authori[sz]ed by|signed off|sanction/i],
  [
    "delivery",
    /deliver|dispatch|shipped|arriv|handed over|hand-?over|returned|picked up|(?:get|got|getting) (?:\w+ ){0,3}back/i,
  ],
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

const MONEY_CONCEPTS = new Set([
  "payment",
  "amount owed",
  "insurer",
  "total charges",
  "invoice",
]);
const LINE_GENERIC = new Set([
  "service",
  "services",
  "charge",
  "charges",
  "fee",
  "fees",
  "bed",
  "the",
  "and",
  "of",
]);
/** A line item's identity: its label's words, minus generic ones. */
export const lineKey = (label) =>
  [
    ...new Set(
      (label.toLowerCase().match(/[a-z]+/g) ?? [])
        .filter((w) => w.length > 2 && !LINE_GENERIC.has(w))
        .map(stemToken),
    ),
  ]
    .sort()
    .join(" ");

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
/**
 * Records of a file with no patient headers (a purchase file, a lease file):
 * a page whose own top heading differs from the previous page's starts a
 * record; pages repeating a heading continue it. Null for a single record.
 */
function headingSegments(doc) {
  if ((doc.pages?.length ?? 0) < 2 || !doc.elements?.length) return null;
  const span = new Map();
  const head = new Map();
  for (const e of doc.elements) {
    if (e.page == null || typeof e.start !== "number") continue;
    const r = span.get(e.page) ?? [Infinity, -1];
    span.set(e.page, [Math.min(r[0], e.start), Math.max(r[1], e.end)]);
    if (e.type === "heading" && !head.has(e.page))
      head.set(e.page, String(e.text).trim().toLowerCase());
  }
  const pages = [...span.keys()].sort((a, b) => a - b);
  if (new Set(pages.map((n) => head.get(n)).filter(Boolean)).size < 2)
    return null;
  const segs = [];
  for (const n of pages) {
    const h = head.get(n) ?? null;
    const last = segs[segs.length - 1];
    if (last && (h === null || h === last.h)) last.pages.push(n);
    else segs.push({ h, pages: [n] });
  }
  return segs.map((sg, i) => ({
    index: i + 1,
    pages: sg.pages,
    start: span.get(sg.pages[0])[0],
    end: span.get(sg.pages[sg.pages.length - 1])[1],
  }));
}

/**
 * "Approved by: Priya Nair" lines inside [start, end): label -> value facts.
 * A text layer often joins consecutive lines ("Approved by: X Approval
 * date: Y"), so each "Label: value" pair on a line is its own fact.
 */
const PAIR =
  /([A-Z][A-Za-z/'()-]*(?: [A-Za-z/'()-]+){0,4}?)\s*:\s+(.+?)(?=\s+[A-Z][A-Za-z/'()-]*(?: [A-Za-z/'()-]+){0,4}?\s*:\s|$)/g;
function lineFacts(text, start, end) {
  const out = [];
  // "Issued by: Office of the Registrar Issue date: ..." splits as "Office
  // of the" | "Registrar Issue date": a value never ends on "the"/"of", so
  // the next label's first word moves back into it.
  const mend = (pairs) => {
    for (let i = 0; i + 1 < pairs.length; i++)
      while (
        /\b(of|the|and|to|for|at|in|on|by|a|an)$/i.test(pairs[i].value) &&
        pairs[i + 1].label.split(/\s+/).length > 1
      ) {
        const [w, ...rest] = pairs[i + 1].label.split(/\s+/);
        pairs[i].value += " " + w;
        pairs[i + 1].label = rest.join(" ");
      }
    return pairs;
  };
  let pos = 0;
  for (const line of text.split("\n")) {
    const a = pos;
    pos += line.length + 1;
    if (a < start || a >= end || /^\s*[|#]/.test(line) || !/:\s/.test(line))
      continue;
    const found = [];
    for (const m of line.matchAll(PAIR))
      found.push({
        label: m[1].trim(),
        value: m[2].trim().replace(/[.;,]$/, ""),
        at: m.index,
        len: m[0].length,
      });
    for (const m of mend(found)) {
      const { label, value } = m;
      if (
        label.length < 3 ||
        label.split(/\s+/).length > 5 ||
        /^(note|notes|correction note|see|http|https|tel|email)$/i.test(
          label,
        ) ||
        !value
      )
        continue;
      const s0 = a + m.at;
      out.push({ label, value, start: s0, end: s0 + m.len });
    }
  }
  return out;
}

export function recordsOf(doc) {
  const segs = packetSegments(doc) ??
    headingSegments(doc) ?? [
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
    const facts = [
      ...tablesIn(doc.text, seg.start, seg.end).flatMap(factsOfTable),
      ...lineFacts(doc.text, seg.start, seg.end),
    ].map((f, i) => {
      // An amount is a charge, a payment or a balance: a non-money concept
      // ("Imaging / diagnostics" is a charge, not a diagnosis) is dropped,
      // and the line label links the same line item across records.
      let concept = conceptOf(f.label);
      const money = MONEY.test(f.value);
      if (money && concept && !MONEY_CONCEPTS.has(concept)) concept = null;
      return {
        id: `${seg.index}.${i + 1}`,
        record: seg.index,
        concept,
        line: money && !concept ? lineKey(f.label) : null,
        pages: locate(doc, f.start, f.end).pages,
        ...f,
      };
    });
    let patient = null;
    try {
      patient = reportMeta(text).patient?.id ?? null;
    } catch {
      patient = null;
    }
    return {
      index: seg.index,
      pages: seg.pages,
      patient,
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
// "Expected go-home", "Planned discharge", "Estimated total": the label
// itself says the value is provisional, whatever record it sits in.
const PROVISIONAL_LABEL =
  /^(expected|planned|estimated|estimate|proposed|target|tentative|provisional|projected|anticipated|draft)\b/i;
const rankOf = (c) =>
  PROVISIONAL_LABEL.test(c.f.label.trim()) ? 0 : RANK[c.r.authority];
const where = (r, many) =>
  `${r.title ? r.title.toLowerCase().replace(/^./, (c) => c.toUpperCase()) : "record"}` +
  (many && r.pages?.length
    ? ` (p.${r.pages[0]}${r.status ? `, ${r.status}` : ""})`
    : r.status
      ? ` (${r.status})`
      : "");

// Words a question uses without naming a subject ("how much did they
// charge for it"), never required to occur in the documents.
const GENERIC_Q = new Set(
  "about after again amount anything before being could does doing done during every first going happen happened here later least many might money other price right should since still their there these thing those total under until value where which while would yours really actually exactly currently".split(
    " ",
  ),
);
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
// Compared on its own kind: an amount by its amounts, a date by its dates
// ("22 Oct · USD 440.00" and "USD 440.00" are the same charge).
const AMOUNTS =
  /(?:USD|INR|EUR|GBP|RS\.?|[$₹])\s?(\d[\d,]*(?:\.\d+)?)|\b(\d[\d,]*\.\d{2})\b/gi;
const DATES =
  /\b(\d{1,2})\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b(?:\s+(\d{4}))?/gi;
const kindKey = (v, kind) =>
  kind === "money"
    ? [...String(v).matchAll(AMOUNTS)]
        .map((m) => String(Number((m[1] ?? m[2]).replace(/,/g, ""))))
        .join(" ")
    : kind === "date"
      ? [...String(v).matchAll(DATES)]
          .map(
            (m) =>
              `${Number(m[1])} ${m[2].toLowerCase().slice(0, 3)}${m[3] ? " " + m[3] : ""}`,
          )
          .join(" ")
      : null;
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
  if (unboundRequestedOwner(question, { records: entries })) return null;
  const qs = new Set(stems(question));
  const qConcepts = conceptsOf(question);
  let primary = conceptOf(question);
  const who =
    /^\s*(who|which (?:vet|doctor|physician|nurse|person|officer|manager|staff|member))\b/i.test(
      question,
    );
  if (!qs.size && !qConcepts.size) return null;
  let all = [];
  for (const en of entries)
    for (const r of en.records ?? [])
      for (const f of r.facts) all.push({ en, r, f });
  // A question naming a patient ID is about that patient's records only.
  const uniqueRecords = [...new Set(all.map((c) => c.r))];
  const ownerIds = new Map(uniqueRecords.map((r) => [r, recordOwnerIds(r)]));
  const named = namedRecordOwners(question, uniqueRecords, ownerIds);
  if (named.length)
    // A question naming a patient is answered from that patient's records
    // only: an unidentified record never answers for a known patient.
    all = all.filter((c) => ownerIds.get(c.r).some((id) => named.includes(id)));
  // A printed name shared by different patient IDs: a name-only question is
  // clarified, never silently attributed to one of them.
  if (!named.length) {
    const nameIds = new Map(); // printed name (lower) -> {ids, display}
    const firstFact = new Map(); // patient id -> {en, f} for citations
    for (const en of entries)
      for (const r of en.records ?? []) {
        const patientIds = recordPatientIds(r);
        if (!patientIds.length) continue;
        let nm = null;
        try {
          nm = reportMeta(
            (en.source?.text ?? en.doc?.text ?? "").slice(r.start, r.end),
          ).patient?.name?.trim();
        } catch {
          nm = null;
        }
        if (nm) {
          const key = nm.toLowerCase();
          const slot = nameIds.get(key) ?? { ids: new Set(), display: nm };
          for (const id of patientIds) slot.ids.add(id);
          nameIds.set(key, slot);
        }
        for (const id of patientIds)
          if (!firstFact.has(id) && r.facts?.length)
            firstFact.set(id, { en, f: r.facts[0] });
      }
    for (const [nm, { ids, display }] of nameIds) {
      if (ids.size < 2) continue;
      const escaped = nm.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      if (!new RegExp(`\\b${escaped}\\b`, "i").test(question)) continue;
      const list = [...ids];
      return {
        spoken: `The records name ${display} under different patient IDs (${list.join(", ")}). Which patient do you mean?`,
        clarify: true,
        lead: null,
        record: null,
        superseded: [],
        sourceId: null,
        cites: list.flatMap((id) => {
          const c = firstFact.get(id);
          return c
            ? [
                {
                  sourceId: c.en.source?.id ?? null,
                  start: c.f.start,
                  end: c.f.end,
                },
              ]
            : [];
        }),
      };
    }
  }
  // A question about something these documents never mention ("what is
  // the warranty period?") is not answered from a fact that merely shares
  // a word ("chairs"): every distinctive question word must occur somewhere
  // in the documents, as the index reads them.
  const vocab = new Set();
  for (const en of entries)
    for (const w of (en.source?.text ?? en.doc?.text ?? "")
      .toLowerCase()
      .match(/[a-z]+/g) ?? [])
      vocab.add(stemToken(w));
  const MON = /^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*$/;
  const missing = [...qs].filter(
    (w) => w.length >= 5 && !GENERIC_Q.has(w) && !MON.test(w) && !vocab.has(w),
  );
  // An amount named in the question ("was the USD 600 paid?") points at the
  // fact that printed it; that fact's label says whose amount it is, and
  // those words steer the match ("patient" share -> "patient" payment).
  const asked = nums(question.replace(MONTH, "")).filter((n) => n >= 10);
  const askedDate = MONTH.exec(question);
  const dateKey = askedDate
    ? `${Number(askedDate[1])} ${askedDate[2].toLowerCase().slice(0, 3)}`
    : null;
  const anchor = asked.length
    ? all.find(({ f }) => asked.every((n) => nums(f.value).includes(n)))
    : dateKey
      ? all.find(({ f }) =>
          (kindKey(f.value, "date") ?? "").startsWith(dateKey),
        )
      : null;
  const extra = new Set(anchor ? allStems(anchor.f.label) : []);
  // The amount named is what the question is about: its concept leads
  // ("was the 12,400 quote approved?" is answered with the approved total).
  // The question's own concept stays primary ("was the 600 paid?" is about
  // payment); the named amount's concept joins it.
  if (anchor?.f.concept) {
    qConcepts.add(anchor.f.concept);
    primary ??= anchor.f.concept;
  }
  const namedAmount = !!anchor && MONEY.test(anchor.f.value);
  // "What did it cost in the end?": a cost question with no named kind of
  // amount asks for the total.
  if (
    /\b(cost|price|how much did|how much was|in the end|altogether)\b/i.test(
      question,
    ) &&
    ![...qConcepts].some((c) => MONEY_CONCEPTS.has(c))
  ) {
    qConcepts.add("total charges");
    primary ??= "total charges";
  }
  const quantity =
    /how much|amount|total|cost|charge|\bbill\b|balance|\bowe|\bpay|paid/i.test(
      question,
    );
  // What kind of answer the question wants: a date ("when", "on 3
  // November?"), an amount, a person.
  const wantsDate =
    /^\s*(when|what date|on what date|since when)\b/i.test(question) ||
    (/^\s*(was|were|is|did)\b/i.test(question) && MONTH.test(question));
  const cands = [];
  for (const c of all) {
    if (c === anchor) continue;
    const ls = stems(c.f.label);
    const hit = ls.filter((w) => qs.has(w));
    // A distinctive word (4+ letters) is worth more than a short one.
    const overlap = hit.reduce((a, w) => a + (w.length >= 4 ? 1.5 : 1), 0);
    const title = stems(c.r.title ?? "").filter(
      (w) => qs.has(w) && !hit.includes(w),
    ).length;
    const steer = allStems(c.f.label).filter(
      (w) => extra.has(w) && !qs.has(w),
    ).length;
    const concept = !!c.f.concept && qConcepts.has(c.f.concept);
    // The same field as the one carrying the value the question named
    // ("on 29 November?" names the proposal's Event date; the confirmed
    // Event date is the same field).
    const sameField =
      !!anchor &&
      allStems(c.f.label).sort().join(" ") ===
        allStems(anchor.f.label).sort().join(" ");
    c.sameField = sameField;
    if (!overlap && !concept && !sameField) continue;
    const money = (quantity || namedAmount) && MONEY.test(c.f.value) ? 3 : 0;
    const dated = wantsDate ? (DATE_V.test(c.f.value) ? 3 : -2) : 0;
    // "Still owe", "left to pay": the residual (balance, outstanding),
    // not the amount that was payable before payments.
    const residual =
      /\b(still|left|remaining|outstanding|now)\b/i.test(question) &&
      /balance|outstanding|remaining|\bdue\b/i.test(c.f.label)
        ? 2
        : 0;
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
      score:
        overlap * 2 +
        (concept ? 3 : 0) +
        steer +
        money +
        lead +
        person +
        dated +
        title +
        residual +
        (sameField ? 3 : 0),
    });
  }
  if (!cands.length) return null;
  const top = Math.max(...cands.map((c) => c.score));
  if (top < 3) return null;
  // Among the best-matching facts, the most authoritative record wins; then
  // the later record.
  // Within the best match's concept (or field), authority decides, however
  // the words overlap: "Expected go-home: 10 Nov" never outranks a signed
  // "Discharged to owner: 12 Nov" because it shares the word "home".
  const topC = cands.find((c) => c.score === top);
  const field = (c) => allStems(c.f.label).sort().join(" ");
  const best = cands
    .filter(
      (c) =>
        c.score >= top - 2 ||
        (topC.f.concept &&
          c.f.concept === topC.f.concept &&
          c.score >= top - 6) ||
        (field(c) === field(topC) && c.score >= top - 6),
    )
    .sort(
      (a, b) =>
        rankOf(b) - rankOf(a) || b.score - a.score || b.r.index - a.r.index,
    );
  const lead = best[0];
  // More of the question's distinctive words absent from the documents
  // than the chosen fact actually matched: the question is about something
  // else, and is not answered from this fact.
  const matched =
    [...qs].filter((w) =>
      [
        ...stems(lead.f.label),
        ...stems(lead.r.title ?? ""),
        ...stems(lead.f.value),
      ].includes(w),
    ).length +
    (lead.f.concept && qConcepts.has(lead.f.concept) ? 1 : 0) +
    (lead.sameField ? 1 : 0);
  if (missing.length > matched) return null;
  // Likewise when the question's distinctive words are in the documents
  // but not in this fact ("is there duplicate billing?" is not answered by
  // the bill's issue date).
  const leadWords = new Set([
    ...stems(lead.f.label),
    ...stems(lead.r.title ?? ""),
    ...stems(lead.f.value),
  ]);
  const unmatched = [...qs].filter(
    (w) =>
      w.length >= 5 && !GENERIC_Q.has(w) && !MON.test(w) && !leadWords.has(w),
  );
  const conceptWords = lead.f.concept && qConcepts.has(lead.f.concept) ? 1 : 0;
  if (unmatched.length > matched + conceptWords) return null;
  const many = (lead.en.records?.length ?? 0) > 1;
  const concept = lead.f.concept;
  // Same concept, same kind of value (a date for a date, money for
  // money), lower authority, a different value: superseded.
  const kind = valueKind(lead.f.value);
  const leadField = allStems(lead.f.label).sort().join(" ");
  const older = kind
    ? all.filter(
        (c) =>
          c.f !== lead.f &&
          c.f !== anchor?.f &&
          // records about different patients never replace each other, and
          // an unidentified record never replaces a known patient's
          !(
            c.r.patient !== lead.r.patient &&
            (c.r.patient || lead.r.patient)
          ) &&
          ((concept && c.f.concept === concept) ||
            allStems(c.f.label).sort().join(" ") === leadField) &&
          valueKind(c.f.value) === kind &&
          rankOf(c) < rankOf(lead) &&
          kindKey(c.f.value, kind) !== kindKey(lead.f.value, kind),
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
  const shownAnchor = anchor
    ? askedDate && !asked.length
      ? askedDate[0]
      : (anchor.f.value.match(/\d+(?:,\d{2,3})*(?:\.\d+)?/)?.[0] ?? "amount")
    : null;
  const from =
    anchor && anchor.r !== lead.r
      ? ` The ${shownAnchor} you mention is from the ${where(anchor.r, many)}: ${anchor.f.label}: ${anchor.f.value}.`
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
