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
4. **Production probably never loads the model.** `dense.mjs` refuses to
   load bge-small (~360 MB resident) without memory headroom, and the free
   Render instance has 512 MB, so live answers are likely keyword-only. The
   first CI run also measured keyword only until `VM_MEMORY_LIMIT_MB` was
   set; the guard reason is now part of the bench output.

## Next experiment

Embed numbered lines and table rows instead of whole documents (the corpus
is already one claim per line), so a paraphrase is compared with one claim,
not a page. Then re-tune the rescue threshold on development and report
held-out again. Ship only if held-out r@1 improves with zero additional
wrong passages and no unanswerable question is newly accepted.
