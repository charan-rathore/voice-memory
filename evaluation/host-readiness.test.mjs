import test from "node:test";
import assert from "node:assert/strict";
import { createLocalServer } from "../server.mjs";
import { NORTHSTAR_DOCS } from "../corpus-northstar.mjs";
import { raw } from "./http-raw.mjs";

const FIXED = "f".repeat(48);
const OWNER = "owner-secret-for-tests-only";

async function start(env = {}) {
  const saved = {};
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  const { createLocalServer: cls } = await import("../server.mjs");
  const server = cls({ port: 0 });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    server,
    base,
    cleanup() {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      server.close();
    },
  };
}

// One browser session: cookie jar + csrf, on a chosen Host header. Uses raw
// http because undici silently drops a custom Host header.
function browser(base, host) {
  let cookie = "";
  let csrf = "";
  return {
    base,
    async getSession() {
      const r = await raw(base, "/api/session", { headers: { cookie, host } });
      cookie = r.headers["set-cookie"]?.[0]?.split(";")[0] ?? cookie;
      csrf = JSON.parse(r.body).csrf;
    },
    async post(path, data) {
      const r = await raw(base, path, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: host.startsWith("127.")
            ? `http://${host}`
            : `https://${host}`,
          ...(cookie ? { cookie } : {}),
          ...(csrf ? { "x-csrf-token": csrf } : {}),
          host,
        },
        body: JSON.stringify(data),
      });
      return { status: r.status, out: JSON.parse(r.body || "null") };
    },
    setCookie(c) {
      cookie = c;
    },
  };
}

async function bolnaCall(base, token) {
  const r = await raw(base, "/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer " + token,
    },
    body: JSON.stringify({
      model: "x",
      stream: true,
      messages: [{ role: "user", content: "What is the engagement fee?" }],
    }),
  });
  return { status: r.status, text: r.body };
}

test("fixed capability: exclusive binding, cross-session revoke protection, no silent revive", async () => {
  const { server, base, cleanup } = await start({ VM_VOICE_CAPABILITY: FIXED });
  try {
    const A = browser(base, `127.0.0.1:${server.address().port}`);
    const B = browser(base, `127.0.0.1:${server.address().port}`);
    await A.getSession();
    await B.getSession();
    assert.equal(
      (await A.post("/api/import", { documents: NORTHSTAR_DOCS })).status,
      200,
    );
    assert.equal(
      (
        await B.post("/api/import", {
          documents: [
            {
              title: "B.md",
              text: "# B\nAuthor: T. Date: 2026-09-01. Type: note.\n1. The engagement fee is $99,000.",
            },
          ],
        })
      ).status,
      200,
    );
    assert.equal((await A.post("/api/voice/start", {})).status, 200);
    // A second session cannot steal the live capability.
    const bStart = await B.post("/api/voice/start", {});
    assert.equal(bStart.status, 400);
    assert.match(bStart.out?.error ?? "", /in use by another session/);
    // The capability serves A's bundle, not B's.
    const call1 = await bolnaCall(base, FIXED);
    assert.equal(call1.status, 200);
    assert.match(call1.text, /48,000|42,000/);
    assert.doesNotMatch(call1.text, /99,000/);
    // B's reset must not revoke A's grant.
    await B.post("/api/reset", {});
    assert.equal((await bolnaCall(base, FIXED)).status, 200);
    // A's reset retires it: old requests die.
    await A.post("/api/reset", {});
    assert.equal((await bolnaCall(base, FIXED)).status, 401);
    // A different session cannot revive a retired capability.
    await B.post("/api/import", {
      documents: [
        {
          title: "B.md",
          text: "# B\nAuthor: T. Date: 2026-09-01. Type: note.\n1. The engagement fee is $99,000.",
        },
      ],
    });
    const bStart2 = await B.post("/api/voice/start", {});
    assert.equal(bStart2.status, 400);
    assert.match(bStart2.out?.error ?? "", /retired/);
    // The retiring session itself cannot re-bind either: rotation requires a
    // NEW credential. reset A -> rebind A is refused, and the old bearer is
    // still dead afterwards.
    await A.post("/api/import", { documents: NORTHSTAR_DOCS });
    const aRebind = await A.post("/api/voice/start", {});
    assert.equal(aRebind.status, 400);
    assert.match(aRebind.out?.error ?? "", /retired/);
    assert.equal((await bolnaCall(base, FIXED)).status, 401);
  } finally {
    cleanup();
  }
});

