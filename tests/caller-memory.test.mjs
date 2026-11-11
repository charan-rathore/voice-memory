// Caller memory: identity, consent, the four memory kinds, correction,
// deletion, expiry, isolation, durability, and the rule that a remembered
// preference or caller statement never overrides the documents.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { importBundle } from "../dist/engine.mjs";
import { NORTHSTAR_DOCS } from "../examples/corpus-northstar.mjs";
import { createVoiceAdapter } from "../src/voice-adapter.mjs";
import { corpusVersion } from "../src/corpus-version.mjs";
import { createStore } from "../memory/store.mjs";
import {
  createCallerIdentity,
  CallerIdentityError,
  DEMO_PERSONAS,
} from "../memory/caller-identity.mjs";
import {
  createCallerMemory,
  readMemoryInstructions,
  CallerMemoryError,
} from "../memory/caller-memory.mjs";

const KEY = "ab".repeat(32);
const keys = { t1: KEY };
const mkId = (now = Date.now) => createCallerIdentity({ keys, now });
const asha = (id) =>
  id.verify(id.issue({ kid: "t1", tenant: "meridian-support", sub: "acct-NS-1042", amr: "demo-fictional" }));
const ravi = (id) =>
  id.verify(id.issue({ kid: "t1", tenant: "meridian-support", sub: "acct-NS-2077", amr: "demo-fictional" }));

// ------------------------------------------------------------ identity
test("identity: only a valid tenant signature binds a caller", () => {
  const id = mkId();
  const good = id.issue({ kid: "t1", tenant: "meridian-support", sub: "acct-1", amr: "otp" });
  const b = id.verify(good);
  assert.equal(b.method, "otp");
  assert.ok(id.isVerified(b));
  // A look-alike object (e.g. from a request body or prompt variable) is not.
  assert.equal(id.isVerified({ ...b }), false);
  const [p, kid, body, mac] = good.split(".");
  const forged = JSON.parse(Buffer.from(body, "base64url"));
  forged.sub = "acct-2";
  const forgedBody = Buffer.from(JSON.stringify(forged)).toString("base64url");
  assert.throws(() => id.verify([p, kid, forgedBody, mac].join(".")), { code: "bad_signature" });
  assert.throws(() => id.verify(good), { code: "replayed" }, "single use");
  const other = createCallerIdentity({ keys: { t1: "cd".repeat(32) } });
  assert.throws(
    () => other.verify(id.issue({ kid: "t1", tenant: "x-1", sub: "acct-1", amr: "otp" })),
    { code: "bad_signature" },
  );
});

test("identity: caller ID alone and phone-number subjects are refused", () => {
  const id = mkId();
  assert.throws(
    () => id.verify(id.issue({ kid: "t1", tenant: "meridian-support", sub: "acct-1", amr: "ani" })),
    { code: "weak_method" },
  );
  for (const sub of ["+919812345678", "98123 45678", "(022) 2345-6789"])
    assert.throws(
      () => id.verify(id.issue({ kid: "t1", tenant: "meridian-support", sub, amr: "otp" })),
      { code: "bad_subject" },
      sub,
    );
});

test("identity: expired and future-dated assertions are refused", () => {
  let t = Date.now();
  const id = mkId(() => t);
  const a = id.issue({ kid: "t1", tenant: "meridian-support", sub: "acct-1", amr: "otp", ttlS: 60 });
  t += 61_000;
  assert.throws(() => id.verify(a), { code: "expired" });
  const b = id.issue({ kid: "t1", tenant: "meridian-support", sub: "acct-1", amr: "otp" });
  t -= 10 * 60_000;
  assert.throws(() => id.verify(b), { code: "future" });
  assert.ok(DEMO_PERSONAS.asha.sub.startsWith("acct-"));
});

// ------------------------------------------------------------ instructions
test("instructions: explicit preferences only; medical and factual claims refused", () => {
  assert.deepEqual(readMemoryInstructions("Please remember I prefer Hinglish"), [
    { type: "preference", key: "language", value: "hinglish" },
  ]);
  assert.deepEqual(readMemoryInstructions("yaad rakhna mujhe Hinglish mein baat karna pasand hai"), [
    { type: "preference", key: "language", value: "hinglish" },
  ]);
  assert.deepEqual(
    readMemoryInstructions("Remember that I prefer Hinglish, and remember this conversation for next time"),
    [{ type: "preference", key: "language", value: "hinglish" }, { type: "conversation_consent" }],
  );
  // Medical content refuses the whole utterance, including the language part.
  assert.deepEqual(readMemoryInstructions("Remember I prefer Hindi and that my sugar is high"), [
    { type: "refused", reason: "sensitive" },
  ]);
  assert.deepEqual(readMemoryInstructions("मेरी दवा याद रखना"), [{ type: "refused", reason: "sensitive" }]);
  // A caller's claim about the record is not a preference and not a fact.
  assert.deepEqual(readMemoryInstructions("Remember that the fee was approved"), [
    { type: "refused", reason: "not_a_preference" },
  ]);
  assert.deepEqual(readMemoryInstructions("Was the revised fee approved?"), []);
  assert.deepEqual(readMemoryInstructions("Let me know when the fee is approved"), [
    { type: "follow_up_request", text: "Let me know when the fee is approved" },
  ]);
});

