# Voice Memory as a controlled knowledge layer

Status: **integration design and transport contract**, not a claim that every vendor adapter is implemented. This document describes the current-facts boundary that a voice platform should use when records can be revised, amended, contradicted, or absent.

## Core decision boundary

Speech-to-text and text-to-speech belong to the voice platform. Voice Memory owns **which facts may be asserted**. It binds a question to one authorized document scope, resolves that scope's current source version, retrieves candidate passages, verifies claims and requested parts, and returns **one canonical result**. A high-ranked retrieved passage never becomes an answer by ranking alone.

The source of truth for the result is `final` from `src/answer-contract.mjs` and the caller-owned question plan from PR #80. For all channels:
- `final.admittedText` is the only document-factual text authorized to be spoken as an answer. If null, speak `final.text` as a refusal/clarification/abstention; do not substitute a search hit, source excerpt, or a suggested completion.
- `final.citations` are admitted source evidence. `final.relatedEvidence` is context only and **never** proof of the answer.
- `final.answeredRequirements` and `final.unresolvedRequirements` distinguish supported parts from missing or ambiguous parts. A supported subanswer does not certify compound completeness.
- `final.scope` identifies the selected document scope and its immutable source version. If the scope changes or expires, reject stale results; do not silently widen to a demo bundle or a different user.
- A document fact may be displayed only if its exact cited line still belongs to the same source version. The voice response and screen response use the same admitted text; translation and paraphrase must not add new claims.
- General educational material, if offered, is visually and structurally separate from document-derived facts. No diagnosis, severity judgement, or treatment advice is part of this integration.

## Proposed current-facts packet

An integration adapter should produce the following **projection of the existing canonical final**. This is a proposed adapter envelope, **not** a claim that a new endpoint already exposes this JSON:

```json
{
  "schemaVersion": "vm-current-facts/1",
  "scope": { "key": "<authorized scope>", "version": "<immutable source version>" },
  "kind": "answered | partial | clarify | refused | abstained",
  "admittedAnswer": "<source-verified text, or null>",
  "speak": "<canonical final.text, never generated from relatedEvidence>",
  "citations": [
    {
      "documentId": "<stable document identity>",
      "title": "<printed source title>",
      "quote": "<exact canonical source line>",
      "location": { "pages": [1], "focus": { "regions": [] } }
    }
  ],
  "answeredRequirements": [],
  "unresolvedRequirements": [],
  "relatedEvidence": [],
  "complete": false
}
```

These placeholder fields describe a shape, not a real patient, validated value, or production answer. Use the actual `final` fields without manufacturing absent citations, scope versions, confidence scores, completeness, or clinical facts. A consumer that cannot preserve this separation should receive only the canonical `speak` string, with citations retained in Voice Memory's own sidecar or screen.

**Cache identity:** cache a verified claim by authorized scope, immutable source revision/hash, claim identity, relevant source spans, verification policy/version, and consent boundary. Do not cache a final answer by normalized question text alone: two similar questions can reverse a negation, identify a different patient, or ask about a revised contract. A source revision invalidates dependent claims. Recheck current scope and revocation at delivery time, including an interrupted call or delayed tool reply. Do not promise persistent cache durability from the current ephemeral server.

## Platform integration map

