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
import { ingestFile, locate, LIMITS } from "../ingest/index.mjs";
import {
  buildTextDocument,
  sourceLineCapability,
} from "../ingest/canonical.mjs";
import { safeFilename } from "../ingest/detect.mjs";
import { PIPELINE_VERSION, parseCacheKey } from "../ingest/version.mjs";

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
// Measured peak RSS while OCR'ing a scan: ~276 MB (worker + tesseract).
// Two files are read at once; OCR itself takes turns across them (one at a
// time, ingest/index.mjs), so the peak stays that of one OCR while a second
// file's text pages are read alongside it. VM_PARSE_CONCURRENCY overrides.
const MAX_PARALLEL_PARSES = Math.max(
  1,
  Number(process.env.VM_PARSE_CONCURRENCY) || 2,
);

// Process-wide parse slots: the host is small (Render free: 512 MB).
// A visitor's upload goes ahead of queued built-in demo documents, which
// are parsed at boot: on a cold start the visitor must not wait behind them.
let active = 0;
const waiting = [];
async function slot(priority = 0) {
  if (active < MAX_PARALLEL_PARSES) {
    active++;
    return;
  }
  await new Promise((r) => {
    const at = waiting.findIndex((w) => w.priority < priority);
    const w = { priority, r };
    if (at < 0) waiting.push(w);
    else waiting.splice(at, 0, w);
  });
  active++;
}
function freeSlot() {
  active--;
  waiting.shift()?.r();
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
      e.status === "ready" ||
      e.status === "partial" ||
      (e.status === "needs_review" && e.included),
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
    // age: how long this upload has been in the pipeline, so a page view
    // can run its clock between polls without trusting the client's clock.
    progress: e.progress
      ? { ...e.progress, age: Date.now() - e.createdAt }
      : null,
    // What the document became (records, facts, index numbers, graph):
    // the reading view's "how it becomes numbers" panels.
    digest: e.digest ?? null,
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
    sourceLineMetadata: sourceLineCapability(e.doc),
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
export function findUploadRetry(s, bytes, filename) {
  const name = safeFilename(filename);
  const hash = createHash("sha256").update(bytes).digest("hex");
  return (
    libraryOf(s).find(
      (e) =>
        e.status !== "failed" &&
        e.filename === name &&
        (e.hash === hash || (!e.hash && e.original?.equals(bytes))),
    ) ?? null
  );
}

export function addUpload(
  s,
  bytes,
  filename,
  rebuild,
  { before = null, after = null } = {},
) {
  const lib = libraryOf(s);
  const name = safeFilename(filename);
  const live = lib.filter((e) => e.status !== "failed");
  const dup = findUploadRetry(s, bytes, name);
  if (dup) return dup;
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
    hash: createHash("sha256").update(bytes).digest("hex"),
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
    // What the pipeline view shows: page states, counts and a short
    // milestone log. Content-free: page numbers and counts, never text.
    progress: { pages: [], log: [], counts: null, answerableAt: null },
  };
  lib.push(entry);
  const t0 = Date.now();
  const set = (status) => {
    // ONE clock reading for the timing and its log event: two Date.now()
    // calls can straddle a millisecond, and the reading view replays the
    // log only up to the final timing - an event stamped 1 ms later would
    // be cut, freezing the view mid-read on a settled document.
    const now = Date.now();
    entry.status = status;
    entry.updatedAt = now;
    entry.timings[status] = now - t0;
    note({ k: "status", status }, now - t0);
  };
  function note(ev, at) {
    const pr = entry.progress;
    const t = at ?? Date.now() - t0;
    const pg = (n) => (pr.pages[n - 1] ??= { n, state: "waiting" });
    switch (ev.k) {
      case "open":
        for (let n = 1; n <= ev.pages; n++) pg(n);
        break;
      case "text":
        Object.assign(pg(ev.n), { state: "text", chars: ev.chars, t });
        break;
      case "scan":
        Object.assign(pg(ev.n), { state: "scan", t });
        break;
      case "ocr-start":
        Object.assign(pg(ev.n), { state: "ocr", p: 0, t });
        break;
      case "ocr":
        // Live percentage only; not logged (it would flood the log).
        pg(ev.n).p = ev.p;
        entry.updatedAt = Date.now();
        return;
      case "ocr-done":
        Object.assign(pg(ev.n), {
          state: ev.paragraphs ? "ocr-done" : "unread",
          p: 100,
          confidence: ev.confidence,
          uncertain: ev.uncertain,
          t,
        });
        break;
      case "ocr-skip":
        Object.assign(pg(ev.n), { state: "unread", t });
        break;
      case "salvaged":
        for (const p of pr.pages)
          if (p.state === "scan" || p.state === "ocr") p.state = "unread";
        break;
      case "layout":
      case "layout-partial":
        pr.counts = {
          tables: ev.tables,
          headings: ev.headings,
          paragraphs: ev.paragraphs,
          furniture: ev.furniture,
        };
        break;
    }
    pr.log.push({ t, ...ev });
    if (pr.log.length > 240) pr.log.splice(1, pr.log.length - 240);
    entry.updatedAt = Date.now();
  }
  // A new document object invalidates everything derived from the old one.
  const adopt = (doc, review) => {
    entry.doc = doc;
    entry.kind = doc.kind;
    entry.review = review;
    entry.clinical = undefined;
    entry.haystack = undefined;
    entry.records = undefined;
    entry.digest = undefined;
  };
  const indexed = () =>
    note({
      k: "indexed",
      elements: entry.doc?.stats?.elements ?? null,
      observations:
        entry.clinical?.observations?.length ??
        entry.clinical?.parts?.reduce((n, p) => n + p.observations.length, 0) ??
        null,
    });
  (async () => {
    let hasSlot = false;
    let preparing = false;
    try {
      // Admission may be queued, but a worker slot is always returned even if
      // memory preparation rejects. Previously these awaits sat outside the
      // try/finally, leaving an upload stuck at "Queued" indefinitely.
      await slot(String(s.sid ?? "").startsWith("case:") ? 0 : 1);
      hasSlot = true;
      if (!lib.includes(entry)) return; // removed while queued
      if (before) {
        preparing = true;
        set("preparing");
        let timer;
        try {
          await Promise.race([
            Promise.resolve().then(() =>
              typeof before === "function" ? before() : before,
            ),
            new Promise((_, reject) => {
              timer = setTimeout(
                () =>
                  reject(
                    Object.assign(
                      Error("Preparing the document reader timed out."),
                      { code: "prepare_timeout" },
                    ),
                  ),
                15000,
              );
            }),
          ]);
        } finally {
          clearTimeout(timer);
        }
      }
      if (!lib.includes(entry)) return; // removed during preparation
      // Declared extension stays in the key, preserving format validation.
      const cacheKey = parseCacheKey(bytes, name);
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
        note({ k: "cache" });
        for (const pg of r.doc?.pages ?? [])
          entry.progress.pages[pg.number - 1] = {
            n: pg.number,
            state:
              pg.textSource === "pdf"
                ? "text"
                : pg.textSource === "ocr"
                  ? "ocr-done"
                  : "unread",
            // A reused reading must show the same per-page facts as the
            // first one; without these the tile renders "undefined%".
            ...(pg.textSource === "ocr"
              ? {
                  p: 100,
                  confidence: pg.ocrConfidence ?? null,
                  uncertain: pg.ocrUncertain ?? 0,
                }
              : {}),
          };
      } else {
        parseCacheStats.misses++;
        r = await ingestFile(bytes, name, {
          onStage: set,
          onEvent: note,
          onPartial: (p) => {
            // Text pages are readable while scanned pages are still OCR'd:
            // index them now so questions work during OCR. Only a clean
            // partial (nothing needing review) is indexed early, and only
            // within the same memory budget as a final document.
            if (!lib.includes(entry) || p.status !== "ready") return;
            if (globalBytes() + deepBytes(p.doc) > MAX_GLOBAL_BYTES) return;
            const previous = {
              doc: entry.doc,
              status: entry.status,
              kind: entry.kind,
              review: entry.review,
              included: entry.included,
            };
            adopt(p.doc, p.review);
            set("partial");
            try {
              rebuild(s);
              entry.progress.answerableAt = Date.now() - t0;
              indexed();
            } catch {
              // A failed partial index was never published. Do not advertise
              // answerability before the next (final) rebuild succeeds.
              entry.doc = previous.doc;
              entry.status = previous.status;
              entry.kind = previous.kind;
              entry.review = previous.review;
              entry.included = previous.included;
              entry.progress.answerableAt = null;
            }
          },
        });
        cacheable = true;
      }
      if (!lib.includes(entry)) return; // removed while parsing
      if (!r.ok) {
        const wasIndexed = entry.status === "partial";
        entry.error = { code: r.code, stage: r.stage, message: r.message };
        entry.original = null; // nothing derived; do not keep unreadable bytes
        entry.doc = null;
        set("failed");
        if (wasIndexed) rebuild(s);
        return;
      }
      // The real budget check, with actual sizes: the pre-parse 2x estimate
      // cannot see expansion of compressed formats, and concurrent uploads
      // are admitted on estimates made before either parse finished.
      // globalBytes() already counts this entry's original bytes.
      // (An early partial version of this entry is already counted there.)
      const held = entry.doc ? deepBytes(entry.doc) : 0;
      if (globalBytes() - held + deepBytes(r.doc) > MAX_GLOBAL_BYTES) {
        entry.error = {
          code: "budget_exceeded",
          stage: "indexing",
          message:
            "The server is holding as many documents as it safely can right now. Try again shortly, or remove a document.",
        };
        const wasIndexed = entry.status === "partial";
        entry.original = null; // free the bytes; nothing is indexed
        entry.doc = null;
        set("failed");
        if (wasIndexed) rebuild(s);
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
      const wasIndexed = entry.status === "partial";
      adopt(r.doc, r.review);
      if (r.status === "needs_review") {
        // Review-required text may be searchable, but it must never be shown
        // as indexed until the final bundle is actually committed.
        set("indexing");
        entry.included = true;
        try {
          rebuild(s);
          indexed();
          set("needs_review");
        } catch (e) {
          entry.doc = null;
          entry.included = false;
          entry.error = {
            code: "index_failed",
            stage: "indexing",
            message: e?.message || "The document could not be indexed.",
          };
          set("failed");
          try {
            rebuild(s);
          } catch {
            /* preserve the preceding bundle */
          }
        }
        return;
      }
      set("indexing"); // indexable() includes "indexing" for this build
      try {
        rebuild(s);
        indexed();
        set("ready");
      } catch (e) {
        entry.error = {
          code: "index_failed",
          stage: "indexing",
          message: e?.message || "The document could not be indexed.",
        };
        entry.doc = null;
        set("failed");
        try {
          rebuild(s);
        } catch {
          /* preserve the preceding bundle */
        }
      }
    } catch (e) {
      const wasIndexed = entry.status === "partial";
      entry.error = {
        code:
          preparing && entry.status === "preparing"
            ? e?.code || "prepare_failed"
            : "parse_failed",
        stage:
          preparing && entry.status === "preparing" ? "preparing" : "parsing",
        message:
          preparing && entry.status === "preparing"
            ? "The document reader could not prepare safely. Try again."
            : "This file could not be read.",
      };
      entry.doc = null;
      set("failed");
      if (wasIndexed)
        try {
          rebuild(s);
        } catch {
          /* preserve the preceding bundle */
        }
    } finally {
      // Balanced for rejected admission, failed preparation, OCR timeouts and
      // successful parses; never resume the dense model at a fixed timer.
      try {
        if (preparing && after) await after();
      } catch {
        // Cleanup failure cannot hold a parser slot forever.
      } finally {
        if (hasSlot) freeSlot();
      }
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
    doc.parser.pipeline = PIPELINE_VERSION;
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
        e.status === "partial" ||
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
 * A retrieval chunk can cross a record boundary, so its quote can lead with
 * a stranger's record before the line the question matches. Trim that
 * prefix: cut at the last record/section heading before the first salient
 * question token, keeping the quote on the record the match belongs to.
 * Returns the (possibly unchanged) quote and how many characters were cut,
 * so callers can shift the start offset. Salient content near the start is
 * never touched, and with no heading to anchor a cut the quote is left
 * whole - a wrong trim would misattribute the excerpt, a kept prefix only
 * shows extra context.
 */
const RECORD_HEAD =
  /^\s*(?:patient\s+(?:name|id)\s*:|name\s*:|dob\s*:|date of birth\s*:|collected\s*:|report status\s*:|#{1,6}\s).*$/gim;
export function trimEvidenceQuote(quote, question) {
  if (!quote) return { quote, dropped: 0 };
  const q = focusTerms(question ?? "");
  if (!q.size) return { quote, dropped: 0 };
  const lower = quote.toLowerCase();
  let first = -1;
  for (const t of q) {
    const at = lower.indexOf(t);
    if (at >= 0 && (first < 0 || at < first)) first = at;
  }
  if (first < 300) return { quote, dropped: 0 };
  RECORD_HEAD.lastIndex = 0;
  let cut = -1;
  for (;;) {
    const m = RECORD_HEAD.exec(quote);
    if (!m || m.index >= first) break;
    cut = m.index;
  }
  if (cut <= 0) return { quote, dropped: 0 };
  return { quote: quote.slice(cut), dropped: cut };
}

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
  // A citation that is exactly one line (a lab row) is its own focus, even
  // when the question shares no word with it ("what was it before the
  // correction?"): the evidence already names the line.
  if (!scored.length && leaves.length === 1)
    scored.push({ e: leaves[0], n: 1 });
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
