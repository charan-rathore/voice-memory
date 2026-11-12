// Caller identity for persistent caller memory.
//
// Voice Memory never decides who a caller is from what the call says. A
// caller is "verified" only when the deploying tenant's own backend (which
// already authenticated the person: account login, OTP, SSO) signs a short-
// lived, single-use assertion with a key shared with this server. The server
// verifies it and binds the result to one server-side call session.
//
// Refused, by design:
//  - caller ID / ANI alone (`amr: "ani"`), or any unknown method;
//  - a subject that is a phone number (tenants must use an opaque account
//    id, so a spoofed or recycled number can never open someone's memory);
//  - anything from a prompt variable, request body field or transcript that
//    is not a valid signature over the claims;
//  - expired, future-dated, over-long or replayed assertions.
//
// Wire format: vmca1.<kid>.<base64url(JSON claims)>.<base64url(HMAC-SHA256)>
// Claims: { v:1, ten, sub, name?, amr, iat, exp, jti } (seconds since epoch).
//
// HONEST SCOPE: HMAC with a shared secret per tenant key id. Key rotation is
// by adding a kid; there is no revocation list beyond expiry and the replay
// window. The demo issuer (VM_CALLER_DEMO=on) signs ONLY fixed fictional
// personas and says so in its method (`amr: "demo-fictional"`).
import {
  createHmac,
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

export const ALLOWED_METHODS = Object.freeze([
  "account-login",
  "otp",
  "sso",
  "demo-fictional",
]);
const MAX_LIFETIME_S = 15 * 60;
const SKEW_S = 60;

export class CallerIdentityError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "CallerIdentityError";
    this.code = code;
  }
}

const b64u = (buf) => Buffer.from(buf).toString("base64url");
const unb64u = (s) => Buffer.from(String(s), "base64url");
const PHONE = /^\+?[\d\s().-]{7,}$/;
const OPAQUE = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,63}$/;

/** One stable, non-reversible key for a (tenant, subject) pair. */
export const subjectKeyOf = (tenant, sub) =>
  createHash("sha256")
    .update(`vm-caller:${tenant}\u0000${sub}`)
    .digest("hex")
    .slice(0, 32);

/**
 * @param {{ keys: Record<string,string>, now?: () => number, replayMax?: number }} opts
 *   keys: kid -> secret (hex, >= 32 bytes). Unset/short keys are refused.
 */
