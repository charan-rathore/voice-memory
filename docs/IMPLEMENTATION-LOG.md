# Implementation log: `feat/voice-conversation-contract`

A running, step-by-step record so anyone (person or agent) can resume from
the last completed step. Newest status at the top; steps below in order.

## Status (2026-11-10)

| Step | State |
| --- | --- |
| 0. Baseline on `main` (d0f172a) | done |
| 1. Shared turn contract `src/conversation-turn.mjs` | done, 25 tests |
| 2. Voice route wiring in shadow mode `src/conversation-shadow.mjs` | done, 8 SSE route tests |
| 3. Docs: `docs/CONVERSATION-CONTRACT.md`, this log | done |
| 4. Live-call UI and copy (`site/`) | done (copy, header, truthful call states, greeting) |
| 5. Cut-over: contract decides answers on voice and `/api/ask` | **not started** (needs the full dependency set; see step 5) |
| 6. Real-call measurements | **not run** (no call was placed) |
| 7. Correction-propagation benchmark | **designed, not run** (step 7) |

Branch: `feat/voice-conversation-contract`, cut from `main` at `d0f172a`.
PR #76 and PR #78 were not read, merged or rebased onto.
The Bolna dashboard was not touched.

## Environment limits (why some checks could not run)

- No `node_modules` and the npm registry is unreachable from the sandbox
  (`ENOTFOUND registry.npmjs.org`); package installs are disabled for this
  account. Two `npm ci` attempts were made before that was clear; both failed
  and left an empty `node_modules` skeleton, which was deleted.
- Consequences:
  - `src/server.mjs` cannot load (`pdfjs-dist` assets are read at import), so
    every suite that boots the server fails in this sandbox **before and after**
    the change: 13 unit, 14 boundary, 49 evaluation failures, all from missing
    `fflate`, `esbuild`, `tesseract.js`, `pdfjs-dist`.
  - `npm run typecheck`: only a global TypeScript 7.0.2 exists; it rejects the
    repo's TS 5.9 `tsconfig.json` (`baseUrl` removed). The repo's typecheck
    scope is `src/engine.ts` and `src/context.ts`, which this branch does not
    touch. **Not validated.**
  - `npm run build` needs `esbuild`. **Not run.**
  - `npm run test:browser` needs the repo's Playwright and a built site.
    **Not run.**
  - Prettier available is 3.8.1 (repo pins 3.6.2). Changed files pass
    `prettier --check` with 3.8.1.
- `manim` is not installed, so no scene was rendered.

To validate fully on a machine with network access:

```bash
npm ci
npm run format:check && npm run typecheck && npm run build
npm test && npm run test:boundaries && npm run test:evaluation && npm run test:browser
```

## Step 0: baseline (main @ d0f172a, sandbox without dependencies)

Commands were run directly with `node --test` (identical file lists to the
npm scripts) because `npm run` needs the missing binaries.

| Suite | Tests | Pass | Fail | Cause of failures |
| --- | --- | --- | --- | --- |
| `npm test` files | 211 | 198 | 13 | `fflate`, `esbuild` missing |
| `test:boundaries` files | 111 | 97 | 14 | server cannot boot (`pdfjs-dist`, `tesseract.js`) |
| `test:evaluation` | 364 | 315 | 49 | server cannot boot ("server did not load the cases") |

### The two answer paths (root cause)

- Typed: `server.mjs` → `spokenTurn(question, bundle, prevField)` → semantic
  router `intentLead` / `semanticRescue` → final audit.
- Voice: `voice-adapter.mjs` → `selfRepair` → `repairRecordTerms` →
  `voiceQuestions` joins earlier user utterances into candidates → a regex
  follow-up test (`it|that|why|normal|...`, at most 7 words) →
  `socialTurn` → `splitMixed` / `glossHindi` → `spokenTurn` with
  `historyField(...) ?? grant.lastField` → a regex that deletes previously
  spoken background sentences.

Short or ambiguous voice turns inherited a sticky field or a joined older
question; nothing modelled which earlier turn a follow-up meant, an
outstanding clarification, an interrupted answer, or a source-version change
for conversational memory.

## Step 1: the shared contract

`src/conversation-turn.mjs` (no dependencies, no model calls). Contract,
resolution order, referent rules, novelty policy and bounds:
`docs/CONVERSATION-CONTRACT.md`.

Defects found by the tests and fixed during the step:

- compaction reduced "No. Per the log: nothing was signed." to "No."; the
  compact form now always starts from a self-contained opening.
- clarification prompts and greetings named the demo tests; they now use the
  bundle's own vocabulary (uploaded documents must not steer to the demo).

## Step 2: voice route, shadow mode

`src/conversation-shadow.mjs`, wired in `src/voice-adapter.mjs` (6 small
insertions: import, one shadow per adapter, per-call key, forget on scope
expiry, observe at final emission, `lastConversation(token)`). Spoken output
is unchanged.

