// VM_DEMO_BUNDLE boot pin: a fresh process must serve the fixed voice
// capability from the built-in fictional corpus with no owner import, owner
// imports must never retarget it, and explicit owner reset retires it
// terminally within the process.
import test from "node:test";
import assert from "node:assert/strict";
import { raw } from "./http-raw.mjs";

const FIXED = "f".repeat(48);
const OWNER = "owner-secret-for-tests-only";
const HOST = "app.example";

const DEMO_ENV = () => ({
  VM_PUBLIC_HOST: HOST,
  VM_PUBLIC_ORIGIN: `https://${HOST}`,
  VM_OWNER_KEY: OWNER,
  VM_VOICE_CAPABILITY: FIXED,
  VM_VOICE_TTL_MS: String(3 * 60 * 60 * 1000),
  VM_VOICE_HARD_EXPIRES_AT: String(Date.now() + 3600000),
  VM_DEMO_BUNDLE: "northstar",
});

async function start(env) {
  const saved = {};
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  let server;
  try {
    const { createLocalServer } = await import("../server.mjs");
    server = createLocalServer({ port: 0 });
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

async function bearer(base, q, token = FIXED) {
  const r = await raw(base, "/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer " + token,
      host: HOST,
    },
    body: JSON.stringify({
      model: "x",
      stream: true,
      messages: [{ role: "user", content: q }],
    }),
  });
  const text = [...r.body.matchAll(/"content":"((?:[^"\\]|\\.)*)"/g)]
    .map((m) => JSON.parse('"' + m[1] + '"'))
    .join("");
  return { status: r.status, text };
}

async function ownerSession(base) {
  const signin = await raw(base, "/owner-signin", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", host: HOST },
    body: "key=" + encodeURIComponent(OWNER),
  });
  const cookie = signin.headers["set-cookie"]?.[0]?.split(";")[0];
  assert.ok(cookie, "owner sign-in cookie");
  const sess = JSON.parse(
    (await raw(base, "/api/session", { headers: { cookie, host: HOST } })).body,
  );
  return {
    post: async (path, data) => {
      const r = await raw(base, path, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie,
          "x-csrf-token": sess.csrf,
          origin: `https://${HOST}`,
          host: HOST,
        },
        body: JSON.stringify(data),
      });
      return { status: r.status, out: JSON.parse(r.body || "null") };
    },
  };
}

test("demo boot pin: fresh process serves voice turns with no owner import", async () => {
  const { server, base } = await start(DEMO_ENV());
  try {
    const turn = await bearer(base, "Was the $42,000 revision finalized?");
    assert.equal(turn.status, 200);
    assert.match(turn.text, /\$42,000/);
    assert.match(turn.text, /not approved/);
    const signin = await raw(base, "/owner-signin", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", host: HOST },
      body: "key=" + encodeURIComponent(OWNER),
    });
    const cookie = signin.headers["set-cookie"]?.[0]?.split(";")[0];
    const ready = JSON.parse(
      (await raw(base, "/api/readiness", { headers: { host: HOST, cookie } })).body,
    );
    assert.equal(ready.demo, true);
  } finally {
    server.close();
  }
});

test("demo boot pin: owner import and voice/start never retarget the pinned credential", async () => {
  const { server, base } = await start(DEMO_ENV());
  try {
    const owner = await ownerSession(base);
    const imp = await owner.post("/api/import", {
      documents: [
        {
          title: "Private.md",
          text: "# Private\nAuthor: T. Date: 2026-10-01. Type: note.\n1. The engagement fee is $99,000 and it is approved.",
        },
      ],
    });
    assert.equal(imp.status, 200);
    const startRes = await owner.post("/api/voice/start", {});
    assert.equal(startRes.status, 200);
    assert.equal(startRes.out.demo, true);
    // The pinned credential still answers from the fictional corpus.
    const turn = await bearer(base, "What is the engagement fee?");
    assert.equal(turn.status, 200);
    assert.match(turn.text, /\$42,000/);
    assert.doesNotMatch(turn.text, /99,000/);
  } finally {
    server.close();
  }
});

