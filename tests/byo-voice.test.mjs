// Bring your own voice: a visitor's own voice platform calls this engine as a
// custom LLM with a scoped key, and a web call can start on the visitor's own
// Bolna account. The engine still writes every reply; keys stay scoped.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createLocalServer } from "../src/server.mjs";

async function boot(opts = {}) {
  const previous = process.env.VM_BYO_VOICE;
  if (opts.byoEnabled !== false) process.env.VM_BYO_VOICE = "on";
  else delete process.env.VM_BYO_VOICE;
  const srv = createLocalServer({ port: 0, ...opts });
  if (previous === undefined) delete process.env.VM_BYO_VOICE;
  else process.env.VM_BYO_VOICE = previous;
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

test("a key can be revoked by whoever holds it, and stops working at once", async () => {
  const { srv, base } = await boot();
  try {
    const key = await (
      await fetch(`${base}/llm/key`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ case: "health" }),
      })
    ).json();
    const auth = { authorization: `Bearer ${key.apiKey}` };
    assert.equal(
      (await fetch(`${base}/llm/v1/models`, { headers: auth })).status,
      200,
    );
    const del = await fetch(`${base}/llm/key`, {
      method: "DELETE",
      headers: auth,
    });
    assert.equal(del.status, 200);
    assert.equal(
      (await fetch(`${base}/llm/v1/models`, { headers: auth })).status,
      401,
    );
    const again = await fetch(`${base}/llm/key`, {
      method: "DELETE",
      headers: auth,
    });
    assert.equal(again.status, 401);
    const none = await fetch(`${base}/llm/key`, { method: "DELETE" });
    assert.equal(none.status, 401);
  } finally {
    srv.close();
  }
});

test("keys issued across all visitors have an hourly ceiling", async () => {
  const before = process.env.VM_BYO_KEYS_PER_HOUR;
  process.env.VM_BYO_KEYS_PER_HOUR = "2";
  const { srv, base } = await boot();
  try {
    const mint = () =>
      fetch(`${base}/llm/key`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ case: "deal" }),
      });
    assert.equal((await mint()).status, 200);
    assert.equal((await mint()).status, 200);
    assert.equal((await mint()).status, 429);
  } finally {
    if (before === undefined) delete process.env.VM_BYO_KEYS_PER_HOUR;
    else process.env.VM_BYO_KEYS_PER_HOUR = before;
    srv.close();
  }
});

test("idle expiry rejects workspace reads before refreshing its lifetime", async () => {
  const old = process.env.VM_WS_IDLE_MIN;
  process.env.VM_WS_IDLE_MIN = "0.0001";
  const { srv, base } = await boot();
  try {
    const workspace = await (
      await fetch(`${base}/workspace`, { method: "POST" })
    ).json();
    await new Promise((resolve) => setTimeout(resolve, 30));
    const result = await fetch(`${base}/workspace/${workspace.id}`);
    assert.equal(result.status, 404);
  } finally {
    if (old === undefined) delete process.env.VM_WS_IDLE_MIN;
    else process.env.VM_WS_IDLE_MIN = old;
    srv.close();
  }
});

test("expired workspace revokes its BYO key without creating another workspace", async () => {
  const { srv, base } = await boot();
  const realNow = Date.now;
  try {
    const workspace = await (
      await fetch(`${base}/workspace`, { method: "POST" })
    ).json();
    await fetch(`${base}/workspace/${workspace.id}/upload`, {
      method: "POST",
      headers: {
        "content-type": "application/octet-stream",
        "x-file-name": "synthetic.txt",
      },
      body: "# Synthetic agreement\n\nThe synthetic renewal fee is $9,000 for the project. Payment is due within thirty days after the invoice. No amendment has been signed. This fixture contains no real personal information.",
    });
    for (let i = 0; i < 100; i++) {
      const status = await (
        await fetch(`${base}/workspace/${workspace.id}`)
      ).json();
      if (status.ready) break;
      if (i === 99) assert.fail(JSON.stringify(status));
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const response = await fetch(`${base}/llm/key`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ case: workspace.id }),
    });
    assert.equal(response.status, 200);
    const key = await response.json();
    Date.now = () => realNow() + 31 * 60000;
    assert.equal(
      (
        await fetch(`${base}/llm/v1/models`, {
          headers: { authorization: `Bearer ${key.apiKey}` },
        })
      ).status,
      401,
    );
    assert.equal(
      (await fetch(`${base}/workspace/${workspace.id}`)).status,
      404,
    );
  } finally {
    Date.now = realNow;
    srv.close();
  }
});

test("BYO default off refuses keys, calls and visitor TTS before vendor access", async () => {
  let calls = 0;
  const { srv, base } = await boot({
    byoEnabled: false,
    vendorFetch: async () => {
      calls++;
      throw Error("must not call");
    },
  });
  try {
    const status = await (await fetch(`${base}/status`)).json();
    assert.equal(status.byoVoice.enabled, false);
    for (const path of [
      "/llm/key",
      "/llm/v1/chat/completions",
      "/voice/byo/session",
      "/speak",
    ]) {
      const response = await fetch(base + path, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-vm-tts-provider": "sarvam",
          "x-vm-tts-key": "synthetic-no-secret",
        },
        body: JSON.stringify({
          case: "health",
          text: "synthetic",
          agent_id: "53863b64-11e0-4cad-85c4-1285ba982159",
        }),
      });
      assert.equal(response.status, 503, path);
    }
    assert.equal(calls, 0);
  } finally {
    srv.close();
  }
});
