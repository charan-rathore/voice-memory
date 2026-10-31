// Canonical document representation (schema vm.document/1).
//
// The original upload is immutable and stored separately. This structure is
// the parser's interpretation of it: elements in reading order, each with the
// exact character span it occupies in `text` (the string the evidence engine
// indexes and quotes from) plus, where the format has them, its page and
// bounding region. A citation [start, end) into `text` therefore resolves to
// concrete elements, pages and regions without any substring search.
//
// Coordinates are only recorded for formats that have them (PDF, images).
// DOCX and plain text have no pages; they carry paragraph order instead.
import { createHash } from "node:crypto";

export const SCHEMA = "vm.document/1";

const sha256 = (b) => createHash("sha256").update(b).digest("hex");

/**
 * @typedef {{type: "heading"|"paragraph"|"table"|"furniture", text?: string,
 *   level?: number, page?: number|null, bbox?: number[]|null,
 *   rows?: Array<{cells: string[], bbox?: number[]|null}>,
 *   method: string, confidence?: number|null}} Block
 */

/** Markdown-ish linearization the chunker understands (headings, pipe tables). */
function renderBlock(b) {
  if (b.type === "heading")
    return "#".repeat(Math.min(4, b.level ?? 1)) + " " + b.text;
  if (b.type === "table") {
    const width = Math.max(...b.rows.map((r) => r.cells.length));
    const line = (cells) =>
      "| " +
      Array.from({ length: width }, (_, i) =>
        (cells[i] ?? "").replace(/\|/g, "/"),
      ).join(" | ") +
      " |";
    const [head, ...rest] = b.rows;
    return [
      line(head.cells),
      "| " + Array(width).fill("---").join(" | ") + " |",
      ...rest.map((r) => line(r.cells)),
    ].join("\n");
  }
  return b.text;
}

/**
 * Build a canonical document from parser blocks. Furniture (repeated page
 * headers/footers) is kept as elements for transparency but excluded from the
 * indexed text, and that exclusion is recorded.
 */
export function buildDocument({
  blocks,
  kind,
  mime,
  filename,
  bytes,
  parser,
  pages = [],
  warnings = [],
}) {
  const elements = [];
  const parts = [];
  let offset = 0;
  const section = [];
  let n = 0;
  for (const b of blocks) {
    const id = "e" + ++n;
    if (b.type === "furniture") {
      elements.push({
        id,
        type: "furniture",
        text: b.text,
        page: b.page ?? null,
        bbox: b.bbox ?? null,
        method: b.method,
        indexed: false,
        start: null,
        end: null,
        section: [...section],
      });
      continue;
    }
    if (b.type === "heading") {
      const level = b.level ?? 1;
      while (section.length && section[section.length - 1].level >= level)
        section.pop();
      section.push({ level, text: b.text });
    }
    const rendered = renderBlock(b);
    if (!rendered.trim()) continue;
    if (parts.length) offset += 2; // "\n\n" separator
    const start = offset;
    parts.push(rendered);
    offset += rendered.length;
    const el = {
      id,
      type: b.type,
      level: b.type === "heading" ? (b.level ?? 1) : undefined,
      text: b.type === "table" ? undefined : b.text,
      page: b.page ?? null,
      bbox: b.bbox ?? null,
      method: b.method,
      confidence: b.confidence ?? null,
      indexed: true,
      start,
      end: offset,
      section: section.map((s) => s.text),
    };
    elements.push(el);
    if (b.type === "table") {
      // Row children: a citation on one row maps to that row's region, and a
      // value never detaches from its label, unit or range (same line).
      const lines = rendered.split("\n");
      let at = start;
      lines.forEach((ln, i) => {
        if (i === 1) {
          at += ln.length + 1;
          return; // separator line
        }
        const r = b.rows[i === 0 ? 0 : i - 1];
        elements.push({
          id: id + ".r" + (i === 0 ? 0 : i - 1),
          parent: id,
          type: i === 0 ? "table-header" : "table-row",
          cells: r.cells,
          text: ln,
          page: b.page ?? null,
          bbox: r.bbox ?? null,
          method: b.method,
          confidence: r.confidence ?? b.confidence ?? null,
          indexed: true,
          start: at,
          end: at + ln.length,
          section: el.section,
        });
        at += ln.length + 1;
      });
    }
  }
  const text = parts.join("\n\n");
  return finish({
    text,
    elements,
    kind,
    mime,
    filename,
    bytes,
    parser,
    pages,
    warnings,
  });
}