test("demo boot pin: explicit owner reset retires terminally, no silent revive", async () => {
  const { server, base } = await start(DEMO_ENV());
  try {
    const owner = await ownerSession(base);
    assert.equal((await bearer(base, "What is the engagement fee?")).status, 200);
    const reset = await owner.post("/api/reset", {});
    assert.equal(reset.status, 200);
    // Bearer is dead now...
    const after = await bearer(base, "What is the engagement fee?");
    assert.equal(after.status, 401);
    // ...and neither voice/start nor a bearer request can rebind it.
    const restart = await owner.post("/api/voice/start", {});
    assert.notEqual(restart.status, 200);
    assert.match(String(restart.out?.error ?? ""), /retired|rotate|expired/i);
    const again = await bearer(base, "What is the engagement fee?");
    assert.equal(again.status, 401);
  } finally {
    server.close();
  }
});

test("demo boot pin: expired credential at boot keeps the server alive, voice strictly 401", async () => {
  const env = DEMO_ENV();
  env.VM_VOICE_HARD_EXPIRES_AT = String(Date.now() - 60000); // already past
  const { server, base } = await start(env);
  try {
    // Bearer is strictly unauthorized; no silent extension or re-arm.
    const turn = await bearer(base, "What is the engagement fee?");
    assert.equal(turn.status, 401);
    // Owner UI and readiness stay up and report the inactive voice state.
    const signin = await raw(base, "/owner-signin", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", host: HOST },
      body: "key=" + encodeURIComponent(OWNER),
    });
    const cookie = signin.headers["set-cookie"]?.[0]?.split(";")[0];
    const ready = JSON.parse(
      (await raw(base, "/api/readiness", { headers: { host: HOST, cookie } })).body,
    );
    assert.equal(ready.demo, true);
    assert.equal(ready.voice.bound, false);
  } finally {
    server.close();
  }
});

test("demo owner evidence feed: plain GET with owner cookie, 403 without, wrong method safe", async () => {
  const { server, base } = await start(DEMO_ENV());
  try {
    // No session cookie: refused (production owner gate).
    const noauth = await raw(base, "/api/voice/last", { headers: { host: HOST } });
    assert.equal(noauth.status, 403);
    // Owner sign-in, then a real voice turn through the pinned credential.
    const signin = await raw(base, "/owner-signin", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", host: HOST },
      body: "key=" + encodeURIComponent(OWNER),
    });
    const cookie = signin.headers["set-cookie"]?.[0]?.split(";")[0];
    assert.ok(cookie);
    const before = JSON.parse(
      (await raw(base, "/api/voice/last", { headers: { host: HOST, cookie } })).body,
    );
    assert.equal(before.turn, null);
    const t = await bearer(base, "Was the $42,000 revision finalized?");
    assert.equal(t.status, 200);
    // The app's actual contract: plain GET, cookie only - no Origin, no CSRF.
    const feedRes = await raw(base, "/api/voice/last", { headers: { host: HOST, cookie } });
    assert.equal(feedRes.status, 200);
    const feed = JSON.parse(feedRes.body).turn;
    assert.match(feed.spokenTurn.spoken, /\$42,000/);
    assert.equal(feed.spokenTurn.verdict, "PROPOSED");
    assert.equal(typeof feed.spokenTurn.at, "number");
    assert.ok(feed.spokenTurn.citations.length > 0);
    // Wrong method is refused and does not mutate the feed.
    const sess = JSON.parse(
      (await raw(base, "/api/session", { headers: { cookie, host: HOST } })).body,
    );
    const wrong = await raw(base, "/api/voice/last", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie,
        "x-csrf-token": sess.csrf,
        origin: `https://${HOST}`,
        host: HOST,
      },
      body: "{}",
    });
    assert.match(String(wrong.status), /^40[34]$/);
    const after = JSON.parse(
      (await raw(base, "/api/voice/last", { headers: { host: HOST, cookie } })).body,
    );
    assert.equal(after.turn.spokenTurn.at, feed.spokenTurn.at);
  } finally {
    server.close();
  }
});

