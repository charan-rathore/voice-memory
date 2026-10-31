// The public synthetic demo (VM_PUBLIC_DEMO=1) is isolated from the owner:
// a demo visitor can ask questions about the fictional documents and nothing
// else; the owner's documents never appear; with the flag off /demo is gated.
import { test } from "node:test";
import assert from "node:assert/strict";
import { raw } from "./http-raw.mjs";

const OWNER = "owner-secret-for-tests-only";
const host = "app.example";
const origin = "https://app.example";

async function start(env) {
  const saved = {};
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  const { createLocalServer } = await import("../server.mjs");
  const server = createLocalServer({ port: 0 });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  for (const [k, v] of Object.entries(saved))
    v === undefined ? delete process.env[k] : (process.env[k] = v);
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    close: () => (server.closeAllConnections?.(), server.close()),
  };
}

async function client(base, cookie) {
  const s = await raw(base, "/api/session", { headers: { host, cookie } });
  const { csrf } = JSON.parse(s.body);
  const h = {
    "content-type": "application/json",
    host,
    cookie,
    "x-csrf-token": csrf,
    origin,
  };
  return {
    post: async (p, b) => {
      const r = await raw(base, p, {
        method: "POST",
        headers: h,
        body: JSON.stringify(b),
      });
      return { status: r.status, out: JSON.parse(r.body || "null") };
    },
    get: async (p) => {
      const r = await raw(base, p, { headers: { host, cookie } });
      return { status: r.status, out: JSON.parse(r.body || "null") };
    },
  };
}

test("demo visitors: fictional documents only, read-and-ask only, owner untouched", async () => {
  const app = await start({
    VM_PUBLIC_HOST: host,
    VM_PUBLIC_ORIGIN: origin,
    VM_OWNER_KEY: OWNER,
    VM_PUBLIC_DEMO: "1",
  });
  try {
    // Owner signs in and imports a private document.
    const signin = await raw(app.base, "/owner-signin", {
      method: "POST",
      headers: { host, "content-type": "application/x-www-form-urlencoded" },
      body: "key=" + encodeURIComponent(OWNER),
    });
    const owner = await client(
      app.base,
      signin.headers["set-cookie"][0].split(";")[0],
    );
    assert.equal(
      (
        await owner.post("/api/import", {
          documents: [
            {
              title: "private.md",
              text: "# Private\n\nThe owner's private retainer is $77,777 per month, agreed by both parties.",
            },
          ],
        })
      ).status,
      200,
    );

    // A visitor opens /demo.
    const d = await raw(app.base, "/demo", { headers: { host } });
    assert.equal(d.status, 302);
    const visitor = await client(
      app.base,
      d.headers["set-cookie"][0].split(";")[0],
    );
    const a = await visitor.post("/api/query", {
      question: "What fee did we finally agree on?",
    });
    assert.equal(a.status, 200);
    assert.match(JSON.stringify(a.out), /42,000/);
    assert.doesNotMatch(JSON.stringify(a.out), /77,777|private/);
    const priv = await visitor.post("/api/query", {
      question: "What is the private retainer?",
    });
    assert.doesNotMatch(JSON.stringify(priv.out), /77,777/);
    for (const [p, b] of [
      ["/api/import", { documents: [{ title: "x.md", text: "x".repeat(50) }] }],
      ["/api/reset", {}],
      ["/api/voice/start", {}],
      ["/api/bolna-session", {}],
    ])
      assert.equal((await visitor.post(p, b)).status, 403, p);
    const graph = await visitor.get("/api/graph?focus=overview");
    assert.equal(graph.status, 200);
    assert.doesNotMatch(JSON.stringify(graph.out), /77,777|private\.md/);

    // The owner's workspace is unchanged.
    const o = await owner.post("/api/query", {
      question: "What is the private retainer?",
    });
    assert.match(JSON.stringify(o.out), /77,777/);
  } finally {
    app.close();
  }
});

test("with VM_PUBLIC_DEMO off, /demo is gated like everything else", async () => {
  const app = await start({
    VM_PUBLIC_HOST: host,
    VM_PUBLIC_ORIGIN: origin,
    VM_OWNER_KEY: OWNER,
    VM_PUBLIC_DEMO: "0",
  });
  try {
    const d = await raw(app.base, "/demo", { headers: { host } });
    assert.notEqual(d.status, 200);
    assert.ok(!d.headers["set-cookie"], "no session minted");
  } finally {
    app.close();
  }
});
