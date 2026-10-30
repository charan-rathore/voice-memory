// Lifecycle redesign regression suite (T01-T15), from the adversarial
// consultation decision: sweep/eviction RELEASES a fixed credential's grant
// but must not RETIRE the credential; a valid fixed credential rebinds at
// completions admission; grants are renewable leases up to an immutable hard
// expiry; only explicit owner reset retires permanently.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createVoiceAdapter } from "../voice-adapter.mjs";
import { importBundle } from "../dist/engine.mjs";

const FIXED = "f".repeat(48);
const b = () =>
  importBundle([
    {
      title: "Security review",
      text: "Pilot launch is proposed for Tuesday. Security sign-off is pending. Maya owns the security review.",
    },
  ]);
const completions = (token, text = "pilot launch security review") =>
  new Request("http://localhost/v1/chat/completions", {
    method: "POST",
    headers: { authorization: "Bearer " + token },
    body: JSON.stringify({
      stream: true,
      messages: [{ role: "user", content: text }],
    }),
  });
const models = (token, method = "GET") =>
  new Request("http://localhost/v1/models", {
    method,
    headers: { authorization: "Bearer " + token },
  });
const clock = (start = 1000) => {
  let t = start;
  return { now: () => t, set: (v) => (t = v), add: (v) => (t += v) };
};

test("T01/T02: sweep or eviction release lets the same fixed credential rebind at admission", async () => {
  const c = clock();
  const a = createVoiceAdapter({ ttlMs: 1000, now: c.now });
  a.bind(b(), FIXED);
  a.release(FIXED); // what the session sweep/eviction now does
  const r = await a.handle(completions(FIXED));
  assert.equal(r.status, 200);
  await r.text();
});

test("T03: a stale release observed before a rebind cannot kill the newer grant", async () => {
  const c = clock();
  const a = createVoiceAdapter({ ttlMs: 1000, now: c.now });
  a.bind(b(), FIXED);
  const g0 = a.grantGeneration(FIXED);
  a.release(FIXED, g0); // legitimate sweep of the observed generation
  const r1 = await a.handle(completions(FIXED)); // admission rebinds: newer grant
  assert.equal(r1.status, 200);
  await r1.text();
  a.release(FIXED, g0); // stale cleanup targeting the pre-rebind generation
  assert.equal(a.isBound(FIXED), true, "newer grant survived stale release");
  const r2 = await a.handle(completions(FIXED));
  assert.equal(r2.status, 200);
  await r2.text();
});

test("T03b: sweep guard leaves a recently active grant (live call) alone", async () => {
  const c = clock();
  const a = createVoiceAdapter({ ttlMs: 1000, now: c.now });
  a.bind(b(), FIXED);
  const r1 = await a.handle(completions(FIXED));
  assert.equal(r1.status, 200);
  await r1.text();
  c.add(100); // 100ms since admission, inside a 10-minute active-call guard
  a.releaseIdle(FIXED, 600000);
  assert.equal(a.isBound(FIXED), true, "active grant protected from sweep");
  c.add(700000); // now idle past the guard
  a.releaseIdle(FIXED, 600000);
  assert.equal(a.isBound(FIXED), false, "idle grant released by sweep");
});

test("T04: an authorized completion renews the lease instead of letting it lapse mid-use", async () => {
  const c = clock();
  const a = createVoiceAdapter({ ttlMs: 100, now: c.now });
  a.bind(b(), FIXED);
  c.set(1050); // 50ms into the 100ms lease
  const r1 = await a.handle(completions(FIXED));
  assert.equal(r1.status, 200);
  await r1.text();
  c.set(1130); // 80ms after renewal: past the ORIGINAL expiry (1100), inside renewed lease
  const r2 = await a.handle(completions(FIXED));
  assert.equal(r2.status, 200);
  await r2.text();
});

test("T05: after a lapsed lease a valid credential obtains a fresh grant", async () => {
  const c = clock();
  const a = createVoiceAdapter({ ttlMs: 100, now: c.now });
  a.bind(b(), FIXED);
  c.set(2000); // lease long dead
  const r = await a.handle(completions(FIXED));
  assert.equal(r.status, 200);
  await r.text();
});

test("T07: after the credential's hard expiry: 401 and no rebind", async () => {
  const c = clock();
  const a = createVoiceAdapter({ ttlMs: 100, now: c.now, hardTtlMs: 200 });
  a.bind(b(), FIXED);
  c.set(1201); // past hard expiry (1000 + 200)
  const r = await a.handle(completions(FIXED));
  assert.equal(r.status, 401);
  a.release(FIXED);
  const r2 = await a.handle(completions(FIXED));
  assert.equal(r2.status, 401);
});

