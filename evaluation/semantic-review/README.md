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

## Universal source-currentness closeout boundary

The final currentness check now covers every resolved candidate path, not only exact-schema certificates. If an upload/removal changes the session bundle while asynchronous work is pending, the response drops the raw candidate, lead, related retrieval evidence, chart and closest-line material together. It retains the exact request identity and returns a stale-scope abstention asking for a retry against current documents. This checks source identity/generation, not semantic entailment or interpretation quality.

An actual HTTP reproduction pauses a fake legacy interpreter, commits a second upload in the same workspace, then releases the interpreter's old-scope clarification. On the previous checkpoint it returns that clarification without stale status. With the final check it returns the stale-scope abstention, empty evidence/citations, no chart or closest line, and a non-admitted stale reason. The source-changing run uses no actual provider and no preserved frozen semantic case. Existing positive and clinical assertions remain unchanged.

## Voice raw-request identity before repair

The opt-in common voice boundary now receives the untouched caller utterance separately from its repaired/history-enriched retrieval candidate. The opaque immutable plan protects the raw utterance, records the candidate as explicitly not semantically verified, and keeps candidate-dependent cache entries separate. The bounded exact-table certificate grammar is reconstructed from the raw request, not a fully consumed repaired tail. No HTTP body field can select the server-only raw-utterance option.

A real local PDF-upload/start/stream/last-turn test on the prior checkpoint shows `originalQuestion` changed from the caller's `ferriting` to repaired `Ferritin`. The same test now retains the raw bytes and exposes repair only as a candidate. A second utterance with a correction cannot turn its exact-table tail into a certificate for the larger original request. Existing clinical values, follow-up and explanation-dedup assertions remain intact. The repaired/history candidate still drives legacy factual selection; preserving it separately is not proof that its meaning matches the raw utterance, and universal pre-channel factual admission remains open.

## Historical-only lexical quote veto

A fresh exposed model-off HTTP probe found a wrong-version answer: a prose invoice says its original amount was $900, a later amendment replaced it with $750, and the earlier invoice is superseded; asking for the current invoice amount returned the original $900 sentence as answered. The cause is the subject-sentence fallback matching invoice/amount while treating current as generic, not a validated temporal relation.

A shared negative compatibility check now excludes explicitly historical-only wording from that sentence selector and the generic extractive selector when the question explicitly asks current/latest/now/today. It does not infer a replacement amount or adjudicate a prose amendment chain. The reproduction now abstains rather than promote the old value. A historical request still returns the original $900, and existing recorded-invoice positives and full regression expectations are retained. This is a bounded lexical veto, not qualified temporal understanding; other producers and implicit historical/current relationships still need semantic certificates.

Typed HTTP and fake voice transport both avoid the old value in this fixture. Their abstention wording still differs because the shared voice resolver falls back to legacy voice wording when there is no lead. That remains an open canonical-path defect, not a parity pass. No frozen case or actual provider was used.

## Direct nonclinical abstention parity

The opt-in shared voice boundary now renders a direct nonclinical no-lead result through the same existing final-answer contract as typed, rather than return to a second voice fallback. The current-invoice development fixture now requires exact typed/streamed abstention text equality and retains the old-value prohibition and historical-access positive. Shared voice turns also retain the evidence feed timestamp; an original feed assertion caught its absence during this migration and was kept unchanged.

This only closes one no-lead rendering discrepancy. Clinical/mixed/compound and broad-deal orchestration remains separate where previously scoped, raw voice normalization remains unqualified, and whole-question semantic equality is not established by the local fixture.

## Early direct nonclinical factual boundary

With the existing opt-in switch, direct nonclinical interrogatives now call the common resolver before voice-only retrieval/renderers choose a factual result. When common resolution returns a result, the separate voice retrieval, brief, record-fact and paraphrase fallbacks are skipped, then that one result is rendered. An empty common raw result cannot keep the previous turn as a draft source. A null common result retains the existing fallback. A new adapter spy requires exactly one common call and zero separate retrieval calls, and fails on the previous late-only checkpoint.

Speech repair/history still happens before this boundary, with raw bytes preserved separately. Clinical, mixed/compound, broad-deal fallbacks and non-interrogative commands remain an incomplete migration; this checkpoint does not qualify their canonical parity or the common resolver's legacy semantics. No provider consent, public flag or workflow setting changed.

## Early direct clinical factual boundary

Direct clinical interrogatives can now use the same early common boundary, after bounded speech repair/history selection but before separate voice factual retrieval/renderers. The existing clinical spy now rejects any separate retrieval call, while current/amended/historical/other-person/follow-up assertions remain unchanged. Clinical common results still use the typed resolver's legacy source operations; this does not create independent clinical admission certificates or qualify normalization/history semantics.

The enabled scope-race test initially stopped testing an in-flight answer because it held only the retrieval route now intentionally skipped. Its harness now holds whichever answer boundary runs (legacy retrieval or common resolver) and waits for actual entry rather than an arbitrary 50ms delay. All original old-case-fact prohibition, switched-case, matching screen text and empty-citation expectations remain intact. Both default and enabled full evaluation passes are recorded separately. Mixed/compound and null-common-result fallbacks remain unfinished migration work.

## Mixed document outcome classification

The opt-in audited document protocol now returns a partial final kind when at least one requirement has cited support but another remains not established or needs clarification. Supported content and each unresolved requirement stay visible; one citation no longer promotes the whole question to answered. All-unanswered clarification remains a clarification, and wholly supported requirements retain the existing document-answer verdict. The site uses the existing amber partial badge and continues to disable voice for cloud-read answers.

A new exposed protocol fixture fails on the preceding checkpoint with DOCUMENT_ANSWER, then passes with PARTIAL_DOCUMENT and final kind partial. The local fake-provider mobile consent test verifies the amber partial badge, retained supported retention window, unresolved approving authority, no voice button, and no horizontal overflow; its pixels were inspected. This tests outcome propagation and presentation only, not the quality of model decomposition, factual entailment or universal admission. No production reader flag, provider request, consent rule or workflow was changed.

## Direct clinical no-lead parity

The opt-in common voice resolver now renders a clinical no-lead result through the same final-answer contract as typed, rather than return null and run a separate voice fallback. Four fresh exposed synthetic questions about favorite food, insurance premium, treatment approver and birthplace retain their typed abstention and zero final citations in fake streaming voice. Existing clinical current/historical/dated/other-person/follow-up positives and missing-test coverage remain unchanged. The named demo-deal exception is not changed, and mixed/compound migration remains open.

The new parity assertions fail on the preceding checkpoint. For unsupported typed comparisons, the synthetic demo's provider is explicitly disabled to obtain its deterministic baseline, then re-enabled before fake voice so the existing zero-provider-call assertion still tests the voice consent boundary. An initial test run left the provider enabled for typed weak-lead questions and counted four caught fake interpretation attempts; this was a fixture-permission mismatch, not a permitted voice provider call. No real provider was used. This is one no-lead path closure, not general semantic qualification.

The first enabled full evaluation exposed a real routing regression: the common no-lead result suppressed the existing instruction to switch from the health demo to the named deal tab. Its original no-other-case-facts and switch-call assertions were kept. The adapter now permits the same navigation-only hint after a citation-free UNKNOWN common result, without re-running factual fallback or reading the other case. That hint is not overwritten by the later renderer. Unrelated unsupported clinical requests still retain exact typed abstention wording.
