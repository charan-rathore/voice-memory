/**
 * Cross-encoder reranking for reworded questions.
 *
 * The bi-encoder (bge-small) embeds the question and each sentence apart, so
 * it scores topic overlap; a cross-encoder reads the question and the
 * sentence together and scores whether the sentence answers it. Retrieve
 * with the cheap fusion, rerank the top k with the cross-encoder, and gate
 * on its calibrated probability and its lead over the runner-up: the
 * standard two-stage pattern (Nogueira & Cho, "Passage Re-ranking with
 * BERT", 2019; Sentence-Transformers retrieve & re-rank). The outside
 * benchmark found that no bi-encoder threshold reaches 90% right at useful
 * coverage (docs/PARAPHRASE-RETRIEVAL.md); this is the measured next step.
 *
 * Local and free: an ONNX cross-encoder through @huggingface/transformers,
 * int8 where the model ships it. Off unless VM_RERANK=on. Never blocks a
 * request: while loading, or after a failure, rerank() returns null and the
 * caller keeps the fused ranking. It never changes an answer the engine
 * gives; it only decides whether a closest line is worth pointing at.
 */
import { memoryLimitBytes } from "./dense.mjs";

export const RERANK_MODEL_ID =
  process.env.VM_RERANK_MODEL || "Xenova/ms-marco-MiniLM-L-6-v2";
// Measured ~23 MB int8 weights; budget the ONNX session generously.
const MODEL_MB = Number(process.env.VM_RERANK_MODEL_MB || 140);
const state = { tok: null, model: null, loading: null, failed: null };

export const rerankEnabled = () => process.env.VM_RERANK === "on";
export const rerankStatus = () => ({
  enabled: rerankEnabled(),
  model: RERANK_MODEL_ID,
  resident: !!state.model,
  failed: state.failed,
});

function headroomOk() {
  const limit = memoryLimitBytes();
  if (limit === null) return false; // fail closed, as dense does
  return limit - process.memoryUsage().rss >= MODEL_MB * 1048576;
}

function ensureLoading() {
  if (!rerankEnabled() || state.failed || state.model) return state.loading;
  if (!state.loading && !headroomOk()) return null;
  state.loading ??= (async () => {
    try {
      const { AutoTokenizer, AutoModelForSequenceClassification, env } =
        await import("@huggingface/transformers");
      env.cacheDir = process.env.VM_DENSE_CACHE || ".cache/models";
      state.tok = await AutoTokenizer.from_pretrained(RERANK_MODEL_ID);
      state.model = await AutoModelForSequenceClassification.from_pretrained(
        RERANK_MODEL_ID,
        { dtype: process.env.VM_RERANK_DTYPE || "q8" },
      );
      return state.model;
    } catch (e) {
      state.failed = String((e && e.message) || e);
      return null;
    }
  })();
  return state.loading;
}

/** Start loading in the background; resolves true once resident. */
export async function warmRerank() {
  const m = await ensureLoading();
  return !!m;
}

const sigmoid = (x) => 1 / (1 + Math.exp(-x));

/**
 * Probability that each passage answers the question, or null when the
 * model is not resident (callers keep their own ranking).
 */
export async function crossScores(question, passages) {
  if (!state.model) {
    ensureLoading();
    return null;
  }
  if (!passages.length) return [];
  try {
    const out = [];
    for (let i = 0; i < passages.length; i += 16) {
      const batch = passages.slice(i, i + 16);
      const inputs = state.tok(new Array(batch.length).fill(question), {
        text_pair: batch,
        padding: true,
        truncation: true,
        max_length: 256,
      });
      const { logits } = await state.model(inputs);
      const width = logits.dims.at(-1) ?? 1;
      const d = logits.data;
      for (let j = 0; j < batch.length; j++)
        // one logit (ms-marco style) or two-way softmax (relevant = last)
        out.push(
          width === 1
            ? sigmoid(Number(d[j]))
            : sigmoid(Number(d[j * width + width - 1]) - Number(d[j * width])),
        );
    }
    return out;
  } catch (e) {
    state.failed = String((e && e.message) || e);
    return null;
  }
}

/**
 * Rerank the top k of a fused ranking (rankUnits output). Returns the k
 * units re-ordered by cross-encoder probability, each with `ce`, or null.
 * The passage is the sentence with its document context, as embedded.
 */
export async function rerankUnits(question, ranked, k = 20) {
  const head = ranked.slice(0, k);
  const s = await crossScores(
    question,
    head.map((r) => r.unit.text),
  );
  if (!s) return null;
  return head
    .map((r, i) => ({ ...r, ce: s[i], fusedRank: i + 1 }))
    .sort((a, b) => b.ce - a.ce);
}

/**
 * Show a closest line only when the cross-encoder is confident about one
 * sentence AND it clearly leads the next one. Thresholds come from the
 * outside benchmark's development half (evaluation/outside-bench.mjs);
 * null means no rule passed the bar and the gate never opens.
 */
export const RERANK_GATE = null;
export function rerankGate(reranked, rule = RERANK_GATE) {
  if (!rule || !reranked?.length) return null;
  const [top, next] = reranked;
  const margin = top.ce - (next?.ce ?? 0);
  if (top.ce < rule.minProb || margin < rule.minMargin) return null;
  if (rule.maxFusedRank && top.fusedRank > rule.maxFusedRank) return null;
  return { ...top, margin };
}
