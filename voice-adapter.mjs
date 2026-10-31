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
import {
  DENSE_MODEL_ID,
  denseAvailableFor,
  embedQueryReady,
} from "./dense.mjs";
import { spokenTurn, historyField } from "./spoken.mjs";
import { normalizeSpoken } from "./spoken-normalize.mjs";
import { extractiveSpoken } from "./spoken-extract.mjs";
import {
  clinicalTurn,
  clinicalOverview,
  observationEvidence,
} from "./clinical/answer.mjs";
import { aliasesFor } from "./clinical/explain.mjs";
import {
  voiceQuestions,
  isFragment,
  FRAGMENT_REPLY,
} from "./spoken-repair.mjs";
export function createVoiceAdapter({
  ttlMs = 120000,
  now = () => Date.now(),
  retrieval = null,
  bodyTimeoutMs = 5000,
  hardTtlMs = null,
  hardExpiresAtMs = null,
  // Called after each answered turn with (token, {question, lead, result,
  // scope}). The server routes it into the owning session's episodic memory.
  onTurn = null,
} = {}) {
  let resolveBundle = null;
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
      // Retargeted to "no documents" (owner removed them all): there is no
      // corpus this credential may answer from, so fail closed.
      if (!cred.bundle) return { status: 401 };
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
      // Parse before taking a turn number. A rejected or side request must
      // not mark the spoken question as superseded.
      const receivedAt = Date.now();
      const logTurn = (entry) => {
        grant.turnLog ??= [];
        grant.turnLog.push({ seq: grant.sequence, receivedAt, ...entry });
        if (grant.turnLog.length > 50) grant.turnLog.shift();
      };
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
      // A visitor's own uploaded workspace, named by the session variable
      // Bolna substitutes into the agent prompt (vm_ws=<id>). The bearer
      // still authenticates; the id only selects among public workspaces.
      let bundle = grant.bundle;
      try {
        const ws = resolveBundle?.(data.messages);
        if (ws) bundle = ws;
      } catch {
        bundle = grant.bundle;
      }
      const askedRaw = latestUser(data.messages);
      if (!askedRaw) {
        return Response.json(
          {
            error: "A request with a user message is required",
          },
          { status: 400 },
        );
      }
      // Classifier / hangup checks (Bolna sets response_format json_object,
      // often with stream false). They share this endpoint. Answering them
      // from the evidence engine, or letting them take the turn number,
      // drops the caller's real question and returns JSON to a stream.
      const jsonMode = data.response_format?.type === "json_object";
      if (jsonMode) {
        return completionJson('{"hangup":"no"}');
      }
      // Bolna's spoken turn is always stream:true. A non-streaming request is
      // not a question: rejecting it before a turn number is taken means it
      // cannot supersede the utterance that is already in flight.
      if (data.stream !== true) {
        return Response.json(
          {
            error: "A streaming request with a final user message is required",
          },
          { status: 400 },
        );
      }
      const transcript = askedRaw;
      // Repair recogniser damage (patient ids, misheard test names) and, for
      // a fragment or a follow-up that lost its subject, join this caller's
      // own previous utterances. Lab questions take the first candidate the
      // clinical layer can answer.
      const reports = bundle?.clinical ?? [];
      const candidates = voiceQuestions(data.messages, {
        reports,
        ids: [
          ...new Set(reports.map((r) => r.meta?.patient?.id).filter(Boolean)),
        ],
        aliasesFor,
        text: messageText,
      }).map((q) => normalizeSpoken(q) || q);
      let asked = candidates[0] || normalizeSpoken(transcript) || transcript;
      if (reports.length) {
        const hit = candidates.find((q) => {
          try {
            return clinicalTurn(q, reports);
          } catch {
            return false;
          }
        });
        if (hit) asked = hit;
      }
      const streaming = true;
      const sequence = ++grant.sequence;
      grant.busy = (grant.busy ?? 0) + 1;
      const releaseBusy = () => {
        grant.busy = Math.max(0, (grant.busy ?? 1) - 1);
      };
      if (req.signal.aborted) {
        releaseBusy();
        logTurn({ transcript, outcome: "aborted" });
        return new Response(null, { status: 499 });
      }
      let spoken, turn;
      if (
        /^\s*(turn (that|this|the brief) into (an? )?email|draft (an? )?email)\s*[.!]?\s*$/i.test(
          transcript,
        )
      ) {
        // The draft comes from THIS call's previous question (its own message
        // history), never from whatever another caller on the same bearer
        // asked last.
        const prev = [...data.messages.slice(0, -1)]
          .reverse()
          .find((m) => m?.role === "user" && messageText(m.content).trim());
        const prevQ = prev ? messageText(prev.content) : undefined;
        let prior = null;
        try {
          prior = prevQ
            ? answer(normalizeSpoken(prevQ) || prevQ, bundle)
            : null;
        } catch {
          prior = null;
        }
        // A minted per-call token is one call, so its own last turn is fine;
        // the fixed operator bearer is shared and never falls back.
        if (!prevQ && !credentials.has(token)) prior = grant.last ?? null;
        if (
          !prior ||
          prior.refused ||
          prior.unresolved ||
          !prior.evidence?.length
        )
          spoken =
            "Ask a question with supporting evidence first. I have not created or sent an email.";
        else {
          const reviewDraft = draft(prior, bundle);
          turn = { draft: reviewDraft };
          spoken =
            "A review draft is ready on screen. Check decisions, conditions and open items before using it. Nothing has been sent.";
        }
      } else {
        let result = retrieval
          ? answerFromRetrieval(
              asked,
              bundle,
              await retrieval.retrieve(asked, bundle, {
                signal: req.signal,
              }),
              {
                actualMode: retrieval.actualMode,
                embeddingModel: retrieval.embeddingModel,
              },
            )
          : answer(asked, bundle, {
              queryVector: await embedQueryReady(asked),
              model: DENSE_MODEL_ID,
              available: denseAvailableFor(bundle),
            });
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
          validateEvidence(evidence, bundle);
        if (req.signal.aborted) {
          releaseBusy();
          logTurn({ transcript, outcome: "aborted" });
          return new Response(null, { status: 499 });
        }
        if (grants.get(token) !== grant || grant.expires <= now()) {
          releaseBusy();
          return Response.json(
            { error: "Invalid or expired session capability" },
            { status: 401 },
          );
        }
        if (streaming && sequence !== grant.sequence) {
          releaseBusy();
          logTurn({ transcript, outcome: "superseded" });
          return Response.json({ error: "Superseded turn" }, { status: 409 });
        }
        grant.last = result;
        turn = { result };
        // Deterministic spoken renderer: routes intent, resolves the field
        // from the claim graph (per-grant inheritance for follow-ups), and
        // fills guarded templates. Engine output above stays the authority
        // for evidence; this layer only chooses what is spoken.
        // Lab results across reports (bundle.clinical, set by the server for
        // uploaded lab tables) answer first; absent for Northstar.
        const clinical = bundle.clinical?.length
          ? (clinicalTurn(asked, bundle.clinical) ??
            candidates
              .map((q) => clinicalOverview(q, bundle.clinical))
              .find(Boolean) ??
            null)
          : null;
        let rendered = clinical
          ? {
              spoken: clinical.spoken,
              verdict: clinical.verdict,
              field: null,
              intent: clinical.intent,
              citations: clinical.used
                .map((o) => observationEvidence(o, bundle))
                .filter(Boolean)
                .map((c) => ({
                  title: c.title,
                  docDate: null,
                  quote: c.quote,
                  firstLine: c.firstLine,
                  lastLine: c.lastLine,
                  hash: c.hash,
                })),
            }
          : null;
        rendered ??= spokenTurn(
          asked,
          bundle,
          // Context from this request's own history only: a fixed bearer is
          // shared by every caller, so grant-level state would leak between
          // concurrent calls.
          historyField(bundle, data.messages.slice(0, -1)) ??
            (credentials.has(token) ? null : (grant.lastField ?? null)),
        );
        // Outside the claim graph's fields: speak one verbatim sentence or
        // table row from the engine's already-validated evidence, or keep
        // the abstention. Deliberate abstentions (unknown entity/amount)
        // carry no "no_field" reason and are never overridden.
        if (!clinical && (!rendered || rendered.reason === "no_field")) {
          const quoted = extractiveSpoken(
            asked,
            result,
            bundle,
            bundle.locateEvidence,
          );
          if (quoted)
            rendered = {
              spoken: quoted.spoken,
              verdict: quoted.verdict,
              field: null,
              intent: rendered?.intent ?? "LOOKUP",
              citations: quoted.citations.map((c) => ({
                title: c.title,
                docDate: null,
                quote: c.quote,
                firstLine: c.firstLine,
                lastLine: c.lastLine,
                hash: c.hash,
              })),
            };
        }
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
      // A cut-off fragment gets a helpful prompt, not a flat abstention.
      if (
        /^I (don't|do not) see that in these documents\.?$/i.test(
          spoken ?? "",
        ) &&
        isFragment(transcript)
      )
        spoken = FRAGMENT_REPLY;
      releaseBusy();
      const id = "local-contract-" + randomBytes(8).toString("hex");
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        start(controller) {
          logTurn({
            transcript,
            normalized: asked ?? null,
            firstByteAt: Date.now(),
            spoken,
            verdict: turn?.spokenTurn?.verdict ?? null,
            outcome: "answered",
          });
          try {
            onTurn?.(token, {
              question: asked,
              lead: turn?.spokenTurn ?? null,
              result: turn?.result ?? null,
              scope: bundle?.scope ?? null,
            });
          } catch {
            /* memory is best-effort; never break the call */
          }
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
    // Voice lab: this grant's recent turns (transcript as received, receipt and
    // first-byte wall-clock times, interruptions). Owner diagnostics only.
    turnLog(token) {
      const g = grants.get(token);
      if (!g || g.expires <= now()) return [];
      return [...(g.turnLog ?? [])];
    },
    setBundleResolver(fn) {
      resolveBundle = typeof fn === "function" ? fn : null;
    },
    setOnTurn(fn) {
      onTurn = typeof fn === "function" ? fn : null;
    },
    lastTurn(token) {
      const g = grants.get(token);
      if (!g || g.expires <= now()) return null;
      return g.turn ?? null;
    },
  };
}

function messageText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (part && typeof part.text === "string") return part.text;
      return "";
    })
    .join("");
}

// Bolna's OpenAI client sometimes ends the history with an empty assistant
// stub, and it may send user text as content parts. The question is the
// latest non-empty user message, not strictly messages.at(-1).
function latestUser(messages) {
  let i = messages.length - 1;
  while (i >= 0) {
    const m = messages[i];
    const t = messageText(m?.content).trim();
    if (!t && (m?.role === "assistant" || m?.role === "tool")) {
      i -= 1;
      continue;
    }
    break;
  }
  const m = messages[i];
  if (!m || m.role !== "user") return null;
  const text = messageText(m.content).trim();
  if (!text || text.length > 4000) return null;
  return text;
}

function completionJson(content) {
  return Response.json({
    id: "local-contract-" + randomBytes(8).toString("hex"),
    object: "chat.completion",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content },
        finish_reason: "stop",
      },
    ],
  });
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
