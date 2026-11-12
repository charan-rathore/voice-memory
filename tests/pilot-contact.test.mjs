// Private pilot contact path: off by default, delivered only to the
// configured recipient, minimal fields, spam-protected, honest on failure.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createPilotContact } from "../src/pilot-contact.mjs";

function harness(opts = {}) {
  const clock = { t: Date.now() };
  const delivered = [];
  let fail = false;
  const handler = createPilotContact({
    now: () => clock.t,
    fetchImpl: async (url, init) => {
      if (fail) return { ok: false, status: 500 };
      delivered.push({
        url,
        headers: init.headers,
        body: JSON.parse(init.body),
      });
      return { ok: true, status: 200 };
    },
    ...opts,
  });
  const srv = http.createServer((req, res) =>
    handler(req, res, {
      ip: "203.0.113.7",
      sameOrigin: req.headers.origin === "https://site",
    }),
  );
  const ready = new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const req = async (method, body, origin = "https://site") => {
    await ready;
    const r = await fetch(`http://127.0.0.1:${srv.address().port}/`, {
      method,
      headers: { "content-type": "application/json", origin },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: r.status, body: await r.json() };
  };
  return {
    req,
    clock,
    delivered,
    setFail: (v) => (fail = v),
    close: () => srv.close(),
  };
}
const good = {
  name: "Asha Rao",
  email: "asha@agency.example",
  company: "Example Voice Agency",
  message: "Repeat callers on warranty lines.",
  consent: true,
};

test("closed by default: no form, no acceptance, nothing delivered", async () => {
  const h = harness();
  try {
    assert.deepEqual((await h.req("GET")).body, { open: false });
    assert.equal((await h.req("POST", good)).status, 404);
    assert.equal(h.delivered.length, 0);
  } finally {
    h.close();
  }
  // A non-https recipient is not accepted as configured.
  const insecure = harness({ webhookUrl: "http://example.invalid/hook" });
  try {
    assert.equal((await insecure.req("GET")).body.open, false);
  } finally {
    insecure.close();
  }
});

test("open: delivers only the four fields to the configured recipient", async () => {
  const h = harness({
    webhookUrl: "https://hooks.example/pilot",
    webhookToken: "tok-123",
  });
  try {
    const { ticket } = (await h.req("GET")).body;
    h.clock.t += 5000;
    const r = await h.req("POST", {
      ...good,
      ticket,
      tracking: "x",
      ip: "1.2.3.4",
    });
    assert.equal(r.status, 202);
    assert.equal(h.delivered.length, 1);
    const d = h.delivered[0];
    assert.equal(d.url, "https://hooks.example/pilot");
    assert.equal(d.headers.authorization, "Bearer tok-123");
    assert.deepEqual(Object.keys(d.body).sort(), [
      "at",
      "company",
      "email",
      "kind",
      "message",
      "name",
    ]);
    assert.doesNotMatch(
      JSON.stringify(d.body),
      /203\.0\.113\.7|1\.2\.3\.4|tracking/,
    );
  } finally {
    h.close();
  }
});

test("spam protection, validation, rate limit and honest failure", async () => {
  const h = harness({ webhookUrl: "https://hooks.example/pilot", perHour: 2 });
  try {
    const { ticket } = (await h.req("GET")).body;
    // Too fast (bot): silently accepted, not delivered.
    assert.equal((await h.req("POST", { ...good, ticket })).status, 202);
    h.clock.t += 5000;
    // Honeypot filled: silently accepted, not delivered.
    assert.equal(
      (await h.req("POST", { ...good, ticket, website: "spam.example" }))
        .status,
      202,
    );
    // Forged ticket: not delivered.
    assert.equal(
      (await h.req("POST", { ...good, ticket: "1.forged" })).status,
      202,
    );
    assert.equal(h.delivered.length, 0);
    assert.equal(
      (await h.req("POST", { ...good, ticket, email: "not-an-email" })).status,
      400,
    );
    assert.equal(
      (await h.req("POST", { ...good, ticket, consent: false })).status,
      400,
    );
    assert.equal(
      (await h.req("POST", { ...good, ticket }, "https://evil.example")).status,
      403,
    );
    h.setFail(true);
    const f = await h.req("POST", { ...good, ticket });
    assert.equal(f.status, 503);
    assert.match(f.body.error, /Nothing was stored/);
    h.setFail(false);
    assert.equal((await h.req("POST", { ...good, ticket })).status, 202);
    assert.equal(
      (await h.req("POST", { ...good, ticket })).status,
      429,
      "per-IP limit",
    );
    assert.equal(h.delivered.length, 1);
  } finally {
    h.close();
  }
});

test("the real server: closed unless VM_PILOT_WEBHOOK_URL is set", async () => {
  const saved = process.env.VM_PILOT_WEBHOOK_URL;
  delete process.env.VM_PILOT_WEBHOOK_URL;
  const { createLocalServer } = await import("../src/server.mjs");
  const server = createLocalServer({ port: 0 });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    const r = await fetch(
      `http://127.0.0.1:${server.address().port}/api/public/pilot-contact`,
    ).then((x) => x.json());
    assert.deepEqual(r, { open: false });
  } finally {
    server.close();
    if (saved !== undefined) process.env.VM_PILOT_WEBHOOK_URL = saved;
  }
});
