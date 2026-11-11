// Voice Memory API v1 ("Mode B"): memory services for a voice agent a
// company already runs. Versioned, tenant-authenticated, idempotent,
// rate-limited, and every write returns a signed audit receipt.
//
// Auth:   Authorization: Bearer <tenant API key>        (VM_TENANTS)
// Writes: Idempotency-Key: <1-80 chars>  (required on POST / DELETE)
//
//   POST   /v1/calls                          start a call binding
//   POST   /v1/calls/{callId}/verify          bind a verified caller (inbound)
//   POST   /v1/calls/{callId}/end             end (or revoke) the call
//   GET    /v1/calls/{callId}/context         recall: preferences, rechecked subjects, open requests
//   POST   /v1/calls/{callId}/answer          a current, source-verified answer (+ what changed since last time)
//   POST   /v1/calls/{callId}/turns           record a completed turn (exactly once per turnId)
//   POST   /v1/calls/{callId}/preferences     remember an explicitly stated preference
//   POST   /v1/calls/{callId}/consent         conversation-memory consent on/off
//   POST   /v1/calls/{callId}/requests        record an open request / promise
//   GET    /v1/calls/{callId}/memory          list everything stored for the caller
//   DELETE /v1/calls/{callId}/memory          ?preference=<key> | ?conversation=1 | ?all=1
//   GET    /v1/providers/bolna/identify       Bolna inbound caller-identification hook
//
// The four data types stay separate in every response: `preferences`
// (caller-provided), `verified` (documentary facts, recomputed now),
// `conversation` (events and what was actually spoken) and `requests`
// (open promises). Nothing in caller memory reaches the resolver except a
// question; no caller statement, model output or preference can change a
// verdict, an approval or a source version.
import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { CallerIdentityError } from "../memory/caller-identity.mjs";
import {
  CallerMemoryError,
  PREFERENCES,
  quoteKey,
} from "../memory/caller-memory.mjs";
import { BindingError, audienceOf } from "../memory/call-binding.mjs";
import { applicableScope } from "./applicability.mjs";

export const API_VERSION = "2026-11-11";
const sha = (s) => createHash("sha256").update(String(s)).digest();

/**
 * @param {{
 *   tenants: Record<string, { apiKey: string, voiceKey: string, cases?: string[] }>,
 *   identity: any, memory: any, bindings: any,
 *   answer: (a:{caseId:string, question:string}) => Promise<{final:any, corpus:any, wholeQuestion?:any}>,
 *   now?: () => number, ratePerMinute?: number,
 * }} deps
 */
