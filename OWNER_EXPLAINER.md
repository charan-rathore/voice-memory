# Owner explainer: from a question to an admitted answer

Plain-language map of the path every question takes, typed or spoken, and
which module owns each step. Written for the person who has to decide whether
a change is safe.

Two sentences carry the whole design:

- Voice Memory may clarify what the caller means.
- The record decides factual answers.

## 1. The original question becomes a question plan

`src/question-plan.mjs` · `questionPlan(...)`

The server builds one plan per request, for typed and spoken requests alike
(`resolveAnswer` in `src/server.mjs`). The plan is frozen and holds:

| Field                     | What it is                                                                                                   | Who may change it                                |
| ------------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------ |
| `originalQuestion`        | The caller's words, byte for byte                                                                            | Nobody                                           |
| `requirements`            | One requirement: the whole question. Compound wording is never split by guesswork                            | Nobody                                           |
| `requirements[0].slots`   | actor, relation, action, object, polarity, version, status, expected answer type; `null` when not recognised | Only the closed grammar below                    |
| `request`                 | The same reading in one place: relation, polar, negated, version, statusAsked, amounts                       | Only the closed grammar                          |
| `scope`                   | `{ key, version }`: the document scope and its immutable source version                                      | The server                                       |
| `followUp`                | The conversation contract's reading: referenced turn, subject, self-correction                               | The conversation contract                        |
| `normalizationCandidates` | A repaired transcript, a history-joined retrieval query, or a model rewrite                                  | Recorded only; never replaces `originalQuestion` |

The slots come from `requestOf(question)` in `src/semantic/intent.mjs`, a
closed grammar over **one clause**:

- a requested relationship: "Who pays X?", "Was X approved by Y?",
  "Does A sign X?" (families: pay, approve, sign, own, propose, request);
- polarity: a yes/no question that is negated ("Is it not approved?");
- a version qualifier: first / previous / latest, and proposed vs approved;
- amounts named in the question.

A question the grammar does not fully consume (a compound, a condition, a
time in place of a party) gets **no** relation. Unknown stays unknown.

A model rewrite can help retrieval under the existing consent, cost and
latency rules. It is stored as a candidate. It cannot become the request.

## 2. Evidence is retrieved, then admitted

Order inside `resolveAnswer`:

1. **Deterministic routes first.** Exact fields and tables, clinical
   comparisons and identity safety, the claim graph for status and authority
   (`src/spoken.mjs`, `src/record-facts.mjs`, `src/exact-field-admission.mjs`,
   `src/event-admission.mjs`, `clinical/*`). Unchanged by this work, except
   two narrow repairs noted below.
2. **Paraphrase retrieval** when those have nothing: BM25 and, where enabled,
   dense retrieval over sentence units, inside the request's scope
   (`src/paraphrase.mjs`, `src/semantic/route.mjs`).
3. **Request admission** (`admitRequest` in `src/answer-admission.mjs`), new.
   It runs once, after the answer cache, for both routes. It checks the
   answer against the plan's `request`:
   - **Relationship.** Candidate sentences come from the existing BM25 units
     plus what the answer already cites. `relationSupport`
     (`src/semantic/verify.mjs`) accepts a sentence only if it asserts the
     relation with a named party (not negated, not conditional, not pending)
     **and** names the asked object, **and** no other sentence in the
     current documents denies, withdraws or leaves that relation pending
     for the same object. A bare role field such as
     `Approved by: Priya Nair` is a recorded observation, not an event, and
     is never taken as support here; the existing field route reports those
     with their own caveat.
   - **Polarity.** A negated question is never met with a bare "Yes." or
     "No."; the record's statement stands on its own.
4. **Whole-question coverage** (`src/whole-question-coverage.mjs`), unchanged:
   an asserting answer whose plan is opaque says, in words, that coverage is
   not verified. Naming an unaddressed part still requires a qualified
   decomposition.
5. **The answer contract** (`finalAnswer` in `src/answer-contract.mjs`).

Request admission never writes a fact. Every sentence it admits is a literal
source span with an exact citation.

## 3. What each changed module owns

