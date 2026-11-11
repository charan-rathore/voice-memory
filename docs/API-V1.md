# Voice Memory API v1 — integration guide

Persistent, controllable memory for voice agents that keeps **what a caller
said** apart from **what the documents say now**.

Status: **Integration ready for fictional/synthetic data. Not production
ready** (see the end of this guide).

## One-minute version

```sh
node examples/client/returning-caller-demo.mjs   # boots a local server, plays 3 calls
```

1. Your backend authenticates the caller (login, OTP, SSO) and signs a
   short-lived **caller assertion**.
2. `POST /v1/calls` → a `callId` (yours) and a secret `callToken`.
3. Start the Bolna call with `user_data: { "vm_call": "<callToken>" }`.
   Your agent's **system** prompt contains `vm_call={vm_call}`. Its custom
   LLM URL is this server's `/v1/chat/completions`, its key your `voiceKey`.
4. Every spoken answer is computed from the documents that apply to this
   caller; completed turns are remembered (with consent) exactly once.
5. Next call: `GET /v1/calls/{callId}/context` returns preferences and every
   remembered subject **rechecked against the documents now**.

## Why not just put memory in the LLM prompt?

A prompt holds whatever text you put in it, so a past conversation and a
current fact look the same to the model. A caller who said "it was
approved" or a stale answer from last month becomes indistinguishable from
the record. Voice Memory keeps four kinds of data apart, re-derives facts
on every call, and never lets the first kind change the second:

| Type                       | Who writes it                         | Can change a fact? |
| -------------------------- | ------------------------------------- | ------------------ |
| Caller preferences         | The caller, explicitly                | Never              |
| Verified documentary facts | Recomputed from documents per request | —                  |
| Conversation events        | Committed turns (+ what was spoken)   | Never              |
| Open requests / promises   | The caller; closed by caller/operator | Never              |

## Authentication and identity

- **Tenant API key** (`Authorization: Bearer <apiKey>`) on every `/v1` call.
- **Caller identity** is a tenant-signed assertion,
  `vmca1.<kid>.<base64url claims>.<base64url HMAC-SHA256>`, claims
  `{ v:1, ten, sub, name?, amr, iat, exp, jti }`: at most 15 minutes, single
  use, `amr ∈ account-login | otp | sso`. A phone number is never a `sub`;
  caller ID alone (`amr: "ani"`) is refused. Your key can only sign for your
  tenant. Sign with `createCallerIdentity(...).issue()` from
  `memory/caller-identity.mjs`, or reimplement: HMAC-SHA256 over
  `vmca1.<kid>.<claims>`.
- **Inbound calls:** configure Bolna caller identification to
  `GET /v1/providers/bolna/identify` (Bearer = your API key). It returns
  `vm_call`, `vm_call_id`, `vm_caller_verified: "no"`. The call has **no
  memory** until your backend calls `/verify` after its own check.

## Conventions

- `Idempotency-Key` header (1–80 chars `[A-Za-z0-9._:-]`) is **required on
  every POST/DELETE**. A repeat returns the first response with
  `Idempotent-Replay: true` (24 h window, per process).
- Rate limit per tenant (`ratePerMinute`, default 120) → `429 rate_limited`.
- Errors: `{ "error": "...", "code": "..." }`. Common codes:
  `unauthenticated` 401, `caller_unverified` 403, `not_permitted` 403,
  `tenant_mismatch` 403, `unknown` 404, `ended`/`revoked` 409,
  `unavailable` 503 (storage fault; nothing was changed).
- Every write and every answer returns a **receipt**, signed with the
  server's private **Ed25519** key (`VM_RECEIPT_KEY`, 64-hex seed; else
  derived from `VM_STORE_KEY`; else ephemeral and flagged so). Schema
  `vm-receipt/2`: `{ id, op, tenant, callId, requestId, callerRef, at,
  apiVersion, scope: { case, sourceVersion, appliedDocuments },
  questionDigest, answerDigest, citations: [{ title, start, end,
  quoteDigest }], outcome: { kind, verdict, coverage, unresolved }, schema,
  kid, signature }`. Digests are SHA-256 of the NFC-normalised UTF-8 text;
  the signature covers the canonical JSON (sorted keys, no whitespace)
  without `signature`. Public keys: `GET /v1/receipts/keys` (no auth).
  Verify anywhere: `node scripts/verify-receipt.mjs receipt.json key.pem
  --question "..." --answer "..." --quote "..."`. `callerRef` is
  non-reversible, never the account id.
- **What a receipt proves, and what it does not.** It proves that Voice
  Memory's server signed this outcome for this tenant, call, request,
  source version, applied documents, question, answer and cited spans at
  this time. It does not prove that the agent spoke it, that the caller
  heard it, or that anyone made a valid decision. It is not a billing,
  legal or non-repudiation instrument. A server operator holding the
  private key can sign anything; keep the key out of the tenant's reach.

## Endpoints

### `POST /v1/calls`

```json
{
  "provider": "bolna",
  "scope": { "case": "insurance" },
  "permissions": { "recall": true, "remember": true, "record": true },
  "caller": { "assertion": "vmca1...." },
  "applicability": { "policyIssuedOn": "2025-09-14" },
  "providerRef": "optional, e.g. your call id"
}
```

`201` → `{ call: { callId, tenant, provider, scope, permissions, verified,
state, createdAt, expiresAt, callToken }, providerUserData: { vm_call },
receipt }`. Without `caller`, all permissions are `false`. The token must be
used within 15 minutes and lives at most 2 hours.

