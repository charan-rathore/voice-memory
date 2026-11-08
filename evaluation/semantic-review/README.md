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

## Caller-owned reader protocol checkpoint

Implemented after the first-stage checkpoint:

- Reader input requirements now come from a server-side decomposition contract, never provider-created `parts`. Existing `validateDocumentPlan` enforces exact question, scope, IDs, text and owners before source validation or auditing. Audit judgments must name the exact request and each statement's requirement ID, with no missing, duplicated or mislabeled judgment.
- The default decomposition is lossless and opaque. It cannot establish whole-question coverage and makes no document-read/audit calls. This intentionally reduces answer availability even with typed cloud permission. It is not a qualified arbitrary-language parser, and the public reader remains off. Server-only fixture resolvers exercise protocol and disclosure-scope behavior without claiming language qualification. No HTTP body field can supply a resolver.
- Repeated exact source quotations may carry an explicit source ID and exact UTF-16 start/end span. Invalid, partial, out-of-bounds, wrong-source or ambiguous legacy quotations are rejected. Legacy unique quotes remain mechanically checkable. Neither span validity nor an audit flag proves semantic entailment.
- The reader checks source fingerprint and caller generation/currentness again after model work. Uncertain outcomes use a fixed epistemic sentence, not ungrounded provider-authored absence explanations. UNKNOWN is displayed as "Answer not established" and no longer receives the companion's claim that every page was checked. Server trace and UI distinguish requested, unavailable and actually completed model reading.
- A real 320px browser check includes the production opaque behavior after its explicitly injected consent fixture. Zero additional provider calls, no "Not in these documents"/"checked every page"/"Cloud answer" claim, and a readable refusal card are asserted and visually inspected.

Availability loss is deliberate and incomplete: a qualified independent request resolver, reconstruction of deterministic certificates, universal factual admission and full typed/voice parity are still open. This checkpoint does not reclassify the first-stage red examples as semantic passes or run the preserved frozen artifact.

## Hosted weight regression

The first-stage branch alone passed the strict eager-byte gate, but the PR's merge with current main included the legitimate upload 4xx-rejection handling (+232 bytes), making the merge 530,066 bytes against `<530,000`. Eager comment prose was removed, without changing the threshold or runtime behavior, to pay for that source payload. Measure the actual candidate merge as well as the branch; a branch-only weight pass was insufficient evidence. No workflow changes are included.

## Bounded positive-admission seam

A separate exact-schema route now answers fully consumed `What is [the] LABEL?` and `What are [the] LABEL and LABEL?` requests against explicit two-column `Field | Value` tables. The dictionary comes from actual printed labels, not a fee/payment/approval synonym list. It rejects ambiguous label segmentation, omitted suffixes/conditions, repeated requirements and unsupported prose/event questions. This is a deliberately bounded schema grammar, not a qualified arbitrary-language parser.

Every requested field becomes its own immutable requirement. A source-fingerprint-bound plan and exact-row candidate go through the shared `admitAnswer` boundary. The server-owned certificate verifier reconstructs the plan and table rows from original source text, checks exact label/value/rendered claim and citation identity, and scans for conflicting values. It does not trust a producer's certificate, approval flag, copied number or final verdict. Field conflicts are explicit clarification outcomes; other admitted fields survive as a partial answer. Patient-bearing records remain with the clinical/owner resolver. No header authority, payer, action, approval event, chronology or source applicability is inferred. The rendered claim says only what the table lists, with an explicit surrounding-conditions limitation.

Actual upload/ask tests cover compound positives, exact-question cache identity, added-source conflicts and retention of the other supported requirement with zero provider calls. Scoped fake voice transport matches typed text for those same two states. The voice adapter routes split exact-schema questions back to the unchanged complete transcript for this bounded route only. Other specialist voice paths remain separate and are not qualified by that test. Unit tests independently reject forged actor/action statements, sources, offsets, requirements, plan keys and producer self-certification. Source-embedded instructions remain quoted table data and never authorize effects.

Actual 390px browser checks inspect complete and partial cards, exact cited rows, no horizontal overflow, and amber partial-answer status. The positive path is registered in existing core, boundary and browser commands without changing workflows. This adds supported behavior rather than counting new abstentions as semantic progress. Universal deterministic/requestedChecked certificates, arbitrary prose role/action entailment, qualified general request decomposition, broad voice parity, identity-majority removal and source-driven summary work remain open.

## Source-outline and record-identity cleanup

The router's weak nonclinical summary fallback no longer asks fixed fee/deadline/open/signature probes. It can offer only explicit Markdown source headings with exact source positions, labeled as a reading aid and not a completed summary. An actual unfamiliar engineering upload is covered through the browser. Sources without explicit headings do not acquire guessed headings. This does not claim a general-document summarizer has been implemented, and legacy strong summary producers are not requalified by it.

Record briefs no longer rank identities by frequency. They use distinct identities, prefer the shared source-bound identity map (including ID-poor records), do not mutate cached raw patient metadata, and reject an unbound selected identity. Unselected multi-identity medical briefs do not pool medicines/diagnoses/reasons/stays or summaries; selected patient facts omit unknown-owner records. Page/day and financial document inventories remain source-level routes, not person binding. Their existing legacy source/status logic still needs independent certificates, so this is not universal identity or financial-semantic qualification.

An initial blanket multi-identity brief block broke the original unselected source-day and bill-change expectations. Those expectations and the source fixtures were retained. The medical guard was scoped to patient-specific intents, and the original full selected/unselected hospital contract passed again. No frozen semantic artifact was inspected or run; the existing exposed case-file regression is a separate set and remains regression evidence only.

## Direct clinical voice boundary checkpoint

With the existing shared-voice switch enabled locally, a direct clinical factual turn no longer bypasses the common no-model resolver just because the legacy clinical candidate finder has a hit. Speech repair and bounded channel follow-up context still happen first. Presentation-only removal of explanations already spoken in the call now happens after common resolution, so it cannot be overwritten by that resolution. The original conversation test caught this repeated-explanation regression during implementation; its assertion was retained and the ordering was fixed.

Actual local typed HTTP and fake streaming-voice transport cover current amended result, original pre-correction result, dated change, another synthetic patient and a version follow-up. A separate adapter spy proves a direct clinical hit reaches the shared boundary instead of merely producing equal legacy wording. All cases use existing exposed synthetic records, never the preserved frozen artifact or a paid provider. These are path and regression tests, not independent semantic qualification.

This remains an incremental migration, not one factual path: mixed/compound specialist orchestration remains separate except for the bounded exact-table grammar, and clinical candidate/history selection still precedes the shared resolver. General per-requirement clinical admission certificates and source-generation-bound structured conversational plans remain open. No public switch, consent, provider, deployment, workflow or merge setting was changed.
