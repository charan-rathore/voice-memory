# Owner guide

How Voice Memory answers, file by file, so you can explain and defend it. Everything here is in the code today; where something is not done, it says so. For design decisions and measured numbers see `ARCHITECTURE.md`; for the Gemini layer see `SEMANTIC.md`.

## 1. Upload → canonical document → index → citation

- `ingest/index.mjs` `ingestFile(bytes, name)` validates type and size, then parses in a worker thread (`ingest/worker.mjs`) under a heap limit and a wall-clock timeout, so a hostile file kills a thread, not the server.
- `ingest/parse.mjs` picks a parser: PDF (`ingest/pdf.mjs`, pdf.js, OCR fallback via tesseract for scanned pages), DOCX (`ingest/docx.mjs`), images (`ingest/image.mjs`, OCR), text. Fewer than 40 characters of text is refused.
- Output is one canonical document (`vm.document/1`, ARCHITECTURE §2): text, elements (headings, tables, rows) and spans with page and box. Every later citation is an offset range into this text, so the screen can open the exact line and page.
- `dist/engine.mjs` `importBundle` (built from `src/engine.ts` + vendored memoRABLE) chunks and indexes 1 to 16 documents. Each chunk keeps source id, hash, offsets and 1-based line numbers (`src/line-index.ts`).
- Original bytes and parsed text are not a durable public vault (see §7).

## 2. Question → evidence

- Spoken repair first: `src/spoken-repair.mjs` `selfRepair` keeps what the caller settled on ("triglycerides, sorry, the HDL" → "the HDL"); `repairTestNames` fixes recogniser spellings of tests; `src/spoken-normalize.mjs` turns spoken numbers into figures.
- Retrieval (`src/engine.ts` `answer`, core in `vendor/web/src/lib/rag/retrieve-core.ts`): BM25 keyword ranking, plus dense embeddings (`src/dense.mjs`, `@huggingface/transformers`) when memory allows; `VM_DENSE=off` disables dense.
- The **evidence gate** returns `positive`, `ambiguous` or `negative_not_found`. Only `positive` grounds an answer.
- Expansion (`src/query-expand.ts`) is a disclosed fallback, tried only when the original question is not `positive`; every transform is returned in `queryTransform`. One verified rewrite exists: `equivalentRewrite` replaces "transcripts retained/kept" with the record's term "transcript retention period", only when the guarded retention phrase is the whole ask. Thresholds are never lowered.
- The spoken layer (`src/spoken.mjs` `spokenTurn`) answers from typed claims; `src/spoken-extract.mjs` may speak one verbatim, span-validated sentence when no claim field fits. Otherwise: "I couldn't establish that from these documents."

## 3. Clinical: identity, time, corrections, units

- Rows become observations in `clinical/observations.mjs` `extractReport` (value, comparator, unit, printed range, flag, page/box).
- **Identity contract** (`subjectOf`): a printed, unmasked **patient ID** is the only thing that links two reports, and only when no report with that ID contradicts it (different printed sex, or ages impossible for the collection dates; `markIdentityConflicts`, run once per report set in `clinicalReportsFor`). A shared **name** never links ("John Smith" twice is two people). A **lab / accession number** (`meta.accession`) names an order or specimen and never links. A masked field (`XXXXXXXXX`) is absent. Unlinked reports stay separate and the answer asks "whose results?". Both graphs use the same `subjectOf`.
- Time: `seriesFor` orders one subject's readings by collection date. Same collection date: amended > corrected > final > preliminary; the replaced value is still cited.
- Units are never inferred or converted: `compare` refuses mg/dL vs µmol/L and bounds like `<0.05`.
- Position vs range (`clinical/explain.mjs` `position`) is literal: within / below / above the lab's printed range, or cannot classify. No distance-based severity. The lab's own critical flag (`CRITICAL_FLAG`) has its own "contact your doctor today" path.
- Treatment and diagnosis questions are declined before retrieval (`src/vernacular.mjs` `adviceKind`, `declineLead`), in the third person when the question is about someone else.

