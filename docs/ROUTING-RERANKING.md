# Query routing and reranking: state and open research (31 October 2026)

Status: research note. Nothing here is implemented unless marked VERIFIED;
no quality claim is made for the candidate designs until their acceptance
tests pass on the frozen benchmark.

## 4.3 Query routing - current state (VERIFIED in code @ e8392bf)

One explicit route exists today:

- **Clinical route** (src/server.mjs `leadFor`): when the bundle carries typed
  lab observations (`bundle.clinical.length > 0`), the question goes to
  `clinicalTurn` first: typed observations, comparability checks (unit,
  patient, amended-report), no clinical judgement. Tone is test-enforced in
  English/Hindi/Hinglish. A non-clinical question or a non-match falls
  through to the general path.
- **Temporal "as of"** is not a route but an engine capability: date-
  qualified questions restrict records by date (longitudinal tests).
- **Everything else** goes to the single general path: retrieve-core
  (BM25 + optional dense RRF) -> calibrated context pack (max 3 chunks) ->
  evidence gate -> deterministic claim renderer or verbatim quotes.

Open: no routing between question TYPES on the general path (factual lookup
vs comparison vs status-vs-proposal vs follow-up). The follow-up mechanism
(working memory `lastField`) exists but is not a routing decision.

Candidate design (NOT implemented): a deterministic classifier over the
existing signals (claim fields present, date mentions, pronoun/follow-up
shape, clinical bundle present) that picks one of {clinical, temporal,
comparison, lookup} BEFORE retrieval, so each type can tune topK and the
evidence gate. Acceptance test: a frozen routing suite (one fixture set per
type, incl. deliberate misrouting bait) with per-type accuracy reported;
routing must never change an answer's evidence, only its retrieval shape.

## 4.4 Reranking - current state (VERIFIED)

- The shipping path reranks inside `retrieveFromRows` (vendored
  retrieve-core): BM25 + optional dense vectors, RRF fusion, then
  `rerankCalibrated` + `selectContext` with the evidence gate. The bench
  runs THROUGH this path, never around it.
- Measured (frozen 30-question bench, 31 Oct): keyword R@1/R@3 0.767/0.767
  (literal n=23: 0.913; paraphrase n=7: 0.286). Hybrid (dense resident):
  R@3 0.867 (literal 1.000, paraphrase 0.429). On the 512 MiB host the
  dense model sheds under first real load (measured live 31 Oct), so the
  practical live mode is keyword.
- Known weak point: the retrieval-gate signal separates paraphrase from
  unanswerable at 0.10 accuracy (documented limitation).

Open research questions, in order of expected value:
1. Paraphrase recall without dense: spelling/notation normalization is done;
   next candidates are field-aware synonym expansion of the QUERY (not the
   corpus) using the claim dictionary, and bigram backoff in BM25.
   Acceptance: paraphrase bucket R@3 >= 0.57 (4/7) on the frozen bench with
   zero literal regressions and zero new false-confidence cases.
2. Gate signal: separate "weak retrieval" from "no answer" using score
   margins + field coverage rather than a single threshold. Acceptance: on
   the abstain set, ambiguous stays non-fabricating AND the 0.10 separation
   improves measurably; report the full confusion, not one number.
3. Reranker features: claim-status agreement between question terms and
   candidate chunk claims (proposed/approved/superseded) as a rerank
   feature, not a filter. Acceptance: status-question fixture set improves,
   no regressions elsewhere.

Rules: every change tests-first through the vendored gate; the frozen bench
and denominators (literal n=23, paraphrase n=7) stay frozen; a new
explanation of a number requires a controlled rerun at both commits.