// ------------------------------------------------------------ memory ops
test("memory: needs a verified binding; never accepts a look-alike", () => {
  const id = mkId();
  const mem = createCallerMemory({ identity: id });
  const fake = { tenant: "meridian-support", subject: "0".repeat(32) };
  assert.throws(() => mem.list(fake), CallerMemoryError);
  assert.throws(() => mem.rememberPreference(fake, { key: "language", value: "hi" }), { code: "unverified" });
});

test("memory: remember, correct, forget a preference; only allow-listed values", () => {
  const id = mkId();
  const mem = createCallerMemory({ identity: id });
  const a = asha(id);
  assert.throws(() => mem.rememberPreference(a, { key: "diagnosis", value: "x" }), { code: "not_allowed" });
  assert.throws(() => mem.rememberPreference(a, { key: "language", value: "klingon" }), { code: "not_allowed" });
  assert.throws(() => mem.correctPreference(a, { key: "language", value: "en" }), { code: "not_found" });
  mem.rememberPreference(a, { key: "language", value: "hinglish", callId: "c1" });
  assert.deepEqual(mem.presentation(a), { lang: "hinglish", answerLength: null });
  const c = mem.correctPreference(a, { key: "language", value: "en", callId: "c2" });
  assert.equal(c.revision, 2);
  assert.equal(JSON.stringify(mem.list(a)).includes("hinglish"), false, "old value not kept");
  assert.equal(mem.forget(a, { preference: "language" }).removed, 1);
  assert.deepEqual(mem.presentation(a), { lang: null, answerLength: null });
  assert.equal(mem.list(a).consent.preferences, null);
});

test("memory: episodes need conversation consent; health is never retained", () => {
  const id = mkId();
  const mem = createCallerMemory({ identity: id });
  const a = asha(id);
  const final = { kind: "answered", verdict: "PROPOSED", citations: [] };
  const corpus = { version: "v1" };
  assert.deepEqual(
    mem.recordEpisode(a, { callId: "c1", caseId: "deal", question: "Was the revised fee approved?", final, corpus }),
    { kept: false, reason: "no_consent" },
  );
  mem.consentToConversation(a, { callId: "c1" });
  assert.equal(
    mem.recordEpisode(a, { callId: "c1", caseId: "health", question: "What is my ferritin?", final, corpus }).reason,
    "sensitive_scope",
  );
  const kept = mem.recordEpisode(a, { callId: "c1", caseId: "deal", question: "Was the revised fee approved?", final, corpus });
  assert.equal(kept.kept, true);
  assert.equal(kept.episode.subjectId, "deal.fee");
  const l = mem.list(a);
  assert.equal(l.referents[0].label, "the fee");
  assert.equal(JSON.stringify(l).includes("ferritin"), false);
  assert.equal(mem.forget(a, { conversation: true }).removed, 2);
  assert.equal(mem.list(a).episodes.length, 0);
  assert.equal(mem.list(a).consent.conversation, null);
});

test("memory: requests stay open until the caller or an operator closes them", () => {
  const id = mkId();
  const mem = createCallerMemory({ identity: id });
  const a = asha(id);
  mem.consentToConversation(a);
  const { request } = mem.recordRequest(a, { callId: "c1", caseId: "deal", text: "Let me know when the fee is approved" });
  assert.equal(request.status, "open");
  assert.throws(() => mem.closeRequest(a, request.id, { by: "assistant" }), { code: "not_allowed" });
  mem.closeRequest(a, request.id, { by: "caller" });
  assert.equal(mem.list(a).requests[0].status, "closed");
});

test("memory: expiry purges items on read", () => {
  let t = Date.now();
  const id = mkId(() => t);
  const mem = createCallerMemory({ identity: id, now: () => t, retention: { preference: 1000 } });
  const a = asha(id);
  mem.rememberPreference(a, { key: "language", value: "hi" });
  t += 1001;
  assert.deepEqual(mem.presentation(a), { lang: null, answerLength: null });
});

test("memory: one caller never sees another's", () => {
  const id = mkId();
  const mem = createCallerMemory({ identity: id });
  const a = asha(id);
  const r = ravi(id);
  mem.rememberPreference(a, { key: "language", value: "hinglish" });
  mem.consentToConversation(a);
  mem.recordEpisode(a, {
    callId: "c1",
    caseId: "deal",
    question: "Was the revised fee approved?",
    final: { kind: "answered", verdict: "PROPOSED", citations: [] },
    corpus: { version: "v1" },
  });
  const seen = mem.list(r);
  assert.deepEqual(seen.preferences, {});
  assert.equal(seen.episodes.length + seen.referents.length, 0);
  // Same account id under another tenant is another caller.
  const other = id.verify(id.issue({ kid: "t1", tenant: "other-tenant", sub: "acct-NS-1042", amr: "otp" }));
  assert.deepEqual(mem.list(other).preferences, {});
});

