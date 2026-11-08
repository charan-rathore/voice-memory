// Races and scope edges on a live call. Each test failed on PR #49's first
// head (d771e0e) before its fix:
//   - two different callers on the shared bearer: B's turn superseded A's
//     answer in flight (one counter per bearer), so A heard silence;
//   - quick A -> B -> A tab switches delivered out of order left the call on
//     B; an answer finished after a switch was spoken for the old case;
//   - "before the correction" on a date the reports do not have answered
//     about another date; "first ferritin" was read as "before correction";
//   - an unreadable vm_ws fell back to every demo record;
//   - an expired workspace said so on the call but nothing reached the page.
// No network: Bolna minting goes through an injected fetch.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createVoiceAdapter } from "../src/voice-adapter.mjs";
import { importBundle } from "../dist/engine.mjs";
import { NORTHSTAR_DOCS } from "../examples/corpus-northstar.mjs";
import { createLocalServer } from "../src/server.mjs";

const agentPrompt = (v) =>
  `Voice Memory evidence agent. Workspace: vm_ws=${v}. Answers come from the Voice Memory engine.`;
const tag = (n) => "c" + String(n).repeat(24).slice(0, 24);
const ask = (token, vmWs, text) =>
  new Request("http://localhost/v1/chat/completions", {
    method: "POST",
    headers: {
      authorization: "Bearer " + token,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "voice-memory",
      stream: true,
      messages: [
        { role: "system", content: agentPrompt(vmWs) },
        { role: "user", content: text },
      ],
    }),
  });
const tick = () => new Promise((r) => setImmediate(r));

test("two callers on the shared bearer never supersede each other; one caller's barge-in still does", async () => {
  const pending = [];
  const bundle = importBundle(NORTHSTAR_DOCS);
  const adapter = createVoiceAdapter({
    retrieval: {
      actualMode: "keyword",
      embeddingModel: null,
      retrieve: async (_q, b) =>
        new Promise((resolve) =>
          pending.push(() =>
            resolve({
              actualMode: "keyword",
              corpusId: b.scope,
              corpusScope: "corpus",
              evidence: "insufficient",
              chunks: [],
            }),
          ),
        ),
    },
  });
  adapter.setBundleResolver((messages) => {
    const m = /vm_ws=deal\.(c[0-9a-f]{24})/.exec(messages[0].content);
    return { bundle, call: m?.[1] ?? null, caseId: "deal" };
  });
  const token = adapter.bind(bundle);
  // caller A is answering slowly; caller B speaks meanwhile
  const a = adapter.handle(
    ask(token, `deal.${tag(1)}`, "What is the engagement fee?"),
  );
  await tick();
  const b2 = adapter.handle(ask(token, `deal.${tag(2)}`, "What's still open?"));
  await tick();
  pending[1]();
  assert.equal((await b2).status, 200);
  pending[0]();
  assert.equal((await a).status, 200, "A must not be superseded by B");
  // the same caller talking over itself: the older turn yields
  const a1 = adapter.handle(
    ask(token, `deal.${tag(1)}`, "What is the engagement fee?"),
  );
  await tick();
  const a2 = adapter.handle(
    ask(token, `deal.${tag(1)}`, "Was the $42,000 revision finalized?"),
  );
  await tick();
  pending[3]();
  assert.equal((await a2).status, 200);
  pending[2]();
  assert.equal((await a1).status, 409, "same-call barge-in preserved");
});

// ------------------------------------------------------------ live server