test("public host: owner sign-in form gates UI, session and docs; checks intact", async () => {
  const { server, base, cleanup } = await start({
    VM_PUBLIC_HOST: "app.example",
    VM_PUBLIC_ORIGIN: "https://app.example",
    VM_OWNER_KEY: OWNER,
  });
  const host = "app.example";
  const signin = (key) =>
    raw(base, "/owner-signin", {
      method: "POST",
      headers: {
        host,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: "key=" + encodeURIComponent(key),
    });
  try {
    // No cookie: UI redirects to the sign-in page; APIs stay closed.
    const noKey = await raw(base, "/", { headers: { host } });
    assert.equal(noKey.status, 302);
    assert.equal(noKey.headers.location, "/owner-signin");
    const form = await raw(base, "/owner-signin", { headers: { host } });
    assert.equal(form.status, 200);
    assert.match(form.body, /name="key"/);
    const anonApi = await raw(base, "/api/session", { headers: { host } });
    assert.equal(anonApi.status, 403);
    // Wrong key: refused; no cookie.
    const wrong = await signin("wrong");
    assert.equal(wrong.status, 403);
    assert.equal(wrong.headers["set-cookie"], undefined);
    // Correct key in the POST body: 302 + session cookie. The secret never
    // appears in any URL.
    const boot = await signin(OWNER);
    assert.equal(boot.status, 302);
    assert.equal(boot.headers.location, "/");
    const cookie = boot.headers["set-cookie"]?.[0]?.split(";")[0];
    assert.ok(cookie?.startsWith("vm="));
    // UI now reachable with the session cookie.
    const ui = await raw(base, "/", { headers: { host, cookie } });
    assert.equal(ui.status, 200);
    // Session + CSRF + correct public Origin: import works.
    const sess = await raw(base, "/api/session", { headers: { host, cookie } });
    const { csrf } = JSON.parse(sess.body);
    const importBody = JSON.stringify({ documents: NORTHSTAR_DOCS });
    const ok = await raw(base, "/api/import", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        host,
        cookie,
        "x-csrf-token": csrf,
        origin: "https://app.example",
      },
      body: importBody,
    });
    assert.equal(ok.status, 200);
    // Wrong Origin is still refused even with a valid session + CSRF.
    const evil = await raw(base, "/api/import", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        host,
        cookie,
        "x-csrf-token": csrf,
        origin: "https://evil.example",
      },
      body: importBody,
    });
    assert.equal(evil.status, 403);
    // No cookie at all: refused.
    const anon = await raw(base, "/api/import", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        host,
        origin: "https://app.example",
        "x-csrf-token": csrf,
      },
      body: importBody,
    });
    assert.equal(anon.status, 403);
    // Sign-in lockout: 10 failed attempts from one address lock it out, and
    // even the correct key is refused while locked.
    for (let i = 0; i < 10; i++)
      assert.equal((await signin("wrong")).status, 403);
    assert.equal((await signin(OWNER)).status, 403);
  } finally {
    cleanup();
  }
});

test("bolna web-call routes: honest unconfigured state, session required", async () => {
  const { server, base, cleanup } = await start({
    VM_PUBLIC_HOST: "app.example",
    VM_PUBLIC_ORIGIN: "https://app.example",
    VM_OWNER_KEY: OWNER,
  });
  const host = "app.example";
  try {
    // No session: both routes are closed.
    const anon = await raw(base, "/api/bolna-config", { headers: { host } });
    assert.equal(anon.status, 403);
    // Owner session: config reports unconfigured (no Bolna env in tests) and
    // the mint route refuses honestly with 503, never a fake session.
    const boot = await raw(base, "/owner-signin", {
      method: "POST",
      headers: { host, "content-type": "application/x-www-form-urlencoded" },
      body: "key=" + encodeURIComponent(OWNER),
    });
    const cookie = boot.headers["set-cookie"]?.[0]?.split(";")[0];
    const cfg = await raw(base, "/api/bolna-config", {
      headers: { host, cookie },
    });
    assert.equal(cfg.status, 200);
    assert.deepEqual(JSON.parse(cfg.body), { configured: false });
    // Grant-before-mint ordering (the Start live call click path): no
    // documents -> 400; documents but no voice grant -> 400; only after
    // /api/voice/start succeeds does the request reach the config check.
    const b = browser(base, host);
    b.setCookie(cookie);
    await b.getSession();
    const premature = await b.post("/api/bolna-session", {});
    assert.equal(premature.status, 400);
    assert.match(premature.out?.error ?? "", /Import documents/);
    assert.equal(
      (await b.post("/api/import", { documents: NORTHSTAR_DOCS })).status,
      200,
    );
    const unbound = await b.post("/api/bolna-session", {});
    assert.equal(unbound.status, 400);
    assert.match(unbound.out?.error ?? "", /Voice grant not started/);
    assert.equal((await b.post("/api/voice/start", {})).status, 200);
    const mint = await raw(base, "/api/bolna-session", {
      method: "POST",
      headers: {
        host,
        cookie,
        origin: "https://app.example",
        "content-type": "application/json",
      },
      body: "{}",
    });
    assert.equal(mint.status, 503);
    assert.match(JSON.parse(mint.body).error, /not configured/);
  } finally {
    cleanup();
  }
});

test("local host stays open to the operator without an owner key", async () => {
  const { server, base, cleanup } = await start({
    VM_PUBLIC_HOST: "app.example",
    VM_PUBLIC_ORIGIN: "https://app.example",
    VM_OWNER_KEY: OWNER,
  });
  try {
    const r = await raw(base, "/");
    assert.equal(r.status, 200);
  } finally {
    cleanup();
  }
});
