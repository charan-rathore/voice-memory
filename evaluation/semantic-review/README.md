# Semantic review development evidence

Current source baseline: 30e7b4cf42652d713ac19a45db7a14aab95ccc9d.

These are exposed development reproductions from the user's forwarded review, not independent evaluation or hidden holdout cases. No actual model, embedding, speech, or paid provider call was made.

- `current30e7-source-reproduction.json`: direct verifyClaims/finalAnswer calls and the exact safeRewrite predicate extracted from current source. Confirms role/action swaps and quote fallback. Source inspections are labelled separately.
- `current30e7-document-omission.json`: actual reader function, local fake read/audit provider. A model-created approval part silently omits the original payer requirement despite audit.complete=true. This measures contract permissiveness, not actual model behaviour.

The referenced frozen JSON was subsequently supplied and preserved privately, outside this public development directory. Its original transport bytes have a different hash from the review's stated hash; both are retained in private provenance without canonicalizing or altering the original. No case-level inspection, reconstruction or run has occurred. Several review-exposed examples were already development material before it arrived, so a future first run cannot honestly establish a wholly unseen independent score. Existing case-file/semantic heldouts are different sets. Do not label these development examples independent or reuse an old score as a fresh qualification.

Required implementation boundaries:

1. Preserve the original question and immutable caller-owned requirements before any retrieval expansion or model rewrite. A model may supply outcomes keyed to requirements, never replace their text, owners, conditions, or coverage.
2. Every candidate path, including requestedChecked and deterministic leads, must undergo the same admission contract. Provider failure must not demote an already admitted deterministic answer. Preservation alone is not admission.
3. Exact source bytes and owner boundaries remain necessary, not sufficient. Claims need source-grounded role/action/object/status/time agreement. Unsupported or unparsed relation checks remain unknown, not proven by lexical overlap.
4. Evidence-only quotations remain related evidence under abstention. They never become an answer by citation presence.
5. Shared structured answers precede factual voice/typed branching. Speech repair/history/interruptions remain channel-specific, not factual candidate selection.
6. Local fake-provider tests prove structural gates only. Model entailment, unfamiliar-document correctness, blind adjudication, latency/cost distributions, and full voice parity remain unqualified until separately measured within permission.

## Initial integration experiment

A broad suppression of every legacy QUOTED lead caused 10/486 evaluation and 6/209 boundary regressions, including source-bound discharge dates and requested tracking-number answers. These failures were preserved in local `admission-eval-open.log` / `admission-bound-open.log`. That broad suppression was reverted rather than weakening tests or claiming safety by disabling supported answers. The evidence-only no-lead fallback is separately repaired. Legacy producer QUOTED leads still require migration through independent deterministic certificates and the universal admission gate. Do not claim that path fixed.

## Intentional evidence-only contract change

The wrapped deadline/fee retrieval fixture has complete source text but no admitted lead. It now remains related evidence under abstention rather than being promoted by finalAnswer. The test still requires the full date/fee retrieval excerpt and no unrelated block. This is a known answer-availability loss relative to old quote fallback, not improved semantic recall. Restoring an affirmative answer requires independent per-requirement admission, not reverting the safety distinction. Cache tests now compare cached candidates separately from each request's exact immutable identity.

## First-stage scope

Implemented: exact-original rewrite promotion only; no-lead retrieval evidence remains related evidence under abstention; legacy model claim verification requires a separate server-owned relation verifier instead of accepting numbers and quotes as entailment; exact immutable original question attached outside normalized cache results; pure request/admission contracts with opaque/unresolved interpretation explicitly marked. New pure contract and HTTP identity tests are registered in existing npm test and test:boundaries targets, without changing workflow files.

Still open: broad deterministic/requestedChecked admission certificates; caller-owned qualified document requirements and actual reader validation; full factual voice unification; general summary; identity-majority removal; structured per-requirement retrieval; typed role/action/time/version parsing and adjudicated semantic evaluation. The pure admission module is not a universal production gate yet. A model's own proposed relation or ok flag cannot enable it. No release qualification is claimed.
