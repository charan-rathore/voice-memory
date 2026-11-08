# General document reader implementation checkpoint

Local/off by default, November8. Not deployed, not a parity or release claim.

## Implementation

`src/semantic/document.mjs` reads the exact question against the complete supplied source set up to90,000characters. Above that bound it explicitly refuses completeness instead of silently clipping evidence. The first model pass plans every requested part with answers or explicit unknowns and exact source quotes. Local checks reject changed questions, invented/repeated quotes, missing evidence and owner-scope violations. A separate model audit rereads the full source context and checks request coverage, relevance and meaning, including negation, attribution, chronology and status. It is not a proof and has demonstrated fallibility. Invalid or incomplete audits do not fall back to a confident unrelated deterministic sentence.

The OpenRouter provider implements both bounded methods. `VM_DOCUMENT_REASONING=on`, enabled provider and existing consent are all required; default behavior remains off. When on, this path replaces the old weak-answer rescue for eligible questions, so it also examines confident deterministic answers. Identity ambiguity, advice, exact identifiers and explicit multi-owner preflights still run before it. Therefore not every answer path is a general model reader. The alternate fixed-voice renderer is not yet wired to this reader. Its third-person wording is repaired separately.

Source-bound identity counting now answers the two reported patient/people count questions without a key, explicitly distinguishing record identities from proven physical people. Selecting a record no longer makes the answer call it the caller's own result. Fixed voice and typed comparison remain equal after updating the clinical test's possessive expectation, with all original numbers/dates/corrections and evidence checks preserved. Generated landing snapshot sentences are updated from actual API results; unrelated generated graph/visual churn was excluded.

## Actual evidence

- Core214/214, boundaries209/209, clinical119/119 after pronoun/alternate-voice repair.
- Evaluation477/477 after the final alternate-voice pronoun change. The final source-neutral companion opener is separately covered by voice-companion tests and visual inspection.
- Actual mobile selected90ng/mL screenshot rechecked after the earlier fix; final third-person screenshot is available and must be visually inspected before completion.
- Public14-page Berkshire trial: one multipart answer, first X/acquisition attempt rejected, second answered. The first answer's acquisition wording is imprecise despite audit acceptance. Preserve this defect.
- Fresh first-use National Archives Constitution question through real local upload/ask API: ten-day/Sundays rule, adjournment exception, veto override, unknown2026budget. One case only, no hidden-set claim.
- Seven calls; provider aggregate spend delta$0.04109220, remaining$4.41911022. No outstanding requests, top-ups, demo renewal or deployment.

## Before enabling live

The latest user wants live delivery, but an unrestricted public reader would expose the main key's shared remaining allowance to all visitors and send consented uploads to the provider. Current scope covers public-document tests, not that rollout. Keep it disabled pending a separately bounded runtime/disclosure decision. An owner-only route is not yet implemented or verified and must not be described as deployed.

Still open: varied independent document corpus, table/scan/revision relationships, model semantic-audit reliability, full voice/typed understanding parity, persistent/multi-instance spend enforcement, latency/cost acceptance, exact-head CI and deployment verification. Do not merge merely because deterministic regressions are green.

## Unpaid shared voice boundary checkpoint

A later local opt-in (`VM_SHARED_VOICE_REASONING=on`, default off) gives fixed and BYO voice a server-owned route to the common deterministic answer boundary. The resolved bundle must be the exact current server session's bundle. Model use is explicitly disabled in this route, including for synthetic sessions: typed consent, request fields and caller history are not voice-provider consent.

This is partial routing, not general reader parity. Specialized clinical follow-up/history, mixed-domain, advice, compound and social orchestration remain in the voice renderer. Missing broad-deal leads retain its validated renderer. The first context-free override failed8 of479 existing evaluations (follow-up, mixed answer, language and screen scope); that failed attempt was retained as local diagnostic evidence, not shipped as a qualified design. The revised route respects those orchestration boundaries and language rendering.

Revised enabled-route evaluation481/481, boundaries209/209; clinical119/119, format/typecheck pass. Added API evidence covers BYO source-identity count equality and cited nonclinical retention answer equality, zero calls to a deliberately failing fake provider despite caller consent spoofing, fixed voice identity counts, and source-replacement/hard-expiry during an awaited answer. These are unpaid regression checks, not a broader real-document understanding benchmark. No rollout flag, runtime environment, main-key binding, deploy or paid request changed.