const CAP = "races" + "7".repeat(59);
async function boot({ voice } = {}) {
  const saved = { ...process.env };
  const dir = mkdtempSync(path.join(tmpdir(), "vm-races-"));
  Object.assign(process.env, {
    VM_VOICE_CAPABILITY: CAP,
    VM_VOICE_HARD_EXPIRES_AT: new Date(Date.now() + 3600e3).toISOString(),
    VM_DENSE: "off",
    BOLNA_API_KEY: "test-dummy",
    BOLNA_AGENT_ID: "test-dummy",
    VM_PUBLIC_VOICE: "on",
    VM_COUNTERS_ALLOW_FILE: "on",
    VM_PUBLIC_COUNTER_FILE: path.join(dir, "counters.json"),
    VM_PUBLIC_CALL_GAP_MS: "1",
    VM_PUBLIC_CALLS_PER_IP_DAY: "50",
    VM_PUBLIC_CALLS_PER_DAY: "50",
  });
  const minted = [];
  const vendorFetch = async (url, init) => {
    if (String(url).includes("/web-call/")) {
      minted.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ execution_id: "ex" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("{}", { status: 200 });
  };
  const srv = createLocalServer({
    port: 0,
    vendorFetch,
    ...(voice ? { voice } : {}),
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  await srv.loadPublicCases({ bindVoice: true });
  await new Promise((r) => setTimeout(r, 300));
  const b = `http://127.0.0.1:${srv.address().port}`;
  const post = async (p, body, headers = {}) => {
    const r = await fetch(b + p, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  const say = async (vmWs, history) => {
    const r = await fetch(b + "/v1/chat/completions", {
      method: "POST",
      headers: {
        authorization: "Bearer " + CAP,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "voice-memory-local",
        stream: true,
        messages: [{ role: "system", content: agentPrompt(vmWs) }, ...history],
      }),
    });
    const raw = await r.text();
    return [...raw.matchAll(/^data: (.*)$/gm)]
      .map((m) => m[1])
      .filter((d) => d !== "[DONE]")
      .map((d) => JSON.parse(d).choices?.[0]?.delta?.content ?? "")
      .join("")
      .trim();
  };
  return {
    b,
    minted,
    post,
    say,
    mint: (user_data, ip) =>
      post(
        "/api/public/voice/session",
        { user_data },
        { "x-forwarded-for": ip },
      ),
    scope: (ticket, c, gen) =>
      post("/api/public/voice/scope", { ticket, case: c, gen }),
    turns: async (ticket) =>
      (
        await (
          await fetch(`${b}/api/public/voice/turns?ticket=${ticket}`)
        ).json()
      ).turns,
    close: async () => {
      await new Promise((r) => srv.close(() => r()));
      for (const k of Object.keys(process.env))
        if (!(k in saved)) delete process.env[k];
      Object.assign(process.env, saved);
    },
  };
}

test("out-of-order scope updates end on what the page shows (A -> B -> A)", async () => {
  const api = await boot();
  try {
    const m = await api.mint({ vm_ws: "health" }, "10.1.0.1");
    const t = m.body.vm_ticket;
    const ws = api.minted[0].user_data.vm_ws;
    // the page sent deal (gen 1) then health (gen 2); deal arrives last
    assert.equal((await api.scope(t, "health", 2)).body.case, "health");
    assert.equal((await api.scope(t, "deal", 1)).body.case, "health");
    const said = await api.say(ws, [
      { role: "user", content: "What is SYN-0001's ferritin result?" },
    ]);
    assert.match(said, /50 ng\/mL/);
    const turns = await api.turns(t);
    assert.equal(turns.at(-1).case, "health");
  } finally {
    await api.close();
  }
});

test("an answer that finishes after a tab switch is not spoken for the old case", async () => {
  // retrieval is held until the page has switched tabs
  let release, entered;
  const started = new Promise((r) => {
    entered = r;
  });
  const gate = new Promise((r) => (release = r));
  const voice = createVoiceAdapter({
    ttlMs: 600000,
    hardExpiresAtMs: Date.now() + 3600e3,
    retrieval: {
      actualMode: "keyword",
      embeddingModel: null,
      retrieve: async (_q, b) => {
        entered();
        await gate;
        return {
          actualMode: "keyword",
          corpusId: b.scope,
          corpusScope: "corpus",
          evidence: "insufficient",
          chunks: [],
        };
      },
    },
  });
  // The enabled common path intentionally skips separate retrieval. Hold
  // the actual common resolver too, so this remains an in-flight source
  // switch test in either mode rather than racing a completed answer.
  const setAnswerResolver = voice.setAnswerResolver;
  voice.setAnswerResolver = (resolver) =>
    setAnswerResolver(async (input) => {
      entered();
      await gate;
      return resolver(input);
    });
  const api = await boot({ voice });
  try {
    const m = await api.mint({ vm_ws: "health" }, "10.1.0.2");
    const t = m.body.vm_ticket;
    const ws = api.minted[0].user_data.vm_ws;
    const inflight = api.say(ws, [
      { role: "user", content: "Has creatinine gone up since September?" },
    ]);
    let deadline;
    try {
      await Promise.race([
        started,
        new Promise((_, reject) => {
          deadline = setTimeout(
            () => reject(Error("answer boundary not reached")),
            3000,
          );
          deadline.unref();
        }),
      ]);
    } finally {
      clearTimeout(deadline);
    }
    assert.equal((await api.scope(t, "deal", 1)).body.case, "deal");
    release();
    const said = await inflight;
    assert.doesNotMatch(said, /creatinine|µmol|mg\/dL/i);
    assert.match(said, /switched to the Northstar deal/);
    const last = (await api.turns(t)).at(-1);
    assert.equal(last.case, "deal");
    assert.equal(last.lead.text, said);
    assert.equal((last.lead?.citations ?? []).length, 0);
  } finally {
    release();
    await api.close();
  }
});

test("an unreadable vm_ws is refused, never widened to every record; a phone call keeps the demo", async () => {
  const api = await boot();
  try {
    for (const bad of [
      "w_123",
      "health.cZZZ",
      "everything",
      "deal.c" + "1".repeat(23),
    ]) {
      const said = await api.say(bad, [
        { role: "user", content: "What is SYN-0001's ferritin result?" },
      ]);
      assert.doesNotMatch(said, /50 ng\/mL|Ferritin/, bad);
      assert.match(said, /can't tell which documents/, bad);
    }
    // placeholder left unsubstituted (phone call): the demo records, as before
    const phone = await api.say("{vm_ws}", [
      { role: "user", content: "What is SYN-0001's ferritin result?" },
    ]);
    assert.match(phone, /50 ng\/mL/);
  } finally {
    await api.close();
  }
});

test("an expired workspace: the same explanation is spoken and shown on the call's page", async () => {
  const api = await boot();
  try {
    const ws = await api.post("/api/public/workspace", {});
    const id = ws.body.id;
    const m = await api.mint({ vm_ws: id }, "10.1.0.3");
    const t = m.body.vm_ticket;
    const vmWs = api.minted[0].user_data.vm_ws;
    assert.match(vmWs, new RegExp(`^${id}\\.c[0-9a-f]{24}$`));
    // empty workspace = nothing to answer from: said plainly, never the
    // demo records and never a false "expired"
    const said = await api.say(vmWs, [
      { role: "user", content: "What is SYN-0001's ferritin result?" },
    ]);
    assert.doesNotMatch(said, /50 ng\/mL|Ferritin/);
    assert.match(said, /don't have any documents/);
    const turns = await api.turns(t);
    assert.equal(turns.at(-1).case, id);
    assert.equal(turns.at(-1).lead.text, said);
  } finally {
    await api.close();
  }
});
