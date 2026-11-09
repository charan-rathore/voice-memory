# Whole-question coverage — 9 November 2026

Branch `whole-question-coverage`, based on `a8c5a2ae60026be2a488f45cc9e6087cf98123f2` (PR #76 head). Development only: not merged, not deployed, no PR, no provider calls, no spend.

## The defect (reproduced before any change)

One uploaded `policy.txt` containing exactly `Maya owns the security review. The retention window is 17 days.`, provider disabled, real HTTP upload/ask API:

| Question | Before: status / final.kind / text | Coverage before |
|---|---|---|
| Who owns the security review, and what is the retention window? | answered / answered / "Maya owns the security review. That's from policy." | `coverageEstablished:false`, `requirementCoverage:null` |
| Who owns the security review, and what is the lunar permit code? | answered / answered / same owner-only sentence | same |
| What is the lunar permit code? | abstained / abstained / "That isn't covered…" | n/a |

Root cause: the opaque-lossless plan always records `coverageEstablished:false`, but nothing reconciled the final answer with it. `finalAnswer` maps `QUOTED` to `answered`, `publicAnswer` copies that into `status`, and the voice call speaks the same lead. `requirementCoverage` was set only by the certified schema paths.

## What this branch claims

**Tier 1: honest coverage provenance (provider-free default).**
- Every answer leaving `resolveAnswer` carries `wholeQuestion` (`src/whole-question-coverage.mjs`), reconciled after the cache at the single shared boundary. Typed answers, the shared voice resolver and agents all read the same object.
- Possible states: `established`, `incomplete`, `unverified`, `not_applicable`. The state is decided only from recorded provenance: certified `requirementCoverage`, a certified schema plan with its admission, or a qualified document decomposition. It is never decided from question wording.
- An opaque plan with an asserting answer is `unverified`, has `complete:false` and has `unaddressedPartsNamed:false`. The lead text ends with one fixed disclosure: "I haven't verified that this covers every part of the question." There are Hindi and Hinglish versions. Screen, call and API carry the same sentence.
- Voice turns rendered locally by the voice renderer have no plan, so they get the same `unverified` coverage and the same sentence. Social turns, clarifications, refusals and abstentions get no disclosure, because they assert no answer.
- Certified single operations keep their statuses. These are exact fields, events, clinical requirements and owner/test matrices; their coverage is `established` or `incomplete` from their own outcomes.

**Tier 2: whole-question answering when interpretation qualifies.**
- On the standard path (not only under `VM_DOCUMENT_REASONING`), the existing source-exact reader runs only when all of these hold: the provider is enabled, consent is given, the general answer is "answered" or "abstained", and `VM_WHOLE_QUESTION_COVERAGE` is not `off`.
- The reader is the existing blind two-pass decomposition, document scope, exact-span validation and independent audit. There is no second trust path.
- The general lead is replaced only when `documentRequirementCoverage` holds. That needs the plan qualification and a valid outcome for every requirement, and every citation must restore to the original source.
- The answer is complete only if every requirement is `answered`. Otherwise unestablished requirements are named verbatim; they are exact source spans of the original question.
- If either proof is missing (decomposition not qualified, quote not in the source, audit rejection, no consent, switch off), Tier 1's honest `unverified` result stands.

## What this branch does NOT claim

- That a qualified answer is semantically correct. The model audit is fallible; spans and quotes are exact, meaning is not proven.
- Provider-profile reliability. The correlated-omission and disagreement regressions in `semantic-reader-2026-11-09.md` are a separate hard problem and are not fixed or re-qualified here.
- Which part of an opaque question went unanswered. That is unknowable without a qualified decomposition, so it is never named.
- That an `unverified` answer is wrong or incomplete. It means completeness was not checked.
- Any accuracy figure. All fixtures are developer-authored and synthetic, or a single public document.

## Proposed status disposition (for owner review; NOT shipped)

This branch is additive. No existing `status` or `final.kind` value changes meaning. New fields: `final.complete`, `final.coverage`, top-level `wholeQuestion`, `lead.coverageNotice`. The status remap below is proposed only:

| Coverage state | Current `status` | Proposed `status` |
|---|---|---|
| established (certified or qualified) | answered | answered (unchanged) |
| incomplete (certified or qualified) | partial | partial (unchanged) |
| unverified, final.kind answered | answered | `answered_unverified` (new value), or keep `answered` and require clients to read `final.complete` |
| not_applicable | clarify / refused / abstained / social | unchanged |

Product trade-off to decide: every opaque single-part answer now carries the disclosure sentence. That is honest but adds 11 words on a call. The Tier 2 path removes it whenever coverage is actually proven.

## Per-fixture evidence (executed in this session)

RED: the new API test file was run against unmodified `a8c5a2a`, with the module import replaced by the literal sentence: **0 of 9 pass**. GREEN on this branch: **9 of 9**.

| Fixture | Provenance | Expected | Result |
|---|---|---|---|
| Original probe: owner + retention, provider off | exact reported probe | unverified, disclosure on screen and call, no named remainder | pass |
| Original probe: owner + lunar code, provider off | exact reported probe | same | pass |
| Absent single question | exact reported probe | abstained, not_applicable, no disclosure | pass |
| Supported single question (retention) | exact reported probe | still answers (17 days), status unchanged | pass |
| Adversarial `vendor-memo.txt`: all, some or no parts answerable; paraphrase; namesake owners (two Priyas); negation; status change; absent half | new synthetic document | no response over-claims; any asserting answer is unverified on screen and call | pass (8 questions) |
| Scripted replay `ownerRetention` | SCRIPTED provider-shaped JSON | established, DOCUMENT_ANSWER, exact quotes | pass |
| Scripted replay `ownerLunar` | SCRIPTED | incomplete, PARTIAL_DOCUMENT, names "and what is the lunar permit code?" | pass |
| Scripted replay `reconstructionDisagrees` | SCRIPTED | unverified; documents never sent for reading | pass |
| Scripted replay `missingSourceProof` (30 days, not in source) | SCRIPTED | unverified; unproven claim never shown | pass |
| Scripted replay `auditRejects` | SCRIPTED | unverified | pass |
| No consent / `VM_WHOLE_QUESTION_COVERAGE=off` | SCRIPTED | zero document calls, unverified | pass |
| Constitution disagreement | ACTUAL saved provider content (scripted audit acceptance) | incomplete, outcomes answered/answered/clarify, names the budget span | pass |

The scripted fixtures are hand-written to the real provider schema. They exercise the admission contract, not model quality.

## Reviewed fixture updates (intentional, not silent)

1. `tests/fictional-sample.test.mjs`: the launch-negative voice answer must now end with the exact disclosure sentence. The answer itself is unchanged and still anchored.
2. `evaluation/spoken-eval.mjs` and `evaluation/spoken-turns.test.mjs`: word caps (45 and 40 words) now measure the answer with the fixed disclosure sentence removed. Two answers went to 51 words only because of the disclosure. The disclosure on the call is asserted in `tests/whole-question-coverage-api.test.mjs`.

Bugs found by the existing suites and fixed in code, not in expectations:
- Coverage briefly copied request identity (original wording and opaque plan key). That broke the cache-equality contract, so coverage now lives only in computed fields. Caught by `tests/cache.test.mjs`.
- Voice social replies ("You're welcome…") received the disclosure. They are now excluded. Caught by `evaluation/conversation-repeat.test.mjs`.

## Follow-up commits on this branch

- **Latency.** The two blind question reconstructions, and the two blind document reads, now run concurrently. Neither pass ever sees the other's output, so qualified questions save two model round trips. Validation, exact agreement, reconciliation and the audit are unchanged. The protected property "no provider call starts after a source change" still holds.
  - Reviewed test update: `tests/question-understanding.test.mjs` now asserts that property directly. It used to count calls in sequential order.
  - New `tests/blind-pass-concurrency.test.mjs` deadlocks if either pair runs sequentially.
  - Cost note: when the primary document read fails, the independent read has already been spent.
- **Wording.** Unanswered parts now read "I could not establish “<exact span>” from these documents." A disputed part reads "For “<span>”, the reading checks disagreed, so I have not established an answer." This replaces the earlier dangling span followed by a generic sentence.
- **Answer card (site/).** A coverage strip renders only from server fields (`wholeQuestion`, `requirementCoverage`):
  - an animated per-part meter;
  - each exact part with its outcome in words;
  - an expandable "Coverage not checked" explanation for opaque answers.
  - It respects reduced motion and never splits questions in the browser.
  - Checked in Chrome at 1280 px and 390 px against the real `site/` and the real engine. The qualified states were replayed from real engine responses produced with the offline scripted provider. No clipping was found.

## Suite results and environment limits

This session cannot reach the npm registry, and package installs are disabled for the account, so `node_modules` is absent. Tests ran under a sandbox-only harness kept outside the repository:
- an empty `node_modules/pdfjs-dist/standard_fonts/` directory, and
- a Node loader that resolves `fflate`, `@xmldom/xmldom`, `tesseract.js`, `pdfjs-dist`, `pdf-lib`, `@google/genai` and `@huggingface/transformers` to stubs that throw when used.

So PDF, DOCX, OCR, embedding and provider code paths fail in this sandbox, in both baseline and branch. `evaluation/site-contract.test.mjs` hangs without `esbuild` and was stopped after 200 s in both runs.

Comparison is per test name, baseline `a8c5a2a` against this branch, under identical harness conditions (final clean run, sequential):

| Suite | Baseline a8c5a2a | Branch | Regressions | New tests |
|---|---|---|---|---|
| core (`npm test`) | 251/268 | 259/276 | 0 | 8, all pass |
| boundaries | 182/218 | 191/227 | 0 | 9, all pass |
| evaluation | 451/513 | 451/513 | 0 | 0 |
| clinical | 57/119 | 57/119 | 0 | 0 |
| ingest | 19/45 | 19/45 | 0 | 0 |

Every baseline failure is identical on the branch and comes from the sandbox (stubbed PDF, OCR, embedding and esbuild paths), not from this change. These are not the 1,171-pass figures from a dependency-ready environment; that environment must re-run them.

Partially verified with tools already present on the machine (not the pinned versions):
- Prettier 3.8.1 (lockfile pins 3.6.2): every changed file in the `format:check` globs passes. The baseline files are also clean under 3.8.1.
- TypeScript 6.0.3 (lockfile pins 5.9.3): `tsc -p tsconfig.json` shows the same two environment errors (missing `@types/node`, a TS 6 `baseUrl` deprecation) on baseline and branch, with zero new errors. Typecheck scope is `src/engine.ts` and `src/context.ts`, which this branch does not touch.

NOT run here: `npm run build` (esbuild; its entry points are unchanged), the Playwright browser suites, and the PDF, OCR and embedding paths. Hosted CI runs on this PR. To reproduce locally:

```
npm ci && npm run build && npm run format && npm run typecheck
npm test && npm run test:boundaries && npm run test:evaluation && npm run test:clinical && npm run test:ingest
```

## Page weight and latency

- The site's first-load budget is 530,000 bytes (`evaluation/site-contract.test.mjs`). Baseline is 525,615 bytes. The coverage strip first took it to 531,052. The final compact CSS gives 529,904, within budget, and the budget itself was not changed.
- `/ask` round trips with the provider off, 60 requests per run, measured on the same machine against baseline and branch engines, alternating: p50 0.8–2.1 ms and p95 2.0–5.0 ms on both. RSS is about 100 MB each. Reconciling coverage adds no measurable cost.
  - Caveat: embeddings are stubbed here, and some requests may be answer-cache hits, so these are not production latency figures.
  - Tier 2 latency is dominated by provider round trips. Running the blind passes concurrently removes two of the five sequential calls.
  - The voice path's shared resolver stays `noModel`, so a call never waits on Tier 2.

## Design notes from comparable systems

- Per-chunk verification fails on multi-part questions, because no single passage is sufficient. Verifying against the decomposed sub-question restores entailment. The reported later-hop AUC rose from 0.546 to 0.840 with a gold decomposition (arXiv 2608.00585). This is why Tier 2 verifies per requirement, and why a per-sentence content-word check (PR #77's approach) is not used as a validator.
- The same paper notes that decompositions are often generated and then discarded before verification. Here the exact requirement spans travel from interpretation through reading, audit, `requirementCoverage` and the final text.
- The first-place RAG Challenge system split compound questions, answered each part separately, required a typed answer schema, and cited pages. Tier 2 follows that shape, but the split must be source-exact and agree across two blind passes instead of being a regex.

## Boundaries

- The model audit is fallible.
- Provider profiles are not re-qualified by this work.
- Opaque questions cannot name their unaddressed parts.
- Tier 2 adds up to five provider calls per eligible consented question on the standard path; `VM_WHOLE_QUESTION_COVERAGE=off` disables it. Latency and cost acceptance are owner decisions.