| Platform | Supported route | Implementation status | Source of platform contract |
| --- | --- | --- | --- |
| **Bolna** | Custom OpenAI-compatible LLM: authenticated `POST /v1/chat/completions`, server-sent streaming, final `data: [DONE]` | **Existing** `src/voice-adapter.mjs` and Bolna agent integration. End-to-end public spoken flow remains subject to live testing. | [Bolna custom LLM](https://www.bolna.ai/integrations/custom-llm) |
| **Vapi** | Custom knowledge-base webhook receives `message.type = knowledge-base-request`. Prefer its direct `custom-message` response for a canonical spoken verdict, rather than passing unadmitted passages to another answer generator. | **Design only**; no Vapi adapter claimed. | [Configure custom knowledge base](https://docs.vapi.ai/knowledge-base/custom-knowledge-base), [request and response shapes](https://docs.vapi.ai/knowledge-base/implement-custom-endpoint) |
| **Retell** | Authenticated **custom function** that calls a bounded current-facts endpoint, or a separate custom-LLM WebSocket adapter with Retell's protocol. Neither is the same as a static KB import. | **Design only**; no Retell adapter claimed. | [Retell custom function integration article](https://www.retellai.com/blog/how-to-integrate-phone-ai-agents-with-your-existing-api-systems), [Retell custom LLM transport](https://www.retellai.com/integrations/custom-llm) |
| **ElevenLabs Agents** | Authenticated **webhook tool** for live claim retrieval. Managed KB/RAG can find candidates, but must not be trusted to override Voice Memory's admission gate. | **Design only**; no ElevenLabs agent adapter claimed. Existing ElevenLabs speech output is a different integration. | [Webhook tools](https://elevenlabs.io/docs/eleven-agents/customization/tools/webhook-tools), [managed knowledge-base RAG](https://elevenlabs.io/docs/eleven-agents/customization/knowledge-base/rag) |

### Bolna (existing)

The custom LLM endpoint already serves OpenAI-shaped chat completions and streaming SSE. Bolna handles ASR, turn-taking and TTS; the Voice Memory transport resolves the authorized bundle and speaks the canonical checked sentence. Its bearer capability and session lifecycle must remain scope-bound. Do not claim an uninterrupted production-quality public call solely from transport tests. Bolna's documentation describes `POST {base_url}/chat/completions`, bearer auth and a `[DONE]` stream terminator.

### Vapi (adapter needed)

Vapi describes a POST containing `message.messages` and `type: "knowledge-base-request"`. Its direct response shape is `{"message":{"type":"custom-message","content":"..."}}`, with a **1,000-character limit** according to its documentation. For a supported factual answer, return canonical `final.text` within that limit (fail closed, never silently truncate an assertion); for null `admittedText`, return the canonical clarification/refusal. Keep source-linked citations in a separate app-readable packet. Vapi's alternative `documents` response allows a downstream model to compose a different claim and therefore requires an independent post-generation verification gate before speech. Configure authentication and verify the provider's webhook signature/secret mode at deployment.

### Retell (adapter needed)

Retell documents custom function HTTP calls and, separately, a custom LLM **WebSocket** protocol. These are **different** integrations: do not point a Retell WebSocket setting at Bolna's HTTP SSE endpoint. A custom function could return a bounded packet as JSON, but model prompting alone cannot guarantee that the final spoken words match the admitted string. An adapter must enforce this contract or defer the call to a dedicated custom LLM transport. Validate `X-Retell-Signature`, scope, timeout, and reentrancy.

### ElevenLabs (adapter needed)

ElevenLabs Agents webhook tools can call authenticated external REST endpoints. Use a `get_verified_record_answer` tool whose reply separates `speak`, `citations`, and `unresolvedRequirements`; do not let the agent treat `relatedEvidence` as answer evidence. Vendor-managed RAG is retrieval, not a substitute for current-version claim admission. If strict typed/spoken equality is required, test the actual agent/tool orchestration, including interruptions and citation display, before claiming it.

## Latency and release qualification

Vendor performance figures are **vendor claims, not measurements of this repo**. For example, [ElevenLabs says](https://elevenlabs.io/docs/eleven-agents/customization/knowledge-base/rag) managed RAG adds **around 250 ms**. This does not measure Voice Memory end-to-end speech latency, cold starts, admission, or source-checking.

Before enabling any provider route: run the same versioned corpus through typed and spoken calls; check exact admitted text, citation spans, clarification and refusal parity, source invalidation, cross-workspace isolation, retries, 429/timeout paths, and interruption. Record p50/p95 first-audio latency separately from retrieval and admission. Any agent that paraphrases unsupported facts, drops an unresolved requirement, or substitutes a stale source is **not qualified**. Keep synthetic fixtures and developer-authored cases labeled as such; they are regression tests, not external accuracy evidence.
