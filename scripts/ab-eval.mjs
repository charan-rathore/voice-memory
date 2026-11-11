#!/usr/bin/env node
// A/B: the same scripted scenarios with (A) no persistent caller memory and
// (B) Voice Memory, through the v1 API on a local server.
//
//   node scripts/ab-eval.mjs [dev|heldout] [out.json]
//
// Arm A starts every call WITHOUT a caller (anonymous): no preference, no
// recall, so a returning caller must repeat their context. Arm B binds the
// verified fictional caller. Both arms ask the same questions against the
// same documents. Developer-authored scenarios: regression evidence only.
// Latency is local loopback, not a real call.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { createCallerIdentity } from "../memory/caller-identity.mjs";
import { DEV_SCENARIOS } from "../evaluation/ab/scenarios.mjs";
import { HELDOUT_SCENARIOS } from "../evaluation/ab/heldout.mjs";

export async function runAB(set = "dev") {
  const scenarios = set === "heldout" ? HELDOUT_SCENARIOS : DEV_SCENARIOS;
  const apiKey = randomBytes(32).toString("hex");
  const callerKey = randomBytes(32).toString("hex");
  Object.assign(process.env, {
    VM_TENANTS: JSON.stringify({
      abtenant: {
        apiKey,
        voiceKey: randomBytes(24).toString("hex"),
        cases: ["deal", "insurance"],
        callerKeys: { k1: callerKey },
        ratePerMinute: 100000,
      },
    }),
    VM_DATA_DIR: mkdtempSync(path.join(tmpdir(), "vm-ab-")),
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
    keys: { abtenant_k1: { secret: callerKey, tenant: "abtenant" } },
  });
  let k = 0;
  const api = async (method, p, body) => {
    const t0 = performance.now();
    const r = await fetch(base + "/v1" + p, {
      method,
      headers: {
        authorization: "Bearer " + apiKey,
        "content-type": "application/json",
        ...(method !== "GET" ? { "idempotency-key": "ab" + ++k } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { body: await r.json(), ms: performance.now() - t0 };
  };
  const results = [];
  const lat = { recall: [], answer: [] };
  for (const arm of ["A", "B"]) {
    for (const sc of scenarios) {
      const sub = `acct-${arm}-${sc.id}`.slice(0, 60);
      const row = {
        arm,
        id: sc.id,
        repeatedContext: 0,
        recallChecks: 0,
        recallCorrect: 0,
        unsupportedClaims: 0,
        clarifyExpected: 0,
        safeClarifications: 0,
        failedExpectations: 0,
        isolationFailures: 0,
      };
      for (const [ci, call] of sc.calls.entries()) {
        const started = await api("POST", "/calls", {
          scope: { case: sc.case },
          permissions: { recall: true, remember: true, record: true },
          ...(arm === "B"
            ? {
                caller: {
                  assertion: signer.issue({
                    kid: "abtenant_k1",
                    tenant: "abtenant",
                    sub,
                    amr: "otp",
                  }),
                },
              }
            : {}),
          ...(call.applicability ? { applicability: call.applicability } : {}),
        });
        const id = started.body.call.callId;
        if (call.recall) {
          row.recallChecks++;
          let ok = false;
          if (arm === "B") {
            const ctx = await api("GET", `/calls/${id}/context`);
            lat.recall.push(ctx.ms);
            const r = ctx.body;
            if (call.recall.none)
              ok =
                !Object.keys(r.preferences ?? {}).length &&
                !(r.rechecked ?? []).length;
            else {
              const sub0 = (r.rechecked ?? [])[0];
              ok =
                (!call.recall.language ||
                  r.preferences?.language?.value === call.recall.language) &&
                (!call.recall.subject ||
                  sub0?.subject?.label === call.recall.subject) &&
                (call.recall.changed === undefined ||
                  sub0?.statusChanged === call.recall.changed ||
                  sub0?.applicabilityChanged === call.recall.changed);
            }
          }
          if (ok) row.recallCorrect++;
          // Without recall the caller has to say again what they said before.
          else if (!call.recall.none) row.repeatedContext++;
        }
        for (const st of call.steps) {
          if (st.pref && arm === "B")
            await api("POST", `/calls/${id}/preferences`, {
              key: "language",
              value: st.pref,
              consent: "caller_explicit",
            });
          if (st.consent && arm === "B")
            await api("POST", `/calls/${id}/consent`, { conversation: true });
          if (st.forget && arm === "B")
            await api("DELETE", `/calls/${id}/memory?all=1`);
          if (st.ask) {
            const a = await api("POST", `/calls/${id}/answer`, {
              question: st.ask,
            });
            lat.answer.push(a.ms);
            const v = a.body.verified ?? {};
            const text = [v.text, v.say].filter(Boolean).join(" ");
            const e = st.expect ?? {};
            if (e.clarify) {
              row.clarifyExpected++;
              if (v.kind === "clarify" && !text) row.safeClarifications++;
            }
            if (e.not && new RegExp(e.not).test(text)) row.unsupportedClaims++;
            if (e.has && !new RegExp(e.has).test(text))
              row.failedExpectations++;
            if (arm === "B")
              await api("POST", `/calls/${id}/turns`, {
                turnId: `t${ci}-${st.ask.length}`,
                question: st.ask,
                spoken: v.say ?? v.clarification ?? null,
              });
          }
        }
        await api("POST", `/calls/${id}/end`, {});
      }
      if (arm === "B") {
        // Another verified caller of the same tenant must see nothing.
        const other = await api("POST", "/calls", {
          scope: { case: sc.case },
          permissions: { recall: true },
          caller: {
            assertion: signer.issue({
              kid: "abtenant_k1",
              tenant: "abtenant",
              sub: `acct-other-${sc.id}`.slice(0, 60),
              amr: "otp",
            }),
          },
        });
        const m = (await api("GET", `/calls/${other.body.call.callId}/memory`))
          .body.memory;
        if (Object.keys(m.preferences).length || m.episodes.length)
          row.isolationFailures++;
      }
      results.push(row);
    }
  }
  server.close();
  const sum = (arm, f) =>
    results.filter((r) => r.arm === arm).reduce((a, r) => a + r[f], 0);
  const pct = (a, p) => {
    const s = [...a].sort((x, y) => x - y);
    return s.length
      ? Math.round(
          s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] * 10,
        ) / 10
      : null;
  };
  const fields = [
    "repeatedContext",
    "recallChecks",
    "recallCorrect",
    "unsupportedClaims",
    "clarifyExpected",
    "safeClarifications",
    "failedExpectations",
    "isolationFailures",
  ];
  return {
    set,
    kind: "developer-authored fictional scenarios — regression evidence, NOT accuracy or business-outcome evidence",
    scenarios: scenarios.length,
    totals: Object.fromEntries(
      ["A", "B"].map((arm) => [
        arm,
        Object.fromEntries(fields.map((f) => [f, sum(arm, f)])),
      ]),
    ),
    latencyMs: {
      kind: "local loopback, warm, one process — not real-call latency",
      recall: { p50: pct(lat.recall, 50), p95: pct(lat.recall, 95) },
      answer: { p50: pct(lat.answer, 50), p95: pct(lat.answer, 95) },
      firstAudio: "not measured (no real provider call)",
    },
    rows: results,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const r = await runAB(process.argv[2] ?? "dev");
  console.log(
    JSON.stringify(
      { set: r.set, kind: r.kind, totals: r.totals, latencyMs: r.latencyMs },
      null,
      2,
    ),
  );
  if (process.argv[3])
    writeFileSync(process.argv[3], JSON.stringify(r, null, 2));
}
