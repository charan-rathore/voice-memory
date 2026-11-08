// A small pool of warm parser threads, handed to ingestFile as its
// workerFactory. Measured on the repo's fixtures: starting a thread and
// loading pdf.js cost about 260 ms of CPU per file, nearly all of a one-page
// PDF's reading time (about 2.6 s on a 0.1-CPU host); a scanned file also
// reloaded the OCR engine every time.
//
// lease() returns an object with the Worker surface ingestFile uses (on,
// once, postMessage, terminate), so ingestFile's timeout, crash, partial and
// OCR-turn handling are unchanged:
//   - terminate() after a finished job returns the thread to the pool;
//     terminate() during a job (timeout, failure) kills and replaces it.
//   - one OCR engine in memory at a time: a warm engine counts as holding
//     the OCR turn and is released before another thread starts OCR; it is
//     kept only while more files are waiting or being read, never at rest
//     beside the embedding model.
//   - idle threads retire after VM_PARSE_IDLE_MS (default 60 s).
import { Worker } from "node:worker_threads";
import { EventEmitter } from "node:events";
import { LIMITS } from "./errors.mjs";

const SIZE = Math.max(1, Number(process.env.VM_PARSE_CONCURRENCY) || 2);
const IDLE_MS = Number(process.env.VM_PARSE_IDLE_MS) || 60_000;
const URL_ = new URL("./pool-worker.mjs", import.meta.url);

const free = []; // idle real threads
const waiting = []; // virtual workers waiting for a thread
let size = 0;
let inFlight = 0; // jobs leased and not finished
let ocrHolder = null; // the thread holding a warm OCR engine
let releasing = null; // pending release of that engine
let nextId = 1;
export const poolStats = { spawned: 0, reused: 0, replaced: 0, ocrReleases: 0 };

function spawn() {
  const w = new Worker(URL_, {
    resourceLimits: { maxOldGenerationSizeMb: LIMITS.workerHeapMb },
    stdout: true,
    stderr: true,
  });
  // Parser libraries can be chatty; their output may contain document text.
  w.stdout?.resume();
  w.stderr?.resume();
  w.unref();
  size++;
  poolStats.spawned++;
  w.job = null;
  w.on("message", (m) => {
    if (m?.type === "ocr-released") {
      if (ocrHolder === w) ocrHolder = null;
      w.onReleased?.();
      w.onReleased = null;
      return;
    }
    if (w.job && m?.id === w.job.id) w.job.fromThread(m);
  });
  w.on("error", (e) => w.job?.emit("error", e));
  w.on("exit", (code) => {
    size--;
    const at = free.indexOf(w);
    if (at >= 0) free.splice(at, 1);
    if (ocrHolder === w) ocrHolder = null;
    w.onReleased?.();
    w.onReleased = null;
    clearTimeout(w.idle);
    const job = w.job;
    w.job = null;
    job?.emit("exit", code);
    pump();
  });
  return w;
}

/** Free the warm OCR engine held by another thread, if any. */
function releaseOcr(except) {
  if (!ocrHolder || ocrHolder === except) return Promise.resolve();
  if (releasing) return releasing;
  const holder = ocrHolder;
  poolStats.ocrReleases++;
  releasing = new Promise((resolve) => {
    holder.onReleased = resolve;
    try {
      holder.postMessage({ type: "ocr-release" });
    } catch {
      resolve();
    }
  }).finally(() => {
    releasing = null;
  });
  return releasing;
}

function pump() {
  while (waiting.length) {
    let w = free.pop();
    if (w) {
      clearTimeout(w.idle);
      poolStats.reused++;
    } else if (size < SIZE) w = spawn();
    else return;
    waiting.shift().attach(w);
  }
}

function park(w) {
  w.job = null;
  if (ocrHolder === w && inFlight === 0) releaseOcr(); // batch over: free it
  free.push(w);
  clearTimeout(w.idle);
  w.idle = setTimeout(() => {
    const at = free.indexOf(w);
    if (at < 0) return;
    free.splice(at, 1);
    w.terminate().catch(() => {});
  }, IDLE_MS);
  w.idle.unref?.();
  pump();
}

class PooledJob extends EventEmitter {
  constructor(bytes, filename) {
    super();
    this.id = nextId++;
    this.bytes = bytes;
    this.filename = filename;
    this.thread = null;
    this.finished = false;
    this.killed = false;
    inFlight++;
    waiting.push(this);
    queueMicrotask(pump);
  }
  attach(w) {
    if (this.killed) return park(w);
    this.thread = w;
    w.job = this;
    w.postMessage({
      type: "job",
      id: this.id,
      bytes: this.bytes,
      filename: this.filename,
    });
    this.bytes = null;
  }
  fromThread(m) {
    if (m.type === "done") {
      this.finished = true;
      inFlight--;
      if (m.warm) ocrHolder = this.thread;
      const stopped = () =>
        this.emit("message", {
          type: "event",
          event: { k: "ocr-engine-stopped" },
        });
      // The last file of a batch frees the warm OCR engine before its
      // result is handed over, as a fresh worker would: nothing OCR-sized
      // stays in memory once ingestion resolves. Within a batch the engine
      // is kept for the next scan.
      if (m.warm && inFlight === 0)
        releaseOcr().then(() => {
          stopped();
          this.emit("message", m.result);
        });
      else {
        if (!m.warm) stopped();
        this.emit("message", m.result);
      }
      return;
    }
    const { id, ...rest } = m;
    this.emit("message", rest);
  }
  postMessage(m) {
    if (m?.type !== "ocr-go" || !this.thread) return;
    const w = this.thread;
    // One OCR engine in memory: free another thread's warm engine first.
    releaseOcr(w).then(() => {
      if (this.thread !== w || this.finished) return;
      ocrHolder = w;
      w.postMessage({ type: "ocr-go", id: this.id });
    });
  }
  terminate() {
    const w = this.thread;
    if (this.finished && w) {
      this.thread = null;
      park(w);
      return Promise.resolve(0);
    }
    // Still running (timeout, failure) or never started: kill and replace.
    if (!this.finished) {
      this.finished = true;
      inFlight--;
    }
    this.killed = true;
    const q = waiting.indexOf(this);
    if (q >= 0) waiting.splice(q, 1);
    if (!w) return Promise.resolve(0);
    this.thread = null;
    w.job = null;
    poolStats.replaced++;
    return w.terminate();
  }
}

/** workerFactory for ingestFile: (url, {workerData}) -> pooled job. */
export function lease(_url, { workerData }) {
  return new PooledJob(workerData.bytes, workerData.filename);
}
