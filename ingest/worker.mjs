// Worker-thread entry: parsing untrusted files happens here, under a heap
// limit and a wall-clock timeout enforced by the parent (which terminates the
// thread). A parser crash or bomb takes down this thread, never the server.
import { parentPort, workerData } from "node:worker_threads";
import { parseBuffer } from "./parse.mjs";
import { shutdownOcr } from "./ocr.mjs";

const { bytes, filename } = workerData;
try {
  const out = await parseBuffer(Buffer.from(bytes), filename);
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
}
