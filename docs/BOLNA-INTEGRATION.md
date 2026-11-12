# Bolna + Voice Memory: the first real voice integration

Status: **built and tested against Bolna-shaped requests; no real Bolna call
has been placed.** The trace in `docs/traces/SIMULATED-bolna-two-calls.md`
is a local replay, labelled as such.

## What Bolna actually provides (checked against Bolna's docs, 11 Nov 2026)

| Fact                                                                                                                                                           | Consequence for Voice Memory                                                                                                                                                                           |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Custom LLM = an OpenAI-compatible chat-completions endpoint, called through the OpenAI SDK.                                                                    | Voice Memory's `/v1/chat/completions` is that endpoint.                                                                                                                                                |
| The only auth header Bolna sends is `Authorization: Bearer <key>` (the key you register for the model).                                                        | One voice key per tenant (`VM_TENANTS.<t>.voiceKey`, 32+ chars). It identifies the tenant, never the caller.                                                                                           |
| No call/execution id, metadata or `user_data` is sent to the custom LLM. `extra_body` is static per agent.                                                     | Per-call identity can only arrive through prompt variables that **your server** sets.                                                                                                                  |
| `POST https://api.bolna.ai/call` accepts `user_data`, substituted into the agent prompt; returns `execution_id`. `POST /call/{execution_id}/stop` ends a call. | Your backend passes `user_data: { vm_call, vm_recall }`.                                                                                                                                               |
| Inbound calls: caller identification is a `GET` with `contact_number`, `agent_id`, `execution_id` (Bearer, 3 s).                                               | A phone number is not identity: `GET /v1/providers/bolna/identify` creates an **unverified** call with no memory until your backend calls `/verify`.                                                   |
| No playback acknowledgement, interruption signal or retry policy is documented.                                                                                | Memory records `delivery: "stream_completed"` only when the whole reply was written to Bolna; a disconnect records nothing; retries are de-duplicated by turn key. Nothing claims the caller heard it. |

## Flow

```
your backend ──(caller signed in: OTP/login)──► sign caller assertion (≤15 min, single use)
your backend ──POST /v1/calls {scope, permissions, caller, applicability}──► Voice Memory
             ◄── callId, providerUserData {vm_call (secret), vm_recall (spoken opener)}
your backend ──POST api.bolna.ai/call {agent_id, recipient, user_data}──► Bolna
Bolna ──POST /v1/chat/completions (Bearer voiceKey; system prompt has vm_call=…)──► Voice Memory
             ◄── streamed answer from the documents that apply to this caller
your backend ──POST /v1/calls/{callId}/end──► token stops working immediately
```

`vm_call` is read only from the **system** message and only under the same
tenant's voice key; it is never spoken (checked by `scripts/bolna-trace.mjs`).
Assistant history is never read into memory.

## Owner-executable checklist (one real call, fictional identity)

Do this on **staging**, never production, with a fictional caller.

1. Staging is up (`docs/deploy/CALLER-MEMORY-RUNBOOK.md`), `/healthz` →
   `callerMemory.storage: "durable"`, deployed SHA recorded.
2. Set `VM_TENANTS` on staging with one fictional tenant, e.g.
   `{"meridian":{"apiKey":"<64 hex>","voiceKey":"<48 hex>","cases":["deal"],"callerKeys":{"k1":"<64 hex>"}}}`.
3. Bolna dashboard → add custom LLM: URL `https://<staging>/v1`, key = the
   `voiceKey`. Create an agent using it.
4. Agent **system prompt** must contain, on its own line:
   `vm_call={vm_call}` and the instruction "Never read internal ids aloud."
   Welcome message: `{vm_recall}` (verify in Bolna that variables are
   substituted in the welcome message; if not, leave it out).
5. On your machine (secrets in env, never in a file you commit):
   `VM_BASE_URL=… VM_TENANT=meridian VM_API_KEY=… VM_CALLER_KID=meridian_k1
VM_CALLER_KEY=… VM_CALLER_SUB=acct-FICTIONAL-1042 BOLNA_API_KEY=…
BOLNA_AGENT_ID=… BOLNA_TO=<your own phone> node
examples/client/bolna-start-call.mjs` (dry run), then add `--live`.
6. Call 1: say "Please remember I prefer Hinglish" is NOT parsed on the
   voice path in this release: set it with
   `POST /v1/calls/{callId}/preferences` and `/consent` from your backend,
   then ask "Was the revised fee approved?". Hang up.
7. `GET /v1/calls/{callId}/memory`: one episode, `delivery:
"stream_completed"`, `scope.version` set. End the call.
8. Call 2 (step 5 again): the opener should be the recall line; ask the
   question again. Check the answer is rechecked, not replayed.
9. Interrupt the agent mid-answer once; check no episode was added for that
   turn. Call `/end`; check the old token no longer answers.
10. Record: Bolna `execution_id`s, `/healthz` commit, the two
    `/memory` responses (redact tokens), first-audio delay you observed.
    Only then can a real-call result be claimed.

## Known gaps (not hidden)

- **Cross-call pronouns on voice.** "Has _it_ been approved now?" as the
  first turn of call 2 is not resolved from memory on the voice path (the
  trace shows the miss). Mitigation: the `vm_recall` opener names the
  subject; the Memory API (`/answer`) works with full questions.
- **"Remember …" by voice** is parsed on the demo route only, not on Bolna
  calls. Set preferences and consent from your backend.
- Call bindings, idempotency keys and the in-flight set are per process:
  run one instance (the staging plan does).
- First-audio latency on a real call has not been measured.
