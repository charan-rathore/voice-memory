# Paraphrase-aware retrieval: where it stands (2026-11-02)

The roadmap item is "paraphrase-aware search with a dense retriever behind
the same evidence gate, measured on held-out questions". The dense retriever
(`src/dense.mjs`, `Xenova/bge-small-en-v1.5`, local, RRF-fused with BM25 in
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

| Split                | Keyword r@1 | Hybrid (shipped) r@1 | Dense only r@1 | Dense only r@3 | Unanswerable refused (hybrid) |
| -------------------- | ----------- | -------------------- | -------------- | -------------- | ----------------------------- |
| Development (15 + 5) | 0.33        | 0.47                 | 0.53           | 0.80           | 2 of 5                        |
| Held-out (15 + 5)    | 0.33        | **0.33**             | 0.47           | 0.87           | 4 of 5                        |

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

## Sentence units + calibrated rescue (src/paraphrase.mjs) - off in production since 2026-11-02

What changed, each from published practice and none using a language model:

- **Small units, big context.** Every sentence or table row is a retrieval
  unit (25 for Northstar instead of 7 documents), prefixed with its
  document's heading, type and date, after Anthropic's _Contextual
  Retrieval_ (the prefix is built from the document's own header, not
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
| ----------------------------------------- | -------- | --------------------- | --------------------- |
| Shipped hybrid, before                    | 0.33     | 3                     | 1                     |
| + paraphrase rescue                       | **0.40** | 3 (no new)            | 1 (no new)            |

Sentence units alone (no gate) put the right sentence in the top 3 for 11 of
15 held-out paraphrases. The gate is deliberately strict: an evidence engine
should say "I don't see that" rather than read the wrong line, so the rescue
only fires when one sentence clearly stands out.

Until 2026-11-02 this was wired into both the voice call and typed answers
after an abstention, never replacing an answer the engine gives. Independent
review on 2026-11-02 found promotion still unsafe beyond the bounded guards
above: weak-status sentences answering strong-action questions ("discussed"
promoted for "prescribed", "came up at the visit"), stale conflicting values
promoted over current ones, and a preliminary result promoted over its
correction. The rescue is now off in production: both answer paths abstain
instead, and the machinery, guards and tests are preserved behind the
developer opt-in `VM_PARAPHRASE_PROMOTE=1` for future gate work. Retrieval
remains evidence discovery only. Unit tests: `tests/paraphrase.test.mjs`;
numbers: the `bench` workflow posts them on every pull request that touches
retrieval.

## Discovery, not promotion (2026-11-02): built, measured, off by default

What production does with a reworded question the engine cannot answer:

1. The engine abstains as before ("I don't see that in these documents").
2. `closestLine` (src/paraphrase.mjs) ranks sentence units with the same
   dense + BM25 fusion and the same calibrated gate (`GATE`), after removing
   every sentence from a document the record has replaced (a report marked
   preliminary or draft beside one that amends, corrects or revises it).
3. If one line clears the gate and passes the same refusals as promotion
   (no weak-status line for a strong-action question, no superseded or
   conflicting value), the typed answer shows it under the abstention as
   **"Closest line in <document> · not an answer"**, with a button that opens
   the document at that sentence. It is never the reply, never spoken on a
   call, and the verdict stays an abstention.

**Status: off in production (`VM_CLOSEST_LINE=on` to enable).** The outside
benchmark below showed the pointer is not yet reliable enough to show
visitors; see "What the outside data decided".

Why this shape: the 2026-11-02 review failures were all about _speaking_ a
retrieved sentence as the answer. A pointer the person opens and judges keeps
the useful part (the dense model usually finds the right place) without
upgrading a record's status. Promotion stays behind `VM_PARAPHRASE_PROMOTE=1`.
The replaced-source filter now applies to the promotion path too.

## Outside-authored benchmark (evaluation/outside-bench.mjs)

The Northstar questions were written by the corpus authors. This benchmark
uses records and questions written by people who never saw the engine:

- **QMSum** test split (Zhong et al., NAACL 2021): 35 real meeting
  transcripts (AMI and ICSI product and research meetings, Welsh Parliament
  committees), spoken language with disfluencies. Annotators wrote the
  queries and marked the answering turns. Kept: 197 specific queries whose
  answer covers at most 15% of the meeting.
- **CUAD v1** test split (Hendrycks et al., NeurIPS 2021): the first 30
  contracts (by title) of real SEC EDGAR filings; 14 clause types fixed
  before any run (governing law, expiration, renewal, termination for
  convenience, non-compete, exclusivity, liability cap, insurance, audit,
  assignment, minimum commitment, warranty duration, effective date). The
  question is the category's plain-English description, so it paraphrases
  the clause by construction. Lawyers marked 236 of 420 as absent: those are
  the unanswerable set.

Nothing is tuned on this data. Each record is its own bundle (ranking within
one meeting or one contract, as when a person uploads one file). Data is
fetched at pinned commits by `evaluation/outside/fetch.sh`; the dense run is
in the `bench` workflow and posted on pull requests.

Results (CI, bge-small, 2026-11-02):

| Set            | answerable / absent | chance top-1 | keyword top-1 / top-3 | hybrid top-1 / top-3 | dense only top-1 / top-3 |
| -------------- | ------------------- | ------------ | --------------------- | -------------------- | ------------------------ |
| QMSum meetings | 197 / 0             | 5.3%         | 40.6% / 62.4%         | 42.1% / 62.4%        | 40.1% / 61.4%            |
| CUAD contracts | 184 / 236           | 1.2%         | 44.0% / 65.2%         | **50.0%** / 67.4%    | 42.9% / 62.5%            |

### What the outside data decided

1. **Fusion helps, dense alone does not.** Hybrid (dense + BM25, RRF) beats
   keyword on both sets, most on contracts (+6 points top-1). Dense alone is
   slightly worse than keyword: the lexical half carries clause vocabulary.
2. **The promotion gate does not transfer to one file.** Its margin is
   measured against another document; a single meeting or contract has none.
   It showed a line for 87 to 92% of answerable questions, right only 47 to
   48% of the time, and for **85.6% of absent CUAD clauses**.
3. **A single-file discovery gate** (`discoveryGate`: cosine floor, lead over
   the next-best line of any document, keyword agreement in the top 3) fixes
   the absent-clause problem but not precision:

   | Set   | shown (answerable) | right when shown | shown when absent |
   | ----- | ------------------ | ---------------- | ----------------- |
   | QMSum | 21.8%              | 65.1%            | -                 |
   | CUAD  | 6.0%               | 81.8%            | 1.7%              |

4. **No rule reaches the bar.** Sweeping cosine floor, margin and keyword
   agreement on the development half (even rows), no setting reaches 90%
   right with at most 10% shown when the answer is absent. The bench prints
   the best precision at each coverage level on dev and its held-out result,
   so the next change (a cross-encoder reranker) is judged on the same curve.

Decision: the closest-line pointer is **off by default**. A pointer that is
wrong a third of the time on meetings undermines the one promise the product
makes. Retrieval keeps the hybrid ranking; answers stay with the engine.

## Next experiments

- A cross-encoder reranker (bge-reranker-base) over the top 10 units, the
  step that gave the largest gain in Anthropic's numbers, if it fits the
  free instance's memory.
- `dtype: "q8"` for the resident model (about a quarter of the memory), with
  the gate re-tuned on development.
- Gate re-tuned on a development half of the outside data (QMSum val split,
  CUAD train contracts), reported on the test halves above.
