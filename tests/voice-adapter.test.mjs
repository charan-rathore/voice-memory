import { test } from "node:test";
import assert from "node:assert/strict";
import { createVoiceAdapter, spellRecordIds } from "../src/voice-adapter.mjs";
import { importBundle } from "../dist/engine.mjs";
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
test("record ids are spelled for the synthesiser, values untouched", () => {
  const ids = ["SYN-0001", "SYN-0003"];
  assert.equal(
    spellRecordIds("SYN-0001 ka ferritin 13.0 hai.", ids),
    "S Y N zero zero zero one ka ferritin 13.0 hai.",
  );
  assert.equal(
    spellRecordIds("Compare SYN-0001 and SYN-0003.", ids),
    "Compare S Y N zero zero zero one and S Y N zero zero zero three.",
  );
  assert.equal(
    spellRecordIds("The fee is USD 42000.", ids),
    "The fee is USD 42000.",
  );
  assert.equal(
    spellRecordIds("syn-0001 lower stays", ids),
    "syn-0001 lower stays",
  );
});

test("only the record inventory is spelled: identifier-shaped text stays verbatim", () => {
  const ids = ["SYN-0001", "SYN-0003", "AL-101"];
  for (const s of [
    "ISO-27001 certification is mentioned.",
    "INV-12345 was paid.",
    "USD-42000 is not a thing.",
    "CASE-2026 stays.",
    "SYN-0002 is not in the inventory.",
  ])
    assert.equal(spellRecordIds(s, ids), s, s);
  // No inventory: nothing is spelled, however id-shaped.
  assert.equal(spellRecordIds("SYN-0001 ka result"), "SYN-0001 ka result");
  // An inventoried id next to numbers: only the id is spelled.
  assert.equal(
    spellRecordIds("AL-101 discharge 24 October 2026, bill 42000.", ids),
    "A L one zero one discharge 24 October 2026, bill 42000.",
  );
});

test("an orphan question with a lost subject declines instead of splicing an earlier topic", async () => {
  const a = createVoiceAdapter();
  const t = a.bind(
    importBundle([
      {
        title: "Northstar agreement",
        text: "The fee for the Northstar deal is USD 42000. The deadline is 30 September 2026.",
      },
    ]),
  );
  const first = await a.handle(request(t, "What is the fee?"));
  assert.match(await first.text(), /42000/);
  const history = (q) => [
    { role: "user", content: "What is the fee?" },
    {
      role: "assistant",
      content: "The fee for the Northstar deal is USD 42000.",
    },
    { role: "user", content: q },
  ];
  const ask = (q) =>
    a.handle(
      new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { authorization: "Bearer " + t },
        body: JSON.stringify({ stream: true, messages: history(q) }),
      }),
    );
  // The recogniser lost the subject: a full possessive question with no
  // anaphora must never be answered by splicing the previous topic.
  const orphan = await ask("kya chamatkari chumbak ka parinam kya hai?");
  const orphanText = await orphan.text();
  assert.doesNotMatch(orphanText, /42000/);
  assert.doesNotMatch(orphanText, /fee/i);
  assert.match(a.lastTurn(t).spokenTurn.verdict, /UNKNOWN|UNBOUND/);
  // An anaphoric follow-up still joins the caller's own history.
  const follow = await ask("kya uska amount kya hai?");
  assert.match(await follow.text(), /42000/);
});

test("a known subject in Hinglish possessive form is answered, never orphaned", async () => {
  const a = createVoiceAdapter();
  const t = a.bind(
    importBundle([
      {
        title: "Northstar agreement",
        text: "The fee for the Northstar deal is USD 42000. The deadline is 30 September 2026.",
      },
    ]),
  );
  // Known subjects that happen to be phrased as Hinglish possessives keep
  // their normal path: the orphan rule must not decline them.
  for (const [q, re] of [
    ["Northstar ka deadline kya hai?", /30 September 2026/],
    ["Northstar deal ki fee kya hai?", /42000/],
  ]) {
    const r = await a.handle(
      new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { authorization: "Bearer " + t },
        body: JSON.stringify({
          stream: true,
          messages: [{ role: "user", content: q }],
        }),
      }),
    );
    assert.match(await r.text(), re, q);
  }
});

test("spoken wire to typed display round-trips ids; non-id text is unchanged", async () => {
  const { typedText } = await import("../src/server.mjs");
  const ids = ["SYN-0001", "SYN-0003"];
  const original =
    "SYN-0001 ka ferritin 50 ng/mL hai; ISO-27001 certified. Fee USD 42000, deadline 30 September 2026.";
  const wire = spellRecordIds(original, ids);
  assert.match(wire, /S Y N zero zero zero one/);
  // non-id text survives the wire untouched
  assert.match(wire, /ISO-27001/);
  assert.match(wire, /50 ng\/mL/);
  assert.match(wire, /USD 42000/);
  // typed display reverses exactly the spelled id
  const typed = typedText(wire, ids);
  assert.equal(typed, original);
  // ordinary words are never reinterpreted as ids on either side
  const plain =
    "I am one of two people. Results for the quarter were fine, nine or ten.";
  assert.equal(spellRecordIds(plain, ids), plain);
  assert.equal(typedText(spellRecordIds(plain, ids), ids), plain);
});

