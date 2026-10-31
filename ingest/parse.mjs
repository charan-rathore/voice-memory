// Format dispatch + canonical build + review policy. Pure function of the
// bytes and filename (runs inside the ingestion worker).
import { IngestError, LIMITS, OCR_FAIL_CONFIDENCE } from "./errors.mjs";
import { detectFormat } from "./detect.mjs";
import { buildDocument, buildTextDocument } from "./canonical.mjs";
import { parsePdf } from "./pdf.mjs";
import { parseDocx } from "./docx.mjs";
import { parseImage } from "./image.mjs";

export const PIPELINE_VERSION = "vm-ingest/1";

const REVIEW_CODES = new Set([
  "ocr_low_confidence",
  "ocr_uncertain_number",
  "no_text_layer",
  "page_unreadable",
]);

/**
 * @returns {Promise<{doc: object, status: "ready"|"needs_review", review: string[]}>}
 */
export async function parseBuffer(buf, filename) {
  const { kind, mime } = detectFormat(buf, filename);
  let doc;
  if (kind === "text" || kind === "markdown") {
    const source = new TextDecoder("utf-8", { fatal: true }).decode(buf);
    doc = buildTextDocument({
      source,
      kind,
      mime,
      filename,
      bytes: buf,
      parser: { name: "vm-text/1", ocr: null },
    });
  } else {
    const parsed =
      kind === "pdf"
        ? await parsePdf(buf)
        : kind === "docx"
          ? parseDocx(buf)
          : await parseImage(buf, kind);
    doc = buildDocument({ ...parsed, kind, mime, filename, bytes: buf });
  }
  doc.parser.pipeline = PIPELINE_VERSION;
  const chars = doc.text.replace(/\s+/g, " ").trim().length;
  if (chars < LIMITS.minTextChars) {
    const scanned =
      doc.pages.length && doc.pages.every((p) => p.textSource === "none");
    throw new IngestError(
      scanned ? "no_text" : "too_little_text",
      scanned
        ? "No readable text was found in this file, even with OCR. If it's a photo or scan, try a sharper, straight-on image."
        : `Only ${chars} characters of text were found. Voice Memory needs at least ${LIMITS.minTextChars} to answer questions from a document.`,
      { stage: "parsing" },
    );
  }
  const ocr = doc.stats.meanOcrConfidence;
  if (
    ocr !== null &&
    ocr < OCR_FAIL_CONFIDENCE &&
    doc.stats.ocrPages + (doc.kind === "png" || doc.kind === "jpeg" ? 1 : 0) > 0
  )
    throw new IngestError(
      "unreadable_scan",
      `The text in this ${doc.kind === "pdf" ? "scan" : "image"} couldn't be read reliably (${ocr}% OCR confidence). Try a sharper, straight-on, well-lit image.`,
      { stage: "parsing" },
    );
  if (doc.text.length > LIMITS.maxTextChars)
    throw new IngestError(
      "too_long",
      `This document has ${doc.text.length.toLocaleString("en-US")} characters of text. The current limit is ${LIMITS.maxTextChars.toLocaleString("en-US")} per document; split it and upload the parts.`,
      { stage: "parsing" },
    );
  // Review policy: anything that means "the text we index may not be what the
  // page says" holds the document out of the index until a person confirms.
  const review = [
    ...new Set(
      doc.warnings
        .filter((w) => REVIEW_CODES.has(w.code))
        .map((w) => w.message),
    ),
  ];
  return { doc, status: review.length ? "needs_review" : "ready", review };
}
