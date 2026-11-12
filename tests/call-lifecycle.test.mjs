// Gate C: call lifecycle and failure-atomic turn recording for the v1
// memory API (unit level: real caller memory + real store, fake clock,
// injected resolver so failures can be forced).
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createCallerIdentity } from "../memory/caller-identity.mjs";
import { createCallerMemory } from "../memory/caller-memory.mjs";
import { createCallBindings } from "../memory/call-binding.mjs";
import { createStore } from "../memory/store.mjs";
import { createMemoryApi } from "../src/memory-api.mjs";

const KEY = "ab".repeat(32);
const tenants = {
  "tenant-one": {
    apiKey: KEY,
    voiceKey: "voice-key-tenant-one-0123456789abcdef",
    cases: ["deal"],
    ratePerMinute: 100000,
  },
};
const callerKey = "cd".repeat(32);

function harness({
  dir = mkdtempSync(path.join(tmpdir(), "vm-lc-")),
  clock = { t: Date.now() },
  answer,
  storeWrap,
} = {}) {
  const now = () => clock.t;
  const identity = createCallerIdentity({
    keys: { "tenant-one_k": { secret: callerKey, tenant: "tenant-one" } },
    now,
  });
  const real = createStore({ dir, keyHex: "11".repeat(32) });
  const store = storeWrap ? storeWrap(real) : real;
  const memory = createCallerMemory({ identity, store, now });
  const bindings = createCallBindings({ now });
  const defaultAnswer = async () => ({
    final: {
      kind: "answered",
      verdict: "PROPOSED",
      admittedText: "$42,000 is the latest proposal, and it is not approved.",
      citations: [
        {
          title: "03_Commercial_Revision.md",
          quote: "Revised fee $42,000 (proposed).",
        },
      ],
    },
    corpus: { version: "v1" },
  });
  const handler = createMemoryApi({
    tenants,
    identity,
    memory,
    bindings,
    answer: answer ?? defaultAnswer,
    now,
  });
  const srv = http.createServer((req, res) => handler(req, res));
  const ready = new Promise((r) => srv.listen(0, "127.0.0.1", r));
  let k = 0;
  const call = async (
    method,
    p,
    body,
    idem = "k" + ++k + "-" + Math.random(),
  ) => {
    await ready;
    const res = await fetch(`http://127.0.0.1:${srv.address().port}/v1${p}`, {
      method,
      headers: {
        authorization: "Bearer " + KEY,
        "content-type": "application/json",
        ...(method === "GET" ? {} : { "idempotency-key": idem }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };
  const assertion = () =>
    identity.issue({
      kid: "tenant-one_k",
      tenant: "tenant-one",
      sub: "acct-1",
      amr: "otp",
    });
  const start = async () =>
    (
      await call("POST", "/calls", {
        scope: { case: "deal" },
        permissions: { recall: true, remember: true, record: true },
        caller: { assertion: assertion() },
      })
    ).body.call.callId;
  return {
    call,
    start,
    assertion,
    clock,
    close: () => srv.close(),
    dir,
    memory,
    identity,
  };
}

test("C1: expired pending, expired live, ended and revoked calls open no memory", async () => {
  const h = harness();
  try {
    // Expired before first use (15 min).
    const p = await h.start();
    h.clock.t += 16 * 60_000;
    assert.equal(
      (await h.call("GET", `/calls/${p}/context`)).body.code,
      "expired",
    );
    // Live (used), then past the 2 h absolute limit.
    const l = await h.start();
    assert.equal((await h.call("GET", `/calls/${l}/memory`)).status, 200);
    h.clock.t += 121 * 60_000;
    for (const [m, route, body] of [
      ["GET", "context"],
      ["GET", "memory"],
      ["POST", "answer", { question: "Was the revised fee approved?" }],
      [
        "POST",
        "preferences",
        { key: "language", value: "hi", consent: "caller_explicit" },
      ],
      ["POST", "consent", { conversation: true }],
      ["POST", "turns", { turnId: "t1", question: "q" }],
      ["POST", "verify", { assertion: h.assertion() }],
      ["DELETE", "memory?all=1"],
    ]) {
      const r = await h.call(m, `/calls/${l}/${route}`, body);
      assert.equal(
        r.body.code,
        "expired",
        `${m} ${route} on an expired call -> ${JSON.stringify(r.body)}`,
      );
    }
    // Ended and revoked: refused; ending again is allowed (idempotent close).
    const e = await h.start();
    assert.equal((await h.call("POST", `/calls/${e}/end`, {})).status, 200);
    assert.equal(
      (await h.call("GET", `/calls/${e}/context`)).body.code,
      "ended",
    );
    assert.equal((await h.call("POST", `/calls/${e}/end`, {})).status, 200);
    const r = await h.start();
    await h.call("POST", `/calls/${r}/end`, { revoke: true });
    assert.equal(
      (
        await h.call("POST", `/calls/${r}/preferences`, {
          key: "language",
          value: "hi",
          consent: "caller_explicit",
        })
      ).body.code,
      "revoked",
    );
  } finally {
    h.close();
  }
});

test("C1: a stale retry after end is refused; account deletion needs a fresh caller assertion", async () => {
  const h = harness();
  try {
    const c = await h.start();
    await h.call("POST", `/calls/${c}/preferences`, {
      key: "language",
      value: "hinglish",
      consent: "caller_explicit",
    });
    await h.call("POST", `/calls/${c}/end`, {});
    // A new write on the old call id: refused.
    assert.equal(
      (
        await h.call("POST", `/calls/${c}/preferences`, {
          key: "language",
          value: "en",
          consent: "caller_explicit",
        })
      ).body.code,
      "ended",
    );
    // Account-level deletion: allowed only with a fresh, valid assertion.
    const fresh = h.assertion();
    const del = await h.call("POST", "/callers/forget", {
      assertion: fresh,
      all: true,
    });
    assert.equal(del.status, 200, JSON.stringify(del.body));
    assert.ok(del.body.receipt);
    const reused = await h.call("POST", "/callers/forget", {
      assertion: fresh,
      all: true,
    });
    assert.equal(reused.status, 401, "the same assertion cannot be replayed");
    const c2 = await h.start();
    assert.deepEqual(
      (await h.call("GET", `/calls/${c2}/memory`)).body.memory.preferences,
      {},
    );
  } finally {
    h.close();
  }
});

test("C2: a failed turn write stays retryable; identical retry = same result; different payload = conflict", async () => {
  let failNext = 1;
  const h = harness({
    answer: async () => {
      if (failNext-- > 0) throw Error("resolver down");
      return {
        final: {
          kind: "answered",
          verdict: "PROPOSED",
          admittedText: "x",
          citations: [],
        },
        corpus: { version: "v1" },
      };
    },
  });
  try {
    const c = await h.start();
    await h.call("POST", `/calls/${c}/consent`, { conversation: true });
    const turn = {
      turnId: "t-1",
      question: "Was the revised fee approved?",
      spoken: "Not approved.",
    };
    const first = await h.call("POST", `/calls/${c}/turns`, turn, "idem-1");
    assert.equal(first.status, 500, "the resolver failure surfaces");
    // Same Idempotency-Key retried after the failure: not a cached failure.
    const retry = await h.call("POST", `/calls/${c}/turns`, turn, "idem-1");
    assert.equal(retry.status, 200, JSON.stringify(retry.body));
    assert.equal(retry.body.recorded, true);
    const replay = await h.call("POST", `/calls/${c}/turns`, turn, "idem-1");
    assert.equal(replay.body.episode.id, retry.body.episode.id);
    const sameTurnNewKey = await h.call(
      "POST",
      `/calls/${c}/turns`,
      turn,
      "idem-2",
    );
    assert.equal(sameTurnNewKey.body.duplicate, true);
    assert.equal(sameTurnNewKey.body.episode.id, retry.body.episode.id);
    const conflict = await h.call(
      "POST",
      `/calls/${c}/turns`,
      { ...turn, spoken: "Approved!" },
      "idem-3",
    );
    assert.equal(conflict.status, 409);
    assert.equal(conflict.body.code, "turn_conflict");
    // Idempotency-Key reused with a different body: rejected, never replayed.
    const reuse = await h.call(
      "POST",
      `/calls/${c}/turns`,
      { ...turn, turnId: "t-2" },
      "idem-1",
    );
    assert.equal(reuse.status, 422);
    assert.equal(reuse.body.code, "idempotency_key_reused");
    assert.equal(
      (await h.call("GET", `/calls/${c}/memory`)).body.memory.episodes.length,
      1,
    );
  } finally {
    h.close();
  }
});

test("C2: a storage failure is 503 and retryable, with nothing half-written", async () => {
  let down = false;
  const h = harness({
    storeWrap: (real) => ({
      save: (ns, v) => {
        if (down) throw Object.assign(Error("EIO"), { code: "EIO" });
        return real.save(ns, v);
      },
      load: (ns) => real.load(ns),
      remove: (ns) => real.remove(ns),
    }),
  });
  try {
    const c = await h.start();
    await h.call("POST", `/calls/${c}/consent`, { conversation: true });
    down = true;
    const t = { turnId: "t-9", question: "Was the revised fee approved?" };
    assert.equal(
      (await h.call("POST", `/calls/${c}/turns`, t, "s-1")).status,
      503,
    );
    down = false;
    const ok = await h.call("POST", `/calls/${c}/turns`, t, "s-1");
    assert.equal(ok.body.recorded, true);
    assert.equal(
      (await h.call("GET", `/calls/${c}/memory`)).body.memory.episodes.length,
      1,
    );
  } finally {
    h.close();
  }
});

test("C2: concurrent submissions of one turn create exactly one episode", async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  const h = harness({
    answer: async () => {
      await gate;
      return {
        final: {
          kind: "answered",
          verdict: "PROPOSED",
          admittedText: "x",
          citations: [],
        },
        corpus: { version: "v1" },
      };
    },
  });
  try {
    const c = await h.start();
    await h.call("POST", `/calls/${c}/consent`, { conversation: true });
    const t = { turnId: "t-c", question: "Was the revised fee approved?" };
    const a = h.call("POST", `/calls/${c}/turns`, t, "c-1");
    const b = h.call("POST", `/calls/${c}/turns`, t, "c-2");
    const same = h.call("POST", `/calls/${c}/turns`, t, "c-1");
    await new Promise((r) => setTimeout(r, 100));
    release();
    const rs = await Promise.all([a, b, same]);
    const codes = rs.map((r) => r.status).sort();
    assert.ok(codes.includes(200));
    assert.ok(
      rs.every(
        (r) =>
          r.status === 200 ||
          (r.status === 409 && r.body.code === "in_progress"),
      ),
      JSON.stringify(rs.map((r) => r.body)),
    );
    assert.equal(
      (await h.call("GET", `/calls/${c}/memory`)).body.memory.episodes.length,
      1,
    );
  } finally {
    h.close();
  }
});

test("C2: after a restart (new process state, same store) a retried turn is not duplicated", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "vm-lc-restart-"));
  const h1 = harness({ dir });
  const c1 = await h1.start();
  await h1.call("POST", `/calls/${c1}/consent`, { conversation: true });
  const t = { turnId: "t-r", question: "Was the revised fee approved?" };
  const first = await h1.call("POST", `/calls/${c1}/turns`, t);
  h1.close();
  // In-memory state is gone; the episode (with its turn key) is on disk.
  // A turn key is scoped to its call, so a retry is only meaningful on the
  // same call id - simulate the provider retrying against a restarted
  // server by recording through memory directly with the same key.
  const h2 = harness({ dir });
  try {
    const c2 = await h2.start();
    const mem = (await h2.call("GET", `/calls/${c2}/memory`)).body.memory;
    assert.equal(mem.episodes.length, 1);
    const key = mem.episodes[0].turnKey;
    assert.equal(key, `api:${c1}:t-r`);
    const binding = h2.identity.verify(h2.assertion());
    const again = h2.memory.recordEpisode(binding, {
      callId: c1,
      caseId: "deal",
      question: t.question,
      final: { kind: "answered", verdict: "PROPOSED", citations: [] },
      corpus: { version: "v1" },
      turnKey: key,
    });
    assert.equal(again.duplicate, true);
    assert.equal(again.episode.id, first.body.episode.id);
    assert.equal(h2.memory.list(binding).episodes.length, 1);
  } finally {
    h2.close();
  }
});

test("C3: an interrupted answer is never recorded as a commitment; delivery is observed, not 'heard'", async () => {
  const h = harness();
  try {
    const c = await h.start();
    await h.call("POST", `/calls/${c}/consent`, { conversation: true });
    const i = await h.call("POST", `/calls/${c}/turns`, {
      turnId: "t-i",
      question: "Was the revised fee approved?",
      delivery: "interrupted",
    });
    assert.equal(i.body.recorded, false);
    assert.equal(i.body.reason, "interrupted");
    const ok = await h.call("POST", `/calls/${c}/turns`, {
      turnId: "t-o",
      question: "Was the revised fee approved?",
    });
    assert.equal(ok.body.episode.delivery, "reported_by_client");
    assert.equal(
      (
        await h.call("POST", `/calls/${c}/turns`, {
          turnId: "t-h",
          question: "q",
          delivery: "heard",
        })
      ).body.code,
      "bad_delivery",
    );
  } finally {
    h.close();
  }
});
