#!/usr/bin/env node
// One-minute demo of Voice Memory for a voice-agent developer.
//
//   node examples/client/returning-caller-demo.mjs
//
// Boots a local Voice Memory server with a FICTIONAL tenant (Harborline
// Assurance) and plays three calls from one fictional customer through the
// API a voice agent would use. Nothing leaves this machine; no phone call is
// placed. Pass VM_DEMO_BASE_URL + VM_DEMO_API_KEY + VM_DEMO_CALLER_KEY to run
// it against your own staging server instead.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { createCallerIdentity } from "../../memory/caller-identity.mjs";
import { VoiceMemory } from "./voice-memory-client.mjs";

const apiKey = process.env.VM_DEMO_API_KEY ?? randomBytes(32).toString("hex");
const callerKey =
  process.env.VM_DEMO_CALLER_KEY ?? randomBytes(32).toString("hex");
let baseUrl = process.env.VM_DEMO_BASE_URL;
let server = null;
if (!baseUrl) {
  Object.assign(process.env, {
    VM_TENANTS: JSON.stringify({
      harborline: {
        apiKey,
        voiceKey: randomBytes(24).toString("hex"),
        cases: ["insurance"],
        callerKeys: { k1: callerKey },
      },
    }),
    VM_DATA_DIR: mkdtempSync(path.join(tmpdir(), "vm-demo-")),
    VM_STORE_KEY: randomBytes(32).toString("hex"),
    VM_CALLER_REQUIRE_DURABLE: "on",
    VM_DENSE: "off",
    VM_GEMINI: "off",
    VM_RSS_WATCHDOG: "off",
    VM_COUNTERS_ALLOW_FILE: "on",
  });
  const { createLocalServer } = await import("../../src/server.mjs");
  server = createLocalServer({ port: 0 });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  await server.loadPublicCases();
  baseUrl = `http://127.0.0.1:${server.address().port}`;
}

// Your backend already authenticated the caller (login, OTP). It signs a
// short-lived assertion; Voice Memory never trusts a phone number.
const signer = createCallerIdentity({
  keys: { harborline_k1: { secret: callerKey, tenant: "harborline" } },
});
const meera = () =>
  signer.issue({
    kid: "harborline_k1",
    tenant: "harborline",
    sub: "pol-DS-25-0412",
    name: "Meera (fictional)",
    amr: "otp",
  });
const vm = new VoiceMemory({ baseUrl, apiKey });
const say = (who, text) => console.log(`  ${who.padEnd(8)} ${text}`);
const Q = "What is my windscreen excess?";

console.log("\nCALL 1 — Meera, policy issued 14 Sep 2025");
let c = await vm.startCall({
  scope: { case: "insurance" },
  callerAssertion: meera(),
  applicability: { policyIssuedOn: "2025-09-14" },
});
console.log(
  `  (give Bolna user_data = ${JSON.stringify({ vm_call: c.providerUserData.vm_call.slice(0, 12) + "…" })})`,
);
say("Caller", "Please remember I prefer Hinglish, and remember this call.");
await vm.rememberPreference(c.call.callId, "language", "hinglish");
await vm.setConversationConsent(c.call.callId, true);
say("Caller", Q);
let a = await vm.answer(c.call.callId, Q);
say(
  "Agent",
  `${a.verified.text}   [${a.verified.citations[0]?.title}, ${a.verified.scope.appliedDocuments}]`,
);
await vm.recordTurn(c.call.callId, {
  turnId: "c1-t1",
  question: Q,
  spoken: a.verified.text,
});
await vm.endCall(c.call.callId);

console.log("\nCALL 2 — same caller, new call, nothing changed");
c = await vm.startCall({
  scope: { case: "insurance" },
  callerAssertion: meera(),
  applicability: { policyIssuedOn: "2025-09-14" },
});
let ctx = await vm.context(c.call.callId);
say(
  "Memory",
  `language=${ctx.preferences.language?.value}; last time: “${ctx.rechecked[0].previously.question}”`,
);
say(
  "Recheck",
  `${ctx.rechecked[0].statusChanged ? "CHANGED" : "unchanged"} → ${ctx.rechecked[0].verified.text}`,
);
await vm.endCall(c.call.callId);

console.log(
  "\nCALL 3 — policy renewed 14 Sep 2026 (your CRM says so, not the caller)",
);
c = await vm.startCall({
  scope: { case: "insurance" },
  callerAssertion: meera(),
  applicability: { policyIssuedOn: "2026-09-14" },
});
ctx = await vm.context(c.call.callId);
say(
  "Recheck",
  `${ctx.rechecked[0].statusChanged ? "CHANGED" : "unchanged"} → ${ctx.rechecked[0].verified.text}`,
);
a = await vm.answer(c.call.callId, Q);
say("Why", a.changedSince.why);
say(
  "Receipt",
  `${a.receipt.id} · ${a.receipt.scope.appliedDocuments} · ${a.receipt.citations.map((s) => s.title).join(", ")} · sig ${a.receipt.signature.slice(0, 10)}…`,
);

console.log("\nNO POLICY DATE — the agent must ask, not guess");
c = await vm.startCall({
  scope: { case: "insurance" },
  callerAssertion: meera(),
});
a = await vm.answer(c.call.callId, Q);
say("Agent", a.verified.clarification);

console.log("\nDELETE — the caller asks to be forgotten");
await vm.forget(c.call.callId, { all: true });
say(
  "Memory",
  JSON.stringify((await vm.memory(c.call.callId)).memory.preferences),
);
server?.close();
console.log("");
