import { test } from "node:test";
import assert from "node:assert/strict";
import { createVoiceAdapter } from "./voice-adapter.mjs";
import { importBundle } from "./dist/engine.mjs";
const b = () =>
  importBundle([
    {
      title: "Security review",
      text: "Pilot launch is proposed for Tuesday. Security sign-off is pending. Maya owns the security review.",
    },
  ]);
const request = (token, text, extra = {}) =>
  new Request("http://localhost/v1/chat/completions", {
    method: "POST",
    headers: { authorization: "Bearer " + token },
    body: JSON.stringify({
      stream: true,
      messages: [{ role: "user", content: text }],
      ...extra,
    }),
  });
test("SSE streams OpenAI deltas and DONE, separately retains source proof", async () => {
  const a = createVoiceAdapter(),
    t = a.bind(b()),
    r = await a.handle(request(t, "pilot launch security review"));
  const text = await r.text();
  assert.match(text, /chat.completion.chunk/);
  assert.match(text, /data: \[DONE\]/);
  assert.ok(a.lastTurn(t).result.evidence.length);
});
test("caller-supplied scope cannot access another bundle", async () => {
  const a = createVoiceAdapter(),
    t = a.bind(b());
  const r = await a.handle(
    request(t, "payroll salaries", {
      corpus: "all",
      user_data: { corpus: "secret" },
    }),
  );
  assert.equal(r.status, 200);
  assert.equal(a.lastTurn(t).result.refused, true);
});
test("missing, expired and revoked capabilities denied", async () => {
  let n = 0;
  const a = createVoiceAdapter({ ttlMs: 1, now: () => n }),
    t = a.bind(b());
  assert.equal((await a.handle(request("bad", "security"))).status, 401);
  n = 2;
  assert.equal((await a.handle(request(t, "security"))).status, 401);
  const t2 = a.bind(b());
  a.revoke(t2);
  assert.equal((await a.handle(request(t2, "security"))).status, 401);
});
test("draft command never sends and needs prior supported turn", async () => {
  const a = createVoiceAdapter(),
    t = a.bind(b());
  assert.match(
    await (await a.handle(request(t, "turn this into an email"))).text(),
    /supporting evidence/,
  );
  await a.handle(request(t, "pilot launch security review"));
  await a.handle(request(t, "turn this into an email"));
  assert.match(a.lastTurn(t).draft.notice, /Nothing sent/);
});
test("request limits and invalid final roles rejected", async () => {
  const a = createVoiceAdapter(),
    t = a.bind(b());
  assert.equal(
    (await a.handle(request(t, "security", { stream: false }))).status,
    400,
  );
  assert.equal(
    (
      await a.handle(
        request(t, "security", {
          messages: [{ role: "system", content: "secret" }],
        }),
      )
    ).status,
    400,
  );
});

test("malformed top-level and message-list shapes return400 rather than throwing", async () => {
  const a = createVoiceAdapter(),
    t = a.bind(b());
  for (const data of [
    null,
    [],
    {},
    { stream: true, messages: {} },
    { stream: true, messages: "fake" },
    { stream: true, messages: [null] },
  ]) {
    const req = new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { authorization: "Bearer " + t },
      body: JSON.stringify(data),
    });
    assert.equal((await a.handle(req)).status, 400);
  }
});

