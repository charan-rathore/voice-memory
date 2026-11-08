# Scope repair checkpoint, 2026-11-08

WIP continuation after 016d5a8, not arbitrary-document qualification or a release recommendation.

## Changes

Selected-owner questions now use a separate derived retrieval index. Excluded and unknown-owner text is blanked without changing source offsets; original sources remain untouched. Internal view hashes are never evidence of original text. Before answer delivery, citations must match the original source exactly and fit inside one owner record. Semantic catalog/retrieval, record facts, visual fallbacks and advice context use selected scope. Explicit multi-person citations also require owner containment. Neutral mixed-domain questions do not automatically inherit the corpus's sole clinical identity.

Name-only labeled records receive document-local identities. Generic header parsing accepts plain Patient labels and stacked PATIENT name/ID cells without confusing the adjacent ENCOUNTER field. Dot/underscore IDs and person contexts are preserved. A narrow coordinated-reference veto clarifies unresolved adjacent people rather than silently dropping them; it is not a general entity planner and its grammar remains limited.

Clinical identity replies and source-catalog/page requests retain their distinct source scope. Same-name exclusion notices can name excluded record identities without exposing their values. Merely overlapping citation/record ranges remain context, not owner support.

Provider-independent immutable scope, question-plan preservation and draft-claim inspection are preparation. They explicitly do not certify entailment or user-ready synthesis. Public Berkshire diagnostic baseline is preserved with source hashes and original-page-grounded post-exposure annotations. No fresh independent general-document capability score exists yet.

## Local evidence

- Evaluation 471/471, boundaries 209/209, clinical 119/119, ingest 51/51.
- Core 214/214 before final neutral-identity and notice adjustments; full rerun remains due for a final release checkpoint.
- Formatting and typecheck pass; existing build used by all suites.
- Browser journey, notes, site, voice sync and readiness checks passed in the normal browser run before its enclosing command hit its time limit. Remaining explainer/evidence-context checks reran separately and passed with system Chrome. The earlier missing bundled-browser attempt is a failure, not a pass.
- Actual selected mobile answer screenshot inspected: TV-P2002 answer90, same-person chart, source identity and excluded TV-P2001 notice agree. No visual claim based only on test assertions.
- Exact-head CI and clean-checkout packaging for this new checkpoint remain due. Prior published016 verify passed; retrieval was still running at last check.

## Remaining outcome

Implement and test the requested model-backed general question plan and relevance/completeness checks, including counts. Verify main provider-key spend and bounded public-document egress before calls. No paid inference occurred in this checkpoint. General understanding, source conflicts across nonclinical identities, broader alternate-path coverage, fresh independent corpus and deployed-version checks remain open. Preserve the user's intended live delivery, but do not enable unbounded public inference or widen private-upload consent.
