// Session document library: uploads move through real stages
//   uploaded -> validating -> parsing -> indexing -> ready
// with needs_review and failed as explicit outcomes. The status shown to the
// person is set only from what actually happened (parser result, index
// build), never from the HTTP upload succeeding.
//
// Storage is in-memory and session-scoped (deleted on session expiry, reset
// or explicit removal). This is a demo-grade store: NOT appropriate for real
// personal or medical records. See docs/ARCHITECTURE.md for the durable design.
import { randomUUID } from "node:crypto";
import { ingestFile, locate, LIMITS } from "./ingest/index.mjs";
import { buildTextDocument } from "./ingest/canonical.mjs";
import { safeFilename } from "./ingest/detect.mjs";

export const MAX_LIBRARY_DOCS = 10;
export const MAX_SESSION_BYTES = 40 * 1024 * 1024;
// Measured peak RSS while OCR'ing a scan: ~276 MB (worker + tesseract).
// One parse at a time fits a 512 MB host; raise on bigger machines.
const MAX_PARALLEL_PARSES = Math.max(
  1,
  Number(process.env.VM_PARSE_CONCURRENCY) || 1,
);

// Process-wide parse slots: the host is small (Render free: 512 MB).
let active = 0;
const waiting = [];
async function slot() {
  if (active < MAX_PARALLEL_PARSES) {
    active++;
    return;
  }
  await new Promise((r) => waiting.push(r));
  active++;
}
function freeSlot() {
  active--;
  waiting.shift()?.();
}

export const libraryOf = (s) => (s.library ??= []);

const TERMINAL = new Set(["ready", "needs_review", "failed"]);

export function publicEntry(e) {
  return {
    id: e.id,
    filename: e.filename,
    kind: e.kind,
    bytes: e.bytes,
    status: e.status,
    included:
      e.status === "ready" || (e.status === "needs_review" && e.included),
    error: e.error,
    review: e.review ?? [],
    warnings: (e.doc?.warnings ?? []).map((w) => ({
      code: w.code,
      message: w.message,
      page: w.page ?? null,
    })),
    stats: e.doc?.stats ?? null,
    parser: e.doc?.parser ?? null,
    createdAt: e.createdAt,
    updatedAt: e.updatedAt,
    timings: e.timings,
  };
}

export function documentView(e) {
  if (!e.doc) return null;
  const {
    text,
    elements,
    pages,
    warnings,
    stats,
    parser,
    sha256,
    textSha256,
    kind,
    mime,
    schema,
    filename,
  } = e.doc;
  return {
    id: e.id,
    schema,
    filename,
    kind,
    mime,
    sha256,
    textSha256,
    parser,
    pages,
    elements,
    text,
    warnings,
    stats,
    status: e.status,
  };
}

function uniqueTitle(lib, name) {
  const taken = new Set(
    lib.filter((e) => e.status !== "failed").map((e) => e.title),
  );
  if (!taken.has(name)) return name;
  const m = /^(.*?)(\.[^.]*)?$/.exec(name);
  for (let i = 2; ; i++) {
    const t = `${m[1]} (${i})${m[2] ?? ""}`;
    if (!taken.has(t)) return t;
  }
}

/**
 * Accept an upload. Returns the entry immediately; parsing continues in the
 * background and calls `rebuild(s)` when the index must change.
 */
export function addUpload(s, bytes, filename, rebuild) {
  const lib = libraryOf(s);
  const name = safeFilename(filename);
  const live = lib.filter((e) => e.status !== "failed");
  if (live.length >= MAX_LIBRARY_DOCS) {
    const err = Error(
      `You can keep up to ${MAX_LIBRARY_DOCS} documents in a session. Remove one to add another.`,
    );
    err.status = 409;
    throw err;
  }
  const used = lib.reduce((n, e) => n + (e.original?.length ?? 0), 0);
  if (used + bytes.length > MAX_SESSION_BYTES) {
    const err = Error(
      `This session holds ${Math.round(used / 1048576)} MB of files; the limit is ${MAX_SESSION_BYTES / 1048576} MB. Remove a document first.`,
    );
    err.status = 413;
    throw err;
  }
  const entry = {
    id: randomUUID(),
    filename: name,
    title: uniqueTitle(lib, name),
    kind: null,
    bytes: bytes.length,
    original: bytes,
    status: "uploaded",
    included: false,
    error: null,
    review: [],
    doc: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    timings: {},
  };
  lib.push(entry);
  const t0 = Date.now();
  const set = (status) => {
    entry.status = status;
    entry.updatedAt = Date.now();
    entry.timings[status] = Date.now() - t0;
  };
  (async () => {
    await slot();
    try {
      if (!lib.includes(entry)) return; // removed while queued
      const r = await ingestFile(bytes, name, { onStage: set });
      if (!lib.includes(entry)) return; // removed while parsing
      if (!r.ok) {
        entry.error = { code: r.code, stage: r.stage, message: r.message };
        entry.original = null; // nothing derived; do not keep unreadable bytes
        set("failed");
        return;
      }
      entry.doc = r.doc;
      entry.kind = r.doc.kind;
      entry.review = r.review;
      if (r.status === "needs_review") {
        set("needs_review");
        return;
      }
      set("indexing"); // indexable() includes "indexing" for this build
      try {
        rebuild(s);
        set("ready");
      } catch (e) {
        entry.error = {
          code: "index_failed",
          stage: "indexing",
          message: e?.message || "The document could not be indexed.",
        };
        set("failed");
        rebuild(s);
      }
    } catch {
      entry.error = {
        code: "parse_failed",
        stage: "parsing",
        message: "This file could not be read.",
      };
      set("failed");
    } finally {
      freeSlot();
    }
  })();
  return entry;
}

