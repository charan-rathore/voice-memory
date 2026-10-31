// PNG/JPEG of printed text via local OCR. Boxes are in image pixels with a
// top-left origin; the page record carries the pixel size so the viewer can
// scale highlights onto the original image.
import { IngestError, LIMITS, OCR_REVIEW_CONFIDENCE } from "./errors.mjs";
import { imageDimensions } from "./detect.mjs";
import { recognize, OCR_ENGINE } from "./ocr.mjs";

export async function parseImage(buf, kind) {
  const dims = imageDimensions(buf, kind);
  if (!dims || !dims.width || !dims.height)
    throw new IngestError(
      "corrupted",
      "This image could not be read. It may be damaged.",
      { stage: "parsing" },
    );
  if (dims.width * dims.height > LIMITS.maxImagePixels)
    throw new IngestError(
      "too_large",
      `This image is ${dims.width}×${dims.height} pixels. The limit is ${Math.round(LIMITS.maxImagePixels / 1e6)} megapixels.`,
      { stage: "parsing" },
    );
  let res;
  try {
    res = await recognize(buf);
  } catch {
    throw new IngestError(
      "corrupted",
      "This image could not be decoded for text recognition.",
      { stage: "parsing" },
    );
  }
  const warnings = [];
  const blocks = res.paragraphs.map((p) => {
    for (const u of p.uncertain)
      warnings.push({
        code: "ocr_uncertain_number",
        page: 1,
        message: `OCR is unsure about "${u.text}" (${u.confidence}% confidence). Check it against the image.`,
      });
    return {
      type: "paragraph",
      text: p.text.replace(/\n/g, " "),
      page: 1,
      bbox: [p.bbox.x0, p.bbox.y0, p.bbox.x1, p.bbox.y1],
      method: "ocr",
      confidence: Math.round(p.confidence),
    };
  });
  const confs = blocks.map((b) => b.confidence);
  const mean = confs.length
    ? confs.reduce((a, b) => a + b, 0) / confs.length
    : 0;
  if (blocks.length && mean < OCR_REVIEW_CONFIDENCE)
    warnings.push({
      code: "ocr_low_confidence",
      message: `This image was read with ${Math.round(mean)}% average OCR confidence. Review the text before relying on it.`,
    });
  return {
    blocks,
    pages: [
      {
        number: 1,
        width: dims.width,
        height: dims.height,
        rotation: 0,
        textSource: blocks.length ? "ocr" : "none",
        unit: "px",
      },
    ],
    warnings,
    parser: { name: "vm-image/1", ocr: OCR_ENGINE },
  };
}
