// A parser worker stuck in native teardown must not hold HTTP upload
// completion or the process-wide OCR queue forever.
import { EventEmitter } from "node:events";
import { test } from "node:test";
import assert from "node:assert/strict";
import { ingestFile } from "./index.mjs";

const bytes = Buffer.from(
  "A fictional document with more than forty characters, " +
    "intended only to exercise the parser lifecycle.",
);

class FakeWorker extends EventEmitter {
  stdout = { resume() {} };
  stderr = { resume() {} };

  constructor(mode) {
    super();
    this.mode = mode;
    if (mode === "request-ocr")
      queueMicrotask(() => this.emit("message", { type: "ocr-wait" }));
  }

  postMessage() {}

  terminate() {
    if (this.mode === "hang") return new Promise(() => {});
    return Promise.resolve(0);
  }
}

test("a parser that never terminates reaches a bounded explicit failure", async () => {
  const result = await ingestFile(bytes, "fixture.txt", {
    timeoutMs: 12,
    terminationTimeoutMs: 25,
    workerFactory: () => new FakeWorker("hang"),
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, "worker_shutdown_failed");
  assert.match(result.message, /stop safely/);
});

test("after unsafe teardown, new OCR requests fail instead of queuing forever", async () => {
  const result = await ingestFile(bytes, "fixture.txt", {
    timeoutMs: 300,
    terminationTimeoutMs: 25,
    workerFactory: () => new FakeWorker("request-ocr"),
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, "ocr_unavailable");
});