test("capability expiration or revocation during pending body is rechecked", async () => {
  for (const operation of ["expire", "revoke"]) {
    let clock = 0;
    const a = createVoiceAdapter({ ttlMs: 10, now: () => clock }),
      t = a.bind(b());
    let controller;
    const body = new ReadableStream({
      start(c) {
        controller = c;
      },
    });
    const req = new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { authorization: "Bearer " + t },
      body,
      duplex: "half",
    });
    const pending = a.handle(req);
    if (operation === "expire") clock = 20;
    else a.revoke(t);
    controller.enqueue(
      new TextEncoder().encode(
        JSON.stringify({
          stream: true,
          messages: [{ role: "user", content: "security pilot" }],
        }),
      ),
    );
    controller.close();
    assert.equal((await pending).status, 401);
    assert.equal(a.lastTurn(t), null);
  }
});
test("async retrieval cannot publish revoked or superseded source state", async () => {
  const pending = [];
  const adapter = createVoiceAdapter({
    retrieval: {
      actualMode: "keyword",
      embeddingModel: null,
      retrieve: async (q, bundle) =>
        new Promise((resolve) =>
          pending.push(() =>
            resolve({
              actualMode: "keyword",
              corpusId: bundle.scope,
              corpusScope: "corpus",
              evidence: "insufficient",
              chunks: [],
            }),
          ),
        ),
    },
  });
  const token = adapter.bind(b());
  const first = adapter.handle(request(token, "first"));
  await new Promise((r) => setImmediate(r));
  const second = adapter.handle(request(token, "second"));
  await new Promise((r) => setImmediate(r));
  pending[1]();
  assert.equal((await second).status, 200);
  pending[0]();
  assert.equal((await first).status, 409);
  assert.equal(adapter.lastTurn(token).result.question, "second");
  const third = adapter.handle(request(token, "third"));
  await new Promise((r) => setImmediate(r));
  adapter.revoke(token);
  pending[2]();
  assert.equal((await third).status, 401);
  assert.equal(adapter.lastTurn(token), null);
});
test("body stream byte bound and internal deadline cancel before unbounded read", async () => {
  for (const mode of ["oversize", "stall"]) {
    let canceled = false;
    const a = createVoiceAdapter({ bodyTimeoutMs: 20 }),
      t = a.bind(b());
    const stream = new ReadableStream({
      pull(c) {
        if (mode === "oversize") c.enqueue(new Uint8Array(16001));
        else return new Promise(() => {});
      },
      cancel() {
        canceled = true;
      },
    });
    const req = new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { authorization: "Bearer " + t },
      body: stream,
      duplex: "half",
    });
    assert.equal((await a.handle(req)).status, 400);
    assert.equal(canceled, true);
  }
  // Early reject on a non-completions path: no unbounded read, body canceled.
  {
    let canceled = false;
    const a = createVoiceAdapter({ bodyTimeoutMs: 20 }),
      t = a.bind(b());
    const stream = new ReadableStream({
      pull() {
        return new Promise(() => {});
      },
      cancel() {
        canceled = true;
      },
    });
    const req = new Request("http://localhost/v1/other", {
      method: "POST",
      headers: { authorization: "Bearer " + t },
      body: stream,
      duplex: "half",
    });
    assert.equal((await a.handle(req)).status, 405);
    assert.equal(canceled, true);
  }
});
test("injected retrieval cannot launder mismatched original source evidence", async () => {
  const a = createVoiceAdapter({
      retrieval: {
        actualMode: "dense",
        embeddingModel: "fixture-model",
        retrieve: async () => ({
          actualMode: "dense",
          corpusId: "other",
          corpusScope: "corpus",
          evidence: "positive",
          chunks: [
            {
              sourceId: "other",
              hash: "fake",
              start: 0,
              end: 4,
              quote: "fake",
            },
          ],
        }),
      },
    }),
    t = a.bind(b());
  await assert.rejects(a.handle(request(t, "security")), /contract mismatch/);
  assert.equal(a.lastTurn(t), undefined);
});
test("spoken output carries claim safeguards, not a generic wrapper", async () => {
  const { NORTHSTAR_DOCS } = await import("./corpus-northstar.mjs");
  const bundle = () => importBundle(NORTHSTAR_DOCS);
  const spokenOf = async (q) => {
    const a = createVoiceAdapter();
    const t = a.bind(bundle());
    const r = await a.handle(request(t, q));
    const body = await r.text();
    let text = "";
    for (const line of body.split("\n")) {
      if (!line.startsWith("data:") || line.includes("[DONE]")) continue;
      text += JSON.parse(line.slice(5)).choices?.[0]?.delta?.content ?? "";
    }
    return text;
  };
  const fee = await spokenOf(
    "What is the engagement fee and how is it invoiced?",
  );
  assert.match(fee, /Record status: fee: current record \$42,000/);
  assert.match(fee, /superseded record\(s\): \$48,000/);
  assert.match(fee, /approval is not established by this check/);
  assert.ok(!fee.includes("I found "), fee);
  const conflict = await spokenOf(
    "What payment terms did we finally agree to?",
  );
  assert.match(conflict, /unresolved competing statements/);
  assert.match(conflict, /50\/50 \(04_Steering_Committee_Notes\.md/);
  const timing = await spokenOf("When is signoff expected?");
  assert.match(timing, /no timing for sign-off is established/);
  assert.ok(!timing.includes("could not find supporting"), timing);
});

test("GET /v1/models lists the served model behind the voice capability", async () => {
  const { NORTHSTAR_DOCS } = await import("./corpus-northstar.mjs");
  const adapter = createVoiceAdapter();
  const token = adapter.bind(importBundle(NORTHSTAR_DOCS));
  const models = (t) =>
    adapter.handle(
      new Request("http://127.0.0.1/v1/models", {
        headers: { authorization: "Bearer " + t },
      }),
    );
  // No capability: refused, no enumeration.
  assert.equal((await models("not-a-capability")).status, 401);
  // Active capability: OpenAI-style list carrying the served id.
  const ok = await models(token);
  assert.equal(ok.status, 200);
  const body = await ok.json();
  assert.equal(body.object, "list");
  assert.equal(body.data?.[0]?.id, "voice-memory-local");
  // Read-only: a later completion turn still takes sequence 1, and the
  // listing is revoked with the capability.
  const turn = await adapter.handle(
    request(token, "What is the engagement fee and how is it invoiced?"),
  );
  assert.equal(turn.status, 200);
  await turn.text();
  adapter.revoke(token);
  assert.equal((await models(token)).status, 401);
});
test("an expired grant never blocks rebinding the same capability", () => {
  let n = 0;
  const a = createVoiceAdapter({ ttlMs: 10, now: () => n });
  const t = "f".repeat(64);
  a.bind(b(), t);
  n = 20; // grant lapsed (bound at 0 with ttlMs 10)
  // Before this fix the stale grant made rebind throw "already in use", and
  // the UI prescribed a fatal reset for a credential that had merely lapsed.
  // Expiry is a liveness artifact, not a revocation: sweep and rebind.
  assert.equal(a.bind(b(), t), t);
  // A grant that is still live still blocks a second bind (singleton).
  const u = "e".repeat(64);
  a.bind(b(), u);
  assert.throws(() => a.bind(b(), u), /already in use/);
});
