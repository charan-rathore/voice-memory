import { readFileSync } from "node:fs";
import { parseBuffer } from "../ingest/parse.mjs";
import { shutdownOcr } from "../ingest/ocr.mjs";
try {
  for (const file of [
    "digital.pdf",
    "scanned.pdf",
    "rotated.pdf",
    "mixed.pdf",
  ]) {
    const r = await parseBuffer(
      readFileSync(
        new URL("../ingest/fixtures/files/" + file, import.meta.url),
      ),
      file,
    );
    if (!r.doc.text.length) throw Error("empty " + file);
  }
  console.log("canvasImports=" + globalThis.canvasImports);
} finally {
  await shutdownOcr();
}
