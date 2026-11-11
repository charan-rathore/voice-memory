# Caller memory

Voice Memory remembers three different things. This document covers the
second, **people**: what a verified caller explicitly asked to be remembered,
kept across calls, corrected and forgotten on request. Conversations (the
current call) are `src/conversation-turn.mjs`; records (versioned document
facts) are the engine, the claim graph and `memory/memory.mjs`.

> A preference changes how an answer is said. It never changes a fact, a
> status, an approval, a source version or an access decision.

## What is stored

Per verified caller, one encrypted record (`memory/caller-memory.mjs`):

| Kind       | What                                                                                     | Kept when                                      | Expires  |
| ---------- | ---------------------------------------------------------------------------------------- | ---------------------------------------------- | -------- |
| preference | `language` (en, hi, hinglish), `answerLength` (short, detailed). Nothing else.            | The caller says "remember ..." with that value | 365 days |
| episode    | Time, the caller's own words, outcome kind and verdict, source scope + version, exact cited spans | The caller consented to conversation memory    | 90 days  |
| referent   | Which document subject an episode was about ("the fee"), bound to its scope              | With its episode                               | 90 days  |
| request    | "Tell me when the fee is approved": open until the caller or an operator closes it       | With conversation consent                      | 90 days  |

Not stored: raw consent utterances, the caller's account id (only a SHA-256
of tenant + account), assistant text, anything from a health scope, any
utterance that contains medical words (the whole utterance is refused, not
sanitised), a caller's claim about the record ("remember the fee was
approved" is refused: the documents decide).

Bounds: 40 episodes, 20 referents, 20 requests, 32 KiB per caller; oldest go
first. Every read purges expired items.

## Identity

`memory/caller-identity.mjs`. A caller is verified only by an assertion the
deploying tenant's backend signs after its own authentication (account login,
OTP, SSO): `vmca1.<kid>.<claims>.<HMAC-SHA256>`, at most 15 minutes, single
use. Refused: caller ID alone (`amr: "ani"`), a phone-number subject, unknown
methods, bad signatures, expired, future-dated and replayed assertions. Only
binding objects produced by `verify()` open memory; a look-alike object built
from request data does not.

`VM_CALLER_DEMO=on` adds a per-process key that signs only two fixed
fictional personas (Asha, Ravi) with `amr: "demo-fictional"`. It is a stand-in
for a tenant backend, not an authentication method.

## Operations

| Operation | API                                                   | Spoken                                  |
| --------- | ----------------------------------------------------- | --------------------------------------- |
| remember  | `POST /api/public/caller/turn`                        | "Remember that I prefer Hinglish"       |
| consent   | same                                                  | "...and remember this conversation"     |
| recall    | `POST /api/public/caller/start` (every new call)      | (automatic)                             |
| correct   | `turn`                                                | "Switch my language to English"         |
| list      | `GET /api/public/caller/memory`, or `turn`            | "What do you remember about me?"        |
| forget    | `POST /api/public/caller/forget` `{all \| preference \| conversation \| id}`, or `turn` | "Forget my language preference", "Forget everything" |

Recall never replays an old answer. Each remembered subject is re-asked
through the same canonical resolver as any typed question, against the
documents as they are now; the result says whether the source version and the
status changed since the earlier call.

Every answer returns three separate sections: **remembered** (what memory
contributed), **verified** (the canonical `final`: kind, verdict, admitted
text, exact citations, source version) and **unresolved** (status not
established, coverage not checked, open requests).

## Configuration

| Variable                        | Effect                                                         |
| ------------------------------- | -------------------------------------------------------------- |
| `VM_CALLER_MEMORY=on`           | Enables `/api/public/caller/*` (off by default)                |
| `VM_CALLER_KEYS`                | JSON `{ "kid": "<64+ hex>" }`: tenant signing keys             |
| `VM_CALLER_DEMO=on`             | Enables the fictional demo issuer (implies the routes)         |
| `VM_DATA_DIR` + `VM_STORE_KEY`  | Durable, AES-256-GCM encrypted storage (else process memory)   |
| `VM_PUBLIC_ORIGIN`              | Allowed `Origin` for writes behind a proxy (e.g. the Vercel site) |

Responses are `Cache-Control: no-store`. Writes need a same-origin `Origin`.
The call cookie is `HttpOnly; SameSite=Strict; Path=/api/public/caller`.

## Honest scope (not production-ready)

- HMAC shared secrets, no key-rotation tooling, no revocation beyond expiry
  and the replay window; the replay window is per process.
- Call sessions are per process (a restart ends calls, not memory).
- Render's free tier has an ephemeral disk: there, memory survives a restart
  only with a persistent disk mounted at `VM_DATA_DIR`.
- Not wired into Bolna voice calls yet: Bolna does not carry a tenant-signed
  caller assertion. The intended wiring is a per-call assertion minted by the
  tenant and passed through the call's server-side context (the same place
  the per-call handle `vm_ws` travels), never a prompt variable.
- Memory confirmations are English only; answers use the preference.
- Medical refusal is a word list (English, Hindi, Hinglish). It refuses
  generously; it is not a classifier and will miss unlisted terms.
- No consent record is shown to an operator; there is no export endpoint.
