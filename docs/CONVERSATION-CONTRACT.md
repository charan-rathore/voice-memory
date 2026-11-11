# Conversation contract

One deterministic turn pipeline for typed and voice turns:
`src/conversation-turn.mjs`. The record still decides every fact; this layer
decides only what the caller is asking, which subject and dimension that
needs, and what may be remembered.

> The record decides factual answers. Voice Memory may clarify what you mean,
> but it only states what the documents support.

## Why it exists

Before this change the two paths diverged:

- **Typed** (`src/server.mjs`): `spokenTurn` with a `prevField`, then the
  semantic router (`src/semantic/route.mjs`) and the final intent audit
  (`src/semantic/intent.mjs`).
- **Voice** (`src/voice-adapter.mjs`): `selfRepair` → `repairRecordTerms` →
  `voiceQuestions` (joins earlier user utterances into candidate questions) →
  a regex follow-up test → `socialTurn` → `splitMixed` / `glossHindi` →
  `spokenTurn`, with one sticky `grant.lastField` as memory and a regex that
  deletes previously spoken generic sentences after the fact.

Short or ambiguous utterances therefore inherited whatever the last field was,
or were joined with older questions, and the answer could be a restated prior
fact. There was no structured notion of "which earlier turn does this refer
to", no clarification state, and no rule for what an interrupted answer means.

## Input

```js
resolveConversationTurn(
  {
    utterance,       // latest user utterance only
    callId,          // stable call/session identity
    utteranceId,     // transport id; a second delivery is a duplicate
    sourceVersion,   // immutable bundle version
    mode,            // "typed" | "voice" (presentation only)
    event,           // "barge_in" drops the staged answer
    records: {       // the record bundle's interface
      vocabulary,    // [{ id, label, aliases }]
      resolve(req),  // -> answered | ambiguous | unanswered
    },
  },
  priorState,        // server-owned; never built from request text
)
```

Assistant messages in a request are never read. "Say that again" repeats only
an answer this server committed for this call and source version.

## Output

```js
{
  turnId, callId, sourceVersion, mode,
  outcome,  // answered | clarify | abstain | repeat | interrupted | scope_changed | duplicate
  understanding: {
    intent,            // lookup | why | history | compare | status | repeat | social
    subject,           // vocabulary id, or [ids] for a multi-part question
    dimension,         // value | reason | history | change | status | clarify | ...
    followUp, referencedTurnId,
    confidence, needsClarification,
    changedMeaning,    // show "Heard / Understood as" only when true
    heard, understoodAs,
    modelUsed: false,
  },
  answer: {
    spoken,            // voice: complete factual text; never silently clipped
    screen,            // full text
    verdict, citations, factIds,
    fingerprint,       // subject + dimension + fact ids + source version
    complete,          // false when any part of the question is unsupported
    novelty,           // fresh | compact | new_dimension | repeat | shorter | social
    notice,
  },
  conversationDelta: {
    carry,             // the structured memory this turn adds (record turns only)
    expire,            // e.g. ["pending_clarification"], ["all_prior_turns"]
  },
}
```

`duplicate` is an addition to the outcome list in the original brief: a second
delivery of one utterance returns no answer and commits nothing.

## Order of resolution

1. Bind state to the call and source version. A new call, or a new source
   version, starts from empty state (old fact references are invalid).
2. Duplicate delivery check (`utteranceId`).
3. Normalise once: record IDs ("S Y N zero zero zero three" → `SYN-0003`) and
   self-correction ("creatinine, sorry, ferritin" → ferritin).
4. Frame: social, explicit repeat (and "shorter"), subjects, record ID,
   dimension cue (why / before / change / status / value), follow-up cue.
5. Outstanding clarification: only its answer resolves it (an offered ID, or
   one of the offered subjects). A direct new subject overrides it.
6. Direct subject, else a follow-up referent, else a short clarification in the
   caller's language. Clarification examples come from the bundle's own
   vocabulary, never the demo's.
7. The record interface, part by part. `ambiguous` becomes a clarification
   listing the candidates (never a silent choice). An unsupported part keeps
   `complete: false`.
8. Novelty (below).
9. Stage the turn. The server commits it with `commitConversationTurn` only
   once its response stream has been fully produced; `completed: false`
   (stream abandoned) drops it. Production is the boundary the transport
   attests - it does not establish that the caller heard the answer.

## Referents

- "Why?" refers to the last record turn when that turn was a change, status,
  reason or history answer. If the last two record turns name different
  subjects and the last was a plain value, the caller is asked which.