test("typed display never reinterprets unrelated spoken codes as record ids", async () => {
  const { typedText } = await import("../src/server.mjs");
  const ids = ["SYN-0001", "SYN-0003"];
  // The review counterexample: not a record id, stays verbatim.
  assert.equal(
    typedText("The code is A B one two three.", ids),
    "The code is A B one two three.",
  );
  // A non-inventoried spelled token stays verbatim even next to a real id.
  assert.equal(
    typedText(
      "S Y N zero zero zero three and I N V one two three four five.",
      ids,
    ),
    "SYN-0003 and I N V one two three four five.",
  );
  // An id outside the inventory is not unspelled by the generic rule.
  assert.equal(
    typedText("S Y N nine nine nine nine ka result", ids),
    "S Y N nine nine nine nine ka result",
  );
  // SYN-0001 has no special bypass: absent from the inventory it stays
  // spelled, and an empty inventory unspells nothing.
  assert.equal(
    typedText("S Y N zero zero zero one ka result", ["SYN-0003"]),
    "S Y N zero zero zero one ka result",
  );
  assert.equal(
    typedText("S Y N zero zero zero one ka result"),
    "S Y N zero zero zero one ka result",
  );
  // Present in the inventory, it unspells as before.
  assert.equal(
    typedText("S Y N zero zero zero one ka result", ["SYN-0001"]),
    "SYN-0001 ka result",
  );
});

test("a token bound to one workspace never reveals another workspace's records", async () => {
  const a = createVoiceAdapter();
  const tokenA = a.bind(
    importBundle([
      {
        title: "Alpha brief",
        text: "Project Kestrel launches on Tuesday after final sign-off from the team.",
      },
    ]),
  );
  // A second caller's workspace exists alongside; it is never bound to tokenA.
  a.bind(
    importBundle([
      {
        title: "Bravo brief",
        text: "Project Falcon ships on Friday pending the remaining vendor checks.",
      },
    ]),
  );
  const r = await a.handle(request(tokenA, "When does Project Falcon ship?"));
  const text = await r.text();
  assert.equal(r.status, 200);
  assert.ok(
    !text.includes("Falcon"),
    "answer must not carry the other workspace's record",
  );
  const turn = a.lastTurn(tokenA);
  assert.ok(
    (turn.result.evidence ?? []).every(
      (e) => !JSON.stringify(e).includes("Bravo"),
    ),
    "evidence must stay inside the token's own workspace",
  );
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
  assert.equal(a.lastTurn(t), null);
});
test("spoken output carries claim safeguards, not a generic wrapper", async () => {
  const { NORTHSTAR_DOCS } = await import("../examples/corpus-northstar.mjs");
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
  // Spoken form: verified values in words, grounded verdict, no record dump.
  assert.match(fee, /\$42,000 is the latest proposal/);
  assert.match(fee, /it is not approved/);
  assert.ok(!fee.includes("I found "), fee);
  assert.ok(!fee.includes(".md"), fee);
  assert.ok(fee.split(/\s+/).length <= 40, fee);
  const conflict = await spokenOf(
    "What payment terms did we finally agree to?",
  );
  assert.match(conflict, /still open/);
  assert.match(conflict, /40\/60/);
  assert.match(conflict, /50\/50/);
  assert.ok(!conflict.includes(".md"), conflict);
  const timing = await spokenOf("When is signoff expected?");
  assert.match(timing, /no timing for sign-off is established/);
  assert.ok(!timing.includes("could not find supporting"), timing);
});

test("GET /v1/models lists the served model behind the voice capability", async () => {
  const { NORTHSTAR_DOCS } = await import("../examples/corpus-northstar.mjs");
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

test("Bolna content parts and a trailing empty assistant still reach the engine", async () => {
  const { NORTHSTAR_DOCS } = await import("../examples/corpus-northstar.mjs");
  const a = createVoiceAdapter();
  const t = a.bind(importBundle(NORTHSTAR_DOCS));
  const parts = await a.handle(
    new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { authorization: "Bearer " + t },
      body: JSON.stringify({
        model: "voice-memory-local",
        stream: true,
        stream_options: { include_usage: true },
        stop: ["User:"],
        messages: [
          { role: "system", content: "Answer only from the documents." },
          {
            role: "user",
            content: [{ type: "text", text: "What is the engagement fee?" }],
          },
          { role: "assistant", content: "" },
        ],
      }),
    }),
  );
  assert.equal(parts.status, 200);
  assert.match(parts.headers.get("content-type") ?? "", /text\/event-stream/);
  assert.match(await parts.text(), /\$42,000/);
});

