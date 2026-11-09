# Round 7 WIP checkpoint, 2026-11-08

This is a reviewable local implementation checkpoint, not a qualification, merge or deployment recommendation. Previous remote draft head was 4ca0cf7. Current changes continue from 3268bf8.

## Root causes and implementation

Separate answer paths selected an owner independently, sometimes by test presence or record majority. A common preflight now runs before public/owner answer routes and semantic rescue, includes document-only patient records, rejects unbound personal/relative references, and does not let stale selection override explicit people. Explicit multi-owner questions are evaluated against structurally filtered per-owner clinical and document records. Missing owners receive an explicit missing-fact block rather than a silently incomplete answer. Charts use every used subject. Final record citations carry source-owned identity metadata. Generic citations outside known record spans stay intact and are not attributed to a patient.

Source summaries retain unreadable scan states instead of reintroducing raw extracted numbers. Generic first-name tokens (including date months and synthetic Test/Patient/Person) do not manufacture identity. Doctor-question framing is separated from the requested patient's pronouns.

## Test interpretation

Frozen hospital question files and vernacular corpora were not edited. The manually classified 69-question unselected contract is post-exposure regression evidence, not an independent holdout. Every answerable record case retains the original positive wants independently of additive contract wants. Original selected hospital positives are independently asserted.

Three vernacular-development questions originally expected unbound "my" results despite multiple people. The untouched original unselected run still produces those three legacy-oracle mismatches; the regression gate explicitly records their ambiguity, not answer success. A separate selected-context rerun must satisfy every original positive and forbidden-string assertion. Historical mixed real-call wording likewise now clarifies the unbound personal half, while its independent deal half stays answerable. Its original positive measurement is separately required with explicit identity. These changes must not be reported as an independent unseen benchmark win.

Boundary tests preserve original positive checks under explicit selection and separately assert unselected identity behavior. Normal browser verification now includes evidence-context-ui-check.mjs. Probe crashes write a failed terminal artifact; provenance includes revision, tree, dirty state, source hash and probe hash. Canonical qualification requires frozen inputs and a clean local expected revision. Unverified implementation artifacts use distinct names.

## Latest local evidence before commit

- Evaluation: 460/460 after multi-owner document repair.
- Non-forced sequential boundaries: 209/209 after repair.
- Non-forced sequential core: 214/214 after repair.
- Clinical: 119/119 after repair.
- Ingest: 51/51 earlier in this run, before final multi-owner route change.
- Format, typecheck, build: pass after repair.
- Normal browser suite including actual packet, long ID, selected/cache/evidence context: pass with CHROME_PATH=/usr/bin/google-chrome, before final document-only citation binding change. The first attempt lacked Playwright's bundled browser and is not counted as a pass.
- Previous ingest benchmark: 131/131 across 22 files, clean exit, at dirty 3268bf8.
- Retrieval: unchanged overall R@3 .77 (30 questions), paraphrase .29 (7 questions). Still weak; not clinical or production proof.

## Open qualification gates

Fresh actual-diff Sol review, exact-checkpoint full rerun and CI, clean-checkout packaging validation, broader voice/alternate-path audit and real-document deep-understanding qualification remain. The user now explicitly requests real documents, original-page checks, subject/chronology relationships and defensible uncertainty. Synthetic packets do not satisfy that requirement. Public original documents may be used; private documents are not to be sent to external review services.

Draft publication may expose this checkpoint honestly as WIP. It does not authorize or recommend merge or deployment.
