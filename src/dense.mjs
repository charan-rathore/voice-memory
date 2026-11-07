import { denseMemoryBudget } from "./dense-memory-budget.mjs";
import { createModelLifetime } from "./model-lifetime.mjs";
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
const state = { pipe: null, loading: null, retiring: null, failed: null };
const lifetime = createModelLifetime();
let modelGeneration = 0;
let pressureTimer = null;
function stopPressureWatch() {
  if (pressureTimer) clearInterval(pressureTimer);
  pressureTimer = null;
}
function watchResidentPressure() {
  if (pressureTimer) return;
  // Native allocator growth may arrive after an inference promise resolves.
  // Sample only while resident; this never loads a model or restarts a server.
  pressureTimer = setInterval(() => relieveMemoryPressure(), 1000);
  pressureTimer.unref?.();
}
// OCR/ingest spikes ~250MB on top of the server; the resident model adds
// ~250-340MB. On a 512MB budget they must never coexist: uploads pause the
// dense stage (dispose the model, no reload kicks) until processing settles.
let ingestDepth = 0;

// Memory budget guard. The container limit is read from cgroups (v2, then
// v1) or VM_MEMORY_LIMIT_MB. The model is loaded only with enough headroom,
// and dropped (back to keyword retrieval) when the process nears the limit.
// Measured on Render free (512 MB): ~60 MB without the model, peaks of
// ~500 MB with it. This is admission/retirement at operation boundaries,
// not a guarantee against allocation peaks or unrelated process growth.
// Clean native fp32 probe: observed incremental RSS reached ~422 MiB.
// Reserve 448 MiB (observed increment plus 26 MiB margin), not the older
// steady-state 360 MiB estimate. This remains an estimate, not a peak bound.
const MODEL_MB = Number(process.env.VM_DENSE_MODEL_MB || 448);
const PRESSURE = 0.9;
export function memoryLimitBytes() {
  return denseMemoryBudget().limitBytes;
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
  stopPressureWatch();
  state.loading = null;
  modelGeneration++;
  guard.dropped++;
  guard.refused = `dropped at ${Math.round(rss / 1048576)} of ${Math.round(limit / 1048576)} MB`;
  // A memory-pressure request cannot invalidate a session an earlier
  // inference still owns. The next load waits until retirement completes.
  const retiring = lifetime.drained().then(() => pipe.dispose?.());
  state.retiring = retiring;
  retiring
    .catch(() => {})
    .finally(() => {
      if (state.retiring === retiring) state.retiring = null;
    });
  return true;
}