`applicability` is **your verified account data** that decides which
document set applies (here: the policy issue date). Missing ⇒ the agent is
told to ask, never to guess.

### `POST /v1/calls/{callId}/verify` — `{ "assertion": "..." }`

Binds a verified caller to an inbound call. Refused if the call is already
bound to a different caller or tenant.

### `GET /v1/calls/{callId}/context` (needs `recall`)

```json
{
  "preferences": { "language": { "value": "hinglish", "createdAt": "...", "updatedAt": "...", "expiresAt": "...", "revision": 1, "source": "caller_explicit" } },
  "consent": { "preferences": {...}, "conversation": {...} },
  "rechecked": [{
    "subject": { "id": "policy.windscreen_excess", "label": "your windscreen excess" },
    "previously": { "at": "...", "question": "...", "verdict": "QUOTED", "sourceVersion": "...", "applied": "insurance-2025" },
    "sourceChanged": false, "statusChanged": true, "applicabilityChanged": true,
    "verified": { /* as in /answer */ }
  }],
  "requests": [{ "id": "r3", "text": "...", "status": "open" }],
  "durable": true
}
```

### `POST /v1/calls/{callId}/answer` — `{ "question": "..." }`

```json
{
  "verified": {
    "kind": "answered", "verdict": "QUOTED",
    "say": "The windscreen excess is ₹2,500 per claim. That's from 01 DriveSure Wording 2026. ...",
    "text": "The windscreen excess is ₹2,500 per claim.",
    "clarification": null,
    "citations": [{ "sourceId": "...", "title": "01_DriveSure_Wording_2026.md", "start": 0, "end": 420, "quote": "..." }],
    "coverage": "unverified",
    "scope": { "case": "insurance", "sourceVersion": "...", "appliedDocuments": "insurance-2026", "applicabilityRule": "..." }
  },
  "changedSince": { "previously": {...}, "sourceChanged": true, "applicabilityChanged": true, "statusChanged": true, "why": "A different document set now applies ..." },
  "receipt": { "op": "answer", "detail": { "appliedDocuments": "...", "verdict": "...", "sources": [...] }, "...": "..." }
}
```

Speak `say` verbatim, or nothing. `text: null` + `clarification` means ask
the caller; do not answer. `coverage: "unverified"` means the question was
not proven to be fully covered: keep it on screen; it need not be spoken
every turn.

### `POST /v1/calls/{callId}/turns` (needs `record`)

`{ "turnId": "t-1", "question": "...", "spoken": "what your agent said" }` →
`{ recorded, episode, receipt }`. Exactly once per `turnId`. The verdict is
**recomputed server-side**; `spoken` is stored only as what was said. Needs
conversation consent. Calls bound through `vm_call` record committed turns
automatically; do not also post them.

### `POST /v1/calls/{callId}/preferences` (needs `remember`)

`{ "key": "language", "value": "hinglish", "consent": "caller_explicit" }`.
Allowed: `language ∈ en | hi | hinglish`, `answerLength ∈ short | detailed`.
Anything else (and anything medical) is refused. Changing the value is a
correction: the old value is not kept.

### `POST /v1/calls/{callId}/consent` — `{ "conversation": true | false }`

`false` revokes and **deletes** episodes, referents and requests.

### `POST /v1/calls/{callId}/requests` — `{ "text": "Tell me when it's approved" }`

Recorded as `open`. An answer never closes it.

### `GET /v1/calls/{callId}/memory` · `DELETE /v1/calls/{callId}/memory`

`DELETE` with `?all=1` | `?conversation=1` | `?preference=<key>`. Hard delete,
including the encrypted file for `all`.

### `POST /v1/calls/{callId}/end` — `{ "revoke": false }`

The `callToken` stops working immediately.

## Bring your own memory store

`createCallerMemory({ identity, store })` takes any object with
`save(namespace, value)`, `load(namespace) → value | null` (throw on an
unreadable record; never return `null` for it) and `remove(namespace)`.
Encrypt before handing data to a shared database. The default is the
encrypted file store (`memory/caller-store.mjs`). Contract tests:
`tests/caller-memory-durable.test.mjs`.

## Measured latency (local, not a real call)

`node scripts/measure-latency.mjs 60` on the fictional Harborline tenant
(two short documents per wording), loopback, warm, one process, Node 22,
answer cache off (`VM_CACHE_MAX=0`):

| Step                                         | p50 ms | p95 ms |
| -------------------------------------------- | -----: | -----: |
| call start (identity verify + binding)       |    0.8 |    1.0 |
| memory recall (1 subject rechecked)          |    2.0 |    3.6 |
| source-verified answer                       |    2.2 |    3.5 |

These exclude the network, telephony, speech recognition and synthesis, and
reflect a tiny corpus. The voice-turn timings the script prints for a
repeated question are not evidence (the voice path has its own caching).
**First spoken audio and total turn time have not been measured on a real
Bolna call.**

## Status

| Level                 | Meaning                                                    | Today |
| --------------------- | ---------------------------------------------------------- | ----- |
| **Demo ready**        | `/calls.html` simulated two-call demo with fictional data  | Yes, once staging is created and `VM_CALLER_DEMO=on` |
| **Integration ready** | A developer can integrate a fictional tenant and caller    | Yes, locally and on staging (this API, example client, tests) |
| **Production ready**  | Real callers, real data, operated                          | **No.** Missing: a real Bolna call test, multi-instance state (bindings, idempotency and replay windows are per process), key rotation, a deletion log for snapshot restores, admin export, monitoring, a security review, legal/consent review for your jurisdiction |
