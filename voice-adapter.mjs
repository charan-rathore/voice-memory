/** OpenAI-compatible streaming contract for a future Bolna custom LLM.
 * Disabled unless explicitly instantiated by a caller. No public listener,
 * credential creation, account configuration or real calls in this module.
 * Each opaque bearer capability binds ONE server-owned bundle. Request body,
 * messages, model and user_data can never select another bundle.
 */
import { randomBytes } from "node:crypto";
import {
  answer,
  answerFromRetrieval,
  draft,
  validateEvidence,
} from "./dist/engine.mjs";
import { spokenTurn, historyField } from "./spoken.mjs";
export function createVoiceAdapter({
  ttlMs = 120000,
  now = () => Date.now(),
  retrieval = null,
  bodyTimeoutMs = 5000,
  hardTtlMs = null,
  hardExpiresAtMs = null,
} = {}) {
  if (
    !Number.isSafeInteger(ttlMs) ||
    ttlMs < 1 ||
    !Number.isSafeInteger(bodyTimeoutMs) ||
    bodyTimeoutMs < 1 ||
    bodyTimeoutMs > 30000 ||
    (hardTtlMs !== null &&
      (!Number.isSafeInteger(hardTtlMs) || hardTtlMs < 1)) ||
    (hardExpiresAtMs !== null &&
      (!Number.isSafeInteger(hardExpiresAtMs) || hardExpiresAtMs < 1)) ||
    (retrieval !== null &&
      (typeof retrieval.retrieve !== "function" ||
        !["keyword", "dense", "hybrid"].includes(retrieval.actualMode) ||
        (retrieval.actualMode !== "keyword" && !retrieval.embeddingModel)))
  )
    throw Error("Invalid voice adapter config.");
  const grants = new Map();
  // Operator-provided (fixed) credentials get a durable record that survives
  // grant release: bundle binding, immutable hard expiry, retirement.
  const credentials = new Map();
  const admit = (token) => {
    const cred = credentials.get(token);
    if (cred) {
      if (cred.retiredAt !== null || now() >= cred.hardExpiresAt)
        return { status: 401 };
      let grant = grants.get(token);
      if (!grant || grant.expires <= now()) {
        // Rebind at admission: the credential, not the owner session, owns
        // the bundle; a lapsed or swept grant is recreated here.
        const generation = cred.generation + 1;
        cred.generation = generation;
        grant = {
          bundle: cred.bundle,
          expires: Math.min(now() + ttlMs, cred.hardExpiresAt),
          last: null,
          sequence: 0,
          generation,
          lastAdmission: now(),
        };
        grants.set(token, grant);
      } else {
        // Renewable lease: each authorized turn extends up to the hard cap.
        grant.expires = Math.min(now() + ttlMs, cred.hardExpiresAt);
        grant.lastAdmission = now();
      }
      return { grant };
    }
    const grant = grants.get(token);
    if (!grant || grant.expires <= now()) {
      grants.delete(token);
      return { status: 401 };
    }
    grant.lastAdmission = now();
    return { grant };
  };
  return {
    bind(bundle, provided) {
      const token = provided ?? randomBytes(32).toString("hex");
      if (typeof token !== "string" || token.length < 32)
        throw Error("Invalid voice capability.");
      // An operator-provided (fixed) capability is a singleton: binding it
      // while a grant is LIVE would silently retarget live callers to another
      // session's documents. An EXPIRED grant is a lapsed liveness artifact,
      // not a revocation: sweep it and allow rebind. Revocation removes the
      // grant entirely, and the server retires a revoked fixed credential
      // separately, so this never resurrects a retired capability.
      const existing = grants.get(token);
      if (existing && existing.expires > now())
        throw Error("Voice capability already in use.");
      if (provided) {
        const prior = credentials.get(token);
        if (prior && prior.retiredAt !== null)
          throw Error(
            "Voice capability was retired. It cannot rebind in this deployment.",
          );
        const hardExpiresAt =
          prior?.hardExpiresAt ??
          hardExpiresAtMs ??
          (hardTtlMs !== null ? now() + hardTtlMs : Number.MAX_SAFE_INTEGER);
        if (now() >= hardExpiresAt)
          throw Error("Voice capability has passed its hard expiry.");
        const generation = (prior?.generation ?? 0) + 1;
        credentials.set(token, {
          bundle,
          hardExpiresAt,
          retiredAt: null,
          generation,
        });
        grants.set(token, {
          bundle,
          expires: Math.min(now() + ttlMs, hardExpiresAt),
          last: null,
          sequence: 0,
          generation,
          lastAdmission: now(),
        });
        return token;
      }
      grants.set(token, {
        bundle,
        expires: now() + ttlMs,
        last: null,
        sequence: 0,
        generation: 0,
        lastAdmission: now(),
      });
      return token;
    },
    // Explicit revocation sticks: for an operator-provided credential this
    // retires the credential itself, so admission cannot silently rebind a
    // revoked capability. Session cleanup must use release()/releaseIdle().
    revoke(token) {
      grants.delete(token);
      const cred = credentials.get(token);
      if (cred) cred.retiredAt = now();
    },
    // Session cleanup (sweep/eviction): release the grant, never the
    // credential. A stale generation observed before a rebind is a no-op.
    release(token, generation) {
      const g = grants.get(token);
      if (!g) return;
      if (generation !== undefined && g.generation !== generation) return;
      grants.delete(token);
    },
    // Sweep/eviction guard: a grant with admission activity inside idleMs is
    // treated as a live call and left alone.
    releaseIdle(token, idleMs, generation) {
      const g = grants.get(token);
      if (!g) return;
      if (now() - (g.lastAdmission ?? 0) < idleMs) return;
      this.release(token, generation);
    },
    // Owner re-import: atomically retarget a fixed credential to the new
    // bundle. The old grant is dropped (any generation), so in-flight
    // old-generation requests reject at the next recheck instead of
    // answering from the stale corpus, and the next admission rebinds to
    // the new bundle. Never resurrects a retired credential and never
    // extends past the pinned hard expiry.
    retarget(token, bundle) {
      const cred = credentials.get(token);
      if (!cred || cred.retiredAt !== null || now() >= cred.hardExpiresAt)
        return false;
      cred.bundle = bundle;
      grants.delete(token);
      return true;
    },
    // Explicit owner revocation. Process-local tombstone: an instance
    // restart forgets it, so leaked-credential rotation is redeploy-with-new-
    // value (the server's runbook couples retire + rotate as one action).
    // Within a process it is permanent - rebind always refuses.
    retire(token) {
      const cred = credentials.get(token);
      if (cred) cred.retiredAt = now();
      grants.delete(token);
    },
    grantGeneration(token) {
      return (
        grants.get(token)?.generation ??
        credentials.get(token)?.generation ??
        null
      );
    },
    isBound(token) {
      const grant = grants.get(token);
      return !!grant && grant.expires > now();
    },
    async handle(req) {
      const bearer =
        req.headers.get("authorization")?.replace(/^Bearer /, "") || "";
      if (req.method === "GET") {
        if (new URL(req.url).pathname !== "/v1/models")
          return Response.json(
            { error: "Method not allowed" },
            { status: 405 },
          );
        // OpenAI-style model list: the registering console calls this with the
        // bearer to validate key and model name at save time. Same capability
        // gate as completions; read-only, advances no turn state.
        const cred = credentials.get(bearer);
        if (cred) {
          // Read-only validation for the registering console: never creates,
          // renews or deletes a grant.
          if (cred.retiredAt !== null || now() >= cred.hardExpiresAt)
            return Response.json(
              { error: "Invalid or expired session capability" },
              { status: 401 },
            );
        } else {
          const grant = grants.get(bearer);
          if (!grant || grant.expires <= now()) {
            grants.delete(bearer);
            return Response.json(
              { error: "Invalid or expired session capability" },
              { status: 401 },
            );
          }
        }
        return Response.json({
          object: "list",
          data: [
            {
              id: "voice-memory-local",
              object: "model",
              created: 0,
              owned_by: "voice-memory",
            },
          ],
        });
      }
      if (
        req.method !== "POST" ||
        new URL(req.url).pathname !== "/v1/chat/completions"
      ) {
        // Reject early but never leave an unread body hanging.
        req.body?.cancel().catch(() => {});
        return Response.json({ error: "Method not allowed" }, { status: 405 });
      }
      const token = bearer;
      const admitted = admit(token);
      if (admitted.status)
        return Response.json(
          { error: "Invalid or expired session capability" },
          { status: admitted.status },
        );
      const grant = admitted.grant;
      const sequence = ++grant.sequence;
      let data;
      try {
        const raw = await boundedBody(req, bodyTimeoutMs);
        data = JSON.parse(raw);
      } catch {
        return Response.json({ error: "Invalid request" }, { status: 400 });
      }
      if (
        !data ||
        typeof data !== "object" ||
        Array.isArray(data) ||
        !Array.isArray(data.messages)
      ) {
        return Response.json(
          { error: "Invalid message list" },
          { status: 400 },
        );
      }
      if (grants.get(token) !== grant || grant.expires <= now()) {
        return Response.json(
          { error: "Invalid or expired session capability" },
          { status: 401 },
        );
      }
      const last = data.messages.at(-1);
      if (
        data.stream !== true ||
        last?.role !== "user" ||
        typeof last.content !== "string" ||
        !last.content.trim() ||
        last.content.length > 4000
      )
        return Response.json(
          {
            error: "A streaming request with a final user message is required",
          },
          { status: 400 },
        );
      if (req.signal.aborted) return new Response(null, { status: 499 });
      let spoken, turn;
      if (
        /^\s*(turn (that|this|the brief) into (an? )?email|draft (an? )?email)\s*[.!]?\s*$/i.test(
          last.content,
        )
      ) {
        if (!grant.last || grant.last.refused || grant.last.unresolved)
          spoken =
            "Ask a question with supporting evidence first. I have not created or sent an email.";
        else {
          const reviewDraft = draft(grant.last, grant.bundle);
          turn = { draft: reviewDraft };
          spoken =
            "A review draft is ready on screen. Check decisions, conditions and open items before using it. Nothing has been sent.";
        }
      } else {
        let result = retrieval
          ? answerFromRetrieval(
              last.content,
              grant.bundle,
              await retrieval.retrieve(last.content, grant.bundle, {
                signal: req.signal,
              }),
              {
                actualMode: retrieval.actualMode,
                embeddingModel: retrieval.embeddingModel,
              },
            )
          : answer(last.content, grant.bundle);
        if (
          !result ||
          typeof result.refused !== "boolean" ||
          !Array.isArray(result.evidence) ||
          (!result.refused && !result.evidence.length)
        )
          // The engine has no answer shape for some in-corpus questions
          // (e.g. fields outside its vocabulary). Treat that as an honest
          // refusal for the evidence feed; the claim-graph renderer below
          // still speaks when it has grounded citations.
          result = { refused: true, evidence: [] };
        for (const evidence of result.evidence)
          validateEvidence(evidence, grant.bundle);
        if (req.signal.aborted) return new Response(null, { status: 499 });
        if (grants.get(token) !== grant || grant.expires <= now())
          return Response.json(
            { error: "Invalid or expired session capability" },
            { status: 401 },
          );
        if (sequence !== grant.sequence)
          return Response.json({ error: "Superseded turn" }, { status: 409 });
        grant.last = result;
        turn = { result };
        // Deterministic spoken renderer: routes intent, resolves the field
        // from the claim graph (per-grant inheritance for follow-ups), and
        // fills guarded templates. Engine output above stays the authority
        // for evidence; this layer only chooses what is spoken.
        const rendered = spokenTurn(
          last.content,
          grant.bundle,
          historyField(grant.bundle, data.messages.slice(0, -1)) ??
            grant.lastField ??
            null,
        );
        if (rendered) {
          grant.lastField = rendered.field ?? grant.lastField ?? null;
          grant.lastTurn = {
            at: Date.now(),
            intent: rendered.intent,
            field: rendered.field,
            verdict: rendered.verdict,
            spoken: rendered.spoken,
            citations: rendered.citations,
          };
          spoken = rendered.spoken;
          // Expose the verified spoken turn (verdict + citations) to the
          // owner's evidence feed alongside the engine result.
          turn = { result, spokenTurn: grant.lastTurn };
        }
        spoken ??=
          grant.last.spoken ??
          (grant.last.unresolved
            ? "Relevant passages need review, but this question is unresolved. No supported answer or draft is available. Review the original passages on screen."
            : grant.last.refused
              ? "I could not find supporting evidence in these documents."
              : `I found ${grant.last.evidence.length} relevant source passages. This local build shows excerpts rather than a synthesized answer. Review the sources on screen, including any conditions or differing decision statements.`);
      }
      const encoder = new TextEncoder(),
        id = "local-contract-" + randomBytes(8).toString("hex");
      const stream = new ReadableStream({
        start(controller) {
          for (const content of spoken.match(/.{1,64}(?:\s|$)|.{1,64}/g) ||
            []) {
            controller.enqueue(
              encoder.encode(
                "data: " +
                  JSON.stringify({
                    id,
                    object: "chat.completion.chunk",
                    choices: [
                      { index: 0, delta: { content }, finish_reason: null },
                    ],
                  }) +
                  "\n\n",
              ),
            );
          }
          controller.enqueue(
            encoder.encode(
              "data: " +
                JSON.stringify({
                  id,
                  object: "chat.completion.chunk",
                  choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
                }) +
                "\n\ndata: [DONE]\n\n",
            ),
          );
          controller.close();
        },
      });
      grant.turn = turn;
      return new Response(stream, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-store",
        },
      });
    },
    lastTurn(token) {
      const g = grants.get(token);
      if (!g || g.expires <= now()) return null;
      return g.turn ?? null;
    },
  };
}

async function boundedBody(req, timeoutMs) {
  if (req.signal.aborted) throw Error("Aborted");
  if (!req.body) throw Error("Missing body");
  const reader = req.body.getReader();
  let timer, listener;
  const stopped = new Promise((_, reject) => {
    listener = () => reject(Error("Aborted"));
    req.signal.addEventListener("abort", listener, { once: true });
    timer = setTimeout(() => reject(Error("Body deadline")), timeoutMs);
  });
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let raw = "",
    bytes = 0;
  try {
    while (true) {
      const { done, value } = await Promise.race([reader.read(), stopped]);
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 128 * 1024) throw Error("Body too large");
      raw += decoder.decode(value, { stream: true });
    }
    return raw + decoder.decode();
  } finally {
    clearTimeout(timer);
    req.signal.removeEventListener("abort", listener);
    reader.cancel().catch(() => {});
  }
}
