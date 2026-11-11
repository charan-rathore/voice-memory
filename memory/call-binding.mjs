// Trusted call-session bindings: which tenant, which verified caller, which
// source scope and which memory permissions a live voice call carries.
//
// A binding is created only by the tenant's own backend (authenticated with
// its API key) or by the provider's server-side inbound hook. The secret
// call token reaches the voice provider through server-side call metadata
// (Bolna `user_data` -> `{vm_call}` in the agent's SYSTEM prompt), never from
// anything a caller says, a phone number, or assistant history.
//
//   create()   -> { callId (public), callToken (secret), expiresAt }
//   resolve(token, { audience }) -> the binding, or throws BindingError:
//                 unknown | expired | revoked | ended | audience_mismatch
//   verify(callId, callerBinding) upgrades an unverified (inbound) call
//   commitTurn(callId, key) -> false when that turn was already committed
//
// Lifetimes: 15 minutes to first use, 2 hours absolute, single process.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export class BindingError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "BindingError";
    this.code = code;
  }
}
const sha = (s) => createHash("sha256").update(String(s)).digest();
export const audienceOf = (voiceBearer) =>
  sha("vm-voice-aud:" + voiceBearer).toString("hex");

export function createCallBindings({
  now = Date.now,
  firstUseMs = 15 * 60000,
  maxLifeMs = 2 * 3600000,
  max = 5000,
} = {}) {
  const byToken = new Map(); // sha(token) hex -> binding
  const byId = new Map(); // callId -> binding
  const sweep = () => {
    const t = now();
    for (const [k, b] of byToken)
      if (
        b.hardExpiresAt <= t ||
        (b.state === "ended" && t - b.endedAt > 60000)
      ) {
        byToken.delete(k);
        byId.delete(b.callId);
      }
    while (byToken.size > max) {
      const [k, b] = byToken.entries().next().value;
      byToken.delete(k);
      byId.delete(b.callId);
    }
  };
  const view = (b) => ({
    callId: b.callId,
    tenant: b.tenant,
    provider: b.provider,
    scope: { ...b.scope },
    permissions: { ...b.permissions },
    verified: !!b.caller,
    state: b.state,
    createdAt: new Date(b.createdAt).toISOString(),
    expiresAt: new Date(
      b.state === "pending" ? b.firstUseBy : b.hardExpiresAt,
    ).toISOString(),
  });

  return {
    create({
      tenant,
      provider = "bolna",
      audience,
      scope,
      permissions = {},
      caller = null,
      providerRef = null,
      applicability = null,
    }) {
      if (!tenant || !audience || !scope?.case)
        throw new BindingError(
          "invalid",
          "tenant, audience and scope.case are required",
        );
      sweep();
      const token = "vmc_" + randomBytes(24).toString("hex");
      const t = now();
      const b = {
        callId: "call_" + randomBytes(10).toString("hex"),
        tokenHash: sha(token).toString("hex"),
        tenant,
        provider,
        audience,
        providerRef,
        scope: { case: scope.case },
        // Verified account facts that decide which documents apply (from
        // the tenant backend, never from the caller).
        applicability:
          applicability && typeof applicability === "object"
            ? { policyIssuedOn: applicability.policyIssuedOn ?? null }
            : null,
        // Without a verified caller there is no memory at all.
        permissions: {
          recall: !!(caller && permissions.recall),
          remember: !!(caller && permissions.remember),
          record: !!(caller && permissions.record),
        },
        requested: {
          recall: !!permissions.recall,
          remember: !!permissions.remember,
          record: !!permissions.record,
        },
        caller,
        state: "pending",
        createdAt: t,
        firstUseBy: t + firstUseMs,
        hardExpiresAt: t + maxLifeMs,
        committed: new Set(),
      };
      byToken.set(b.tokenHash, b);
      byId.set(b.callId, b);
      return { ...view(b), callToken: token };
    },
    resolve(token, { audience } = {}) {
      const b = byToken.get(sha(token).toString("hex"));
      if (!b) throw new BindingError("unknown", "Unknown call token.");
      const t = now();
      if (b.state === "revoked")
        throw new BindingError("revoked", "Call revoked.");
      if (b.state === "ended") throw new BindingError("ended", "Call ended.");
      if (t >= b.hardExpiresAt || (b.state === "pending" && t >= b.firstUseBy))
        throw new BindingError("expired", "Call token expired.");
      const a = Buffer.from(String(audience ?? ""), "hex");
      const want = Buffer.from(b.audience, "hex");
      if (a.length !== want.length || !timingSafeEqual(a, want))
        throw new BindingError(
          "audience_mismatch",
          "This call token belongs to another voice integration.",
        );
      b.state = "live";
      return b;
    },
    /**
     * A call the tenant may act on NOW. Ended, revoked or expired calls are
     * refused for every memory operation: knowing an old callId is never a
     * standing right to a caller's memory (account-level deletion has its
     * own route, authorised by a fresh caller assertion). API use counts as
     * first use, like the voice provider's first request.
     * `{ any: true }` returns the call in any state (only for /end).
     */
    get(callId, tenant, { any = false } = {}) {
      const b = byId.get(callId);
      if (!b || b.tenant !== tenant)
        throw new BindingError("unknown", "Unknown call.");
      if (any) return b;
      const t = now();
      if (b.state === "revoked")
        throw new BindingError("revoked", "Call revoked.");
      if (b.state === "ended") throw new BindingError("ended", "Call ended.");
      if (t >= b.hardExpiresAt || (b.state === "pending" && t >= b.firstUseBy))
        throw new BindingError("expired", "Call expired.");
      b.state = "live";
      return b;
    },
    view,
    verify(callId, tenant, caller) {
      const b = this.get(callId, tenant);
      if (caller.tenant !== tenant)
        throw new BindingError(
          "tenant_mismatch",
          "Caller belongs to another tenant.",
        );
      if (b.caller && b.caller.subject !== caller.subject)
        throw new BindingError(
          "caller_mismatch",
          "This call is bound to another caller.",
        );
      b.caller = caller;
      b.permissions = { ...b.requested };
      return view(b);
    },
    end(callId, tenant, { revoke = false } = {}) {
      const b = this.get(callId, tenant, { any: true });
      b.state = revoke ? "revoked" : "ended";
      b.endedAt = now();
      return view(b);
    },
    /** Exactly-once per turn key: retries and duplicate events write nothing. */
    commitTurn(b, key) {
      if (b.committed.has(key)) return false;
      b.committed.add(key);
      if (b.committed.size > 500)
        b.committed.delete(b.committed.values().next().value);
      return true;
    },
  };
}