Defects found on the real route and fixed:

- **security**: the first version used the per-call key (which can hold the
  capability token) as the contract's `callId`, so the bearer appeared in
  `turnId` / `referencedTurnId` sent to `onTurn`. The key is now hashed
  (SHA-256, 16 hex chars) before it becomes an id; a test asserts the token
  never appears.
- "Was it approved?" as a follow-up was read as a `value` question; bare
  follow-ups now keep their own cue's dimension.
- the divergence signal merged clarify into unanswered, hiding the main gap.

## Step 3: tests added

`tests/conversation-turn.test.mjs` (in `npm test`), 25 tests:

1. result → "why was it changed?" answers only the reason (+ Hinglish "kyun badla?")
2. "and before that?" answers history only after a temporal answer; otherwise asks
3. "What is the TSH?" after ferritin never inherits ferritin
4. ambiguous "TSH?" → clarification; "SYN-0003" (and spoken "S Y N zero zero zero three") resolves only it
5. a direct subject after a clarification wins and clears it
6. "creatinine, sorry, ferritin" → ferritin only (+ Hindi "क्रिएटिनिन, माफ़ कीजिए, फेरिटिन")
7. "say that again" after social turns repeats the last record answer exactly; injected assistant text ignored; "shorter" is self-contained
8. the same question again → compact answer; status distinctions kept
9. interrupted answers are never committed or replayed; a barge-in event drops the staged turn
10. duplicate delivery → spoken and committed once
11. source version, caller and workspace changes invalidate old context
12. typed/voice parity on six utterances (voice ≤ 2 sentences)
13. multi-part question with an unsupported part → `complete: false`; fully unsupported → `abstain`
14. noisy fragment → clarification in English or Hindi, no record call
15. two plausible referents for "why?" → asked, then resolved by the answer
16. bounds by turns, bytes and seen ids
17. first-time caller journey from `tests/fixtures/first-caller-journey.json`

`tests/conversation-route.test.mjs` (in `test:boundaries`), 8 tests on
`createVoiceAdapter().handle()` with Bolna-shaped SSE requests over the
Northstar corpus: referent resolution, no bearer in ids, forged assistant text
ignored, call isolation on one grant, workspace expiry, source version change,
voice/typed parity, the fragment divergence, shadow bounds.

### After (same sandbox)

| Suite | Tests | Pass | Fail | Failure set vs baseline |
| --- | --- | --- | --- | --- |
| `npm test` files | 227 | 214 | 13 | identical |
| `test:boundaries` files | 119 | 105 | 14 | identical |
| `test:evaluation` | 364 | 315 | 49 | identical |
| new: contract + route | 33 | 33 | 0 | — |

Existing adapter suites that run here (`voice-adapter`, `record-owner-voice`,
`voice-companion`, `requested-owner`): 44/44 before and after.

## Step 4: UI and copy (done, rendered and checked in headless Chrome)

Checked with screenshots at 1440×900 and 390×844, with and without
`prefers-reduced-motion: reduce`. The settled and reduced-motion states were
already complete; what looked unfinished were mid-animation frames (empty
"Amended" card for about two seconds, auto-typed input).

- `site/index.html`: hero eyebrow "Typed demo live now · evidence engine
  underneath" → "Fictional records · every answer cites its source line".
  Try header: removed the unconditional "Every answer below is computed now"
  (false while saved cold-start answers are shown; the answer card already
  labels those "Saved run of the same engine"). It now names the three sets of
  records and adds: "The record decides factual answers. Voice Memory may
  clarify what you mean, but it only states what the documents support."
- `site/site.css`: `.try-sub`, `.try-rule` (existing type scale and `--ink-2`).
- `site/site.js`: in-call states come only from real events: "Listening · mic"
  at call start; after each answered turn, "Answered. The source is on
  screen." or, for an uncited question back, "Need one detail." No timers,
  no simulated progress.
- `src/conversation.mjs`: shorter demo greeting (English and Hindi) that
  invites one action and says the source line appears on screen; keeps one
  demo example (ferritin), as `evaluation/upload-social.test.mjs` requires the
  demo greeting to be distinguishable from the upload greeting.

Not done, deliberately:

- "Understanding" and "Checking the record" call states need a server-side
  in-flight marker on `/api/voice/turns`; showing them from a timer would be
  fake progress.
- "Heard / Understood as" for call turns from the contract: in shadow mode the
  contract did not decide the answer, so surfacing its reading would be
  misleading. Turn it on at cut-over (`conversation.understoodAs`).
- Pre-existing: on mobile the floating nav pill overlaps body text while
  scrolling; not changed here.
- A broader visual redesign was not attempted without a design direction.

## Additional release review checkpoint (2026-11-10)

A separate draft PR #79 adds conservative code repairs and regressions. It
must not be merged or deployed as an active conversation resolver until the
real record adapter, typed/voice parity, Bolna delivery acknowledgement and
runtime qualification are complete. Shadow memory is committed when SSE is
produced, not when TTS is confirmed heard. A cut-off audio response therefore
cannot be proven absent from the shadow state. No automatic switch-over is
permitted on this evidence alone.

