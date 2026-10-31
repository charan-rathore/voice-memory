// Local OCR (tesseract.js, English model shipped in node_modules: no network,
// no paid service). Returns paragraphs and lines with pixel boxes and
// per-word confidence so callers can flag uncertain numbers instead of
// silently trusting them.
import { createWorker } from "tesseract.js";
import { zlibSync } from "fflate";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const LANG_PATH = fileURLToPath(
  new URL(
    "../node_modules/@tesseract.js-data/eng/4.0.0_best_int",
    import.meta.url,
  ),
);

let workerPromise = null;
function worker() {
  workerPromise ??= createWorker("eng", 1, {
    langPath: LANG_PATH,
    cachePath: tmpdir(),
    gzip: true,
    errorHandler: () => {},
  });
  return workerPromise;
}

export async function shutdownOcr() {
  if (!workerPromise) return;
  const w = await workerPromise.catch(() => null);
  workerPromise = null;
  await w?.terminate().catch(() => {});
}

export const OCR_ENGINE = "tesseract.js@5 eng 4.0.0_best_int";

/**
 * @param {Uint8Array} image PNG or JPEG bytes
 * @returns {Promise<{width:number,height:number,confidence:number,
 *   paragraphs: Array<{text:string, bbox:{x0:number,y0:number,x1:number,y1:number},
 *   confidence:number, lines: Array<{text:string,bbox:object,confidence:number}>,
 *   uncertain: Array<{text:string, confidence:number}>}>}>}
 */
export async function recognize(image) {
  const w = await worker();
  const { data } = await w.recognize(
    Buffer.from(image),
    {},
    { blocks: true, text: false },
  );
  const paragraphs = [];
  for (const b of data.blocks ?? [])
    for (const p of b.paragraphs ?? []) {
      const lines = (p.lines ?? [])
        .map((l) => ({
          text: l.text.replace(/\s+/g, " ").trim(),
          bbox: l.bbox,
          confidence: l.confidence,
        }))
        .filter((l) => l.text);
      if (!lines.length) continue;
      const words = (p.lines ?? []).flatMap((l) => l.words ?? []);
      paragraphs.push({
        text: lines.map((l) => l.text).join("\n"),
        bbox: p.bbox,
        lines,
        // Conservative: a paragraph is only as trustworthy as its weakest line.
        confidence: Math.min(...lines.map((l) => l.confidence)),
        uncertain: words
          .filter((wd) => wd.confidence < 70 && /\d/.test(wd.text))
          .map((wd) => ({
            text: wd.text,
            confidence: Math.round(wd.confidence),
          })),
      });
    }
  return { confidence: data.confidence, paragraphs };
}

// Minimal PNG encoder for raw pixels pulled out of a scanned PDF page.
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++)
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  Buffer.from(data).copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}
/** @param {number} channels 1 (gray), 3 (RGB) or 4 (RGBA) */
export function encodePng(width, height, pixels, channels) {
  const colorType = { 1: 0, 3: 2, 4: 6 }[channels];
  const stride = width * channels;
  const raw = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    raw.set(
      pixels.subarray(y * stride, (y + 1) * stride),
      y * (stride + 1) + 1,
    );
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = colorType;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlibSync(raw, { level: 3 })),
    chunk("IEND", new Uint8Array(0)),
  ]);
}
