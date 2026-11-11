// First customer example: a fictional motor insurer (Harborline, DriveSure)
// whose policy wording changed on 2026-04-01. Which wording applies depends
// on the caller's policy issue date (verified account data from the tenant
// backend), not on which document is newest.
//
//   - two customers, same question, two correct answers
//   - unknown applicability: a clarification, no number, nothing stored
//   - a returning caller whose renewed policy now follows the 2026 wording:
//     recall says it changed and why, with a source-linked receipt
//   - the caller's language preference never changes the amount
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createCallerIdentity } from "../memory/caller-identity.mjs";

const T = {
  apiKey: "f6".repeat(32),
  voiceKey: "voice-key-harborline-0123456789abcdef",
  caller: "a7".repeat(32),
};
const signer = createCallerIdentity({
  keys: { harborline_k1: { secret: T.caller, tenant: "harborline" } },
});
const meera = () =>
  signer.issue({
    kid: "harborline_k1",
    tenant: "harborline",
    sub: "pol-DS-25-0412",
    amr: "otp",
  });
const kabir = () =>
  signer.issue({
    kid: "harborline_k1",
    tenant: "harborline",
    sub: "pol-DS-26-0907",
    amr: "otp",
  });
const ENV = {
  VM_TENANTS: JSON.stringify({
    harborline: {
      apiKey: T.apiKey,
      voiceKey: T.voiceKey,
      cases: ["insurance"],
      callerKeys: { k1: T.caller },
    },
  }),
  VM_DATA_DIR: mkdtempSync(path.join(tmpdir(), "vm-ins-")),
  VM_STORE_KEY: "88".repeat(32),
  VM_CALLER_REQUIRE_DURABLE: "on",
  VM_DENSE: "off",
  VM_GEMINI: "off",
  VM_RSS_WATCHDOG: "off",
};
const saved = {};
let S;
before(async () => {
  for (const [k, v] of Object.entries(ENV)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
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
async function api(method, p, body) {
  const res = await fetch(S.base + "/v1" + p, {
    method,
    headers: {
      authorization: "Bearer " + T.apiKey,
      "content-type": "application/json",
      ...(method !== "GET" ? { "idempotency-key": "i" + ++n } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}
const call = async (assertion, policyIssuedOn) =>
  (
    await api("POST", "/calls", {
      provider: "bolna",
      scope: { case: "insurance" },
      permissions: { recall: true, remember: true, record: true },
      caller: { assertion },
      ...(policyIssuedOn ? { applicability: { policyIssuedOn } } : {}),
    })
  ).body.call.callId;
const Q = "What is my windscreen excess?";

test("same question, two customers, two correct answers", async () => {
  const a = await api(
    "POST",
    `/calls/${await call(meera(), "2025-09-14")}/answer`,
    { question: Q },
  );
  const b = await api(
    "POST",
    `/calls/${await call(kabir(), "2026-06-02")}/answer`,
    { question: Q },
  );
  assert.match(a.body.verified.text, /₹1,000/);
  assert.equal(a.body.verified.scope.appliedDocuments, "insurance-2025");
  assert.ok(
    a.body.verified.citations.some((c) => /Wording_2025/.test(c.title)),
  );
  assert.match(b.body.verified.text, /₹2,500/);
  assert.equal(b.body.verified.scope.appliedDocuments, "insurance-2026");
  assert.ok(
    b.body.verified.citations.some((c) => /Wording_2026/.test(c.title)),
  );
  // Source-linked, signed audit receipt naming the documents that applied.
  assert.equal(a.body.receipt.scope.appliedDocuments, "insurance-2025");
  assert.ok(a.body.receipt.citations.some((s) => /Wording_2025/.test(s.title)));
  assert.ok(a.body.receipt.signature);
});

test("unknown policy date: a clarification, never a guessed amount, nothing remembered", async () => {
  const id = await call(meera(), null);
  await api("POST", `/calls/${id}/consent`, { conversation: true });
  const r = await api("POST", `/calls/${id}/answer`, { question: Q });
  assert.equal(r.body.verified.kind, "clarify");
  assert.equal(r.body.verified.text, null);
  assert.doesNotMatch(JSON.stringify(r.body.verified), /₹/);
  assert.match(
    r.body.verified.clarification,
    /when your DriveSure policy was issued/,
  );
  const t = await api("POST", `/calls/${id}/turns`, {
    turnId: "u1",
    question: Q,
  });
  assert.equal(t.body.recorded, false, "a clarification is not a memory");
});

test("returning caller after renewal: recalled, rechecked under the wording that now applies", async () => {
  // Call one: 2025 policy; Hinglish preference; asks about the excess.
  const c1 = await call(meera(), "2025-09-14");
  await api("POST", `/calls/${c1}/preferences`, {
    key: "language",
    value: "hinglish",
    consent: "caller_explicit",
  });
  await api("POST", `/calls/${c1}/consent`, { conversation: true });
  const t1 = await api("POST", `/calls/${c1}/turns`, {
    turnId: "c1-1",
    question: Q,
    spoken: "Aapka windscreen excess ₹1,000 hai.",
  });
  assert.equal(t1.body.recorded, true);
  assert.equal(t1.body.episode.scope.applied, "insurance-2025");
  await api("POST", `/calls/${c1}/end`, {});

  // Call two, same policy: unchanged.
  const c2 = await call(meera(), "2025-09-14");
  const ctx2 = await api("GET", `/calls/${c2}/context`);
  assert.equal(ctx2.body.preferences.language.value, "hinglish");
  assert.equal(ctx2.body.rechecked[0].subject.label, "your windscreen excess");
  assert.equal(ctx2.body.rechecked[0].statusChanged, false);
  assert.equal(ctx2.body.rechecked[0].applicabilityChanged, false);
  await api("POST", `/calls/${c2}/end`, {});

  // Call three, after renewal on 2026-09-14 (tenant account data).
  const c3 = await call(meera(), "2026-09-14");
  const ctx3 = await api("GET", `/calls/${c3}/context`);
  const r = ctx3.body.rechecked[0];
  assert.equal(r.applicabilityChanged, true);
  assert.equal(r.statusChanged, true);
  assert.match(r.verified.text, /₹2,500/);
  assert.equal(r.verified.scope.appliedDocuments, "insurance-2026");
  const ans = await api("POST", `/calls/${c3}/answer`, { question: Q });
  assert.equal(ans.body.changedSince.applicabilityChanged, true);
  assert.match(ans.body.changedSince.previously.line, /₹1,000/);
  assert.match(
    ans.body.changedSince.why,
    /A different document set now applies[\s\S]*2026 wording/,
  );
  // The remembered preference did not touch the amount.
  assert.match(ans.body.verified.text, /₹2,500/);
});

test("C4: a voice-recorded turn and an API recall store and compare the same scope", async () => {
  const c1 = await call(meera(), "2025-09-14");
  await api("POST", `/calls/${c1}/consent`, { conversation: true });
  const token = (await api("GET", `/calls/${c1}/context`)).body.call
    ? null
    : null;
  void token;
  // Start a call whose token we keep, and speak one turn through the
  // Bolna-shaped custom-LLM route.
  const started = await api("POST", "/calls", {
    provider: "bolna",
    scope: { case: "insurance" },
    permissions: { recall: true, remember: true, record: true },
    caller: { assertion: meera() },
    applicability: { policyIssuedOn: "2025-09-14" },
  });
  const vc = started.body.call.callId;
  await api("POST", `/calls/${vc}/consent`, { conversation: true });
  const res = await fetch(S.base + "/v1/chat/completions", {
    method: "POST",
    headers: {
      authorization: "Bearer " + T.voiceKey,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "vm",
      stream: true,
      messages: [
        {
          role: "system",
          content: `Harborline support. vm_call=${started.body.providerUserData.vm_call}.`,
        },
        { role: "user", content: Q },
      ],
    }),
  });
  assert.match(await res.text(), /1,000/);
  await new Promise((r) => setTimeout(r, 50)); // recorded on response finish
  const mem = (await api("GET", `/calls/${vc}/memory`)).body.memory;
  const voiceEp = mem.episodes.find((e) => e.turnKey?.startsWith("voice:"));
  assert.ok(voiceEp, "the spoken turn was recorded");
  assert.equal(
    voiceEp.delivery,
    "stream_completed",
    "observed delivery, never 'heard'",
  );
  assert.equal(
    voiceEp.scope.applied,
    "insurance-2025",
    "voice path keeps the applied wording",
  );
  await api("POST", `/calls/${vc}/end`, {});
  // Next call, same policy: the API recall must not report a change.
  const c2 = await call(meera(), "2025-09-14");
  const r = (await api("GET", `/calls/${c2}/context`)).body.rechecked.find(
    (x) => x.subject.id === "policy.windscreen_excess",
  );
  assert.equal(r.applicabilityChanged, false);
  assert.equal(r.sourceChanged, false);
  assert.equal(r.statusChanged, false);
});
