// Bring your own voice: a visitor's own voice platform calls this engine as a
// custom LLM with a scoped key, and a web call can start on the visitor's own
// Bolna account. The engine still writes every reply; keys stay scoped.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createLocalServer } from "../src/server.mjs";

async function boot(opts = {}) {
  const srv = createLocalServer({ port: 0, ...opts });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  await srv.loadPublicCases();
  return { srv, base: `http://127.0.0.1:${srv.address().port}/api/public` };
}

test("a custom-LLM key answers its case in OpenAI format, with the engine's verdict", async () => {
  const { srv, base } = await boot();
  try {
    const k = await fetch(`${base}/llm/key`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ case: "deal" }),
    });
    assert.equal(k.status, 200);
    const key = await k.json();
    assert.match(key.baseUrl, /\/api\/public\/llm\/v1$/);
    assert.match(key.apiKey, /^[0-9a-f]{64}$/);
    const auth = { authorization: `Bearer ${key.apiKey}` };
    const models = await fetch(`${base}/llm/v1/models`, { headers: auth });
    assert.equal(models.status, 200);
    const r = await fetch(`${base}/llm/v1/chat/completions`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({
        stream: true,
        model: "voice-memory",
        messages: [
          { role: "user", content: "Was the $42,000 revision finalized?" },
        ],
      }),
    });
    assert.equal(r.status, 200);
    const text = await r.text();
    assert.match(text, /chat\.completion\.chunk/);
    assert.match(text, /42,000/);
    assert.match(text, /not|isn't|nahi|नहीं/i, "proposed, not approved");
  } finally {
    srv.close();
  }
});

test("bad, missing or unknown-scope keys are refused", async () => {
  const { srv, base } = await boot();
  try {
    const bad = await fetch(`${base}/llm/v1/chat/completions`, {
      method: "POST",
      headers: {
        authorization: "Bearer " + "0".repeat(64),
        "content-type": "application/json",
      },
      body: JSON.stringify({ messages: [{ role: "user", content: "fee?" }] }),
    });
    assert.equal(bad.status, 401);
    const none = await fetch(`${base}/llm/v1/models`);
    assert.equal(none.status, 401);
    const ws = await fetch(`${base}/llm/key`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ case: "w_" + "0".repeat(32) }),
    });
    assert.equal(ws.status, 404, "no key for a workspace that does not exist");
    const junk = await fetch(`${base}/llm/key`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ case: "../owner" }),
    });
    assert.equal(junk.status, 400);
  } finally {
    srv.close();
  }
});

test("a BYO call mints on the visitor's own Bolna account and keeps no key", async () => {
  const seen = [];
  const vendorFetch = async (url, init) => {
    seen.push({
      url,
      auth: init.headers.authorization,
      body: JSON.parse(init.body),
    });
    return new Response(JSON.stringify({ session_id: "s1", token: "t" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const { srv, base } = await boot({ vendorFetch });
  try {
    const visitorKey = "bn-visitor-key-123456";
    const r = await fetch(`${base}/voice/byo/session`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-bolna-key": visitorKey,
      },
      body: JSON.stringify({
        agent_id: "53863b64-11e0-4cad-85c4-1285ba982159",
        user_data: { vm_ws: "demo" },
      }),
    });
    assert.equal(r.status, 200);
    const out = await r.json();
    assert.equal(out.session_id, "s1");
    assert.equal(seen.length, 1);
    assert.equal(seen[0].auth, "Bearer " + visitorKey);
    assert.equal(seen[0].body.agent_id, "53863b64-11e0-4cad-85c4-1285ba982159");
    assert.ok(!JSON.stringify(out).includes(visitorKey), "key never echoed");
    const noKey = await fetch(`${base}/voice/byo/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agent_id: "53863b64-11e0-4cad-85c4-1285ba982159",
      }),
    });
    assert.equal(noKey.status, 400);
    const badAgent = await fetch(`${base}/voice/byo/session`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-bolna-key": visitorKey,
      },
      body: JSON.stringify({ agent_id: "not an id; drop table" }),
    });
    assert.equal(badAgent.status, 400);
    assert.equal(seen.length, 1, "nothing sent to Bolna for refused requests");
  } finally {
    srv.close();
  }
});
