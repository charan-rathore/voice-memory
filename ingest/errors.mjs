// Typed ingestion failures. `code` is stable and machine-readable (tests and
// the UI branch on it); `message` is written for the person holding the file.
export class IngestError extends Error {
  constructor(code, message, { stage = "validating", detail = null } = {}) {
    super(message);
    this.name = "IngestError";
    this.code = code;
    this.stage = stage;
    this.detail = detail;
  }
}

export const LIMITS = Object.freeze({
  maxFileBytes: 15 * 1024 * 1024, // per upload
  maxPdfPages: 60,
  maxOcrPages: 12, // scanned pages OCR'd per PDF
  maxImagePixels: 25_000_000,
  maxDocxEntries: 2000,
  maxDocxXmlBytes: 20 * 1024 * 1024, // inflated word/document.xml
  maxDocxRatio: 200, // inflated / compressed, per entry
  maxTextChars: 250_000, // canonical text per document (engine limit)
  minTextChars: 40,
  parseTimeoutMs: 90_000,
  workerHeapMb: 384,
});

// Below this mean OCR confidence a document is held for review instead of
// being indexed automatically. Tesseract confidences are not calibrated
// probabilities; this is a conservative gate, not an accuracy claim.
export const OCR_REVIEW_CONFIDENCE = 85;
// Below this the OCR output is treated as unreadable rather than reviewable:
// offering near-random text for "include anyway" would invite indexing junk.
export const OCR_FAIL_CONFIDENCE = 40;