function ensureLoading() {
  if (process.env.VM_DENSE === "off" || state.failed) return null;
  if (state.pipe) return Promise.resolve(state.pipe);
  if (state.retiring || ingestDepth > 0 || lifetime.blocked)
    return state.loading;
  if (!state.loading && !memoryHeadroomOk()) {
    const limit = memoryLimitBytes();
    guard.refused =
      limit === null
        ? `not loaded: no valid memory ceiling readable; check VM_MEMORY_LIMIT_MB or host cgroup to enable dense (model needs ~${MODEL_MB} MB)`
        : `not loaded: ${Math.round(process.memoryUsage().rss / 1048576)} MB used of ${Math.round(limit / 1048576)} MB, model needs ~${MODEL_MB} MB`;
    return null;
  }
  if (!state.loading) {
    const generation = modelGeneration;
    const loading = (async () => {
      try {
        const { pipeline, env } = await import("@huggingface/transformers");
        env.cacheDir = process.env.VM_DENSE_CACHE || ".cache/models";
        const pipe = await pipeline("feature-extraction", MODEL_ID, {
          quantized: true,
        });
        // A parser may have started while the model was loading. Never
        // resurrect a stale pipeline after the ingestion pause.
        if (
          generation !== modelGeneration ||
          ingestDepth > 0 ||
          lifetime.blocked
        ) {
          await pipe.dispose?.();
          return null;
        }
        state.pipe = pipe;
        // A background load can itself cross the pressure threshold. Do not
        // wait for a later user query before retiring that resident model.
        if (relieveMemoryPressure()) {
          await state.retiring;
          return null;
        }
        watchResidentPressure();
        return pipe;
      } catch (e) {
        if (generation === modelGeneration && ingestDepth === 0)
          state.failed = String((e && e.message) || e);
        return null;
      }
    })();
    state.loading = loading;
    loading
      .finally(() => {
        if (state.loading === loading) state.loading = null;
      })
      .catch(() => {});
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
  const pipe = state.pipe;
  if (!pipe) {
    if (ingestDepth === 0) ensureLoading();
    return null;
  }
  const release = lifetime.acquire();
  if (!release || state.pipe !== pipe) {
    release?.();
    return null;
  }
  return Promise.resolve()
    .then(() => pipe(q, { pooling: "mean", normalize: true }))
    .then((out) => Array.from(out.data))
    .catch((e) => {
      if (ingestDepth === 0) state.failed = String((e && e.message) || e);
      return null;
    })
    .finally(() => {
      release();
      relieveMemoryPressure();
    });
}

/**
 * The text a chunk is embedded as. Contextual chunk headers (the deterministic
 * flavour of contextual retrieval): the document title and the chunk's
 * heading path are prepended, so "Approved by: pending" is embedded as part
 * of "Commercial revision > Approvals", not as a context-free fragment. The
 * stored chunk text, citations and BM25 are unchanged.
 *
 * OFF by default. Measured on the hybrid bench (CI, 2026-11-02, bge-small,
 * 30 questions / 16 chunks): bare chunks R@3 0.87, MRR 0.81; with headers
 * R@3 0.83, MRR 0.79 (one literal question fell out of the top 3). On this
 * small corpus every chunk of a document gains the same title words, which
 * blurs chunks of one document together. VM_DENSE_CONTEXT=on to experiment;
 * bench.yml runs both on every retrieval PR.
 */
export function passageText(row) {
  const text = row?.chunk?.text ?? "";
  if (process.env.VM_DENSE_CONTEXT !== "on") return text;
  const title = String(row?.title ?? "")
    .replace(/\.(md|txt|pdf|docx)$/i, "")
    .replace(/[_-]+/g, " ")
    .trim();
  const heading = String(row?.chunk?.heading ?? "").trim();
  const head = [title, heading && !text.startsWith(heading) ? heading : null]
    .filter(Boolean)
    .join(" > ");
  return head ? `${head}\n${text}` : text;
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
          relieveMemoryPressure();
          if (state.pipe !== pipe || ingestDepth > 0) return false;
          if (r.chunk.embedding && r.chunk.embedding_model === MODEL_ID)
            continue;
          const release = lifetime.acquire();
          if (!release) return false;
          try {
            const out = await pipe(passageText(r), {
              pooling: "mean",
              normalize: true,
            });
            r.chunk.embedding = JSON.stringify(Array.from(out.data));
            r.chunk.embedding_model = MODEL_ID;
          } finally {
            release();
            relieveMemoryPressure();
          }
          if (state.pipe !== pipe) return false;
        }
        return true;
      } catch (e) {
        if (ingestDepth === 0) state.failed = String((e && e.message) || e);
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
  lifetime.pause();
  // A second parallel upload uses the same retirement barrier; it must
  // not dispose the same model a second time.
  if (ingestDepth > 1) return state.retiring ?? Promise.resolve();
  modelGeneration++;
  const pipe = state.pipe;
  const loading = state.loading;
  state.pipe = null;
  stopPressureWatch();
  state.loading = null;
  const previous = state.retiring ?? Promise.resolve();
  const retiring = previous
    .catch(() => {})
    .then(async () => {
      if (loading) await loading;
      await lifetime.drained();
      await pipe?.dispose?.();
    });
  state.retiring = retiring;
  retiring
    .catch(() => {})
    .finally(() => {
      if (state.retiring === retiring) state.retiring = null;
    });
  return retiring;
}

export function resumeDenseAfterIngest(rows) {
  if (ingestDepth === 0) return;
  ingestDepth--;
  lifetime.resume();
  if (ingestDepth !== 0 || !rows) return;
  // Even if a failed preparation timed out, do not warm a new model before
  // the previous pipeline has definitely stopped.
  const retirement = state.retiring;
  if (retirement) retirement.then(() => warmDense(rows)).catch(() => {});
  else warmDense(rows);
}

export const DENSE_MODEL_ID = MODEL_ID;
export const denseStatus = () => {
  const budget = denseMemoryBudget();
  return {
    model: MODEL_ID,
    ready: !!state.pipe,
    loading: !!state.loading && !state.pipe && !state.failed,
    disabled: process.env.VM_DENSE === "off",
    failed: state.failed,
    memory: {
      rssMb: Math.round(process.memoryUsage().rss / 1048576),
      limitMb: budget.limitBytes
        ? Math.round(budget.limitBytes / 1048576)
        : null,
      limitSource: budget.source,
      hostLimitBytes: budget.hostBytes,
      hostLimitSource: budget.hostSource,
      configuredLimitBytes: budget.configuredBytes,
      measurement: "process RSS; rounded MiB, not cgroup usage",
      guard: guard.refused,
      dropped: guard.dropped,
    },
  };
};

/**
 * Embeddings for arbitrary texts, only when the model is ALREADY resident
 * (never triggers a load on the request path). Returns null otherwise.
 * Vectors are mean-pooled and L2-normalised, so a dot product is a cosine.
 */
export async function embedTextsReady(texts) {
  relieveMemoryPressure();
  const pipe = state.pipe;
  if (!pipe || !texts.length) return null;
  try {
    const out = [];
    for (const t of texts) {
      relieveMemoryPressure();
      if (ingestDepth > 0 || state.pipe !== pipe) return null;
      const release = lifetime.acquire();
      if (!release) return null;
      try {
        const v = await pipe(t, { pooling: "mean", normalize: true });
        out.push(Float32Array.from(v.data));
      } finally {
        release();
        relieveMemoryPressure();
      }
      if (state.pipe !== pipe) return null;
    }
    return out;
  } catch (e) {
    if (ingestDepth === 0) state.failed = String((e && e.message) || e);
    return null;
  }
}
