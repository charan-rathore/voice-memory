// Worker-thread entry: parsing untrusted files happens here, under a heap
// limit and a wall-clock timeout enforced by the parent (which terminates the
// thread). A parser crash or bomb takes down this thread, never the server.
//
// Messages to the parent: {type:"event"} progress records (counts and page
// numbers only, never document text), at most one {type:"partial"} result
// when a PDF's text pages are readable before its scans are OCR'd, then the
// final result (the only message carrying `ok`).
import { parentPort, workerData } from "node:worker_threads";
import { parseBuffer } from "./parse.mjs";
import { shutdownOcr } from "./ocr.mjs";

const { bytes, filename } = workerData;
// The parent grants the OCR turn (one file OCRs at a time).
let ocrGo = null;
parentPort.on("message", (m) => {
  if (m?.type === "ocr-go") ocrGo?.();
});
try {
  const out = await parseBuffer(Buffer.from(bytes), filename, {
    onEvent: (event) => parentPort.postMessage({ type: "event", event }),
    onPartial: (r) => parentPort.postMessage({ type: "partial", ...r }),
    waitForOcr: () =>
      new Promise((resolve) => {
        ocrGo = resolve;
        parentPort.postMessage({ type: "ocr-wait" });
      }),
  });
  parentPort.postMessage({ ok: true, ...out });
} catch (e) {
  parentPort.postMessage({
    ok: false,
    code: e?.code ?? "parse_failed",
    stage: e?.stage ?? "parsing",
    message: e?.code ? e.message : "This file could not be read.",
  });
} finally {
  await shutdownOcr();
  parentPort.close();
}