export function createMemoryApi({
  tenants,
  identity,
  memory,
  bindings,
  answer,
  now = Date.now,
  ratePerMinute = 120,
}) {
  const auth = new Map(); // sha(apiKey) hex -> tenant
  const identifyAuth = new Map();
  for (const [tenant, t] of Object.entries(tenants ?? {})) {
    if (!/^[0-9a-f]{64,}$/i.test(t.apiKey ?? ""))
      throw Error(`VM_TENANTS.${tenant}.apiKey must be 64+ hex`);
    if (!t.voiceKey || String(t.voiceKey).length < 24)
      throw Error(`VM_TENANTS.${tenant}.voiceKey must be 24+ chars`);
    auth.set(sha(t.apiKey).toString("hex"), tenant);
    identifyAuth.set(sha("identify:" + t.apiKey).toString("hex"), tenant);
  }
  const receiptKey = (tenant) =>
    createHmac("sha256", tenants[tenant].apiKey)
      .update("vm-receipt-v1")
      .digest();
  const idem = new Map(); // tenant\0key -> { at, status, body, hash }
  const buckets = new Map();

  const send = (res, status, body, headers = {}) => {
    res.writeHead(status, {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "Voice-Memory-Version": API_VERSION,
      ...headers,
    });
    res.end(JSON.stringify(body));
  };
  const fail = (status, code, message) =>
    Object.assign(new Error(message), { status, code });
  const tenantOf = (req) => {
    const m = /^Bearer\s+(\S+)$/.exec(req.headers.authorization ?? "");
    if (!m)
      throw fail(
        401,
        "unauthenticated",
        "Send Authorization: Bearer <tenant API key>.",
      );
    const t = auth.get(sha(m[1]).toString("hex"));
    if (!t) throw fail(401, "unauthenticated", "Unknown API key.");
    return t;
  };
  const limit = (tenant) => {
    const t = now();
    const b = buckets.get(tenant) ?? { tokens: ratePerMinute, at: t };
    b.tokens = Math.min(
      ratePerMinute,
      b.tokens + ((t - b.at) / 60000) * ratePerMinute,
    );
    b.at = t;
    if (b.tokens < 1)
      throw fail(429, "rate_limited", "Too many requests for this tenant.");
    b.tokens -= 1;
    buckets.set(tenant, b);
  };
  const readJson = async (req) => {
    const chunks = [];
    let n = 0;
    for await (const c of req) {
      n += c.length;
      if (n > 16 * 1024) throw fail(413, "too_large", "Body over 16 KB.");
      chunks.push(c);
    }
    if (!n) return {};
    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      throw fail(400, "bad_json", "Send JSON.");
    }
  };
  const receipt = (
    tenant,
    op,
    {
      callId = null,
      key = null,
      sourceVersion = null,
      subject = null,
      extra = null,
    } = {},
  ) => {
    const r = {
      id: "rcpt_" + randomBytes(10).toString("hex"),
      op,
      tenant,
      callId,
      // A stable, non-reversible caller reference (never the account id).
      callerRef: subject
        ? sha("vm-ref:" + tenant + ":" + subject)
            .toString("hex")
            .slice(0, 16)
        : null,
      at: new Date(now()).toISOString(),
      idempotencyKey: key,
      sourceVersion,
      ...(extra ? { detail: extra } : {}),
      apiVersion: API_VERSION,
    };
    r.signature = createHmac("sha256", receiptKey(tenant))
      .update(JSON.stringify(r))
      .digest("base64url");
    return r;
  };
  const verifiedPart = (got, caseId) => {
    const f = got?.final ?? null;
    if (!f) return null;
    return {
      kind: f.kind,
      verdict: f.verdict ?? null,
      text: typeof f.admittedText === "string" ? f.admittedText : null,
      clarification:
        typeof f.admittedText === "string" ? null : (f.text ?? null),
      citations: (f.citations ?? []).map((c) => ({
        sourceId: c.sourceId ?? null,
        title: c.title ?? null,
        start: c.start ?? null,
        end: c.end ?? null,
        quote: c.quote ?? null,
      })),
      coverage: (got?.wholeQuestion ?? f.coverage)?.state ?? null,
      scope: {
        case: caseId,
        sourceVersion: got?.corpus?.version ?? null,
        appliedDocuments: got?.applicability?.applied ?? null,
        applicabilityRule: got?.applicability?.rule ?? null,
      },
    };
  };
  const needCaller = (b, perm) => {
    if (!b.caller)
      throw fail(
        403,
        "caller_unverified",
        "No verified caller on this call: memory is off.",
      );
    if (perm && !b.permissions[perm])
      throw fail(403, "not_permitted", `This call was not granted '${perm}'.`);
  };

  // The documents that apply to THIS call (src/applicability.mjs). Unknown
  // applicability is a clarification, never a guess, and is never stored.
  const answerFor =
    (b) =>
    async ({ question }) => {
      const sc = applicableScope(b.scope, b.applicability);
      if (sc.clarify)
        return {
          final: {
            kind: "clarify",
            verdict: null,
            admittedText: null,
            text: sc.clarify,
            citations: [],
          },
          corpus: null,
          applicability: { applied: null, rule: sc.rule },
        };
      const got = await answer({ caseId: sc.case, question });
      return {
        ...got,
        corpus: got?.corpus ? { ...got.corpus, applied: sc.applied } : null,
        applicability: sc.applied
          ? { applied: sc.applied, rule: sc.rule }
          : null,
      };
    };

  async function route(req, res, tenant, parts, url) {
    const [, callId, action] = parts; // ["calls", id, action]
    const key = req.headers["idempotency-key"] ?? null;
    if (req.method === "POST" && parts.length === 1 && parts[0] === "calls") {
      const d = await readJson(req);
      const t = tenants[tenant];
      if (!(t.cases ?? ["deal"]).includes(d?.scope?.case))
        throw fail(
          400,
          "bad_scope",
          "scope.case is not permitted for this tenant.",
        );
      let caller = null;
      if (d.caller?.assertion) {
        caller = identity.verify(d.caller.assertion);
        if (caller.tenant !== tenant)
          throw fail(
            403,
            "tenant_mismatch",
            "Caller belongs to another tenant.",
          );
      }
      const b = bindings.create({
        tenant,
        provider: d.provider ?? "bolna",
        audience: audienceOf(t.voiceKey),
        scope: { case: d.scope.case },
        permissions: d.permissions ?? {},
        applicability: d.applicability ?? null,
        caller,
        providerRef:
          typeof d.providerRef === "string" ? d.providerRef.slice(0, 80) : null,
      });
      return [
        201,
        {
          call: b,
          // Pass this to Bolna as user_data; the agent prompt must contain
          // "vm_call={vm_call}" in its SYSTEM prompt.
          providerUserData: { vm_call: b.callToken },
          receipt: receipt(tenant, "call.start", {
            callId: b.callId,
            key,
            subject: caller?.subject,
          }),
        },
      ];
    }
    if (parts[0] !== "calls" || !callId)
      throw fail(404, "not_found", "No such route.");
    const b = bindings.get(callId, tenant);
    const ctx = { callId, key, subject: b.caller?.subject };
    if (req.method === "POST" && action === "verify") {
      const d = await readJson(req);
      const caller = identity.verify(d.assertion);
      return [
        200,
        {
          call: bindings.verify(callId, tenant, caller),
          receipt: receipt(tenant, "call.verify", {
            ...ctx,
            subject: caller.subject,
          }),
        },
      ];
    }
    if (req.method === "POST" && action === "end") {
      const d = await readJson(req);
      return [
        200,
        {
          call: bindings.end(callId, tenant, { revoke: d.revoke === true }),
          receipt: receipt(tenant, d.revoke ? "call.revoke" : "call.end", ctx),
        },
      ];
    }
    if (["ended", "revoked"].includes(b.state))
      throw fail(409, b.state, `Call ${b.state}.`);
    if (req.method === "GET" && action === "context") {
      needCaller(b, "recall");
      const rec = await memory.recall(b.caller, {
        caseId: b.scope.case,
        answer: answerFor(b),
      });
      return [
        200,
        {
          call: bindings.view(b),
          preferences: rec.preferences,
          consent: rec.consent,
          rechecked: rec.rechecked.map((x) => ({
            subject: { id: x.subjectId, label: x.label },
            previously: x.previously,
            sourceChanged: x.sourceChanged,
            statusChanged: x.statusChanged,
            applicabilityChanged: x.applicabilityChanged ?? false,
            verified: verifiedPart(x.now, b.scope.case),
          })),
          requests: rec.openRequests,
          durable: rec.durable,
        },
      ];
    }
    if (req.method === "POST" && action === "answer") {
      const d = await readJson(req);
      const q = String(d.question ?? "").trim();
      if (!q || q.length > 400)
        throw fail(400, "bad_question", "question: 1-400 characters.");
      const got = await answerFor(b)({ question: q });
      const verified = verifiedPart(got, b.scope.case);
      let changedSince = null;
      if (b.caller && b.permissions.recall) {
        const subj = memory.subjectOf(q, b.scope.case)?.id ?? null;
        const prev = subj
          ? memory
              .list(b.caller)
              .episodes.filter(
                (e) => e.subjectId === subj && e.caseId === b.scope.case,
              )
              .at(-1)
          : null;
        if (prev) {
          const sourceChanged =
            prev.scope.version !== verified?.scope.sourceVersion;
          const applicabilityChanged =
            (prev.scope.applied ?? null) !==
            (verified?.scope.appliedDocuments ?? null);
          const statusChanged =
            prev.outcome.verdict !== verified?.verdict ||
            quoteKey(prev.citations?.[0]) !==
              quoteKey(verified?.citations?.[0]);
          const newSources = (verified?.citations ?? [])
            .map((c) => c.title)
            .filter((t) => t && !prev.citations.some((p) => p.title === t));
          changedSince = {
            previously: {
              at: prev.at,
              verdict: prev.outcome.verdict,
              line: prev.citations?.[0]?.quote ?? null,
              sourceVersion: prev.scope.version,
              appliedDocuments: prev.scope.applied ?? null,
            },
            sourceChanged,
            applicabilityChanged,
            statusChanged,
            why: !statusChanged
              ? sourceChanged || applicabilityChanged
                ? "The documents changed, but not in a way that changes this answer."
                : "Nothing changed since the caller last asked."
              : applicabilityChanged
                ? `A different document set now applies to this caller (${prev.scope.applied ?? "earlier"} → ${verified?.scope.appliedDocuments}). ${verified?.scope.applicabilityRule ?? ""}`.trim()
                : newSources.length
                  ? `The answer changed because of a newer source: ${[...new Set(newSources)].join(", ")}.`
                  : "The answer changed; see the cited sources.",
          };
        }
      }
      const answerReceipt = receipt(tenant, "answer", {
        callId,
        key: null,
        subject: b.caller?.subject,
        sourceVersion: verified?.scope.sourceVersion ?? null,
        extra: {
          appliedDocuments: verified?.scope.appliedDocuments ?? null,
          verdict: verified?.verdict ?? null,
          sources: (verified?.citations ?? []).map((c) => ({
            title: c.title,
            start: c.start,
            end: c.end,
          })),
        },
      });
      return [200, { verified, changedSince, receipt: answerReceipt }];
    }
    if (req.method === "POST" && action === "turns") {
      needCaller(b, "record");
      const d = await readJson(req);
      const turnId = String(d.turnId ?? "");
      if (!/^[A-Za-z0-9._:-]{1,80}$/.test(turnId))
        throw fail(400, "bad_turn", "turnId: 1-80 chars [A-Za-z0-9._:-].");
      const q = String(d.question ?? "").trim();
      if (!q) throw fail(400, "bad_question", "question required.");
      if (!bindings.commitTurn(b, "api:" + turnId))
        return [200, { recorded: false, duplicate: true }];
      // The verdict is recomputed here; the client's text is kept only as
      // what was spoken, never as a fact.
      const got = await answerFor(b)({ question: q });
      const kept = memory.recordEpisode(b.caller, {
        callId,
        caseId: b.scope.case,
        question: q,
        final: got?.final,
        corpus: got?.corpus,
        spoken: typeof d.spoken === "string" ? d.spoken.slice(0, 600) : null,
      });
      return [
        200,
        {
          recorded: kept.kept,
          reason: kept.kept ? null : kept.reason,
          episode: kept.episode ?? null,
          receipt: receipt(tenant, "turn.record", {
            ...ctx,
            sourceVersion: got?.corpus?.version ?? null,
          }),
        },
      ];
    }
    if (req.method === "POST" && action === "preferences") {
      needCaller(b, "remember");
      const d = await readJson(req);
      if (d.consent !== "caller_explicit")
        throw fail(
          400,
          "consent_required",
          "Preferences need consent: 'caller_explicit' (the caller asked you to remember it).",
        );
      if (
        !Object.hasOwn(PREFERENCES, d.key) ||
        !PREFERENCES[d.key].includes(d.value)
      )
        throw fail(
          400,
          "not_allowed",
          `Allowed: ${JSON.stringify(PREFERENCES)}.`,
        );
      const p = memory.rememberPreference(b.caller, {
        key: d.key,
        value: d.value,
        callId,
        channel: "api",
      });
      return [
        200,
        {
          preference: { key: d.key, ...p },
          receipt: receipt(tenant, "preference.set", ctx),
        },
      ];
    }
    if (req.method === "POST" && action === "consent") {
      needCaller(b, "remember");
      const d = await readJson(req);
      if (d.conversation === true)
        memory.consentToConversation(b.caller, { callId, channel: "api" });
      else if (d.conversation === false)
        memory.forget(b.caller, { conversation: true });
      else throw fail(400, "bad_consent", "conversation: true | false");
      return [
        200,
        {
          consent: memory.list(b.caller).consent,
          receipt: receipt(
            tenant,
            d.conversation ? "consent.grant" : "consent.revoke",
            ctx,
          ),
        },
      ];
    }
    if (req.method === "POST" && action === "requests") {
      needCaller(b, "record");
      const d = await readJson(req);
      const r = memory.recordRequest(b.caller, {
        callId,
        caseId: b.scope.case,
        text: String(d.text ?? "").slice(0, 200),
      });
      return [200, { ...r, receipt: receipt(tenant, "request.record", ctx) }];
    }
    if (req.method === "GET" && action === "memory") {
      needCaller(b);
      return [200, { memory: memory.list(b.caller) }];
    }
    if (req.method === "DELETE" && action === "memory") {
      needCaller(b);
      const sp = url.searchParams;
      const what =
        sp.get("all") === "1"
          ? { all: true }
          : sp.get("conversation") === "1"
            ? { conversation: true }
            : sp.get("preference")
              ? { preference: sp.get("preference") }
              : null;
      if (!what)
        throw fail(
          400,
          "bad_delete",
          "?all=1 | ?conversation=1 | ?preference=<key>",
        );
      const r = memory.forget(b.caller, what);
      return [200, { ...r, receipt: receipt(tenant, "memory.delete", ctx) }];
    }
    throw fail(404, "not_found", "No such route.");
  }

  // Bolna inbound caller identification: GET with contact_number, agent_id,
  // execution_id, Bearer = sha-derived identify token. A phone number is not
  // identity: the binding it creates has NO memory until the tenant backend
  // verifies the caller via /verify.
  async function identify(req, res, url) {
    const m = /^Bearer\s+(\S+)$/.exec(req.headers.authorization ?? "");
    const tenant = m
      ? (identifyAuth.get(sha("identify:" + m[1]).toString("hex")) ??
        auth.get(sha(m[1]).toString("hex")))
      : null;
    if (!tenant) return send(res, 401, { error: "unauthenticated" });
    const t = tenants[tenant];
    const b = bindings.create({
      tenant,
      provider: "bolna",
      audience: audienceOf(t.voiceKey),
      scope: { case: (t.cases ?? ["deal"])[0] },
      permissions: { recall: true, remember: true, record: true },
      caller: null,
      providerRef:
        String(url.searchParams.get("execution_id") ?? "").slice(0, 80) || null,
    });
    // Variables merged into the agent prompt. vm_call_id lets the tenant's
    // own verification step (OTP) call /verify for this exact call.
    return send(res, 200, {
      vm_call: b.callToken,
      vm_call_id: b.callId,
      vm_caller_verified: "no",
    });
  }

  return async function handle(req, res) {
    const url = new URL(req.url, "http://x");
    if (
      !url.pathname.startsWith("/v1/") ||
      url.pathname.startsWith("/v1/chat/")
    )
      return false;
    try {
      if (
        url.pathname === "/v1/providers/bolna/identify" &&
        req.method === "GET"
      ) {
        await identify(req, res, url);
        return true;
      }
      const tenant = tenantOf(req);
      limit(tenant);
      const parts = url.pathname.slice(4).split("/").filter(Boolean);
      const write = req.method === "POST" || req.method === "DELETE";
      const key = req.headers["idempotency-key"];
      if (
        write &&
        (typeof key !== "string" || !/^[A-Za-z0-9._:-]{1,80}$/.test(key))
      )
        throw fail(
          400,
          "idempotency_key_required",
          "Send an Idempotency-Key header (1-80 chars) on every write.",
        );
      const ik = write
        ? `${tenant}\u0000${req.method} ${url.pathname}${url.search}\u0000${key}`
        : null;
      if (ik && idem.has(ik)) {
        const prior = idem.get(ik);
        return (
          send(res, prior.status, prior.body, { "Idempotent-Replay": "true" }),
          true
        );
      }
      const [status, body] = await route(req, res, tenant, parts, url);
      if (ik) {
        idem.set(ik, { status, body, at: now() });
        for (const [k, v] of idem)
          if (now() - v.at > 24 * 3600000) idem.delete(k);
        while (idem.size > 20000) idem.delete(idem.keys().next().value);
      }
      send(res, status, body);
    } catch (e) {
      if (e instanceof CallerIdentityError)
        send(res, 401, { error: "Caller not verified.", code: e.code });
      else if (e instanceof BindingError)
        send(res, e.code === "unknown" ? 404 : 409, {
          error: e.message,
          code: e.code,
        });
      else if (e instanceof CallerMemoryError)
        send(res, e.code === "unavailable" ? 503 : 400, {
          error: e.message,
          code: e.code,
        });
      else if (e?.status)
        send(res, e.status, { error: e.message, code: e.code });
      else {
        console.error("memory api:", e?.message);
        send(res, 500, { error: "Something went wrong." });
      }
    }
    return true;
  };
}

export const _test = { sha, timingSafeEqual };
