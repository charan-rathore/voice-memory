// Server-private receipt signing (Ed25519) with a published public key.
//
// A receipt says what Voice Memory SIGNED: which tenant and call, which
// request/turn, which source scope and version, which documents applied,
// digests of the question, of the admitted answer and of every cited span,
// the outcome and what stayed unresolved. Anyone with the public key can
// check it (scripts/verify-receipt.mjs); no tenant can forge one, because
// the private key never leaves this process and is not derived from any
// tenant secret.
//
// It does NOT prove that a caller heard the answer, that an agent spoke it,
// or that anyone made a legally valid decision. It is not a billing or
// non-repudiation instrument.
//
// Key: VM_RECEIPT_KEY = 64 hex chars (an Ed25519 seed). Without it, a seed
// is derived from VM_STORE_KEY (stable across restarts); without either,
// an ephemeral key is generated and the published key says so.
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  hkdfSync,
  randomBytes,
  sign,
  verify,
} from "node:crypto";

export const RECEIPT_SCHEMA = "vm-receipt/2";
const PKCS8_ED25519_PREFIX = Buffer.from(
  "302e020100300506032b657004220420",
  "hex",
);

/** Deterministic JSON: sorted keys, no whitespace, no undefined. */
export function canonical(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  return `{${Object.keys(v)
    .filter((k) => v[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`)
    .join(",")}}`;
}
/** sha256 over the NFC-normalised UTF-8 text, hex. Null for non-strings. */
export const digest = (text) =>
  typeof text === "string"
    ? createHash("sha256").update(text.normalize("NFC"), "utf8").digest("hex")
    : null;

export function createReceiptSigner({
  seedHex = null,
  storeKeyHex = null,
} = {}) {
  let seed;
  let ephemeral = false;
  if (/^[0-9a-f]{64}$/i.test(seedHex ?? "")) seed = Buffer.from(seedHex, "hex");
  else if (/^[0-9a-f]{64}$/i.test(storeKeyHex ?? ""))
    seed = Buffer.from(
      hkdfSync(
        "sha256",
        Buffer.from(storeKeyHex, "hex"),
        Buffer.alloc(0),
        "voice-memory/receipt-signer/v1",
        32,
      ),
    );
  else {
    seed = randomBytes(32);
    ephemeral = true;
  }
  const privateKey = createPrivateKey({
    key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]),
    format: "der",
    type: "pkcs8",
  });
  seed.fill(0);
  const publicKey = createPublicKey(privateKey);
  const spki = publicKey.export({ format: "der", type: "spki" });
  const kid =
    "vmk_" + createHash("sha256").update(spki).digest("hex").slice(0, 16);
  const publicPem = publicKey.export({ format: "pem", type: "spki" });
  return {
    kid,
    ephemeral,
    /** The only key material ever exposed. */
    publicKeys: () => [
      { kid, alg: "Ed25519", publicKeyPem: publicPem, ephemeral },
    ],
    sign(body) {
      const unsigned = { ...body, schema: RECEIPT_SCHEMA, kid };
      const sig = sign(
        null,
        Buffer.from(canonical(unsigned), "utf8"),
        privateKey,
      ).toString("base64url");
      return { ...unsigned, signature: sig };
    },
  };
}

/** Verify a receipt against a PEM public key. Returns { ok, reason }. */
export function verifyReceipt(receipt, publicKeyPem) {
  if (!receipt || typeof receipt !== "object")
    return { ok: false, reason: "not a receipt" };
  const { signature, ...unsigned } = receipt;
  if (unsigned.schema !== RECEIPT_SCHEMA)
    return { ok: false, reason: `unknown schema ${unsigned.schema}` };
  if (typeof signature !== "string")
    return { ok: false, reason: "no signature" };
  let ok = false;
  try {
    ok = verify(
      null,
      Buffer.from(canonical(unsigned), "utf8"),
      createPublicKey(publicKeyPem),
      Buffer.from(signature, "base64url"),
    );
  } catch {
    return { ok: false, reason: "bad key or signature encoding" };
  }
  return ok
    ? { ok: true, reason: null }
    : { ok: false, reason: "signature does not match" };
}