test("a non-streaming side request does not supersede the spoken turn", async () => {
  const pending = [];
  const adapter = createVoiceAdapter({
    retrieval: {
      actualMode: "keyword",
      embeddingModel: null,
      retrieve: async (_q, bundle) =>
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
  const spoken = adapter.handle(request(token, "security review"));
  await new Promise((r) => setImmediate(r));
  const side = adapter.handle(
    request(token, "Is this call complete? Reply as JSON.", {
      stream: false,
      response_format: { type: "json_object" },
    }),
  );
  await new Promise((r) => setImmediate(r));
  // The classifier must not enter the evidence engine or bump the turn.
  assert.equal(pending.length, 1);
  const sideRes = await side;
  assert.equal(sideRes.status, 200);
  const sideJson = await sideRes.json();
  assert.equal(sideJson.object, "chat.completion");
  assert.equal(typeof sideJson.choices?.[0]?.message?.content, "string");
  pending[0]();
  assert.equal((await spoken).status, 200);
});

test("workspace still being read: pending scope says so, never the demo records", async () => {
  const a = createVoiceAdapter(),
    t = a.bind(b());
  a.setBundleResolver(() => ({
    pending: true,
    call: "c" + "0".repeat(24),
    caseId: "w_" + "0".repeat(32),
  }));
  const r = await a.handle(request(t, "how many open safety items?"));
  assert.equal(r.status, 200);
  const text = await r.text();
  assert.match(text, /still reading/i);
  assert.ok(!/expired/i.test(text));
});

test("workspace whose uploads all failed says re-upload, never 'expired'", async () => {
  const a = createVoiceAdapter(),
    t = a.bind(b());
  a.setBundleResolver(() => ({
    pending: "failed",
    call: "c" + "0".repeat(24),
    caseId: "w_" + "0".repeat(32),
  }));
  const r = await a.handle(request(t, "how many open safety items?"));
  assert.equal(r.status, 200);
  const text = await r.text();
  assert.match(text, /couldn't read/i);
  assert.ok(!/expired/i.test(text));
});

test("an engine fault becomes a spoken fallback, never an internal leak", async () => {
  const a = createVoiceAdapter(),
    t = a.bind(b());
  a.setBundleResolver(() => {
    const broken = b();
    Object.defineProperty(broken, "clinical", {
      get() {
        throw new Error("boom-internal-marker");
      },
    });
    return { bundle: broken, call: null, caseId: "demo" };
  });
  const r = await a.handle(request(t, "pilot launch security review"));
  assert.equal(r.status, 200);
  const text = await r.text();
  assert.match(text, /ask me again/i);
  assert.ok(!text.includes("boom-internal-marker"));
  // The grant survives the fault: the next clean turn answers normally.
  a.setBundleResolver(() => null);
  const ok = await a.handle(request(t, "pilot launch security review"));
  assert.equal(ok.status, 200);
  assert.match(await ok.text(), /chat.completion.chunk/);
});

test("resolver rechecks admitted bearer and bundle identity independently of replay policy", async () => {
  for (const allowClientReplay of [true, false])
    for (const change of [
      "unchanged",
      "replacement",
      "unavailable",
      "exception",
    ]) {
      let finish;
      const original = b();
      let current = original;
      const reads = [];
      const adapter = createVoiceAdapter({
        allowClientReplay,
        retrieval: {
          actualMode: "keyword",
          embeddingModel: null,
          retrieve: async () =>
            new Promise((resolve) => {
              finish = () =>
                resolve({
                  actualMode: "keyword",
                  corpusId: original.scope,
                  corpusScope: "corpus",
                  evidence: "insufficient",
                  chunks: [],
                });
            }),
        },
      });
      const token = adapter.bind(original);
      adapter.setBundleResolver((_messages, admitted) => {
        reads.push(admitted);
        if (current === "throw") throw Error("unavailable");
        return { bundle: current, caseId: "health", expired: !current };
      });
      const pending = adapter.handle(
        request(token, "pilot launch security review"),
      );
      for (let i = 0; i < 100 && !finish; i++)
        await new Promise((r) => setImmediate(r));
      assert.ok(finish);
      if (change === "replacement") current = { ...original };
      if (change === "unavailable") current = null;
      if (change === "exception") current = "throw";
      finish();
      const response = await pending;
      const output = await response.text();
      assert.deepEqual(reads, [token, token]);
      if (change === "unchanged")
        assert.doesNotMatch(output, /became unavailable/);
      else assert.match(output, /became unavailable/);
    }
});
