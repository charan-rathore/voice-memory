// Pooled parser thread: stays alive across files so pdf.js (and, within a
// batch, the OCR engine) is loaded once instead of once per file. Each job
// is isolated the same way a one-shot worker is: the parent enforces the
// timeout and heap limit and replaces this thread if it crashes or overruns.
//
// Protocol (every message carries the job id):
//   in : {type:"job", id, bytes, filename}   {type:"ocr-go", id}
//        {type:"ocr-release"}                (free the OCR engine's memory)
//   out: {type:"event"|"partial"|"ocr-wait", id, ...}
//        {type:"done", id, warm, result}     {type:"ocr-released"}
import { parentPort } from "node:worker_threads";
import { parseBuffer } from "./parse.mjs";
import { shutdownOcr, ocrWarm } from "./ocr.mjs";

let current = null;
parentPort.on("message", async (m) => {
  if (m?.type === "ocr-go" && current?.id === m.id) current.ocrGo?.();
  else if (m?.type === "ocr-release") {
    await shutdownOcr();
    parentPort.postMessage({ type: "ocr-released" });
  } else if (m?.type === "job") run(m);
});

async function run({ id, bytes, filename }) {
  current = { id, ocrGo: null };
  const post = (msg) => parentPort.postMessage({ ...msg, id });
  let result;
  try {
    const out = await parseBuffer(Buffer.from(bytes), filename, {
      onEvent: (event) => post({ type: "event", event }),
      onPartial: (r) => post({ type: "partial", ...r }),
      waitForOcr: () =>
        new Promise((resolve) => {
          current.ocrGo = resolve;
          post({ type: "ocr-wait" });
        }),
    });
    result = { ok: true, ...out };
  } catch (e) {
    result = {
      ok: false,
      code: e?.code ?? "parse_failed",
      stage: e?.stage ?? "parsing",
      message: e?.code ? e.message : "This file could not be read.",
    };
  }
  current = null;
  post({ type: "done", warm: ocrWarm(), result });
}
