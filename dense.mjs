import { readFileSync } from "node:fs";
/**
 * Dense retrieval stage (Phase 3 hybrid) - local embeddings, no paid API.
 *
 * Model: Xenova/bge-small-en-v1.5 (MIT), int8-quantized ONNX via
 * @huggingface/transformers v3. Measured: ~341MB RSS resident after load,
 * ~6ms per query embedding. First boot downloads ~33MB into VM_DENSE_CACHE.
 *
 * Fail-closed, never blocks the request path:
 * - The model loads in the BACKGROUND (warmDense / first use). While it is
 *   loading, or if load or embed ever fails, embedQuery returns null and
 *   retrieval keeps its BM25 keyword path (retrieve-core falls back with a
 *   diagnostic). Dense only re-ranks; it never gates an answer and never
 *   touches citation validity.
 * - A circuit breaker (state.failed) stops retry storms after a failure.
 *
 * VM_DENSE=off disables the stage entirely (no download, no memory).
 */
const MODEL_ID = process.env.VM_DENSE_MODEL || "Xenova/bge-small-en-v1.5";
const state = { pipe: null, loading: null, failed: null };
// OCR/ingest spikes ~250MB on top of the server; the resident model adds
// ~250-340MB. On a 512MB budget they must never coexist: uploads pause the
// dense stage (dispose the model, no reload kicks) until processing settles.
let ingestDepth = 0;

// Memory budget guard. The container limit is read from cgroups (v2, then
// v1) or VM_MEMORY_LIMIT_MB. The model is loaded only with enough headroom,
// and dropped (back to keyword retrieval) when the process nears the limit.
// Measured on Render free (512 MB): ~60 MB without the model, peaks of
// ~500 MB with it, so a load with less than MODEL_MB of headroom is refused.
const MODEL_MB = Number(process.env.VM_DENSE_MODEL_MB || 360);
const PRESSURE = 0.9;
export function memoryLimitBytes() {
  if (process.env.VM_MEMORY_LIMIT_MB)
    return Number(process.env.VM_MEMORY_LIMIT_MB) * 1048576;
  for (const f of [
    "/sys/fs/cgroup/memory.max",
    "/sys/fs/cgroup/memory/memory.limit_in_bytes",
  ]) {
    try {
      const v = readFileSync(f, "utf8").trim();
      const n = Number(v);
      if (v !== "max" && Number.isFinite(n) && n > 0 && n < 2 ** 50) return n;
    } catch {
      /* not this cgroup version */
    }
  }
  return null;
}
const guard = { refused: null, dropped: 0 };
export function memoryHeadroomOk(rss = process.memoryUsage().rss) {
  const limit = memoryLimitBytes();
  // Fail closed: with no readable cgroup limit and no explicit
  // VM_MEMORY_LIMIT_MB the guard cannot bound RSS, and the measured
  // limit-absent behavior was a +130 MiB ratchet per OCR cycle past a
  // 512 MiB ceiling. Dense stays off on such hosts until an operator sets
  // a verified explicit limit.
  if (limit === null) return false;
  return limit - rss >= MODEL_MB * 1048576;
}
/** Drop the resident model when the process is near its memory limit. */
export function relieveMemoryPressure(rss = process.memoryUsage().rss) {
  const limit = memoryLimitBytes();
  if (!limit || !state.pipe || rss < limit * PRESSURE) return false;
  const pipe = state.pipe;
  state.pipe = null;
  state.loading = null;
  guard.dropped++;
  guard.refused = `dropped at ${Math.round(rss / 1048576)} of ${Math.round(limit / 1048576)} MB`;
  pipe.dispose?.().catch?.(() => {});
  return true;
}

function ensureLoading() {
  if (process.env.VM_DENSE === "off" || state.failed || state.pipe)
    return state.loading;
  if (!state.loading && !memoryHeadroomOk()) {
    const limit = memoryLimitBytes();
    guard.refused =
      limit === null
        ? `not loaded: no memory limit readable; set VM_MEMORY_LIMIT_MB explicitly to enable dense (model needs ~${MODEL_MB} MB)`
        : `not loaded: ${Math.round(process.memoryUsage().rss / 1048576)} MB used of ${Math.round(limit / 1048576)} MB, model needs ~${MODEL_MB} MB`;
    return null;
  }
  if (!state.loading) {
    state.loading = (async () => {
      try {
        const { pipeline, env } = await import("@huggingface/transformers");
        env.cacheDir = process.env.VM_DENSE_CACHE || ".cache/models";
        state.pipe = await pipeline("feature-extraction", MODEL_ID, {
          quantized: true,
        });
        return state.pipe;
      } catch (e) {
        state.failed = String((e && e.message) || e);
        return null;
      }
    })();
  }
  return state.loading;
}

