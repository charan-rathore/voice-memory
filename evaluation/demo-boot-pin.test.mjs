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