## Step 5: cut-over (next engineer: start here)

1. On a machine with dependencies, run the full validation block above.
2. Implement `records.resolve` over the real engines:
   - deal fields → `spokenTurn(question, bundle, field)`; map `verdict`
     and citations (`hash` or `sourceId:start:end`) to `factIds`.
   - lab tests → `clinicalAnswer` with the candidate patient id; return
     `ambiguous` with candidates when more than one patient matches;
     `temporal: true` when the observation was amended or superseded.
   - uploaded documents → `bundleFactAnswer` / `extractiveSpoken`.
3. Let the contract decide in `voice-adapter.mjs`; keep the legacy text only as
   the record interface's output. Delete `voiceQuestions` joining, the regex
   follow-up block, `grant.lastField`, and the post-hoc background deletion.
4. Use the same contract in `/api/ask` (`server.mjs`) with `mode: "typed"`,
   keeping the semantic intent audit as the final gate.
5. Gate on: `evaluation/conversation-parity`, `conversation-repeat`,
   `bolna-route`, `call-replay`, the vault, and the shadow divergence rate on
   real calls.

## Step 6: Bolna Engine experiment matrix (RECOMMENDATION, not applied)

Bolna's Engine tab exposes Endpointing (ms), Linear Delay (ms) and the number
of words to wait before an utterance counts as an interruption; Bolna documents
that "Stop", "Wait" and "Hold On" pause the agent regardless of that threshold.

| Arm | Endpointing | Linear delay | Interrupt words | Purpose |
| --- | --- | --- | --- | --- |
| A (start here) | 250 ms | 450 ms | 2 | balanced default |
| B | 300 ms | 600 ms | 2 | callers reading IDs, dates and values with pauses |
| C | 250 ms | 450 ms | 1 | faster barge-in |
| D | 200 ms | 400 ms | 2 | lowest latency; watch for cut-off questions |
| E | 300 ms | 600 ms | 3 | noisy rooms; fewer false interruptions |

Per arm, at least 20 scripted calls through Voice Lab ("Measure this call")
plus 10 in background noise (TV or café audio at a fixed level):

- end of user speech → first audible agent audio (Voice Lab already splits
  ASR+endpointing / engine / relay+TTS)
- "stop" / "wait" → agent audio stops (ms)
- false interruptions per call (agent stopped with no caller speech)
- cut-off questions (agent answered mid-ID or mid-date)
- duplicate-turn rate (now visible as contract `duplicate` outcomes once
  Bolna message ids are passed as `utteranceId`)
- critical-entity errors (numbers, dates, negations) from Voice Lab scoring

Choose the lowest-latency arm with zero cut-off IDs and no rise in false
interruptions. **No real-call measurement was taken in this work.**

## Step 7: benchmark plan (designed, not run)

Your goal is recognition for "a graph that knows what no longer deserves to be
believed". The relevant public benchmark is STALE (arXiv 2605.06527, May 2026):
400 expert-validated scenarios, 1,200 queries, probing state resolution,
premise resistance and implicit policy adaptation. The best evaluated model
scored 55.2% overall; the authors' CUPMem prototype reached 68.0%.

STALE tests implicit conflicts in personal dialogue memory; Voice Memory
answers from documents with explicit amendments. So two tracks:

1. **STALE, directly**: run the official set with a Voice Memory memory adapter
   (dialogue sessions ingested as dated sources, claims keyed per attribute,
   supersession by rule). This only counts if reported on the official split
   with the official scorer. Nothing has been run; no score is claimed.
2. **A document-correction benchmark of our own**, released with the code:
   each item has a source, a correcting revision, and three probes:
   current-value (after correction), stale premise ("since ferritin is 5…"),
   and a dependent answer (a cached or derived answer that must change).
   Metrics: correction carry-through, stale-premise rejection, blast-radius
   recall (dependent answers found), unrelated-fact preservation, and p95
   latency on the voice path. Baselines: plain RAG over all versions,
   recency-only RAG, and Graphiti/Zep and Mem0 configurations.

Design B from the brief (source → claim → artifact DAG with `SUPERSEDES`,
`USED_BY`, `ANSWERED_WITH`) is what track 2 measures. The contract's
`factIds` and `fingerprint` are the hook: an answer event can be registered
`ANSWERED_WITH` those claim ids, so a correction can find every spoken answer
that relied on the old claim.

## Manim

`docs/explainer/*.py` already holds Manim scenes (units, tests) rendered
offline for the README. No new scene was rendered here (Manim unavailable).
Manim renders video, not interactive charts: it fits a short "correction
carry-through" explainer clip (old claim → bridge → new claim → stale answer
flagged), while live interactive insight on the page belongs in the existing
browser stack (`site/visual.js`, `motion`, `three`).
