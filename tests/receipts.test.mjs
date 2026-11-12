// Workstream D: receipts signed by a server-private Ed25519 key, checkable
// by anyone with the published public key, bound to the exact question,
// admitted answer, cited spans, scope, outcome and unresolved parts.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHmac, generateKeyPairSync, sign } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createCallerIdentity } from "../memory/caller-identity.mjs";
import { canonical, digest, verifyReceipt } from "../memory/receipt-signer.mjs";

const T = {
  apiKey: "9a".repeat(32),
  voiceKey: "voice-key-receipts-0123456789abcdef",
  caller: "8b".repeat(32),
};
const signer = createCallerIdentity({
  keys: { harborline_k1: { secret: T.caller, tenant: "harborline" } },
});
const work = mkdtempSync(path.join(tmpdir(), "vm-rcpt-"));
const ENV = {
  VM_TENANTS: JSON.stringify({
    harborline: {
      apiKey: T.apiKey,
      voiceKey: T.voiceKey,
      cases: ["insurance"],
      callerKeys: { k1: T.caller },
    },
  }),
  VM_DATA_DIR: path.join(work, "data"),
  VM_STORE_KEY: "6c".repeat(32),
  VM_DENSE: "off",
  VM_GEMINI: "off",
  VM_RSS_WATCHDOG: "off",
};
const saved = {};
let S;
before(async () => {
  for (const [k, v] of Object.entries(ENV))
    ((saved[k] = process.env[k]), (process.env[k] = v));
  const { createLocalServer } = await import("../src/server.mjs");
  const server = createLocalServer({ port: 0 });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  await server.loadPublicCases();
  S = { server, base: `http://127.0.0.1:${server.address().port}` };
});
after(() => {
  S?.server.close();
  for (const [k, v] of Object.entries(saved))
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
});
let n = 0;
const api = async (method, p, body) => {
  const res = await fetch(S.base + "/v1" + p, {
    method,
    headers: {
      authorization: "Bearer " + T.apiKey,
      "content-type": "application/json",
      ...(method !== "GET" ? { "idempotency-key": "r" + ++n } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return res.json();
};
const Q = "What is my windscreen excess?";
async function answered() {
  const c = await api("POST", "/calls", {
    scope: { case: "insurance" },
    permissions: { recall: true },
    caller: {
      assertion: signer.issue({
        kid: "harborline_k1",
        tenant: "harborline",
        sub: "pol-9",
        amr: "otp",
      }),
    },
    applicability: { policyIssuedOn: "2026-05-01" },
  });
  return api("POST", `/calls/${c.call.callId}/answer`, { question: Q });
}

test("an answer receipt verifies with the published key and binds question, answer and spans", async () => {
  const a = await answered();
  const r = a.receipt;
  const { keys } = await fetch(S.base + "/v1/receipts/keys").then((x) =>
    x.json(),
  );
  assert.equal(keys.length, 1);
  assert.equal(keys[0].alg, "Ed25519");
  assert.equal(
    keys[0].ephemeral,
    false,
    "derived from VM_STORE_KEY: stable across restarts",
  );
  assert.doesNotMatch(
    JSON.stringify(keys),
    /PRIVATE/,
    "no private key material is ever served",
  );
  assert.equal(r.kid, keys[0].kid);
  assert.deepEqual(verifyReceipt(r, keys[0].publicKeyPem), {
    ok: true,
    reason: null,
  });
  assert.equal(r.questionDigest, digest(Q));
  assert.equal(r.answerDigest, digest(a.verified.say));
  assert.equal(r.citations.length, a.verified.citations.length);
  assert.equal(
    r.citations[0].quoteDigest,
    digest(a.verified.citations[0].quote),
  );
  assert.equal(r.scope.appliedDocuments, "insurance-2026");
  assert.ok(r.scope.sourceVersion);
  assert.equal(r.outcome.kind, a.verified.kind);
  assert.ok(Array.isArray(r.outcome.unresolved));
  assert.equal(r.schema, "vm-receipt/2");
});

test("any tampering, a wrong key or a tenant-made signature fails", async () => {
  const { receipt: r } = await answered();
  const { keys } = await fetch(S.base + "/v1/receipts/keys").then((x) =>
    x.json(),
  );
  for (const mutate of [
    (x) => (x.outcome.verdict = "CONFIRMED"),
    (x) => (x.scope.appliedDocuments = "insurance-2025"),
    (x) =>
      (x.answerDigest = digest("The windscreen excess is ₹1,000 per claim.")),
    (x) => (x.citations[0].quoteDigest = digest("forged")),
    (x) => (x.outcome.unresolved = []),
    (x) => (x.tenant = "other"),
    (x) => (x.at = "2020-01-01T00:00:00.000Z"),
  ]) {
    const t = structuredClone(r);
    mutate(t);
    assert.equal(verifyReceipt(t, keys[0].publicKeyPem).ok, false);
  }
  const other = generateKeyPairSync("ed25519");
  assert.equal(
    verifyReceipt(r, other.publicKey.export({ format: "pem", type: "spki" }))
      .ok,
    false,
  );
  // The old scheme: anything a tenant can compute from its API key.
  const { signature, ...unsigned } = r;
  void signature;
  const hmac = createHmac(
    "sha256",
    createHmac("sha256", T.apiKey).update("vm-receipt-v1").digest(),
  )
    .update(canonical(unsigned))
    .digest("base64url");
  assert.equal(
    verifyReceipt({ ...unsigned, signature: hmac }, keys[0].publicKeyPem).ok,
    false,
  );
  // A tenant's own Ed25519 key cannot stand in for the server's.
  const forged = {
    ...unsigned,
    signature: sign(
      null,
      Buffer.from(canonical(unsigned)),
      other.privateKey,
    ).toString("base64url"),
  };
  assert.equal(verifyReceipt(forged, keys[0].publicKeyPem).ok, false);
});

test("the standalone verifier: pass on the real thing, fail on tampering", async () => {
  const a = await answered();
  const { keys } = await fetch(S.base + "/v1/receipts/keys").then((x) =>
    x.json(),
  );
  const rp = path.join(work, "r.json");
  const kp = path.join(work, "k.pem");
  writeFileSync(rp, JSON.stringify(a.receipt));
  writeFileSync(kp, keys[0].publicKeyPem);
  const run = promisify(execFile);
  const root = new URL("..", import.meta.url).pathname;
  const okRun = await run(
    process.execPath,
    [
      "scripts/verify-receipt.mjs",
      rp,
      kp,
      "--question",
      Q,
      "--answer",
      a.verified.say,
      "--quote",
      a.verified.citations[0].quote,
    ],
    { cwd: root },
  );
  assert.match(okRun.stdout, /PASS  signature/);
  assert.doesNotMatch(okRun.stdout, /FAIL/);
  writeFileSync(
    rp,
    JSON.stringify({
      ...a.receipt,
      outcome: { ...a.receipt.outcome, verdict: "CONFIRMED" },
    }),
  );
  await assert.rejects(
    run(process.execPath, ["scripts/verify-receipt.mjs", rp, kp], {
      cwd: root,
    }),
    (e) => e.code === 1 && /FAIL  signature/.test(e.stdout),
  );
  writeFileSync(rp, JSON.stringify(a.receipt));
  await assert.rejects(
    run(
      process.execPath,
      [
        "scripts/verify-receipt.mjs",
        rp,
        kp,
        "--answer",
        "The windscreen excess is ₹1,000 per claim.",
      ],
      { cwd: root },
    ),
    (e) => e.code === 1 && /FAIL  answer/.test(e.stdout),
  );
});