- "And before that?" resolves only when the record marked the last answer as
  part of a temporal sequence (`temporal: true`); otherwise the caller is asked.
- Other bare follow-ups ("was it approved?", "is that normal?") take the last
  record subject with their own dimension.
- Interrupted, abandoned or duplicate turns are never referents.

## Novelty

| Situation                                | Behaviour                                                                                                 |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| "Say that again"                         | The last committed record answer, word for word, no record call                                           |
| "Say that again, shorter"                | Its opening, at least four words ("No." alone is never a short answer)                                    |
| Same subject, same dimension, same facts | One compact answer: the self-contained opening plus sentences carrying a value, unit, refusal or status   |
| Same subject, new dimension              | Sentences already heard are dropped, except corrections, refusals, unit, identity and status distinctions |
| New fact for a subject                   | Full answer (the fingerprint changed)                                                                     |

A shorter repeat must retain later corrections, units and status caveats; if
there is no safe shorter sentence, the full answer is repeated. Partially
answered and compound record turns are not valid implicit referents: vague
follow-ups need clarification.

## State lifecycle and bounds

- Per call: at most `maxTurns` (8) committed turns and `maxBytes` (16 KiB);
  oldest turns are dropped first. At most `maxSeen` (32) utterance ids.
- One outstanding clarification at a time. Social turns and repeats keep it;
  any other completed turn clears it.
- Source version change: all turns and pending clarification expire.
- Caller change: a different `callId` never reads another call's state.
- Workspace expiry: the voice route forgets the call's state.

## Voice route wiring (shadow mode)

`src/conversation-shadow.mjs` runs the contract on every spoken Bolna turn in
`createVoiceAdapter().handle()`:

- state per call, keyed by the call handle (or the per-call capability). Only a
  SHA-256 digest of the key appears in turn ids, so a bearer never reaches
  the page. The fixed shared bearer without a call handle gets no state.
- at most 64 calls held per adapter; workspace expiry forgets the call.
- the record interface replays the answer the existing engine produced, so
  facts still come from the engine.
- the result is attached to `onTurn(...).conversation` and returned by
  `adapter.lastConversation(token)`. Nothing spoken changes.
- **Shadow's `completed: true` means response emission only**. This is not
  a Bolna audio-delivery acknowledgement; playback could be cut off. Never
  use shadow-committed memory as proof of a heard answer at cut-over.

Each observation reports `decision: { legacy, contract }` and `diverges`. The
first known divergence: on a noise fragment ("uh"), the legacy path says "I
couldn't establish that from these documents" where the contract asks a short
question.

## Cut-over status

Done (see `OWNER_EXPLAINER.md`):

- **Factual authority.** The canonical resolver (`resolveAnswer`) answers
  spoken requests by default, as it answers typed ones. Evidence: with it
  forced on, the evaluation, boundary and vault suites had no new failure
  against `main`. `VM_SHARED_VOICE_REASONING=off` is an operator rollback.
- **Admission.** One request admission (`admitRequest`) for both routes, and
  for answers the adapter still renders itself.
- **Contract on the call's screen feed.** Each spoken turn carries the
  canonical answer contract (`contract`).
- **The contract's reading on the plan.** `preview()` reads follow-up,
  referenced turn and self-correction before an answer exists; it rides on
  `questionPlan.followUp`.

Not done:

1. **Referent resolution.** The adapter's existing chain still decides what a
   follow-up refers to (`voiceQuestions` joining, the follow-up test,
   `grant.lastField`). The contract observes it (`conversation.diverges`).
2. To finish: build `records.resolve` over the canonical resolver; give the
   contract patient and date inheritance and the Hindi paths; collect
   divergence on real calls; switch; then delete the chain above and the
   post-hoc sentence removal.

## API changes (additive)

- `createVoiceAdapter().lastConversation(token)`: new.
- `onTurn(token, payload)`: `payload.conversation` added.
- New modules: `src/conversation-turn.mjs`, `src/conversation-shadow.mjs`.
- `final.admittedText`, `final.answeredRequirements`,
  `final.unresolvedRequirements`, `final.scope`; `final.relatedEvidence` is
  always an array.
- `questionPlan.request`, `questionPlan.scope`, `questionPlan.followUp`;
  requirement `slots` may be filled by the closed grammar.
- `onTurn(...).contract` and `contract` on each `/api/public/voice/turns` entry.