/**
 * Query vector when the model is ALREADY resident, else null. A cold model
 * is kicked to load in the background but never awaited here: a voice turn
 * or typed query must answer from keyword rather than wait on a download.
 */
export function embedQueryReady(q) {
  relieveMemoryPressure();
  if (!state.pipe) {
    if (ingestDepth === 0) ensureLoading();
    return null;
  }
  return state
    .pipe(q, { pooling: "mean", normalize: true })
    .then((out) => Array.from(out.data))
    .catch((e) => {
      state.failed = String((e && e.message) || e);
      return null;
    });
}

/**
 * Background warmup: load the model (if needed), then fill chunk.embedding
 * (JSON string, the format retrieve-core's parseEmbedding expects) and
 * chunk.embedding_model for the given rows. Never throws; rows simply stay
 * vectorless on failure and retrieval remains keyword-only.
 */
export function warmDense(rows) {
  const loading = ensureLoading();
  if (!loading) return Promise.resolve(false);
  return loading
    .then(async (pipe) => {
      if (!pipe) return false;
      try {
        for (const r of rows) {
          if (r.chunk.embedding && r.chunk.embedding_model === MODEL_ID)
            continue;
          const out = await pipe(r.chunk.text, {
            pooling: "mean",
            normalize: true,
          });
          r.chunk.embedding = JSON.stringify(Array.from(out.data));
          r.chunk.embedding_model = MODEL_ID;
        }
        return true;
      } catch (e) {
        state.failed = String((e && e.message) || e);
        return false;
      }
    })
    .catch(() => false);
}

/**
 * Cache-key suffix reflecting the ACTUAL retrieval mode of an answer:
 * ":d" only when the model is resident AND every row is embedded (full
 * hybrid); ":p<embedded>of<total>" while warmup is partway (an early
 * partial-hybrid answer must never be served after the remaining rows
 * warm); ":k" whenever the model is not resident (keyword execution, even
 * if stale embeddings linger after a shed). Coverage is part of the key,
 * so each warmup state re-keys instead of persisting an early answer.
 */
export function denseCacheSuffix(bundle, resident = !!state.pipe) {
  if (!resident || !bundle || bundle.rows.length === 0) return ":k";
  let embedded = 0;
  for (const r of bundle.rows)
    if (r.chunk.embedding && r.chunk.embedding_model === MODEL_ID) embedded++;
  if (embedded === 0) return ":k";
  return embedded === bundle.rows.length
    ? ":d"
    : `:p${embedded}of${bundle.rows.length}`;
}

/** True when at least one row carries a vector for the active model. */
export function denseAvailableFor(bundle) {
  return (
    !!bundle &&
    bundle.rows.some(
      (r) => r.chunk.embedding && r.chunk.embedding_model === MODEL_ID,
    )
  );
}

/**
 * Upload-side memory guard. Call before queueing an upload's processing and
 * pair with resumeDenseAfterIngest when it settles. Disposes the resident
 * model; while paused, queries stay on keyword (embedQueryReady won't start
 * a reload mid-spike).
 */
export function pauseDenseForIngest() {
  ingestDepth++;
  const pipe = state.pipe;
  state.pipe = null;
  state.loading = null;
  return pipe ? pipe.dispose().catch(() => {}) : Promise.resolve();
}

export function resumeDenseAfterIngest(rows) {
  ingestDepth = Math.max(0, ingestDepth - 1);
  if (ingestDepth === 0 && rows) warmDense(rows);
}

export const DENSE_MODEL_ID = MODEL_ID;
export const denseStatus = () => ({
  model: MODEL_ID,
  ready: !!state.pipe,
  loading: !!state.loading && !state.pipe && !state.failed,
  disabled: process.env.VM_DENSE === "off",
  failed: state.failed,
  memory: {
    rssMb: Math.round(process.memoryUsage().rss / 1048576),
    limitMb: memoryLimitBytes()
      ? Math.round(memoryLimitBytes() / 1048576)
      : null,
    guard: guard.refused,
    dropped: guard.dropped,
  },
});
