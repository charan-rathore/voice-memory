// Ingestion entry point used by the server and the benchmark.
//
//   const r = await ingestFile(bytes, filename, { onStage });
//   r.ok   -> { doc, status: "ready"|"needs_review", review: string[] }
//   !r.ok  -> { code, stage, message }   (never throws for bad input)
//
// Validation (signature, size) runs in-process and is cheap. Parsing runs in
// a worker thread with a heap limit and a timeout.
import { Worker } from "node:worker_threads";
import { detectFormat, safeFilename } from "./detect.mjs";
import { IngestError, LIMITS } from "./errors.mjs";

export { locate } from "./canonical.mjs";
export { LIMITS } from "./errors.mjs";

export async function ingestFile(
  bytes,
  filename,
  { onStage = () => {}, timeoutMs = LIMITS.parseTimeoutMs } = {},
) {
  const name = safeFilename(filename);
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  onStage("validating");
  try {
    detectFormat(buf, name);
  } catch (e) {
    if (e instanceof IngestError)
      return {
        ok: false,
        code: e.code,
        stage: "validating",
        message: e.message,
      };
    throw e;
  }
  onStage("parsing");
  return await new Promise((resolve) => {
    let settled = false;
    const done = (v) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(v);
    };
    const worker = new Worker(new URL("./worker.mjs", import.meta.url), {
      workerData: { bytes: new Uint8Array(buf), filename: name },
      resourceLimits: { maxOldGenerationSizeMb: LIMITS.workerHeapMb },
      stdout: true,
      stderr: true,
    });
    // Parser libraries can be chatty; never forward their output (it may
    // contain document text) to the server log.
    worker.stdout?.resume();
    worker.stderr?.resume();
    const timer = setTimeout(() => {
      worker.terminate();
      done({
        ok: false,
        code: "timeout",
        stage: "parsing",
        message: `Reading this file took longer than ${Math.round(timeoutMs / 1000)} seconds, so it was stopped.`,
      });
    }, timeoutMs);
    worker.once("message", (m) => {
      done(
        m.ok ? { ok: true, doc: m.doc, status: m.status, review: m.review } : m,
      );
      worker.terminate();
    });
    worker.once("error", (e) =>
      done({
        ok: false,
        code:
          /heap|memory/i.test(String(e?.message)) ||
          e?.code === "ERR_WORKER_OUT_OF_MEMORY"
            ? "resource_limit"
            : "parse_failed",
        stage: "parsing",
        message:
          /heap|memory/i.test(String(e?.message)) ||
          e?.code === "ERR_WORKER_OUT_OF_MEMORY"
            ? "This file needed more memory to read than the safety limit allows."
            : "This file could not be read.",
      }),
    );
    worker.once("exit", (code) => {
      if (code !== 0)
        done({
          ok: false,
          code: "parse_failed",
          stage: "parsing",
          message: "This file could not be read.",
        });
    });
  });
}
