import { readFileSync } from "node:fs";
import { parseBuffer } from "../ingest/parse.mjs";
import { shutdownOcr } from "../ingest/ocr.mjs";
try {
  for (const f of ["notes.txt", "minutes.docx", "printed.png", "printed.jpg"]) {
    const r = await parseBuffer(
      readFileSync(new URL("../ingest/fixtures/files/" + f, import.meta.url)),
      f,
    );
    if (!r.doc.text.length) throw Error("empty " + f);
    console.log(f, r.status);
  }
} finally {
  await shutdownOcr();
}
