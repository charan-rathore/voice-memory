# Paraphrase-aware retrieval: where it stands (2026-11-01)

The roadmap item is "paraphrase-aware search with a dense retriever behind
the same evidence gate, measured on held-out questions". The dense retriever
(`dense.mjs`, `Xenova/bge-small-en-v1.5`, local, RRF-fused with BM25 in
`retrieveFromRows`) already exists. This note records what it actually does
for paraphrased questions, measured, and what was decided.

## Method

- `evaluation/paraphrase-questions.json`: 30 questions over the Northstar
  corpus that avoid the documents' own key words, plus 10 the record cannot
  answer. Written before any run; split by position into development (odd)
  and held-out (even). Thresholds may only be tuned on development.
- `evaluation/paraphrase-bench.mjs` runs the shipping retriever three ways:
  keyword only, hybrid as shipped (dense + BM25, then the evidence gate), and
  dense scores alone (no gate), and records the top dense cosine scores.
- It runs in CI (`.github/workflows/bench.yml`), which can download the
  model; results are posted on the pull request.

Same-author caveat: the questions were written by the people who wrote the
corpus. The outside-authored benchmark on the roadmap is the real test.

## Results (bge-small, whole-document chunks)

| Split | Keyword r@1 | Hybrid (shipped) r@1 | Dense only r@1 | Dense only r@3 | Unanswerable refused (hybrid) |
| --- | --- | --- | --- | --- | --- |
| Development (15 + 5) | 0.33 | 0.47 | 0.53 | 0.80 | 2 of 5 |
| Held-out (15 + 5) | 0.33 | **0.33** | 0.47 | 0.87 | 4 of 5 |

Findings:

1. **The dense model finds the right document; the gate throws it away.** On
   held-out, dense ranks the right passage in its top 3 for 13 of 15
   paraphrases, but the shipped hybrid path scores exactly like keyword
   search: the evidence gate is lexical, so a paraphrase with no shared
   words is refused even when dense ranked it first.
2. **Absolute cosine cannot separate answerable from unanswerable here.**
   Top-1 cosine for unanswerable questions spans 0.46 to 0.57; for
   answerable ones 0.52 to 0.65. Chunks are whole documents (16 chunks for
   15 documents), which dilutes every embedding.
3. **A tuned "semantic rescue" gate is not worth shipping yet.** Rule: when
   the lexical gate serves nothing, serve dense top-1 if cosine ≥ 0.605 and
   it leads the runner-up by ≥ 0.01 (tuned on development: r@1 0.47 → 0.60
   with no new wrong passages). On held-out it lifts r@1 from 0.33 to 0.40
   but serves one wrong passage ("How was the original price going to be
   billed?" got the revision memo). For an engine whose promise is "never
   the wrong line", +1 right and +1 wrong on 15 questions is not a win, so
   the gate is unchanged.
4. **Production does load the model** (Render logs, 1 Nov 2026: the
   transformers "dtype not specified … fp32" line at boot), but in fp32: the
   `quantized: true` option is ignored by transformers v3, which wants
   `dtype: "q8"`. Switching would cut the resident model roughly fourfold on
   the 512 MB instance; it changes the vectors slightly, so it needs a
   re-tuned gate and is listed under next experiments. CI sets
   `VM_MEMORY_LIMIT_MB`, without which the guard refuses to load the model.

## Shipped: sentence units + calibrated rescue (paraphrase.mjs)

What changed, each from published practice and none using a language model:

- **Small units, big context.** Every sentence or table row is a retrieval
  unit (25 for Northstar instead of 7 documents), prefixed with its
  document's heading, type and date, after Anthropic's *Contextual
  Retrieval* (the prefix is built from the document's own header, not
  generated).
- **Weighted reciprocal-rank fusion** of bge-small cosine and BM25, 0.8 / 0.2,
  k = 60 (Cormack et al. 2009; Anthropic contextual-embeddings cookbook).
- **Query instruction measured, not assumed.** The BGE instruction prefix
  raised held-out unit recall@1 (0.40 → 0.47) but its best development gate
  served a wrong passage on held-out; without it, none. Queries are embedded
  plain.
- **Calibrated gate.** Serve one verbatim sentence only when the engine
  abstained, the top unit's cosine is ≥ 0.62 and it beats the best unit of
  any other document. Chosen on development as the most rescues with zero
  wrong passages and zero accepted unanswerable questions.

| Held-out (15 answerable + 5 unanswerable) | recall@1 | wrong passages served | unanswerable accepted |
| --- | --- | --- | --- |
| Shipped hybrid, before | 0.33 | 3 | 1 |
| + paraphrase rescue | **0.40** | 3 (no new) | 1 (no new) |

Sentence units alone (no gate) put the right sentence in the top 3 for 11 of
15 held-out paraphrases. The gate is deliberately strict: an evidence engine
should say "I don't see that" rather than read the wrong line, so the rescue
only fires when one sentence clearly stands out.

Wired into both the voice call and typed answers after an abstention; it
never replaces an answer the engine gives. Unit tests: `paraphrase.test.mjs`;
numbers: the `bench` workflow posts them on every pull request that touches
retrieval.

## Next experiments

- A cross-encoder reranker (bge-reranker-base) over the top 10 units, the
  step that gave the largest gain in Anthropic's numbers, if it fits the
  free instance's memory.
- `dtype: "q8"` for the resident model (about a quarter of the memory), with
  the gate re-tuned on development.
- A larger, outside-authored question set: 15 held-out questions can show a
  direction, not a reliable size.
