// Session document library: uploads move through real stages
//   uploaded -> validating -> parsing -> indexing -> ready
// with needs_review and failed as explicit outcomes. The status shown to the
// person is set only from what actually happened (parser result, index
// build), never from the HTTP upload succeeding.
//
// Storage is in-memory and session-scoped (deleted on session expiry, reset
// or explicit removal). This is a demo-grade store: NOT appropriate for real
// personal or medical records. See docs/ARCHITECTURE.md for the durable design.
import { randomUUID, createHash } from "node:crypto";
import { ingestFile, locate, LIMITS } from "./ingest/index.mjs";
import { buildTextDocument } from "./ingest/canonical.mjs";
import { safeFilename } from "./ingest/detect.mjs";

export const MAX_LIBRARY_DOCS = 10;
export const MAX_SESSION_BYTES = 40 * 1024 * 1024;
// Process-wide admission budget (audit P0): per-session caps alone allowed
// 50 sessions x 40 MB = 2 GB of originals on a 512 MB host. Uploads are
// refused once all live libraries together hold this much.
//
// This bounds RETAINED LIBRARY CONTENT, not whole-process RSS: a ready
// document holds both its original bytes (provenance/download) and its
// parsed canonical document, so globalBytes() counts both. Embeddings, the
// parse cache (byte-capped below), and transient parse/OCR memory are
// bounded separately (dense RSS shed guard, single-parse concurrency,
// parser limits in ingest/errors.mjs).
export const MAX_GLOBAL_BYTES =
  Number(process.env.VM_GLOBAL_DOC_MB || 96) * 1024 * 1024;
const libraries = new Set(); // WeakRef<library array>

// Serialized-size estimator for retained JS structures. Counts every string
// as its UTF-8 bytes plus a per-value overhead, so duplicated text inside
// the canonical document (blocks, sections) is charged for, not just the
// top-level text field. An estimate, not a heap measurement: object headers
// and V8 internals are approximated by the constants.
function deepBytes(v, depth = 0) {
  if (v == null) return 4;
  if (typeof v === "string") return 16 + Buffer.byteLength(v, "utf8");
  if (typeof v === "number") return 8;
  if (typeof v === "boolean") return 4;
  if (depth > 24) return 64;
  if (Array.isArray(v))
    return 64 + v.reduce((n, x) => n + deepBytes(x, depth + 1), 0);
  if (typeof v === "object") {
    let n = 64;
    for (const k of Object.keys(v))
      n += 16 + Buffer.byteLength(k, "utf8") + deepBytes(v[k], depth + 1);
    return n;
  }
  return 8;
}
function retainedBytes(e) {
  return (e.original?.length ?? 0) + (e.doc ? deepBytes(e.doc) : 0);
}
export function globalBytes() {
  let n = 0;
  for (const ref of libraries) {
    const lib = ref.deref();
    if (!lib) {
      libraries.delete(ref);
      continue;
    }
    for (const e of lib) n += retainedBytes(e);
  }
  return n;
}
// Content-addressed parse reuse: the same bytes are never parsed or OCR'd
// twice (key = SHA-256 of the bytes + pipeline version). Each session still
// has to upload the bytes itself, so reuse never grants access to anything.
const PARSE_CACHE_MAX = 24;
// Byte bound as well as a count bound: cached parse results are dominated
// by their canonical text, and 24 large texts would otherwise sit outside
// every budget (audit: cache was counted nowhere).
const PARSE_CACHE_MAX_BYTES =
  Number(process.env.VM_PARSE_CACHE_MB || 24) * 1024 * 1024;
const parseCache = new Map(); // key -> { value, size }
export const parseCacheStats = { hits: 0, misses: 0, bytes: 0, evictions: 0 };
function parseCacheTrim() {
  while (
    parseCache.size > 0 &&
    (parseCache.size > PARSE_CACHE_MAX ||
      parseCacheStats.bytes > PARSE_CACHE_MAX_BYTES)
  ) {
    const oldest = parseCache.keys().next().value;
    parseCacheStats.bytes -= parseCache.get(oldest).size;
    parseCache.delete(oldest);
    parseCacheStats.evictions++;
  }
}
const PIPELINE = "vm-ingest/1";
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

export const libraryOf = (s) => {
  if (!s.library) {
    s.library = [];
    libraries.add(new WeakRef(s.library));
  }
  return s.library;
};

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
  // Cheap pre-parse heuristic ONLY: compressed formats (DOCX/PDF) can
  // expand far beyond 2x raw, so this admits optimistically and the REAL
  // budget check runs post-parse with actual sizes (see below).
  const global = globalBytes();
  if (global + 2 * bytes.length > MAX_GLOBAL_BYTES) {
    const err = Error(
      "The server is holding as many documents as it safely can right now. Try again shortly, or remove a document.",
    );
    err.status = 503;
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
      const cacheKey =
        // The declared type is part of validation ("named .pdf but it's a
        // PNG" must still be refused), so the extension is in the key.
        PIPELINE +
        ":" +
        (/\.([a-z0-9]{1,8})$/i.exec(name)?.[1].toLowerCase() ?? "") +
        ":" +
        createHash("sha256").update(bytes).digest("hex");
      let r;
      let cacheable = false;
      const hit = parseCache.get(cacheKey);
      if (hit) {
        parseCacheStats.hits++;
        parseCache.delete(cacheKey);
        parseCache.set(cacheKey, hit); // LRU refresh; size/bytes unchanged
        set("validating");
        set("parsing");
        r = structuredClone(hit.value);
        if (r.doc) r.doc.filename = name;
      } else {
        parseCacheStats.misses++;
        r = await ingestFile(bytes, name, { onStage: set });
        cacheable = true;
      }
      if (!lib.includes(entry)) return; // removed while parsing
      if (!r.ok) {
        entry.error = { code: r.code, stage: r.stage, message: r.message };
        entry.original = null; // nothing derived; do not keep unreadable bytes
        set("failed");
        return;
      }
      // The real budget check, with actual sizes: the pre-parse 2x estimate
      // cannot see expansion of compressed formats, and concurrent uploads
      // are admitted on estimates made before either parse finished.
      // globalBytes() already counts this entry's original bytes.
      if (globalBytes() + deepBytes(r.doc) > MAX_GLOBAL_BYTES) {
        entry.error = {
          code: "budget_exceeded",
          stage: "indexing",
          message:
            "The server is holding as many documents as it safely can right now. Try again shortly, or remove a document.",
        };
        entry.original = null; // free the bytes; nothing is indexed
        entry.doc = null;
        set("failed");
        return; // rejected results are NOT cached: fail closed before any commit
      }
      if (cacheable && r.ok) {
        // Cache commit only after the document was accepted (miss path
        // only; a hit is already cached). Size of the
        // WHOLE cached result (document + review + metadata), including
        // text duplicated inside the structure.
        const size = deepBytes(r);
        if (size <= PARSE_CACHE_MAX_BYTES) {
          parseCache.set(cacheKey, { value: structuredClone(r), size });
          parseCacheStats.bytes += size;
          parseCacheTrim();
        }
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