## 4. Contracts and meetings: claims, authority, supersession

- `extractClaims` (in `dist/engine.mjs`, from `src/claim-check.ts`) reads typed claims for eight fields (fee, paymentSplit, deadline, scope, signoffWho, signedAgreement, launchApproval, reporting) with status (approved, proposed, discussed, requested, internal-target, unresolved, rejected), source span and `scopeEntities` (which engagement).
- `resolveClaims` decides current vs superseded; two current values with no approval are `open`.
- Authority (`memory/graph.mjs` `approvalAuthority`): credited only to the actor of a non-negated approval clause about that field; joint or competing actors → "approver not established". An internal approval is never shown as a client signature; a "signed agreement" record that says there is none reads "no signed record".
- Known limit: motions, objections, action owners and committee resolutions are not typed fields; they are searchable text, not graph nodes.

## 5. A Bolna call

1. Bolna's STT (Deepgram) transcribes the caller and posts the whole message history to `POST /v1/chat/completions` (OpenAI-shaped) with an opaque bearer capability.
2. `src/voice-adapter.mjs`: each capability binds one server-owned bundle (`bind`), has a TTL and a hard expiry; the request body can never choose the bundle.
3. Per turn: `selfRepair` → `socialTurn` (hear-check, thanks, "say that again", language) → advice decline → clinical (`clinicalAnswer`) or deal (`spokenTurn`) → extractive fallback.
4. The reply streams back as SSE (`text/event-stream`); Bolna's TTS speaks it. The same turn is recorded so the web page shows the identical sentence and its citation.
5. Public voice is guarded by durable call counters (Upstash) and fails closed without them.
- NOT TESTED end to end: a real microphone call through STT → engine → TTS → screen.

## 6. Isolation

- Per call: context comes only from that request's message history (Bolna resends it); nothing from caller A reaches caller B (`evaluation/call-isolation.test.mjs`).
- Per workspace: uploads live in an in-memory workspace (`src/server.mjs`, `VM_WS_FILES`, default 5 files; dropped after `VM_WS_IDLE_MIN`, default 30 idle minutes). A spoken workspace id cannot select a workspace; an expired one never falls back to demo data.

## 7. Memory and the graph; what is durable

- Episodic memory (`memory/memory.mjs` `recordTurn`): each answered question with the spans it cited. `liveEpisodes` drops any episode whose cited text no longer exists (deleted or replaced document).
- The graph (`memory/graph.mjs` `buildGraph`, `src/public-api.mjs` `clinicalGraph`) is recomputed from documents + live episodes on every request. It is a view, not a database.
- Durable: only the optional owner workspace (`memory/store.mjs`, AES-256-GCM with a configured key and disk). Public workspaces are ephemeral, not accounts.

## 8. Gemini (optional)

- Off unless `GEMINI_API_KEY` / `OPENROUTER_API_KEY` is set server-side; `VM_GEMINI=off` is a kill switch.
- Consent (`src/semantic/scope.mjs` `semanticConsentFor`): uploaded workspaces (`ws:`) only with the visitor's opt-in.
- Gemini may route intent or propose claims for still-unanswered, consented questions; each claim goes through `src/semantic/verify.mjs` `verifyClaims` against source spans before it is spoken. Google Search grounding (`src/semantic/gemini.mjs`) returns its own URLs, kept apart from document citations.

## 9. Limits

- Benchmarks are small and partly built by the same team (synthetic labs, Northstar, Mariner); outside sets (QMSum, CUAD) are in `evaluation/outside-bench.mjs`. Treat scores as regression signals, not accuracy claims.
- Free-tier hosting: Render sleeps when idle (cold start), limited memory (dense may be disabled by the memory guard), Vercel proxies `/api/public`.
- Original public PDFs (WM14, Cairngorms) and real Bolna calls are not covered by CI.

