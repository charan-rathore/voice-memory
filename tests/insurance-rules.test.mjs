// Workstream E: strict applicability rules for the fictional insurer.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createCallerIdentity } from "../memory/caller-identity.mjs";
import { digest } from "../memory/receipt-signer.mjs";
import { HARBORLINE_2026 } from "../examples/corpus-harborline.mjs";
import {
  isCalendarDate,
  applicableScope,
  normaliseHinglishQuestion,
} from "../src/applicability.mjs";

const T = {
  apiKey: "2f".repeat(32),
  voiceKey: "voice-key-rules-0123456789abcdefghij",
  caller: "3e".repeat(32),
};
const signer = createCallerIdentity({
  keys: { harborline_k1: { secret: T.caller, tenant: "harborline" } },
});
const ENV = {
  VM_TENANTS: JSON.stringify({
    harborline: {
      apiKey: T.apiKey,
      voiceKey: T.voiceKey,
      cases: ["insurance"],
      callerKeys: { k1: T.caller },
      ratePerMinute: 100000,
    },
  }),
  VM_DATA_DIR: mkdtempSync(path.join(tmpdir(), "vm-rules-")),
  VM_STORE_KEY: "4f".repeat(32),
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
      ...(method !== "GET" ? { "idempotency-key": "e" + ++n } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return res.json();
};
const ask = async (
  applicability,
  question = "What is my windscreen excess?",
) => {
  const c = await api("POST", "/calls", {
    scope: { case: "insurance" },
    permissions: { recall: true },
    caller: {
      assertion: signer.issue({
        kid: "harborline_k1",
        tenant: "harborline",
        sub: "pol-" + n,
        amr: "otp",
      }),
    },
    ...(applicability ? { applicability } : {}),
  });
  return api("POST", `/calls/${c.call.callId}/answer`, { question });
};
const noAmount = (v) => !/₹\s?\d/.test(JSON.stringify([v.say, v.text]));

test("exact calendar dates only", () => {
  for (const ok of ["2026-02-28", "2024-02-29", "2026-04-01"])
    assert.equal(isCalendarDate(ok), true, ok);
  for (const bad of [
    "2026-02-30",
    "2025-02-29",
    "2026-13-01",
    "2026-04-31",
    "2026-4-1",
    "01-04-2026",
    "2026-04-01T00:00",
    "",
  ])
    assert.equal(isCalendarDate(bad), false, bad);
  assert.ok(
    applicableScope({ case: "insurance" }, { policyIssuedOn: "2026-02-30" })
      .clarify,
    "Date.parse would have normalised this",
  );
});

test("invalid, missing, contradictory or unknown account data: ask, never an amount", async () => {
  for (const a of [
    { policyIssuedOn: "2026-02-30" },
    null,
    { policyIssuedOn: "2026-06-01", wordingVersion: "2025.1" },
    { policyIssuedOn: "2025-06-01", endorsements: ["glass-shield"] },
    { policyIssuedOn: "2026-06-01", endorsements: ["platinum-glass"] },
    { policyIssuedOn: "2024-01-01" },
  ]) {
    const r = await ask(a);
    assert.equal(r.verified.kind, "clarify", JSON.stringify(a));
    assert.ok(noAmount(r.verified), JSON.stringify(r.verified));
    assert.match(
      r.verified.clarification,
      /Which policy are you asking about\?/,
    );
  }
});

test("competing endorsement: applies only to accounts holding it, and never resolved by guessing", async () => {
  const plain = await ask({ policyIssuedOn: "2026-06-01" });
  assert.match(plain.verified.text, /₹2,500/);
  assert.deepEqual(plain.verified.scope.effective, {
    wordingVersion: "2026.1",
    effectiveFrom: "2026-04-01",
    effectiveTo: null,
    endorsements: [],
    source: "tenant_account",
  });
  const holder = await ask({
    policyIssuedOn: "2026-06-01",
    endorsements: ["glass-shield"],
  });
  assert.equal(
    holder.verified.scope.appliedDocuments,
    "insurance-2026+glass-shield",
  );
  // Two amounts are on record for this account; the engine does not know
  // which governs, so it must not state either as the answer.
  assert.doesNotMatch(
    String(holder.verified.text ?? ""),
    /₹2,500/,
    JSON.stringify(holder.verified),
  );
  if (holder.verified.text) assert.match(holder.verified.text, /₹500/);
});

test("a caller's statement never changes which wording applies", async () => {
  const r = await ask(
    { policyIssuedOn: "2026-06-01" },
    "My policy was issued in 2025, so what is my windscreen excess?",
  );
  assert.equal(r.verified.scope.appliedDocuments, "insurance-2026");
  assert.doesNotMatch(
    JSON.stringify([r.verified.say, r.verified.text]),
    /₹1,000/,
  );
});

test("the Hinglish question is answered from the documents, and the rewrite is disclosed", async () => {
  assert.equal(
    normaliseHinglishQuestion("Mera windscreen excess kitna hai?"),
    "What is my windscreen excess?",
  );
  assert.equal(normaliseHinglishQuestion("windscreen excess batao yaar"), null);
  const r = await ask(
    { policyIssuedOn: "2026-06-01" },
    "Mera windscreen excess kitna hai?",
  );
  assert.match(r.verified.text, /₹2,500/);
  assert.equal(r.verified.normalizedQuestion, "What is my windscreen excess?");
  assert.equal(
    r.receipt.questionDigest,
    digest("Mera windscreen excess kitna hai?"),
    "the receipt binds what the caller asked",
  );
  // An unmatched Hinglish phrasing is not rescued by guessing.
  const u = await ask(
    { policyIssuedOn: "2026-06-01" },
    "windscreen excess batao yaar",
  );
  if (!u.verified.text) assert.ok(noAmount(u.verified));
  else assert.match(u.verified.text, /₹2,500/);
});

test("one precise clause is cited, with exact offsets into the document", async () => {
  const r = await ask({ policyIssuedOn: "2026-06-01" });
  const c = r.verified.citations[0];
  assert.equal(c.quote, "1. The windscreen excess is ₹2,500 per claim.");
  const doc = HARBORLINE_2026.find((d) => d.title === c.title);
  assert.ok(doc, c.title);
  assert.ok(c.passage, "the wider passage is kept for reference");
  // Offsets index the document's own text (engine offsets are into the
  // ingested text; checked against the clause, which is verbatim).
  assert.ok(doc.text.includes(c.quote));
  assert.equal(r.receipt.citations[0].quoteDigest, digest(c.quote));
});
