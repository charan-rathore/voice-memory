// Voice Memory API v1 client. Zero dependencies (Node 18+ / any fetch).
// Every write gets a fresh Idempotency-Key unless you pass one, so a retry
// with the same key is safe. See docs/API-V1.md for the full contract.
import { randomUUID } from "node:crypto";

export class VoiceMemoryError extends Error {
  constructor(status, body) {
    super(body?.error ?? `HTTP ${status}`);
    this.status = status;
    this.code = body?.code ?? null;
  }
}

export class VoiceMemory {
  /** @param {{ baseUrl: string, apiKey: string, fetch?: typeof fetch }} o */
  constructor({ baseUrl, apiKey, fetch: f = globalThis.fetch }) {
    this.base = baseUrl.replace(/\/$/, "") + "/v1";
    this.key = apiKey;
    this.fetch = f;
  }
  async #req(method, path, body, idempotencyKey) {
    const res = await this.fetch(this.base + path, {
      method,
      headers: {
        authorization: `Bearer ${this.key}`,
        "content-type": "application/json",
        ...(method === "GET"
          ? {}
          : { "idempotency-key": idempotencyKey ?? randomUUID() }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new VoiceMemoryError(res.status, json);
    return json;
  }
  /**
   * Start a call. Pass `callerAssertion` (signed by YOUR backend after you
   * authenticated the caller) to enable memory; omit it for an anonymous call.
   * Give `result.providerUserData` to Bolna as `user_data`.
   */
  startCall(
    {
      scope,
      callerAssertion,
      permissions = { recall: true, remember: true, record: true },
      applicability,
      providerRef,
    },
    key,
  ) {
    return this.#req(
      "POST",
      "/calls",
      {
        provider: "bolna",
        scope,
        permissions,
        ...(callerAssertion ? { caller: { assertion: callerAssertion } } : {}),
        ...(applicability ? { applicability } : {}),
        ...(providerRef ? { providerRef } : {}),
      },
      key,
    );
  }
  verifyCaller(callId, callerAssertion, key) {
    return this.#req(
      "POST",
      `/calls/${callId}/verify`,
      { assertion: callerAssertion },
      key,
    );
  }
  context(callId) {
    return this.#req("GET", `/calls/${callId}/context`);
  }
  answer(callId, question, key) {
    return this.#req("POST", `/calls/${callId}/answer`, { question }, key);
  }
  recordTurn(callId, { turnId, question, spoken }, key) {
    return this.#req(
      "POST",
      `/calls/${callId}/turns`,
      { turnId, question, spoken },
      key,
    );
  }
  rememberPreference(callId, key_, value, key) {
    return this.#req(
      "POST",
      `/calls/${callId}/preferences`,
      { key: key_, value, consent: "caller_explicit" },
      key,
    );
  }
  setConversationConsent(callId, on, key) {
    return this.#req(
      "POST",
      `/calls/${callId}/consent`,
      { conversation: !!on },
      key,
    );
  }
  recordRequest(callId, text, key) {
    return this.#req("POST", `/calls/${callId}/requests`, { text }, key);
  }
  memory(callId) {
    return this.#req("GET", `/calls/${callId}/memory`);
  }
  forget(callId, what = { all: true }, key) {
    const q = what.all
      ? "all=1"
      : what.conversation
        ? "conversation=1"
        : `preference=${encodeURIComponent(what.preference)}`;
    return this.#req("DELETE", `/calls/${callId}/memory?${q}`, undefined, key);
  }
  endCall(callId, { revoke = false } = {}, key) {
    return this.#req("POST", `/calls/${callId}/end`, { revoke }, key);
  }
}
