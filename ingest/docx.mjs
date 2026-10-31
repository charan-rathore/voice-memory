// DOCX parsing from WordprocessingML. Only [Content_Types].xml and
// word/document.xml are inflated, after checking declared sizes, entry count
// and compression ratio (decompression-bomb guard). The parser runs inside a
// heap-limited worker with a timeout as a second line of defence.
// Supported: paragraphs, Title/Heading styles, tables, tabs and breaks,
// tracked insertions. Skipped (and reported): deleted tracked text, footnotes,
// headers/footers, comments, embedded images.
import { unzipSync, strFromU8 } from "fflate";
import { DOMParser } from "@xmldom/xmldom";
import { IngestError, LIMITS } from "./errors.mjs";

export const DOCX_PARSER = "vm-docx/1 (fflate + xmldom)";
const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";

export function parseDocx(buf) {
  let entries = 0;
  const wanted = new Set(["[Content_Types].xml", "word/document.xml"]);
  const present = new Set();
  let files;
  try {
    files = unzipSync(new Uint8Array(buf), {
      filter(f) {
        entries++;
        if (entries > LIMITS.maxDocxEntries)
          throw new IngestError(
            "docx_too_complex",
            "This Word file has too many internal parts to process safely.",
            { stage: "parsing" },
          );
        if (f.name.includes("..") || f.name.startsWith("/"))
          throw new IngestError(
            "unsafe_archive",
            "This Word file contains unsafe internal paths.",
            { stage: "parsing" },
          );
        present.add(f.name);
        if (!wanted.has(f.name)) return false;
        if (
          f.originalSize > LIMITS.maxDocxXmlBytes ||
          (f.size > 0 && f.originalSize / f.size > LIMITS.maxDocxRatio)
        )
          throw new IngestError(
            "decompression_limit",
            `This Word file expands to ${(f.originalSize / 1048576).toFixed(0)} MB of internal data, which is over the safety limit.`,
            { stage: "parsing" },
          );
        return true;
      },
    });
  } catch (e) {
    if (e instanceof IngestError) throw e;
    throw new IngestError(
      "corrupted",
      "This Word file could not be opened. It may be damaged or not a real .docx.",
      { stage: "parsing" },
    );
  }
  const main = files["word/document.xml"];
  if (!main)
    throw new IngestError(
      "corrupted",
      "This file is a ZIP archive but not a Word document (no word/document.xml).",
      { stage: "parsing" },
    );
  if (main.length > LIMITS.maxDocxXmlBytes)
    throw new IngestError(
      "decompression_limit",
      "This Word file's text data is over the safety limit.",
      { stage: "parsing" },
    );

  const errors = [];
  const dom = new DOMParser({
    onError: (level, msg) => {
      if (level !== "warning") errors.push(msg);
    },
  }).parseFromString(strFromU8(main), "text/xml");
  if (errors.length || !dom?.documentElement)
    throw new IngestError(
      "corrupted",
      "This Word file's main text part is not valid XML.",
      { stage: "parsing" },
    );
  const body = dom.getElementsByTagNameNS(W, "body")[0];
  if (!body)
    throw new IngestError("corrupted", "This Word file has no document body.", {
      stage: "parsing",
    });

  const warnings = [];
  let deleted = 0;
  const childEls = (el) =>
    Array.from(el.childNodes ?? []).filter((n) => n.nodeType === 1);
  const isW = (n, name) => n.namespaceURI === W && n.localName === name;

  const runText = (el) => {
    let out = "";
    const walk = (n) => {
      for (const c of childEls(n)) {
        if (isW(c, "del")) {
          deleted++;
          continue; // tracked deletion: not part of the current text
        }
        if (isW(c, "t")) out += c.textContent ?? "";
        else if (isW(c, "tab")) out += "\t";
        else if (isW(c, "br") || isW(c, "cr")) out += "\n";
        else if (isW(c, "delText") || isW(c, "instrText")) continue;
        else walk(c);
      }
    };
    walk(el);
    return out;
  };
  const styleOf = (p) => {
    const pPr = childEls(p).find((c) => isW(c, "pPr"));
    const ps = pPr && childEls(pPr).find((c) => isW(c, "pStyle"));
    return ps?.getAttributeNS(W, "val") || ps?.getAttribute("w:val") || "";
  };

  const blocks = [];
  const visit = (container) => {
    for (const n of childEls(container)) {
      if (isW(n, "p")) {
        const text = runText(n)
          .replace(/[ \t]+/g, " ")
          .replace(/ *\n */g, "\n")
          .trim();
        if (!text) continue;
        const style = styleOf(n);
        const h = /^heading\s?(\d)$/i.exec(style);
        if (/^title$/i.test(style))
          blocks.push({ type: "heading", level: 1, text, method: "docx-xml" });
        else if (h)
          blocks.push({
            type: "heading",
            level: Math.min(4, Number(h[1]) + 1),
            text,
            method: "docx-xml",
          });
        else blocks.push({ type: "paragraph", text, method: "docx-xml" });
      } else if (isW(n, "tbl")) {
        const rows = childEls(n)
          .filter((r) => isW(r, "tr"))
          .map((tr) => ({
            cells: childEls(tr)
              .filter((c) => isW(c, "tc"))
              .map((tc) => runText(tc).replace(/\s+/g, " ").trim()),
          }))
          .filter((r) => r.cells.some(Boolean));
        if (rows.length >= 2)
          blocks.push({ type: "table", rows, method: "docx-xml" });
        else
          for (const r of rows)
            blocks.push({
              type: "paragraph",
              text: r.cells.filter(Boolean).join(" "),
              method: "docx-xml",
            });
      } else if (isW(n, "sdt") || isW(n, "sdtContent") || isW(n, "customXml")) {
        visit(n);
      }
    }
  };
  visit(body);
  if (deleted)
    warnings.push({
      code: "tracked_deletions_skipped",
      message: `${deleted} tracked deletion(s) were left out; only the current text was read.`,
    });
  const skipped = [
    ["word/footnotes.xml", "footnotes"],
    ["word/endnotes.xml", "endnotes"],
    ["word/comments.xml", "comments"],
  ].filter(([f]) => present.has(f));
  if (skipped.length)
    warnings.push({
      code: "parts_not_read",
      message: `This build does not read ${skipped.map(([, l]) => l).join(", ")} in Word files.`,
    });
  if ([...present].some((f) => /^word\/(header|footer)\d*\.xml$/.test(f)))
    warnings.push({
      code: "headers_not_read",
      message: "Page headers and footers in this Word file were not read.",
    });
  if ([...present].some((f) => f.startsWith("word/media/")))
    warnings.push({
      code: "images_not_read",
      message:
        "Images inside this Word file were not read (no OCR for embedded images yet).",
    });
  return {
    blocks,
    pages: [],
    warnings,
    parser: { name: DOCX_PARSER, ocr: null },
  };
}