test("T08: explicit retirement is permanent: 401 forever, rebinding throws", async () => {
  const c = clock();
  const a = createVoiceAdapter({ ttlMs: 1000, now: c.now });
  a.bind(b(), FIXED);
  a.retire(FIXED);
  const r = await a.handle(completions(FIXED));
  assert.equal(r.status, 401);
  assert.throws(() => a.bind(b(), FIXED), /retired/i);
  const r2 = await a.handle(completions(FIXED));
  assert.equal(r2.status, 401);
});

test("T09: unknown and wrong-length capabilities stay 401", async () => {
  const a = createVoiceAdapter({ ttlMs: 1000 });
  assert.equal((await a.handle(completions("x".repeat(48)))).status, 401);
  assert.equal((await a.handle(completions("short"))).status, 401);
});

test("T13: GET /v1/models validates a credential without creating or renewing a grant", async () => {
  const c = clock();
  const a = createVoiceAdapter({ ttlMs: 100, now: c.now });
  a.bind(b(), FIXED);
  a.release(FIXED); // no live grant
  const r = await a.handle(models(FIXED));
  assert.equal(r.status, 200);
  assert.equal(a.isBound(FIXED), false, "models must not create a grant");
});

test("T14: POST /v1/models is 405, never dispatched into completions", async () => {
  const a = createVoiceAdapter({ ttlMs: 1000 });
  a.bind(b(), FIXED);
  const r = await a.handle(models(FIXED, "POST"));
  assert.equal(r.status, 405);
});

test("T15: lease expiry alone does not kill an admitted in-flight response", async () => {
  const c = clock();
  const a = createVoiceAdapter({ ttlMs: 50, now: c.now });
  a.bind(b(), FIXED);
  c.add(10);
  const r = await a.handle(completions(FIXED)); // admitted at t=1010
  c.add(100); // lease lapses mid-flight
  assert.equal(r.status, 200);
  const text = await r.text();
  assert.match(text, /data: \[DONE\]/);
});

test("T15b: explicit retirement DOES cut an in-flight request", async () => {
  const c = clock();
  const a = createVoiceAdapter({ ttlMs: 5000, now: c.now });
  a.bind(b(), FIXED);
  const slow = new Request("http://localhost/v1/chat/completions", {
    method: "POST",
    headers: { authorization: "Bearer " + FIXED },
    body: JSON.stringify({
      stream: true,
      messages: [{ role: "user", content: "pilot launch security review" }],
    }),
  });
  const p = a.handle(slow);
  a.retire(FIXED); // owner resets while the turn is being prepared
  const r = await p;
  assert.equal(r.status, 401);
});

test("T16: fixed credential hard expiry is an externally pinned absolute time", async () => {
  const c = clock();
  const a = createVoiceAdapter({
    ttlMs: 100,
    now: c.now,
    hardExpiresAtMs: 1200,
  });
  a.bind(b(), FIXED);
  // Lapse the grant; admission rebinds but keeps the SAME absolute expiry,
  // never a fresh one derived from the later time.
  c.set(1150);
  assert.equal((await a.handle(completions(FIXED))).status, 200);
  // Past the pinned instant the credential is dead, and a "restarted"
  // adapter configured with the same pinned value cannot resurrect it.
  c.set(1200);
  assert.throws(() => a.bind(b(), FIXED), /hard expiry/);
  const restarted = createVoiceAdapter({
    ttlMs: 100,
    now: c.now,
    hardExpiresAtMs: 1200,
  });
  assert.throws(() => restarted.bind(b(), FIXED), /hard expiry/);
});

test("T17: retarget on re-import is atomic and rejects in-flight old-generation requests", async () => {
  const c = clock();
  const a = createVoiceAdapter({
    ttlMs: 1000,
    now: c.now,
    hardExpiresAtMs: 5000,
  });
  const v1 = b();
  a.bind(v1, FIXED);
  // In-flight request on the OLD grant: body pending.
  let controller;
  const body = new ReadableStream({
    start(ctrl) {
      controller = ctrl;
    },
  });
  const pending = a.handle(
    new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { authorization: "Bearer " + FIXED },
      body,
      duplex: "half",
    }),
  );
  // Owner re-imports: retarget to v2.
  assert.equal(a.retarget(FIXED, b()), true);
  controller.enqueue(
    new TextEncoder().encode(
      JSON.stringify({
        stream: true,
        messages: [{ role: "user", content: "pilot launch" }],
      }),
    ),
  );
  controller.close();
  // The old-generation request must reject, never answer from stale corpus.
  assert.equal((await pending).status, 401);
  // Admission rebinds to v2.
  assert.equal((await a.handle(completions(FIXED))).status, 200);
  // Retarget refuses on a retired credential (no resurrection).
  a.retire(FIXED);
  assert.equal(a.retarget(FIXED, b()), false);
  assert.equal((await a.handle(completions(FIXED))).status, 401);
});