/**
 * Text and Markdown: the canonical text IS the (newline-normalized) original,
 * so every citation is a literal span of what the person uploaded.
 */
export function buildTextDocument({
  source,
  kind,
  mime,
  filename,
  bytes,
  parser,
}) {
  const text = source.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  const elements = [];
  const section = [];
  let n = 0;
  const re = /[^\n]+(?:\n[^\n]+)*/g; // blocks separated by blank lines
  for (let m; (m = re.exec(text)); ) {
    const block = m[0];
    const lines = block.split("\n");
    let at = m.index;
    let para = null;
    const flush = () => {
      if (para) elements.push(para);
      para = null;
    };
    for (const ln of lines) {
      const h = kind === "markdown" ? /^(#{1,6})\s+(.*)$/.exec(ln) : null;
      if (h) {
        flush();
        const level = h[1].length;
        while (section.length && section[section.length - 1].level >= level)
          section.pop();
        section.push({ level, text: h[2].trim() });
        elements.push({
          id: "e" + ++n,
          type: "heading",
          level,
          text: h[2].trim(),
          page: null,
          bbox: null,
          method: "text",
          indexed: true,
          start: at,
          end: at + ln.length,
          section: section.map((s) => s.text),
        });
      } else if (ln.trim()) {
        if (!para)
          para = {
            id: "e" + ++n,
            type: "paragraph",
            text: ln,
            page: null,
            bbox: null,
            method: "text",
            indexed: true,
            start: at,
            end: at + ln.length,
            section: section.map((s) => s.text),
          };
        else {
          para.text += "\n" + ln;
          para.end = at + ln.length;
        }
      }
      at += ln.length + 1;
    }
    flush();
  }
  return finish({
    text,
    elements,
    kind,
    mime,
    filename,
    bytes,
    parser,
    pages: [],
    warnings: [],
  });
}

function finish({
  text,
  elements,
  kind,
  mime,
  filename,
  bytes,
  parser,
  pages,
  warnings,
}) {
  const ocrElements = elements.filter((e) => e.method === "ocr" && e.indexed);
  const confs = ocrElements
    .map((e) => e.confidence)
    .filter((c) => typeof c === "number");
  return {
    schema: SCHEMA,
    kind,
    mime,
    filename,
    sha256: sha256(bytes),
    bytes: bytes.length,
    parser,
    parsedAt: new Date().toISOString(),
    pages,
    elements,
    text,
    textSha256: sha256(text),
    warnings,
    stats: {
      characters: text.length,
      words: (text.match(/\S+/g) ?? []).length,
      elements: elements.filter((e) => e.indexed && !e.parent).length,
      tables: elements.filter((e) => e.type === "table").length,
      pages: pages.length || null,
      pagesWithText: pages.length
        ? pages.filter((p) => p.textSource !== "none").length
        : null,
      ocrPages: pages.filter((p) => p.textSource === "ocr").length,
      meanOcrConfidence: confs.length
        ? Math.round(confs.reduce((a, b) => a + b, 0) / confs.length)
        : null,
      furnitureExcluded: elements.filter((e) => e.type === "furniture").length,
    },
  };
}

/**
 * Resolve a [start, end) span of canonical text to the elements, pages and
 * regions it covers. Leaf elements (table rows) win over their table.
 */
export function locate(doc, start, end) {
  const hits = doc.elements.filter(
    (e) => e.indexed && e.start < end && e.end > start,
  );
  const leafParents = new Set(
    hits.filter((e) => e.parent).map((e) => e.parent),
  );
  const leaves = hits.filter((e) => !leafParents.has(e.id));
  const pages = [
    ...new Set(leaves.map((e) => e.page).filter((p) => p != null)),
  ].sort((a, b) => a - b);
  return {
    elementIds: leaves.map((e) => e.id),
    pages,
    regions: leaves
      .filter((e) => e.page != null && e.bbox)
      .map((e) => ({ page: e.page, bbox: e.bbox })),
    section: leaves[0]?.section ?? [],
    methods: [...new Set(leaves.map((e) => e.method))],
    minConfidence: leaves.some((e) => typeof e.confidence === "number")
      ? Math.min(
          ...leaves
            .filter((e) => typeof e.confidence === "number")
            .map((e) => e.confidence),
        )
      : null,
    paragraphIndex: doc.pages.length
      ? null
      : doc.elements
          .filter((e) => e.indexed && !e.parent)
          .findIndex((e) => e.id === (leaves[0]?.parent ?? leaves[0]?.id)) +
          1 || null,
  };
}
