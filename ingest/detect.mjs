// Format detection by file signature. The extension is only used to decide
// between text and Markdown and to catch mislabelled files; it never makes a
// binary file "text".
import { IngestError, LIMITS } from "./errors.mjs";

const startsWith = (buf, bytes, at = 0) =>
  buf.length >= at + bytes.length && bytes.every((b, i) => buf[at + i] === b);

const PDF = [0x25, 0x50, 0x44, 0x46, 0x2d]; // %PDF-
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG = [0xff, 0xd8, 0xff];
const ZIP = [0x50, 0x4b, 0x03, 0x04];
const OLE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]; // legacy .doc/.xls

export const MIME = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  png: "image/png",
  jpeg: "image/jpeg",
  text: "text/plain; charset=utf-8",
  markdown: "text/markdown; charset=utf-8",
};

const LABEL = {
  pdf: "a PDF",
  docx: "a Word document",
  png: "a PNG image",
  jpeg: "a JPEG image",
  zip: "a ZIP archive",
  ole: "an older Office file (.doc/.xls)",
  binary: "binary data",
};

export function extensionOf(filename) {
  const m = /\.([a-z0-9]{1,8})$/i.exec(String(filename ?? ""));
  return m ? m[1].toLowerCase() : "";
}

export function safeFilename(name) {
  // Display name only: strip any path, control characters and bidi overrides.
  const base = String(name ?? "")
    .split(/[\\/]/)
    .pop()
    .replace(/[\u0000-\u001f\u007f‪-‮⁦-⁩]/g, "")
    .trim();
  if (!base) return "untitled";
  return base.length > 140 ? base.slice(0, 120) + "…" + base.slice(-16) : base;
}

function sniff(buf) {
  if (startsWith(buf, PDF)) return "pdf";
  // Some PDFs carry junk before the header; the spec tolerates 1024 bytes.
  const head = buf.subarray(0, 1024);
  if (head.indexOf("%PDF-") > 0) return "pdf";
  if (startsWith(buf, PNG)) return "png";
  if (startsWith(buf, JPEG)) return "jpeg";
  if (startsWith(buf, ZIP)) return "zip";
  if (startsWith(buf, OLE)) return "ole";
  return null;
}

function looksLikeText(buf) {
  if (buf.includes(0x00)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(buf);
    return true;
  } catch {
    return false;
  }
}

/**
 * @returns {{kind: "pdf"|"docx"|"png"|"jpeg"|"text"|"markdown", mime: string}}
 */
export function detectFormat(buf, filename) {
  if (!buf || buf.length === 0)
    throw new IngestError(
      "empty",
      "This file is empty (0 bytes). Check that it saved correctly, then upload it again.",
    );
  if (buf.length > LIMITS.maxFileBytes)
    throw new IngestError(
      "too_large",
      `This file is ${(buf.length / 1048576).toFixed(1)} MB. The limit is ${LIMITS.maxFileBytes / 1048576} MB per file.`,
    );
  const ext = extensionOf(filename);
  const sig = sniff(buf);
  let kind = null;
  if (sig === "zip") {
    // A .docx is a ZIP with a Word main part; the part check happens in the
    // parser (central directory), here we only accept the declared intent.
    if (ext === "docx") kind = "docx";
    else
      throw new IngestError(
        "unsupported_type",
        `This looks like ${LABEL.zip}. Voice Memory reads PDF, Word (.docx), PNG, JPEG, text and Markdown files.`,
      );
  } else if (sig === "ole") {
    throw new IngestError(
      "legacy_office",
      "Older .doc files aren't supported yet. Open it in Word or Google Docs and save it as .docx.",
    );
  } else if (sig) {
    kind = sig;
  } else if (looksLikeText(buf)) {
    kind = ext === "md" || ext === "markdown" ? "markdown" : "text";
  } else {
    throw new IngestError(
      ext === "txt" || ext === "md" ? "binary_text" : "unsupported_type",
      ext === "txt" || ext === "md"
        ? `This .${ext} file contains binary data, not readable text.`
        : "Voice Memory reads PDF, Word (.docx), PNG, JPEG, text and Markdown files. This file isn't one of those.",
    );
  }
  // A mislabelled file is rejected rather than guessed at: the name is what
  // the person believes they uploaded.
  const expected = {
    pdf: ["pdf"],
    docx: ["docx"],
    png: ["png"],
    jpeg: ["jpg", "jpeg"],
    text: ["txt", "text", "csv", "log", ""],
    markdown: ["md", "markdown"],
  }[kind];
  if (ext && !expected.includes(ext)) {
    const known = [
      "pdf",
      "docx",
      "png",
      "jpg",
      "jpeg",
      "txt",
      "md",
      "markdown",
      "doc",
    ];
    throw new IngestError(
      known.includes(ext) ? "signature_mismatch" : "unsupported_type",
      known.includes(ext)
        ? `This file is named .${ext} but its contents are ${LABEL[kind] ?? "something else"}. Export it again or rename it to match.`
        : `.${ext} files aren't supported. Voice Memory reads PDF, Word (.docx), PNG, JPEG, text and Markdown files.`,
    );
  }
  return { kind, mime: MIME[kind] };
}

/** Pixel dimensions from the header, without decoding the image. */
export function imageDimensions(buf, kind) {
  if (kind === "png") {
    if (buf.length < 24) return null;
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  if (kind === "jpeg") {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) {
        i++;
        continue;
      }
      const marker = buf[i + 1];
      const len = buf.readUInt16BE(i + 2);
      // SOF0..SOF15 except DHT(C4), JPG(C8), DAC(CC)
      if (
        marker >= 0xc0 &&
        marker <= 0xcf &&
        ![0xc4, 0xc8, 0xcc].includes(marker)
      )
        return {
          height: buf.readUInt16BE(i + 5),
          width: buf.readUInt16BE(i + 7),
        };
      i += 2 + len;
    }
  }
  return null;
}
