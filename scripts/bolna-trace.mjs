#!/usr/bin/env node
// Produce a SANITIZED, SIMULATED trace of two Bolna-shaped calls for one
// fictional verified caller: the tenant-backend requests, the exact
// custom-LLM requests Bolna sends (OpenAI chat completions, Bearer key,
// vm_call in the system prompt) and Voice Memory's responses.
//
//   node scripts/bolna-trace.mjs [out.md]
//
// No Bolna call is placed. Secrets are redacted. Exits non-zero if the call
// token ever appears in anything that would be spoken.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { createCallerIdentity } from "../memory/caller-identity.mjs";

const out = process.argv[2] ?? null;
const apiKey = randomBytes(32).toString("hex");
const voiceKey = randomBytes(24).toString("hex");
const callerKey = randomBytes(32).toString("hex");
Object.assign(process.env, {
  VM_TENANTS: JSON.stringify({
    meridian: {
      apiKey,
      voiceKey,
      cases: ["deal"],
      callerKeys: { k1: callerKey },
    },
  }),
  VM_DATA_DIR: mkdtempSync(path.join(tmpdir(), "vm-trace-")),
  VM_STORE_KEY: randomBytes(32).toString("hex"),
  VM_CALLER_REQUIRE_DURABLE: "on",
  VM_DENSE: "off",
  VM_GEMINI: "off",
  VM_RSS_WATCHDOG: "off",
  VM_COUNTERS_ALLOW_FILE: "on",
});
const { createLocalServer } = await import("../src/server.mjs");
const server = createLocalServer({ port: 0 });
await new Promise((r) => server.listen(0, "127.0.0.1", r));
await server.loadPublicCases();
const base = `http://127.0.0.1:${server.address().port}`;
const signer = createCallerIdentity({
  keys: { meridian_k1: { secret: callerKey, tenant: "meridian" } },
});
const assertion = () =>
  signer.issue({
    kid: "meridian_k1",
    tenant: "meridian",
    sub: "acct-FICTIONAL-1042",
    amr: "otp",
  });

const tokens = new Set();
const SECRET = new RegExp([apiKey, voiceKey, callerKey].join("|"), "g");
const scrub = (v) =>
  JSON.parse(
    JSON.stringify(v)
      .replace(SECRET, "<redacted-key>")
      .replace(/vmca1\.[A-Za-z0-9_.-]+/g, "<redacted-caller-assertion>")
      .replace(/vmc_[0-9a-f]{48}/g, "vmc_<redacted>")
      .replace(/"signature":"[^"]+"/g, '"signature":"<ed25519…>"'),
  );
const lines = [];
const log = (title, req, res, ms) =>
  lines.push({ title, req: scrub(req), res: scrub(res), ms });
let k = 0;
async function api(method, p, body) {
  const t0 = performance.now();
  const r = await fetch(base + "/v1" + p, {
    method,
    headers: {
      authorization: "Bearer " + apiKey,
      "content-type": "application/json",
      ...(method !== "GET" ? { "idempotency-key": "trace-" + ++k } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const j = await r.json();
  log(
    `${method} /v1${p}`,
    {
      headers: {
        authorization: "Bearer <tenant API key>",
        "idempotency-key": method !== "GET" ? `trace-${k}` : undefined,
      },
      body,
    },
    { status: r.status, body: j },
    Math.round(performance.now() - t0),
  );
  if (j?.providerUserData?.vm_call) tokens.add(j.providerUserData.vm_call);
  return j;
}
async function bolna(token, turns, title) {
  const body = {
    model: "voice-memory",
    stream: true,
    messages: [
      {
        role: "system",
        content: `You are Meridian's support line. Never read internal ids aloud. vm_call=${token}`,
      },
      ...turns,
    ],
  };
  const t0 = performance.now();
  const r = await fetch(base + "/v1/chat/completions", {
    method: "POST",
    headers: {
      authorization: "Bearer " + voiceKey,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const raw = await r.text();
  const spoken = [...raw.matchAll(/"content":"((?:[^"\\]|\\.)*)"/g)]
    .map((m) => JSON.parse('"' + m[1] + '"'))
    .join("");
  for (const t of tokens)
    if (spoken.includes(t) || spoken.includes("vmc_"))
      throw Error("call token leaked into spoken output");
  log(
    `${title}: POST /v1/chat/completions (as Bolna)`,
    { headers: { authorization: "Bearer <tenant voice key>" }, body },
    { status: r.status, spoken },
    Math.round(performance.now() - t0),
  );
  await new Promise((res) => setTimeout(res, 30));
  return spoken;
}

const Q = "Was the revised fee approved?";
const c1 = await api("POST", "/calls", {
  provider: "bolna",
  scope: { case: "deal" },
  permissions: { recall: true, remember: true, record: true },
  caller: { assertion: assertion() },
});
await api("POST", `/calls/${c1.call.callId}/preferences`, {
  key: "language",
  value: "hinglish",
  consent: "caller_explicit",
});
await api("POST", `/calls/${c1.call.callId}/consent`, { conversation: true });
await bolna(
  c1.providerUserData.vm_call,
  [{ role: "user", content: Q }],
  "Call 1, turn 1",
);
await bolna(
  c1.providerUserData.vm_call,
  [{ role: "user", content: Q }],
  "Call 1, turn 1 retried by the provider",
);
await api("GET", `/calls/${c1.call.callId}/memory`);
await api("POST", `/calls/${c1.call.callId}/end`, {});
await bolna(
  c1.providerUserData.vm_call,
  [{ role: "user", content: Q }],
  "Call 1 token after end",
);
const c2 = await api("POST", "/calls", {
  provider: "bolna",
  scope: { case: "deal" },
  permissions: { recall: true, remember: true, record: true },
  caller: { assertion: assertion() },
});
await api("GET", `/calls/${c2.call.callId}/context`);
await bolna(
  c2.providerUserData.vm_call,
  [{ role: "user", content: "And has it been approved now?" }],
  "Call 2, turn 1",
);
await api("POST", `/calls/${c2.call.callId}/answer`, { question: Q });
await api("POST", `/calls/${c2.call.callId}/end`, {});
server.close();

const md = [
  "# SIMULATED Bolna trace — two calls, one fictional verified caller",
  "",
  "**No Bolna call was placed.** These are the exact HTTP requests a tenant backend and Bolna's",
  "custom-LLM transport send, replayed against a local Voice Memory server. Keys, caller",
  "assertions, call tokens and signatures are redacted. Timings are local loopback.",
  "",
  `Generated by \`node scripts/bolna-trace.mjs\` on ${new Date().toISOString().slice(0, 10)}.`,
  "",
  ...lines.flatMap((l) => [
    `## ${l.title} (${l.ms} ms)`,
    "",
    "```json",
    JSON.stringify({ request: l.req, response: l.res }, null, 2),
    "```",
    "",
  ]),
].join("\n");
if (out) writeFileSync(out, md);
console.log(
  `ok: ${lines.length} exchanges, no token in spoken output${out ? ", written to " + out : ""}`,
);
