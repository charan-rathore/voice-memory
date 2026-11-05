// The records graph: what each record states, whose it is, how authoritative
// it is, and which of its facts a more authoritative record replaces.
//
// Built only from structure the engine already verified (record-facts.mjs:
// table facts with exact spans, printed statuses; clinical/observations.mjs:
// printed patient identity). Nothing is inferred from prose, and every value
// node carries the span it was read from, so the graph can be checked line
// by line against the document.
import { reportMeta } from "../clinical/observations.mjs";

const IDENTITY =
  /^(patient(?:'s)?\s*(name|id)|name|date of birth|dob|patient)$/i;
const RANK = { authoritative: 2, unknown: 1, provisional: 0 };
const MONEY =
  /\b(USD|INR|EUR|GBP|RS\.?)\s?[\d,]|[$₹]\s?\d|\b\d[\d,]*\.\d{2}\b/i;
const DATE_V =
  /\b\d{1,2}\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b|\b\d{4}-\d{2}-\d{2}\b/i;
const kindOf = (v) =>
  MONEY.test(v) ? "money" : DATE_V.test(v) ? "date" : null;
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
const cap = (s) =>
  String(s ?? "")
    .toLowerCase()
    .replace(/^./, (c) => c.toUpperCase());

/** Node id of a record: the file, plus the record number inside a packet. */
export const recordNodeId = (sourceId, rec, many) =>
  `doc:${sourceId}${many ? "#" + rec.index : ""}`;

export function recordGraph(bundle) {
  const nodes = new Map();
  const edges = new Map();
  const node = (n) => nodes.set(n.id, { ...nodes.get(n.id), ...n });
  const edge = (e) => {
    const id = `${e.from}->${e.to}:${e.kind}`;
    edges.set(id, { id, ...e });
  };
  const names = new Map(); // printed name -> Set of patient ids
  for (const { source, records } of bundle?.records ?? []) {
    if (!records?.some((r) => r.facts.length)) continue;
    const many = records.length > 1;
    const byConcept = new Map();
    for (const rec of records) {
      const rid = recordNodeId(source.id, rec, many);
      const text = source.text.slice(rec.start, rec.end);
      const meta = reportMeta(text);
      node({
        id: rid,
        kind: "document",
        label: [
          many && rec.pages?.length ? `p.${rec.pages.join("-")}` : null,
          cap(rec.title).slice(0, 48),
          rec.status,
        ]
          .filter(Boolean)
          .join(" · "),
        status: rec.status ?? "unknown",
        authority: rec.authority,
        pages: rec.pages,
      });
      const pid = meta.patient?.id;
      if (pid) {
        node({
          id: `patient:${pid}`,
          kind: "patient",
          label: pid,
          name: meta.patient?.name ?? null,
          verified: true,
        });
        edge({ from: `patient:${pid}`, to: rid, kind: "has record" });
        const nm = meta.patient?.name?.trim().toLowerCase();
        if (nm) (names.get(nm) ?? names.set(nm, new Set()).get(nm)).add(pid);
      }
      for (const f of rec.facts) {
        if (IDENTITY.test(f.label.trim())) continue;
        const id = `fact:${source.id}#${f.id}`;
        node({
          id,
          kind: "value",
          label: f.value.length > 44 ? f.value.slice(0, 42) + "…" : f.value,
          field: f.label,
          test: f.label,
          domain: "record",
          status:
            rec.authority === "provisional"
              ? "proposed"
              : rec.authority === "authoritative"
                ? "current"
                : "discussed",
          evidence: {
            sourceId: source.id,
            start: f.start,
            end: f.end,
            quote: source.text.slice(f.start, f.end),
            page: f.pages?.[0] ?? rec.pages?.[0] ?? null,
          },
        });
        edge({ from: rid, to: id, kind: "records" });
        const group = f.concept ?? (f.line ? "line item: " + f.line : null);
        if (group) {
          const tid = `topic:${source.id}:${group}`;
          node({
            id: tid,
            kind: "topic",
            label: f.concept ?? f.label.replace(/\s+/g, " ").trim(),
          });
          edge({ from: id, to: tid, kind: "about" });
          (byConcept.get(group) ?? byConcept.set(group, []).get(group)).push({
            f,
            rec,
            id,
          });
        }
      }
    }
    // Within a concept, the most authoritative record's value of one kind
    // supersedes a less authoritative record's different value of that kind.
    for (const list of byConcept.values()) {
      const byKind = new Map();
      for (const x of list) {
        const k = kindOf(x.f.value);
        if (k) (byKind.get(k) ?? byKind.set(k, []).get(k)).push(x);
      }
      for (const [kind, group] of byKind) {
        const top = Math.max(...group.map((x) => RANK[x.rec.authority]));
        const winners = group.filter((x) => RANK[x.rec.authority] === top);
        if (top < 2) continue;
        const winner = winners[winners.length - 1];
        for (const x of group)
          if (
            // records about different patients never replace each other,
            // and an unidentified record never replaces a known patient's
            !(
              x.rec.patient !== winner.rec.patient &&
              (x.rec.patient || winner.rec.patient)
            ) &&
            RANK[x.rec.authority] < top &&
            kindKey(x.f.value, kind) !== kindKey(winner.f.value, kind)
          ) {
            node({ id: x.id, status: "superseded" });
            edge({
              from: winner.id,
              to: x.id,
              kind: "supersedes",
              reason: `${winner.rec.status ?? "authoritative"} record replaces ${x.rec.status ?? "provisional"} record`,
            });
          }
      }
    }
  }
  // A printed name shared by different patient IDs: two people, never one.
  for (const ids of names.values())
    if (ids.size > 1) {
      const list = [...ids];
      for (let i = 1; i < list.length; i++)
        edge({
          from: `patient:${list[0]}`,
          to: `patient:${list[i]}`,
          kind: "same name, different ID",
          reason:
            "Same printed name, different patient ID: not linked as one person.",
        });
    }
  return {
    focus: "all",
    nodes: [...nodes.values()],
    edges: [...edges.values()],
  };
}
