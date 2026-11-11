#!/usr/bin/env node
// p50/p95 latency of Voice Memory's own work, measured over local loopback
// against a warm, single-process server with the fictional Harborline tenant.
//
//   node scripts/measure-latency.mjs [iterations=60] [out.json]
//
// This is NOT real-call latency: no network hops, no telephony, no speech
// recognition or synthesis. First spoken audio on a real call = provider
// STT end-of-turn + network RTT + "voice turn: first byte" below + TTS
// start. Measure those on a real Bolna call before quoting any number.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { createCallerIdentity } from "../memory/caller-identity.mjs";

const N = Number(process.argv[2] ?? 60);
const out = process.argv[3] ?? null;
const apiKey = randomBytes(32).toString("hex");
const voiceKey = randomBytes(24).toString("hex");
const callerKey = randomBytes(32).toString("hex");
Object.assign(process.env, {
  VM_TENANTS: JSON.stringify({
    harborline: {
      apiKey,
      voiceKey,
      cases: ["insurance"],
      callerKeys: { k1: callerKey },
      ratePerMinute: 100000,
    },
  }),
  VM_DATA_DIR: mkdtempSync(path.join(tmpdir(), "vm-lat-")),
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
  keys: { harborline_k1: { secret: callerKey, tenant: "harborline" } },
});
let k = 0;
const api = async (method, p, body) => {
  const res = await fetch(base + "/v1" + p, {
    method,
    headers: {
      authorization: "Bearer " + apiKey,
      "content-type": "application/json",
      ...(method !== "GET" ? { "idempotency-key": "m" + ++k } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return res.json();
};
const Q = "What is my windscreen excess?";
const samples = {
  "call start (identity verify + binding)": [],
  "memory recall (context, 1 subject rechecked)": [],
  "source-verified answer": [],
  "voice turn: first byte": [],
  "voice turn: total": [],
};
const time = async (label, fn) => {
  const t0 = performance.now();
  const r = await fn();
  samples[label].push(performance.now() - t0);
  return r;
};
// Seed one remembered subject so recall does real work.
const seed = await api("POST", "/calls", {
  scope: { case: "insurance" },
  permissions: { recall: true, remember: true, record: true },
  caller: {
    assertion: signer.issue({
      kid: "harborline_k1",
      tenant: "harborline",
      sub: "pol-1",
      amr: "otp",
    }),
  },
  applicability: { policyIssuedOn: "2025-09-14" },
});
await api("POST", `/calls/${seed.call.callId}/consent`, { conversation: true });
await api("POST", `/calls/${seed.call.callId}/turns`, {
  turnId: "seed",
  question: Q,
});
for (let i = 0; i < N + 5; i++) {
  const warm = i < 5;
  const c = await time("call start (identity verify + binding)", () =>
    api("POST", "/calls", {
      scope: { case: "insurance" },
      permissions: { recall: true, remember: true, record: true },
      caller: {
        assertion: signer.issue({
          kid: "harborline_k1",
          tenant: "harborline",
          sub: "pol-1",
          amr: "otp",
        }),
      },
      applicability: { policyIssuedOn: "2025-09-14" },
    }),
  );
  await time("memory recall (context, 1 subject rechecked)", () =>
    api("GET", `/calls/${c.call.callId}/context`),
  );
  await time("source-verified answer", () =>
    api("POST", `/calls/${c.call.callId}/answer`, { question: Q }),
  );
  const t0 = performance.now();
  const res = await fetch(base + "/v1/chat/completions", {
    method: "POST",
    headers: {
      authorization: "Bearer " + voiceKey,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "vm",
      stream: true,
      messages: [
        { role: "system", content: `vm_call=${c.providerUserData.vm_call}.` },
        { role: "user", content: Q },
      ],
    }),
  });
  const reader = res.body.getReader();
  await reader.read();
  samples["voice turn: first byte"].push(performance.now() - t0);
  while (!(await reader.read()).done);
  samples["voice turn: total"].push(performance.now() - t0);
  if (warm) for (const s of Object.values(samples)) s.length = 0;
}
server.close();
const pct = (a, p) => {
  const s = [...a].sort((x, y) => x - y);
  return (
    Math.round(
      s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] * 10,
    ) / 10
  );
};
const result = {
  kind: "local loopback, warm single process, fictional tenant — NOT real-call latency",
  answerCache:
    process.env.VM_CACHE_MAX === "0"
      ? "off (every answer computed)"
      : "on (repeated question: mostly cache hits)",
  corpus: "Harborline DriveSure wording: 2 short documents per version",
  node: process.version,
  iterations: N,
  ms: Object.fromEntries(
    Object.entries(samples).map(([k2, v]) => [
      k2,
      { p50: pct(v, 50), p95: pct(v, 95) },
    ]),
  ),
};
console.log(JSON.stringify(result, null, 2));
if (out) writeFileSync(out, JSON.stringify(result, null, 2));