## 10. Failure modes, diagnostics, tests, rollback

- `GET /healthz`: cache, dense state, memory, and `commit` (`RENDER_GIT_COMMIT`): compare it with the page's commit before a demo.
- Logs say "fail closed" when counters or keys are missing; they never contain document text.
- Local gate: `npm run verify` (format, typecheck, build, unit, boundaries, evaluation, ingest, clinical, benches, vault, browser, graph).
- Rollback: Render "Rollback" to the previous deploy; Vercel "Promote" the previous deployment. No data migration exists, so rollback is code only.

## Functions changed in PR #50

Each: invariant · a counterexample that failed before · the test.

| Function | Invariant | Failed before | Test |
|---|---|---|---|
| `clinical/lab-lines.mjs` `genericMeta`, `isMaskedIdentity` | Only patient-ID labels (UHID, MRN, Patient ID…) fill `patient.id`; Lab/Accession No. go to `accession`; masked values are absent | two labs printing `Lab No.: ABC123` were one person | `evaluation/patient-identity.test.mjs` |
| `clinical/observations.mjs` `subjectOf`, `identityConflict`, `markIdentityConflicts` | Patient ID links unless contradicted by sex or impossible ages; names never link | two John Smiths (36, 25) merged | same |
| `src/public-api.mjs` `clinicalGraph` | Identity from `subjectOf`; `verified` only for patient IDs; `latest` only for the last collection of a fully dated verified series | Sept final and Oct amended both "latest" | same |
| `clinical/answer.mjs` `subjectLabel` | Unlinked reports are named "Name (file)" so choices are distinguishable | "more than one person (John Smith, John Smith)" | same |
| `memory/graph.mjs` `approvalAuthority` | Actor = subject of a non-negated approval clause about the field; else null | "Finance noted that client approved" → finance | `evaluation/status-labels.test.mjs` |
| `memory/graph.mjs` `engagementKeys` | Same amount in non-overlapping engagements = two values | Alder proposed + Birch approved $42,000 = one approved node | `evaluation/graph-integrity.test.mjs` |
| `site/status-labels.js` `statusLabel` | Wording from the node's own domain, not the page | lab value read "in force" | `evaluation/status-labels.test.mjs` |
| `src/query-expand.ts` `transcriptRetentionAsk`, `equivalentRewrite` | Rewrite only a duration ask whose transcript phrase ends the clause (or "for" / "for the pilot") | "for confidentiality" rewritten to retention | `evaluation/query-expansion.test.mjs` |
| `src/spoken.mjs` HISTORY render, `unknownNamedEntity`, `resolveField` | "Yes" only if the named figure is the earlier record; openers and contractions are not names; "who signs off" → approver | "Was the original fee $42,000?" → "Yes" | `evaluation/spoken-openers.test.mjs` |
| `clinical/explain.mjs` `position` | Literal position, no distance tiers | "clearly above… see your doctor soon" | `clinical/explain.test.mjs` |
| `src/conversation.mjs` `socialTurn`, `isSocialReply`, `shorterOf`, `asksAfterCourtesy` | Repeat = last record answer; shorter = opening ≥4 words of it; a question after "thanks" is answered | repeated "You're welcome" | `evaluation/conversation-repeat.test.mjs` |
| `clinical/explain.mjs` `aboutSomeoneElse`, `thirdPerson`; `src/vernacular.mjs` `declineLead` | No "you/your" for someone else's results (English answers; declines in en/hi/Hinglish) | "What is his TSH?" → "Your TSH…" | same |
| `site/graph.js` `colorOf` | Unknown/open status never uses the approved colour | open 40/60 vs 50/50 drawn teal | `evaluation/status-labels.test.mjs` |
| `src/server.mjs` `/healthz` | Reports the deployed commit hash only | no way to tell what Render runs | `tests/cache.test.mjs` |
