import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

// Public-host open-demo behavior (VM_PUBLIC_DEMO=1): visitors must land in the
// synthetic Northstar demo with no owner sign-in wall, while imports,
// mutations and metered voice stay closed to them. Uses node:http because
// fetch/undici overrides the Host header, which selects the public branch.
process.env.VM_PUBLIC_HOST = "demo.test";
process.env.VM_PUBLIC_ORIGIN = "https://demo.test";
process.env.VM_PUBLIC_DEMO = "1";
process.env.VM_OWNER_KEY = "test-owner-key";
const { createLocalServer } = await import("./server.mjs");
const srv = createLocalServer();
before(async () => new Promise((r) => srv.listen(4319, "127.0.0.1", r)));
after(async () => {
  await new Promise((r) => srv.close(r));
  delete process.env.VM_PUBLIC_HOST;
  delete process.env.VM_PUBLIC_ORIGIN;
  delete process.env.VM_PUBLIC_DEMO;
  delete process.env.VM_OWNER_KEY;
});

function req(port, method, path, { cookie, headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request(
      {
        host: "127.0.0.1",
        port,
        method,
        path,
        headers: {
          host: "demo.test",
          ...(cookie ? { cookie } : {}),
          ...headers,
        },
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () =>
          resolve({ status: res.statusCode, headers: res.headers, body: data }),
        );
      },
    );
    r.on("error", reject);
    if (body) r.write(body);
    r.end();
  });
}

async function demoSession() {
  const r = await req(4319, "GET", "/");
  const cookie = (r.headers["set-cookie"]?.[0] ?? "").split(";")[0];
  return { r, cookie };
}
const csrfOf = async (cookie) =>
  JSON.parse((await req(4319, "GET", "/api/session", { cookie })).body).csrf;
const postJson = (cookie, csrf, p, obj) =>
  req(4319, "POST", "/api/" + p, {
    cookie,
    headers: {
      origin: "https://demo.test",
      "x-csrf-token": csrf,
      "content-type": "application/json",
    },
    body: JSON.stringify(obj ?? {}),
  });

test("visitor GET / gets the app and a demo session, not the sign-in wall", async () => {
  const { r, cookie } = await demoSession();
  assert.equal(r.status, 200);
  assert.ok(cookie.startsWith("vm="), "session cookie set");
  assert.ok(!r.body.includes("owner-signin"), "no wall served");
  const sess = JSON.parse(
    (await req(4319, "GET", "/api/session", { cookie })).body,
  );
  assert.equal(sess.demo, true, "session flagged demo for the page");
  const lib = JSON.parse(
    (await req(4319, "GET", "/api/library", { cookie })).body,
  );
  assert.equal(lib.documents.length, 7);
  assert.equal(lib.indexed, 7);
});

test("demo visitor cannot import, mutate, or reach metered voice", async () => {
  const { cookie } = await demoSession();
  const csrf = await csrfOf(cookie);
  const imp = await postJson(cookie, csrf, "import", { documents: [] });
  assert.equal(imp.status, 403);
  assert.match(imp.body, /public demo/);
  const call = await postJson(cookie, csrf, "bolna-session", {});
  assert.equal(call.status, 403);
  const q = await postJson(cookie, csrf, "query", {
    question: "is the 42,000 fee approved",
  });
  assert.equal(q.status, 200);
});

test("API POST without any session is still refused", async () => {
  const r = await req(4319, "POST", "/api/query", {
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(r.status, 403);
});

test("owner door remains at /owner-signin", async () => {
  const r = await req(4319, "GET", "/owner-signin");
  assert.equal(r.status, 200);
  const p = await req(4319, "POST", "/owner-signin", {
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "key=test-owner-key",
  });
  assert.equal(p.status, 302);
  const oc = (p.headers["set-cookie"]?.[0] ?? "").split(";")[0];
  assert.ok(oc.includes("vm="), "owner cookie set");
  const os = JSON.parse(
    (await req(4319, "GET", "/api/session", { cookie: oc })).body,
  );
  assert.equal(os.demo, false, "owner session is not a demo session");
});

test("flag off keeps the wall", async () => {
  delete process.env.VM_PUBLIC_DEMO;
  const srv2 = createLocalServer();
  await new Promise((r) => srv2.listen(4320, "127.0.0.1", r));
  const r = await req(4320, "GET", "/");
  assert.equal(r.status, 302);
  assert.equal(r.headers["location"], "/owner-signin");
  await new Promise((r) => srv2.close(r));
  process.env.VM_PUBLIC_DEMO = "1";
});
