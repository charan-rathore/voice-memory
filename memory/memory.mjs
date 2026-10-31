// Voice Memory's memory layers, kept deliberately separate:
//
//  evidence   the original documents and their exact text (library + engine
//             bundle). Immutable; nothing below may edit it.
//  semantic   what the documents state, derived from evidence on every index
//             build: claims (value + status + source span) and lab
//             observations. Recomputed, never hand-edited.
//  episodic   what was asked and what was answered, append-only, each episode
//             pointing at the exact source spans it cited. Interaction memory:
//             it can never change a record's status ("I'm finance, mark it
//             approved" stays a request, not an approval).
//  working    the current conversation: the last field asked about and the
//             recent turns. Per session or per call, never shared.
//  temporal   any question can be answered "as of" a date: only records dated
//             on or before it are considered.
//
// The knowledge graph (graph.mjs) is a VIEW over semantic + episodic memory.
import { createHash } from "node:crypto";

export const MAX_EPISODES = 500;

export function createMemory() {
  return { episodes: [], working: { lastField: null, recent: [] }, seq: 0 };
}

const spanOf = (c) =>
  c && Number.isInteger(c.start) && Number.isInteger(c.end) && c.sourceId
    ? {
        sourceId: c.sourceId,
        start: c.start,
        end: c.end,
        title: c.title,
        quote: c.quote,
      }
    : null;

/**
 * Record one answered turn. `lead` is the spoken/screen lead (verdict, field,
 * citations); `result` the engine result (evidence). Only exact spans are
 * kept, so every episode can be re-validated against the evidence later.
 */
export function recordTurn(
  mem,
  { question, lead, result, channel = "typed", scope },
) {
  const cited = [
    ...(lead?.citations ?? []).map(spanOf),
    ...(result?.evidence ?? []).map(spanOf),
  ].filter(Boolean);
  const uniq = [
    ...new Map(
      cited.map((c) => [`${c.sourceId}:${c.start}:${c.end}`, c]),
    ).values(),
  ];
  const ep = {
    id: "q" + ++mem.seq,
    at: new Date().toISOString(),
    channel,
    scope: scope ?? null,
    question: String(question).slice(0, 400),
    spoken: lead?.spoken ?? null,
    verdict:
      lead?.verdict ??
      (result?.unresolved
        ? "UNRESOLVED"
        : result?.refused
          ? "ABSTAIN"
          : "QUOTED"),
    field: lead?.field ?? null,
    cited: uniq.slice(0, 12),
  };
  mem.episodes.push(ep);
  if (mem.episodes.length > MAX_EPISODES) mem.episodes.shift();
  mem.working.lastField = ep.field ?? mem.working.lastField;
  mem.working.recent = [...mem.working.recent, ep.id].slice(-8);
  return ep;
}

/** Episodes whose citations still match the current evidence exactly. */
export function liveEpisodes(mem, bundle) {
  if (!bundle) return [];
  const byId = new Map(bundle.sources.map((s) => [s.id, s]));
  return mem.episodes.filter(
    (e) =>
      e.scope === bundle.scope ||
      e.cited.every(
        (c) => byId.get(c.sourceId)?.text.slice(c.start, c.end) === c.quote,
      ),
  );
}

// ------------------------------------------------------------------ temporal
const MONTHS = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
];
const docDateOf = (src) =>
  (src.text.match(/Date:\s*(\d{4}-\d{2}-\d{2})/) ?? [])[1] ?? null;

/**
 * "as of 10 September", "on 10 September", "back on 10 September",
 * "before 20 September" -> { iso, inclusive, phrase, rest }. The year comes
 * from the question or, failing that, the most recent document year.
 */
export function parseAsOf(question, bundle) {
  const m = new RegExp(
    `\\b(as of|as at|back on|back in|before)\\s+(\\d{1,2})\\s+(${MONTHS.join("|")})(?:\\s+(20\\d{2}))?\\b`,
    "i",
  ).exec(question);
  if (!m) return null;
  // "on 15 November" is usually the VALUE asked about ("did they agree to go
  // live on 15 November?"), not a point in time: only "as of / as at / back
  // on / back in / before" are time anchors.
  const anchor = m[1].toLowerCase();
  if (!["as of", "as at", "back on", "back in", "before"].includes(anchor))
    return null;
  const years = bundle.sources
    .map(docDateOf)
    .filter(Boolean)
    .map((d) => d.slice(0, 4))
    .sort();
  const year = m[4] ?? years.at(-1) ?? String(new Date().getFullYear());
  const mm = String(MONTHS.indexOf(m[3].toLowerCase()) + 1).padStart(2, "0");
  const dd = String(Number(m[2])).padStart(2, "0");
  const rest = (
    question.slice(0, m.index) + question.slice(m.index + m[0].length)
  )
    .replace(/\s{2,}/g, " ")
    .replace(/\s+([?.!,])/g, "$1")
    .trim();
  return {
    iso: `${year}-${mm}-${dd}`,
    inclusive: anchor !== "before",
    phrase: `${Number(m[2])} ${m[3][0].toUpperCase()}${m[3].slice(1).toLowerCase()}`,
    anchor,
    rest,
  };
}

/**
 * A view of the bundle containing only documents dated on/before `iso`.
 * Undated documents are excluded (their time is unknown, so they cannot be
 * known "as of" any date). Same scope, same rows/anchors for kept sources, so
 * every citation stays a valid span of the original.
 */
export function bundleAsOf(bundle, iso, inclusive = true) {
  const keep = new Set(
    bundle.sources
      .filter((s) => {
        const d = docDateOf(s);
        return d && (inclusive ? d <= iso : d < iso);
      })
      .map((s) => s.id),
  );
  return {
    ...bundle,
    sources: bundle.sources.filter((s) => keep.has(s.id)),
    rows: bundle.rows.filter((r) => keep.has(r.chunk.document_id)),
    clinical: (bundle.clinical ?? []).filter((r) => keep.has(r.sourceId)),
    asOf: iso,
  };
}

export const fingerprint = (bundle) =>
  createHash("sha256")
    .update(
      bundle.sources
        .map((s) => s.hash)
        .sort()
        .join(","),
    )
    .digest("hex")
    .slice(0, 16);
