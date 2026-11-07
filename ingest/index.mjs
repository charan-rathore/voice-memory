// Ingestion entry point used by the server and the benchmark.
//
//   const r = await ingestFile(bytes, filename, { onStage, onEvent, onPartial });
//   r.ok   -> { doc, status: "ready"|"needs_review", review: string[] }
//   !r.ok  -> { code, stage, message }   (never throws for bad input)
//
// Validation (signature, size) runs in-process and is cheap. Parsing runs in
// a worker thread with a heap limit and a timeout.
//
// onEvent receives content-free progress records from the parser (page
// numbers, counts, OCR %). onPartial receives a readable result early when a
// PDF's text pages are done before its scanned pages; if OCR then overruns
// the timeout or the heap limit, that partial result is returned (scanned
// pages marked unread and held for review) instead of discarding the file.
import { Worker } from "node:worker_threads";
import { detectFormat, safeFilename } from "./detect.mjs";
import { IngestError, LIMITS } from "./errors.mjs";

export { locate } from "./canonical.mjs";

// One OCR at a time across all parses (tesseract peaks near 280 MB on a
// 512 MB host); text reading runs in parallel around it.
let ocrBusy = false;
const ocrQueue = [];
function takeOcr() {
  if (!ocrBusy) {
    ocrBusy = true;
    return Promise.resolve();
  }
  return new Promise((r) => ocrQueue.push(r));
}
function giveOcr() {
  const next = ocrQueue.shift();
  if (next) next();
  else ocrBusy = false;
}
export { LIMITS } from "./errors.mjs";

export async function ingestFile(
  bytes,
  filename,
  {
    onStage = () => {},
    onEvent = () => {},
    onPartial = () => {},
    timeoutMs = LIMITS.parseTimeoutMs,
  } = {},
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
    let holdsOcr = false;
    let wantsOcr = false;
    const done = (v) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      wantsOcr = false;
      // Do not reopen OCR or parse admission while the old worker is
      // still retiring. Its nested OCR engine has already shut down before
      // a successful final result is posted (worker.mjs).
      worker.terminate().then(
        () => {
          try {
            onEvent({ k: "parser-worker-stopped" });
          } catch {}
          if (holdsOcr) giveOcr();
          holdsOcr = false;
          resolve(v);
        },
        () => {
          // Unknown teardown means the OCR permit cannot safely be reused.
          resolve({
            ok: false,
            code: "parse_failed",
            stage: "parsing",
            message:
              "The document parser could not be stopped safely. Try again later.",
          });
        },
      );
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
    let partial = null;
    // The scanned pages did not finish: keep every page that was read,
    // mark the rest unread, and hold the document for review.
    const salvage = (why) => {
      const doc = partial.doc;
      for (const w of doc.warnings)
        if (w.code === "ocr_pending") {
          w.code = "no_text_layer";
          w.message = `Page ${w.page} is a scanned image and ${why}, so it was not read. The other pages were.`;
        }
      const review = [
        ...new Set([
          ...partial.review,
          ...doc.warnings
            .filter((w) => w.code === "no_text_layer")
            .map((w) => w.message),
        ]),
      ];
      onEvent({ k: "salvaged" });
      return { ok: true, doc, status: "needs_review", review };
    };
    const fail = (v) => done(partial ? salvage(v.why) : v.result);
    const timer = setTimeout(() => {
      fail({
        why: `reading it took longer than ${Math.round(timeoutMs / 1000)} seconds`,
        result: {
          ok: false,
          code: "timeout",
          stage: "parsing",
          message: `Reading this file took longer than ${Math.round(timeoutMs / 1000)} seconds, so it was stopped.`,
        },
      });
    }, timeoutMs);
    worker.on("message", (m) => {
      if (settled) return;
      if (m?.type === "ocr-wait") {
        wantsOcr = true;
        takeOcr().then(() => {
          // Finished (or stopped) while waiting: hand the turn on.
          if (settled || !wantsOcr) return giveOcr();
          holdsOcr = true;
          try {
            worker.postMessage({ type: "ocr-go" });
          } catch {
            done({
              ok: false,
              code: "parse_failed",
              stage: "parsing",
              message: "This file could not be read.",
            });
          }
        });
        return;
      }
      if (m?.type === "event") {
        try {
          onEvent(m.event);
        } catch {
          /* a display callback never breaks parsing */
        }
        return;
      }
      if (m?.type === "partial") {
        partial = { doc: m.doc, status: m.status, review: m.review };
        try {
          onPartial(partial);
        } catch {
          /* the final result still arrives */
        }
        return;
      }
      done(
        m.ok ? { ok: true, doc: m.doc, status: m.status, review: m.review } : m,
      );
    });
    worker.once("error", (e) => {
      const oom =
        /heap|memory/i.test(String(e?.message)) ||
        e?.code === "ERR_WORKER_OUT_OF_MEMORY";
      fail({
        why: oom
          ? "needed more memory than the safety limit allows"
          : "could not be decoded",
        result: {
          ok: false,
          code: oom ? "resource_limit" : "parse_failed",
          stage: "parsing",
          message: oom
            ? "This file needed more memory to read than the safety limit allows."
            : "This file could not be read.",
        },
      });
    });
    worker.once("exit", (code) => {
      if (code !== 0)
        fail({
          why: "could not be decoded",
          result: {
            ok: false,
            code: "parse_failed",
            stage: "parsing",
            message: "This file could not be read.",
          },
        });
    });
  });
}