// Regression: in pinned-demo mode the web-call session mint must follow the
// same pinned-credential admission as voice/start. Before the fix the mint
// route demanded session-local import + grant state that demo mode never
// sets, so every Start click died with HTTP 400 after a successful
// voice/start (production repro 2026-10-31).
test("demo pin: mint route mirrors pinned admission, gates still hold", async () => {
  const mintCalls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    mintCalls.push({ url: String(url), body: JSON.parse(init.body) });
    return new Response(
      JSON.stringify({
        run_id: "run-test-1",
        wss_url: "wss://calls.example/run-test-1",
        sip_username: "sip-test",
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
  const { server, base } = await start({
    ...DEMO_ENV(),
    BOLNA_API_KEY: "test-bolna-key",
    BOLNA_AGENT_ID: "agent-test-1",
  });
  try {
    const signin = await raw(base, "/owner-signin", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", host: HOST },
      body: "key=" + encodeURIComponent(OWNER),
    });
    const cookie = signin.headers["set-cookie"]?.[0]?.split(";")[0];
    const sess = JSON.parse(
      (await raw(base, "/api/session", { headers: { cookie, host: HOST } })).body,
    );
    const authed = (path, data) =>
      raw(base, path, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie,
          "x-csrf-token": sess.csrf,
          origin: `https://${HOST}`,
          host: HOST,
        },
        body: JSON.stringify(data ?? {}),
      });
    // Anonymous and CSRF-less mints stay closed and never reach Bolna.
    assert.equal(
      (await raw(base, "/api/bolna-session", {
        method: "POST",
        headers: { "content-type": "application/json", host: HOST },
        body: "{}",
      })).status,
      403,
    );
    assert.equal(
      (await raw(base, "/api/bolna-session", {
        method: "POST",
        headers: { "content-type": "application/json", cookie, host: HOST },
        body: "{}",
      })).status,
      403,
    );
    assert.equal(mintCalls.length, 0);
    // Demo start binds the pinned credential, then the mint must proceed
    // against the pinned corpus with the identical user_data contract.
    assert.equal((await authed("/api/voice/start")).status, 200);
    const mint = await authed("/api/bolna-session", {
      user_data: { documents: [{ title: "Demo pin", blocks: 7 }] },
    });
    assert.equal(mint.status, 200, mint.body);
    assert.equal(JSON.parse(mint.body).run_id, "run-test-1");
    assert.equal(mintCalls.length, 1);
    assert.equal(mintCalls[0].body.agent_id, "agent-test-1");
    assert.equal(mintCalls[0].body.user_data.documents[0].title, "Demo pin");
  } finally {
    server.close();
    globalThis.fetch = realFetch;
  }
});

test("demo pin: expired or retired credential never mints a Bolna session", async () => {
  const mintCalls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    mintCalls.push(String(url));
    return new Response("{}", { status: 200 });
  };
  try {
    // Expired hard cap: start and mint both refuse, nothing reaches Bolna.
    const expired = await start({
      ...DEMO_ENV(),
      VM_VOICE_HARD_EXPIRES_AT: String(Date.now() - 1000),
      BOLNA_API_KEY: "test-bolna-key",
      BOLNA_AGENT_ID: "agent-test-1",
    });
    try {
      const signin = await raw(expired.base, "/owner-signin", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", host: HOST },
        body: "key=" + encodeURIComponent(OWNER),
      });
      const cookie = signin.headers["set-cookie"]?.[0]?.split(";")[0];
      const sess = JSON.parse(
        (await raw(expired.base, "/api/session", { headers: { cookie, host: HOST } })).body,
      );
      const authed = (path) =>
        raw(expired.base, path, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            cookie,
            "x-csrf-token": sess.csrf,
            origin: `https://${HOST}`,
            host: HOST,
          },
          body: "{}",
        });
      assert.equal((await authed("/api/voice/start")).status, 400);
      const mint = await authed("/api/bolna-session");
      assert.match(String(mint.status), /^4\d\d$/);
      assert.equal(mintCalls.length, 0);
    } finally {
      expired.server.close();
    }
    // Owner reset retires the pinned credential: mint stays closed.
    const live = await start({
      ...DEMO_ENV(),
      BOLNA_API_KEY: "test-bolna-key",
      BOLNA_AGENT_ID: "agent-test-1",
    });
    try {
      const signin = await raw(live.base, "/owner-signin", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", host: HOST },
        body: "key=" + encodeURIComponent(OWNER),
      });
      const cookie = signin.headers["set-cookie"]?.[0]?.split(";")[0];
      const sess = JSON.parse(
        (await raw(live.base, "/api/session", { headers: { cookie, host: HOST } })).body,
      );
      const authed = (path) =>
        raw(live.base, path, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            cookie,
            "x-csrf-token": sess.csrf,
            origin: `https://${HOST}`,
            host: HOST,
          },
          body: "{}",
        });
      assert.equal((await authed("/api/reset")).status, 200);
      const mint = await raw(live.base, "/api/bolna-session", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie,
          "x-csrf-token": sess.csrf,
          origin: `https://${HOST}`,
          host: HOST,
        },
        body: "{}",
      });
      assert.match(String(mint.status), /^4\d\d$/);
      assert.equal(mintCalls.length, 0);
    } finally {
      live.server.close();
    }
  } finally {
    globalThis.fetch = realFetch;
  }
});
