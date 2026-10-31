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

function ensureLoading() {
  if (process.env.VM_DENSE === "off" || state.failed || state.pipe)
    return state.loading;
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
});