| Module                        | Owns                                   | Changed how                                                                                                                                                |
| ----------------------------- | -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/semantic/intent.mjs`     | Reading the question's cues            | Added `requestOf`, the closed grammar, `RELATIONS`                                                                                                         |
| `src/semantic/verify.mjs`     | Verifying claims against source text   | Added `assertedAgent`, `relationSupport`, `mentionsRelation`, `deniesRelation`                                                                             |
| `src/question-plan.mjs`       | The caller-owned plan                  | Slots from the grammar; `request`, `scope`, `followUp`. Requirement ids are unchanged                                                                      |
| `src/answer-admission.mjs`    | The shared admission contract          | Added `admitRequest`                                                                                                                                       |
| `src/answer-contract.mjs`     | The one definition of "the answer"     | Added the request view (below)                                                                                                                             |
| `src/source-version.mjs`      | Source identity                        | Added `sourceVersionOf(bundle)`                                                                                                                            |
| `src/server.mjs`              | Orchestration                          | Plan carries scope and follow-up; admission after the cache; the canonical resolver is the default for voice; the call's screen feed carries the contract  |
| `src/voice-adapter.mjs`       | Bolna-shaped transport                 | Compound requests go whole to the resolver; local answers pass the same admission; each turn logs its contract; the conversation reading rides on the plan |
| `src/conversation-shadow.mjs` | Conversation contract beside the route | Added `preview` (reads committed state, commits nothing)                                                                                                   |
| `src/spoken.mjs`              | Claim-graph wording                    | History answers use earlier-dated claims when an approved record exists; "latest proposed" names the last proposal and the approval after it               |
| `src/event-admission.mjs`     | The explicit event language            | A bare determiner is not an object ("Who approved the" is not a question)                                                                                  |
| `src/public-api.mjs`          | Public payload                         | `final` exposes the request view                                                                                                                           |

## 4. Answer, partial answer, clarification, refusal, related evidence

`final.kind` is the outcome. The request view says why.

| Situation                                                                                            | `kind`         | What the caller gets                                                                                                                    |
| ---------------------------------------------------------------------------------------------------- | -------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| The record states the answer                                                                         | `answered`     | The answer, with exact citations. If the plan is opaque, the coverage notice                                                            |
| A relationship is asked and a source sentence states it                                              | `answered`     | That sentence verbatim, its source, one citation. What the earlier value answer cited moves to `relatedEvidence`                        |
| The answer itself reports the event's status but no source names the party                           | `partial`      | The status, then "These documents don't name the approver." `complete: false`, the requirement listed as unsupported                    |
| The record denies the event ("not approved")                                                         | unchanged kind | The status, then "No approval is recorded, so there is no approver to name."                                                            |
| The documents state it and then take it back ("That approval was withdrawn")                         | `abstained`    | "The documents state this and then take it back, so it is not established." Both sentences under `relatedEvidence`                      |
| A certified operation already recorded "not established" (the explicit event language, exact fields) | unchanged      | That finding stands. It is replaced only by a sentence asserting exactly the asked relation, and for "did A do X?" only when it names A |
| Two sentences name different parties                                                                 | `answered`     | Both, each with its source. Neither is picked                                                                                           |
| The asked person, record or patient is ambiguous                                                     | `clarify`      | One short question listing the candidates. Never the majority or nearest one                                                            |
| An excerpt is relevant but does not establish the claim                                              | `abstained`    | "These documents don't state who ...", no citations, the excerpts under `relatedEvidence`                                               |
| Nothing relevant                                                                                     | `abstained`    | The plain abstention, nothing cited                                                                                                     |
| Advice, another case, an identifier that binds to no record                                          | `refused`      | The existing refusals, unchanged                                                                                                        |

Per requirement, one of three outcomes: `supported`, `unsupported`,
`unresolved` (needs a clarification). They appear as
`final.answeredRequirements` and `final.unresolvedRequirements`.

`final` (all additive):

```
kind, verdict, text, citations            (existing)
coverage, complete                        (existing)
admittedText             the admitted answer text, or null
answeredRequirements     [{ requirementId, text, outcome: "supported", reason }]
unresolvedRequirements   [{ ..., outcome: "unsupported" | "unresolved", reason }]
relatedEvidence          always an array; never mixed into citations
scope                    { key, version }
```

## 5. How typed and spoken stay aligned

- **One resolver.** The Bolna route calls the same `resolveAnswer` the typed
  route calls. It was opt-in (`VM_SHARED_VOICE_REASONING=on`); it is now the
  default. `=off` remains as an operator rollback only.
- **One admission.** `admitRequest` runs inside that resolver. An answer the
  adapter renders itself (a standalone adapter with no server, or the
  mixed-domain demo orchestration) passes the same function before it is
  spoken.
- **One contract on both screens.** The typed response returns `final`. Each
  spoken turn carries `contract` on `/api/public/voice/turns`, with the same
  kind, verdict, coverage, requirement outcomes and exact citation spans.
  `evaluation/canonical-question-plan.test.mjs` compares the two.
- **One plan shape.** Both routes build the plan from the caller's own words;
  the adapter's repaired or history-joined query is only a candidate.

## 6. What is deliberately not done here

- **Conversation referents are not cut over.** Which earlier turn "it" means
  on a call is still resolved by the adapter's existing chain. The
  conversation contract reads each turn and its reading rides on the plan
  (`followUp`), but it does not yet select the subject. Cutting that over
  needs the contract to carry patient and date inheritance and the Hindi
  paths the existing chain has, and real-call divergence data.
- **Compound questions are not split.** By design: a split guessed from
  wording was rejected in earlier work and is pinned by tests.
- **Relation statements are not ranked by authority.** If a signed agreement
  and a later amendment name different payers, both are shown with their
  sources. Supersession between relation sentences is future work.
- **A quoted relation sentence does not establish coverage.** A denial or
  withdrawal about the same object is caught; a condition phrased without
  those cues ("ratification is expected next quarter") is not. Coverage
  stays "unverified" and is disclosed.
- **"Who approved X?" over ordinary prose is still often refused.** The
  explicit event language consumes that wording first and abstains unless a
  sentence asserts it exactly. That is the safer side and it is pinned.
- **The grammar is small and English.** Six relation families. Hindi and
  Hinglish relation questions fall through to the existing behaviour.