/** Text documents imported as JSON (demo corpus, samples): same library, same index. */
export function replaceWithText(s, documents) {
  const lib = libraryOf(s);
  lib.length = 0;
  for (const d of documents) {
    const bytes = Buffer.from(String(d.text ?? ""), "utf8");
    const filename = safeFilename(d.title);
    const kind = /\.(md|markdown)$/i.test(filename) ? "markdown" : "text";
    const doc = buildTextDocument({
      source: String(d.text ?? ""),
      kind,
      mime:
        kind === "markdown"
          ? "text/markdown; charset=utf-8"
          : "text/plain; charset=utf-8",
      filename,
      bytes,
      parser: { name: "vm-text/1", ocr: null },
    });
    doc.parser.pipeline = "vm-ingest/1";
    lib.push({
      id: randomUUID(),
      filename,
      title: d.title,
      kind,
      bytes: bytes.length,
      original: bytes,
      status: "ready",
      included: true,
      error: null,
      review: [],
      doc,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      timings: {},
    });
  }
}

/** Documents that belong in the index, in library order. */
export function indexable(s) {
  return libraryOf(s).filter(
    (e) =>
      e.doc &&
      (e.status === "ready" ||
        e.status === "indexing" ||
        (e.status === "needs_review" && e.included)),
  );
}

export function findEntry(s, id) {
  return libraryOf(s).find((e) => e.id === id) ?? null;
}

export function removeEntry(s, id) {
  const lib = libraryOf(s);
  const i = lib.findIndex((e) => e.id === id);
  if (i < 0) return false;
  lib.splice(i, 1);
  return true;
}

export function isSettled(s) {
  return libraryOf(s).every((e) => TERMINAL.has(e.status));
}

/**
 * Attach source locations to every evidence item: which library document,
 * which pages and regions, extraction method and OCR confidence. Read-only
 * with respect to the evidence itself (quote/offsets untouched).
 */
const FOCUS_STOP = new Set(
  "a an the and or of in on at to for from by with is are was were be do does did has have had will what which who when where why how this that it its not no any".split(
    " ",
  ),
);
const focusTerms = (s) =>
  new Set(
    (
      String(s)
        .toLowerCase()
        .match(/[a-z0-9][a-z0-9.%/-]*/g) ?? []
    ).filter((t) => t.length > 1 && !FOCUS_STOP.has(t)),
  );

/**
 * Within a cited span, the element(s) that actually match the question: a
 * chunk can cover a whole page, but the viewer should land on the line.
 */
function focusOf(doc, loc, question) {
  const q = focusTerms(question);
  const leaves = loc.elementIds
    .map((id) => doc.elements.find((e) => e.id === id))
    .filter(Boolean);
  const scored = leaves
    .map((e) => {
      const t = focusTerms(e.text ?? (e.cells ?? []).join(" "));
      let n = 0;
      for (const w of q) if (t.has(w)) n++;
      return { e, n };
    })
    .filter((x) => x.n > 0)
    .sort((a, b) => b.n - a.n);
  if (!scored.length) return null;
  // A table's header row labels the answer; it is never the answer itself
  // when a data row also matches. Naming a row's first cell is the strongest
  // signal ("TSH" picks the TSH row, not every row sharing a unit).
  for (const x of scored)
    if (
      x.e.type === "table-row" &&
      focusTerms(x.e.cells?.[0] ?? "").size &&
      [...focusTerms(x.e.cells[0])].every((t) => q.has(t))
    )
      x.n += 1;
  scored.sort((a, b) => b.n - a.n);
  const data = scored.filter((x) => x.e.type !== "table-header");
  const pool = data.length ? data : scored;
  const top = pool
    .filter((x) => x.n === pool[0].n)
    .slice(0, 3)
    .map((x) => x.e);
  const headerOf = (e) =>
    doc.elements.find((h) => h.parent === e.parent && h.type === "table-header")
      ?.cells ?? null;
  return {
    elementIds: top.map((e) => e.id),
    pages: [...new Set(top.map((e) => e.page).filter((p) => p != null))],
    regions: top
      .filter((e) => e.page != null && e.bbox)
      .map((e) => ({ page: e.page, bbox: e.bbox })),
    text: top.map((e) => e.text ?? (e.cells ?? []).join(" | ")),
    rows: top
      .filter((e) => e.type === "table-row")
      .map((e) => ({ header: headerOf(e), cells: e.cells })),
  };
}

export function decorateResult(result, s) {
  const map = s.sourceToEntry ?? new Map();
  const deco = (ev) => {
    const e = map.get(ev.sourceId);
    if (!e?.doc) return ev;
    const location = locate(e.doc, ev.start, ev.end);
    location.focus = focusOf(e.doc, location, result.question ?? "");
    return { ...ev, documentId: e.id, kind: e.doc.kind, location };
  };
  return {
    ...result,
    evidence: (result.evidence ?? []).map(deco),
    reviewEvidence: (result.reviewEvidence ?? []).map(deco),
  };
}

/** Evidence -> location resolver bound to a bundle (used by the voice layer). */
export function locatorFor(sourceToEntry) {
  return (ev) => {
    const e = sourceToEntry.get(ev.sourceId);
    return e?.doc ? locate(e.doc, ev.start, ev.end) : null;
  };
}

export { LIMITS };