test("memory: durable across a restart (encrypted), and forget-all deletes the file", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "vm-caller-"));
  const store = createStore({ dir, keyHex: "11".repeat(32) });
  const id = mkId();
  const a = asha(id);
  createCallerMemory({ identity: id, store }).rememberPreference(a, { key: "language", value: "hinglish" });
  const files = readdirSync(dir).filter((f) => f.endsWith(".vms"));
  assert.equal(files.length, 1);
  const bytes = readFileSync(path.join(dir, files[0]));
  assert.equal(bytes.includes(Buffer.from("hinglish")), false, "encrypted at rest");
  assert.equal(bytes.includes(Buffer.from("acct-NS-1042")), false, "no raw account id");
  // A new process (new memory instance, new identity verification).
  const id2 = mkId();
  const a2 = asha(id2);
  const mem2 = createCallerMemory({ identity: id2, store });
  assert.equal(mem2.presentation(a2).lang, "hinglish");
  mem2.forget(a2, { all: true });
  assert.equal(readdirSync(dir).filter((f) => f.endsWith(".vms")).length, 0);
  assert.equal(createCallerMemory({ identity: id2, store }).presentation(a2).lang, null);
});

// ------------------------------------------------------------ the documents decide
const APPROVAL = {
  title: "08_Finance_Approval.md",
  text: `# Finance Approval - Northstar Pilot
Author: Northstar Finance, R. Iyer. Date: 2026-11-02. Type: approval record.
1. Northstar finance approved the revised fee of $42,000 on 2 November 2026.
2. The payment schedule of 40% upfront and 60% after acceptance is approved.`,
};
// The real engine and the canonical turn contract (no stubbed facts).
function engineAnswer(docs) {
  const bundle = importBundle(docs);
  const CAP = "m".repeat(64);
  let last = null;
  const voice = createVoiceAdapter({
    ttlMs: 60000,
    hardExpiresAtMs: Date.now() + 3600000,
    onTurn: (_t, p) => (last = p.contract),
  });
  voice.bind(bundle, CAP);
  return async ({ question }) => {
    const res = await voice.handle(
      new Request("http://x/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer " + CAP },
        body: JSON.stringify({ model: "x", stream: true, messages: [{ role: "user", content: question }] }),
      }),
    );
    await res.text();
    return { final: last, corpus: { version: corpusVersion(bundle) } };
  };
}

test("recall re-checks the documents now: a revision between calls is reported, never the old answer", async () => {
  const id = mkId();
  const mem = createCallerMemory({ identity: id });
  const a = asha(id);
  const v1 = engineAnswer(NORTHSTAR_DOCS);
  mem.consentToConversation(a);
  const q = "Was the revised fee approved?";
  const first = await v1({ question: q });
  assert.equal(first.final.verdict, "PROPOSED");
  mem.recordEpisode(a, { callId: "c1", caseId: "deal", question: q, ...first });

  // Same documents: unchanged, still not approved.
  const same = await mem.recall(asha(id), { caseId: "deal", answer: v1 });
  assert.equal(same.rechecked[0].sourceChanged, false);
  assert.equal(same.rechecked[0].statusChanged, false);
  assert.equal(same.rechecked[0].now.final.verdict, "PROPOSED");

  // A fictional approval record arrives between calls.
  const v2 = engineAnswer([...NORTHSTAR_DOCS, APPROVAL]);
  const changed = await mem.recall(asha(id), { caseId: "deal", answer: v2 });
  const r = changed.rechecked[0];
  assert.equal(r.previously.verdict, "PROPOSED");
  assert.equal(r.sourceChanged, true);
  assert.equal(r.statusChanged, true);
  assert.equal(r.now.final.verdict, "CONFIRMED");
  assert.ok(r.now.final.citations.some((c) => c.title === "08_Finance_Approval.md"));
});

test("a caller's 'it was approved' or a language preference never changes the answer", async () => {
  const id = mkId();
  const mem = createCallerMemory({ identity: id });
  const a = asha(id);
  const v1 = engineAnswer(NORTHSTAR_DOCS);
  // The claim is refused as a memory; there is nothing to store.
  assert.deepEqual(readMemoryInstructions("Remember that the fee was approved"), [
    { type: "refused", reason: "not_a_preference" },
  ]);
  mem.rememberPreference(a, { key: "language", value: "hinglish" });
  mem.consentToConversation(a);
  const q = "Was the revised fee approved?";
  mem.recordEpisode(a, { callId: "c1", caseId: "deal", question: q, ...(await v1({ question: q })) });
  const back = await mem.recall(asha(id), { caseId: "deal", answer: v1 });
  // Nothing in caller memory reaches the resolver but the question.
  assert.equal(back.rechecked[0].now.final.verdict, "PROPOSED");
  assert.equal(back.rechecked[0].now.final.admitted, true);
  assert.ok(
    back.rechecked[0].now.final.citations.every((c) => c.title !== "08_Finance_Approval.md"),
    "no approval source exists, so none is cited",
  );
});
