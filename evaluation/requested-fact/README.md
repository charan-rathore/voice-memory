# Local requested-fact repair evidence

Base HEAD: `f1b1989000a3fd8611c6fbde6e26b2b8e9d6f3dc`.
Candidate: the uncommitted public-code patch in this checkout. No commits,
pushes, PRs, deployments, account changes, model/TTS/Bolna calls or pressure-file
changes. `dist/engine.mjs` must be rebuilt before running either source version;
the tracked generated bundle at this HEAD lacks exports used by its source.
The generated bundle is intentionally excluded from the patch.

## Reproduce

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run build
node --test tests/requested-fact.test.mjs
node evaluation/requested-fact/reproduce.mjs /tmp/requested-fact-output.json
VM_DENSE=off VM_RERANK=off node evaluation/answer-quality-bench.mjs
```

The harness binds an ephemeral loopback HTTP server, uploads **all seven public
Markdown documents separately** through `/api/public/workspace/:id/upload`,
waits for local ingestion, and asks `/api/public/ask` without semantic consent.
It reads canonical documents through the public document endpoint and binds those
same texts to a **default** voice adapter (no injected retrieval). SSE is exercised
via real HTTP `/v1/chat/completions`, with no voice-session mint or audio API.
There is no browser, provider, external-model or TTS mock answer substitution.

Existing process-local options: `VM_WS_FILES=10` (the public default of five
cannot hold this seven-document workload), `VM_WS_PER_IP_HOUR=100`, dense,
rerank and watchdog off, persistence and public-host overrides unset/empty.
No admission policy code changed. All HTTP lead/body citations and SSE citations
are checked against the canonical source's exact half-open `[start,end)` slice.
SSE content deltas are concatenated and checked for exact equality with the
adapter's recorded spoken turn. Fixtures contain public/synthetic text only.

## Actual before/after

[`baseline.json`](baseline.json) and [`candidate.json`](candidate.json) contain
complete raw ask responses, raw SSE frames, spoken turns, citation quotes and
source spans for the three requested questions (including the curly apostrophe).
Random document/session IDs, timestamps and latencies vary between runs.

Baseline lead and spoken text:

- Deadline: `That is still open: 15 November 2026 versus 22 November 2026 are both on record.`
  The client request is in lead citations (`06_Client_Email_Extract.md`,
  `[108,182)`), but the body incorrectly returns kickoff notes `[0,537)`.
- Frequency: `The client agreed to weekly progress reporting, per the client kickoff notes from September 11.`
  This lead is grounded, but the body returns only the original proposal `[0,584)`.
- Finance: `No. Per the internal action log from October 9: no signed commercial agreement exists for the revised terms.`
  This answers agreement existence rather than finance approval. The body contains
  the steering non-signoff statement inside a broad `[0,436)` excerpt, but omits
  the explicit pending finance-approval sentence.

Candidate body, lead and spoken turn use the **same verbatim statements**, with
`QUOTED` rather than inferred `CONFIRMED`/agreement verdicts. They begin
`Source statements (not an inferred approval or agreement):` and include:

| Question | First quote | Source span |
| --- | --- | --- |
| Deadline | The client asks to retain the original 15 November deadline for the pilot. | `06_Client_Email_Extract.md [108,182)` |
| Frequency | Weekly reporting is confirmed; the client wants a finance review before any commercial change is approved. | `02_Client_Kickoff_Notes.md [228,334)` |
| Finance | Finance approval for any revised fee or payment schedule remains pending after this meeting. | `02_Client_Kickoff_Notes.md [338,430)` |

The frequency answer also quotes the earlier proposed cadence as proposed.
Finance also quotes the action-log outstanding approval and steering non-signoff
statements. These are source claims, not a claim that individual accountants
have been identified. A fee proposal or unsigned agreement alone is not accepted
as finance decision support.

## Scope and bounds

`src/requested-fact.ts` recognizes three relation classes, not literal questions:
client/customer requested retained deadlines, report cadence, and finance
approval/signoff status. Its values come only from source sentences. It retains
unknown question modifiers/names/complete opaque IDs as required literal
qualifiers. Explicit foreign finance parties, hypothetical decisions and draft
approvals do not answer client signoff. Ordinary unrelated question routes and
external retrieval-pack policy are unchanged.

The local support lookup scans at most 16 sources / 500,000 canonical characters;
returns at most three distinct complete assertions, 450 characters / 55 words
per assertion and 110 total words. Eligible oversized assertions, scan overflow
or support overflow abstain, rather than silently truncating contrary support.
Confirmed/decision-bearing reporting statements rank before proposals. Different
source values/polarities are exposed as `AMBIGUOUS`, with exact review citations;
they cannot authorize drafts. No document recency is promoted to authority, no
retrieval threshold is lowered and ordinary retrieval top-k stays three.
`requestedChecked` preserves the source-only decision through existing public
and SSE rendering/semantic-rescue boundaries.

This is deliberately a small extractive grammar, not general semantic inference:
unsupported syntax and unbound modifiers can still abstain. Date syntax supports
day-first English month dates and ISO dates. No general promise of record ownership
or accountant/finance identity equivalence is added. Hybrid/fp32 was **not** run:
there is no cached embedding model, and these measurements deliberately use no
model download. Dense/memory/reactive-pressure modules were not edited.

## Verification

- [`red.txt`](red.txt): initial focused HTTP/SSE regression fails on baseline.
- [`red-controls.txt`](red-controls.txt): final regression file run against exact
  original source files (then restored to candidate and rebuilt); failures are
  retained verbatim, not hidden by altering existing tests.
- [`green.txt`](green.txt): final focused regression run, including missing,
  changed, proposed, conditional, wrong-party, unknown modifier/ID, overflow,
  conflicting support, draft denial and actual HTTP/SSE controls.
- [`baseline-bench.json`](baseline-bench.json), [`candidate-bench.json`](candidate-bench.json):
  keyword final-answer needed-fact coverage **26/30 -> 29/30**. Raw retrieval
  rankings are unchanged. All three requested gaps recover. The remaining
  original-pitch-cost question still misses; this patch does not claim 30/30.
  The benchmark's printed "shipping hybrid path" label is its pre-existing
  label; these runs explicitly set `VM_DENSE=off`.
- [`unit-tests.txt`](unit-tests.txt), [`boundary-tests.txt`](boundary-tests.txt),
  [`clinical-tests.txt`](clinical-tests.txt), [`typecheck.txt`](typecheck.txt):
  full local verification logs. Initial `VM_DENSE=off npm test` had two diagnostic
  failures in dense-guard tests because that switch bypasses guard diagnostics.
  The successful rerun uses `env -u VM_DENSE VM_MEMORY_LIMIT_MB=256 VM_RERANK=off
  VM_RSS_WATCHDOG=off npm test`, preventing model loads while testing guards.

No PR exists (as requested), so these are local raw logs, not PR `run_check`
attestations. Rebuild before rerunning after applying the source-only patch.

Final counts: focused **17/17**, boundaries **207/207**, clinical **83/83**,
typecheck and formatting pass. `npm test` with its pre-existing
`--test-force-exit` flag reported 181 passing tests on the last parallel run.
For complete evidence, the identical test list was also run **without** that flag:
[`unit-tests-no-force-exit.txt`](unit-tests-no-force-exit.txt) reports **196/196**,
including all identifier tests. A separate identifier run
([`identifier-tests.txt`](identifier-tests.txt)) passed **49/49**. No existing
test or test-runner flag was changed to obtain these results. The final RED run
has 6 passes / 11 failures; final GREEN has 17 passes / zero failures.