export function createCallerIdentity({
  keys = {},
  now = Date.now,
  replayMax = 4096,
} = {}) {
  const secrets = new Map();
  // A key is either "<hex>" (legacy: any tenant) or { secret, tenant }: a
  // tenant-scoped key can only vouch for that tenant's callers.
  const keyTenant = new Map();
  for (const [kid, v] of Object.entries(keys ?? {})) {
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(kid)) throw Error("Bad caller key id.");
    const hex = typeof v === "string" ? v : v?.secret;
    if (!/^[0-9a-f]{64,}$/i.test(String(hex ?? "")))
      throw Error("Caller signing keys must be at least 32 bytes of hex.");
    secrets.set(kid, Buffer.from(hex, "hex"));
    if (typeof v === "object" && v?.tenant) keyTenant.set(kid, v.tenant);
  }
  // Only objects this instance produced from a valid signature count as a
  // verified binding; a look-alike object built from request data does not.
  const verified = new WeakSet();
  const seen = new Map(); // jti -> exp (s)
  const sign = (kid, body) =>
    createHmac("sha256", secrets.get(kid))
      .update(`vmca1.${kid}.${body}`)
      .digest();

  return {
    configured: secrets.size > 0,
    /** For the tenant backend (and the fictional demo issuer). */
    issue({ kid, tenant, sub, name = null, amr, ttlS = 300 }) {
      if (!secrets.has(kid))
        throw new CallerIdentityError("unknown_key", "Unknown key id.");
      const iat = Math.floor(now() / 1000);
      const claims = {
        v: 1,
        ten: tenant,
        sub,
        ...(name ? { name } : {}),
        amr,
        iat,
        exp: iat + Math.min(ttlS, MAX_LIFETIME_S),
        jti: randomBytes(12).toString("hex"),
      };
      const body = b64u(JSON.stringify(claims));
      return `vmca1.${kid}.${body}.${b64u(sign(kid, body))}`;
    },
    /** Verify once. Returns a frozen binding or throws CallerIdentityError. */
    verify(assertion) {
      const parts = String(assertion ?? "").split(".");
      if (parts.length !== 4 || parts[0] !== "vmca1")
        throw new CallerIdentityError("malformed", "Not a caller assertion.");
      const [, kid, body, mac] = parts;
      if (!secrets.has(kid))
        throw new CallerIdentityError("unknown_key", "Unknown signing key.");
      const want = sign(kid, body);
      const got = unb64u(mac);
      if (got.length !== want.length || !timingSafeEqual(got, want))
        throw new CallerIdentityError(
          "bad_signature",
          "Signature does not verify.",
        );
      let c;
      try {
        c = JSON.parse(unb64u(body).toString("utf8"));
      } catch {
        throw new CallerIdentityError("malformed", "Unreadable claims.");
      }
      const t = Math.floor(now() / 1000);
      if (c?.v !== 1)
        throw new CallerIdentityError("malformed", "Unknown version.");
      if (!ALLOWED_METHODS.includes(c.amr))
        throw new CallerIdentityError(
          "weak_method",
          "This sign-in method cannot open caller memory (caller ID alone is never enough).",
        );
      if (typeof c.ten !== "string" || !OPAQUE.test(c.ten))
        throw new CallerIdentityError("malformed", "Bad tenant.");
      // Only the demo-scoped key may sign the fictional demo tenant.
      if (c.ten === DEMO_TENANT && keyTenant.get(kid) !== DEMO_TENANT)
        throw new CallerIdentityError(
          "wrong_tenant",
          "Only the demo signer can sign demo callers.",
        );
      if (keyTenant.has(kid) && keyTenant.get(kid) !== c.ten)
        throw new CallerIdentityError(
          "wrong_tenant",
          "This key cannot vouch for that tenant.",
        );
      if (typeof c.sub !== "string" || PHONE.test(c.sub) || !OPAQUE.test(c.sub))
        throw new CallerIdentityError(
          "bad_subject",
          "The caller must be an opaque account id, not a phone number.",
        );
      if (!Number.isInteger(c.iat) || !Number.isInteger(c.exp))
        throw new CallerIdentityError("malformed", "Bad times.");
      if (c.iat > t + SKEW_S)
        throw new CallerIdentityError("future", "Issued in the future.");
      if (c.exp <= t)
        throw new CallerIdentityError("expired", "Assertion expired.");
      if (c.exp - c.iat > MAX_LIFETIME_S)
        throw new CallerIdentityError(
          "too_long",
          "Assertion lifetime too long.",
        );
      if (typeof c.jti !== "string" || c.jti.length < 16)
        throw new CallerIdentityError("malformed", "Missing assertion id.");
      for (const [j, e] of seen) if (e <= t) seen.delete(j);
      if (seen.has(c.jti))
        throw new CallerIdentityError("replayed", "Assertion already used.");
      seen.set(c.jti, c.exp);
      while (seen.size > replayMax) seen.delete(seen.keys().next().value);
      const binding = Object.freeze({
        tenant: c.ten,
        subject: subjectKeyOf(c.ten, c.sub),
        displayName: typeof c.name === "string" ? c.name.slice(0, 60) : null,
        method: c.amr,
        verifiedAt: new Date(t * 1000).toISOString(),
      });
      verified.add(binding);
      return binding;
    },
    isVerified: (b) => !!b && typeof b === "object" && verified.has(b),
  };
}

// Fictional callers for the public demo. They live in their own tenant,
// "demo-visitors", whose signing key is scoped to it (it cannot vouch for any
// real tenant), and each visitor gets their own Asha and Ravi: the subject is
// derived from a server-issued, HMAC-signed visitor id (src/caller-api.mjs).
export const DEMO_TENANT = "demo-visitors";
export const DEMO_PERSONAS = Object.freeze({
  asha: Object.freeze({ name: "Asha (fictional)" }),
  ravi: Object.freeze({ name: "Ravi (fictional)" }),
});
/** The demo subject for one visitor's persona (never a real account). */
export const demoSubject = (visitorId, persona) =>
  `demo-${createHash("sha256")
    .update("vm-demo-visitor:" + visitorId)
    .digest("hex")
    .slice(0, 24)}-${persona}`;
