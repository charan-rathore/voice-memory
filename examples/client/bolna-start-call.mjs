#!/usr/bin/env node
// Tenant-backend side of a REAL Bolna call bound to Voice Memory.
//
// 1. Your backend has authenticated the caller and signs an assertion.
// 2. POST /v1/calls (your Voice Memory tenant key) -> callToken.
// 3. POST https://api.bolna.ai/call with user_data { vm_call } (your Bolna
//    API key). The agent's SYSTEM prompt must contain "vm_call={vm_call}".
//
// Dry run by default: prints both requests with secrets redacted and sends
// nothing to Bolna. --live places the call (owner action, real phone).
//
// Env: VM_BASE_URL VM_TENANT VM_API_KEY VM_CALLER_KID VM_CALLER_KEY
//      VM_CALLER_SUB (a FICTIONAL account id) VM_SCOPE (default "deal")
//      VM_POLICY_ISSUED_ON (insurance only)
//      BOLNA_API_KEY BOLNA_AGENT_ID BOLNA_TO (your own test phone, E.164)
import { createCallerIdentity } from "../../memory/caller-identity.mjs";
import { VoiceMemory } from "./voice-memory-client.mjs";

const live = process.argv.includes("--live");
const need = (k) => {
  if (!process.env[k]) {
    console.error(`missing ${k}`);
    process.exit(2);
  }
  return process.env[k];
};
const redact = (s) =>
  typeof s === "string" && s.length > 12
    ? `${s.slice(0, 8)}…(${s.length} chars)`
    : "…";

const signer = createCallerIdentity({
  keys: {
    [need("VM_CALLER_KID")]: {
      secret: need("VM_CALLER_KEY"),
      tenant: need("VM_TENANT"),
    },
  },
});
const assertion = signer.issue({
  kid: process.env.VM_CALLER_KID,
  tenant: process.env.VM_TENANT,
  sub: need("VM_CALLER_SUB"),
  amr: "otp",
});
const vm = new VoiceMemory({
  baseUrl: need("VM_BASE_URL"),
  apiKey: need("VM_API_KEY"),
});
const scope = process.env.VM_SCOPE || "deal";
const started = await vm.startCall({
  scope: { case: scope },
  callerAssertion: assertion,
  ...(process.env.VM_POLICY_ISSUED_ON
    ? { applicability: { policyIssuedOn: process.env.VM_POLICY_ISSUED_ON } }
    : {}),
});
console.log(
  `Voice Memory call ${started.call.callId} · verified=${started.call.verified} · expires ${started.call.expiresAt}`,
);
const bolnaBody = {
  agent_id: need("BOLNA_AGENT_ID"),
  recipient_phone_number: need("BOLNA_TO"),
  user_data: started.providerUserData,
};
console.log(
  "POST https://api.bolna.ai/call",
  JSON.stringify({
    ...bolnaBody,
    recipient_phone_number: redact(bolnaBody.recipient_phone_number),
    user_data: { vm_call: redact(bolnaBody.user_data.vm_call) },
  }),
);
if (!live) {
  console.log("(dry run: nothing sent to Bolna; ending the Voice Memory call)");
  await vm.endCall(started.call.callId);
  process.exit(0);
}
const r = await fetch("https://api.bolna.ai/call", {
  method: "POST",
  headers: {
    authorization: `Bearer ${need("BOLNA_API_KEY")}`,
    "content-type": "application/json",
  },
  body: JSON.stringify(bolnaBody),
});
const j = await r.json().catch(() => ({}));
console.log(
  `Bolna ${r.status}: execution_id=${j.execution_id ?? "?"} status=${j.status ?? "?"}`,
);
console.log(
  `When the call ends: node -e "…" or POST /v1/calls/${started.call.callId}/end (the token then stops working).`,
);
