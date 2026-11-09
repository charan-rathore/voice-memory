// All provider and key-health responses are mocked. Zero external network.
import test from "node:test";
import assert from "node:assert/strict";
import { createLocalServer } from "../src/public-review-preview.mjs";
const PASSWORD = "offline-test-only-not-a-saved-secret";
async function setup(options = {}) {
  let clock = Date.now(),
    calls = [],
    captures = [];
  const expiry = new Date(clock + 25 * 60000).toISOString();
  const env = {
    IS_PULL_REQUEST: "true",
    VM_REVIEW_PASSWORD: PASSWORD,
    VM_REVIEW_EXPIRES_AT: expiry,
    VM_REVIEW_PAID: "one-final-audit",
    VM_REVIEW_API_KEY: "mock-dedicated-key",
    OPENROUTER_API_KEY: "must-never-be-used",
    BOLNA_API_KEY: "must-never-be-used",
    ...options.env,
  };
  const server = createLocalServer({
    env,
    now: () => clock,
    fetchImpl: async (url, init) => {
      calls.push(url);
      assert.equal(
        init.headers.Authorization ?? init.headers.authorization,
        "Bearer mock-dedicated-key",
      );
      if (url.endsWith("/key"))
        return Response.json({
          data: {
            limit: 0.0495,
            limit_reset: null,
            limit_remaining: 0.0495,
            expires_at: expiry,
            ...options.key,
          },
        });
      const b = JSON.parse(init.body),
        p = JSON.parse(b.messages[0].content);
      captures.push(b);
      if (options.fail) throw Error("Simulated timeout");
      const value = {
        question: p.requestPlan.originalQuestion,
        questionPlanKey: p.requestPlan.key,
        scopeKey: p.requestPlan.scopeKey,
        complete: !options.reject,
        relevant: true,
        supported: true,
        items: p.statements.map((s, index) => ({
          index,
          requirementId: s.requirementId,
          accept: true,
        })),
        coverageItems: p.independentPlan.requirements.flatMap((r) =>
          r.status === "answered"
            ? r.claims.map((_, claimIndex) => ({
                requirementId: r.id,
                claimIndex,
                accept: true,
              }))
            : [{ requirementId: r.id, claimIndex: null, accept: true }],
        ),
      };
      return Response.json({
        choices: [{ message: { content: JSON.stringify(value) } }],
        usage: { prompt_tokens: 10000, completion_tokens: 500, cost: 0.01 },
      });
    },
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  env.RENDER_EXTERNAL_URL = origin;
  const request = (path, init = {}) =>
    fetch(origin + path, { redirect: "manual", ...init });
  const login = async () => {
    const r = await request("/review/login", {
      method: "POST",
      headers: { origin, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ password: PASSWORD }),
    });
    assert.equal(r.status, 303);
    return r.headers.get("set-cookie").split(";")[0];
  };
  const run = async (cookie, body = "{}") =>
    request("/review/run", {
      method: "POST",
      headers: { origin, cookie },
      body,
    });
  return {
    calls,
    captures,
    origin,
    request,
    login,
    run,
    expire: () => (clock += 31 * 60000),
    close: async () => {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    },
  };
}
test("preview fails closed without dedicated configuration or after expiry despite inherited production credentials", async () => {
  for (const env of [
    { VM_REVIEW_PASSWORD: "" },
    { IS_PULL_REQUEST: "false" },
    { VM_REVIEW_EXPIRES_AT: "" },
  ]) {
    const s = await setup({ env });
    try {
      assert.equal((await s.request("/")).status, 503);
      assert.equal(s.calls.length, 0);
    } finally {
      await s.close();
    }
  }
  const s = await setup();
  try {
    const cookie = await s.login();
    s.expire();
    assert.equal((await s.run(cookie)).status, 503);
    assert.equal(s.calls.length, 0);
  } finally {
    await s.close();
  }
});
test("authentication, same origin, fixed body and route allowlist block disclosure before fetch", async () => {
  const s = await setup();
  try {
    assert.equal((await s.run("")).status, 401);
    const cookie = await s.login();
    for (const path of [
      "/api/public/ask",
      "/api/public/voice/session",
      "/api/public/transcribe",
      "/api/import",
      "/api/public/upload",
    ])
      assert.equal(
        (
          await s.request(path, {
            method: "POST",
            headers: {
              origin: s.origin,
              cookie,
            },
            body: "private body",
          })
        ).status,
        404,
      );
    assert.equal((await s.run(cookie, '{"text":"private"}')).status, 400);
    assert.equal(
      (
        await s.request("/review/run", {
          method: "POST",
          headers: { origin: "https://other.invalid", cookie },
          body: "{}",
        })
      ).status,
      403,
    );
    assert.equal(s.calls.length, 0);
    const page = await (await s.request("/", { headers: { cookie } })).text();
    assert.match(page, /saved responses/);
    assert.doesNotMatch(page, /type="file"/);
  } finally {
    await s.close();
  }
});
test("one fixed final audit preserves useful partial output and exact source quotes, repeat requests share same result", async () => {
  const s = await setup();
  try {
    const cookie = await s.login();
    const responses = await Promise.all([s.run(cookie), s.run(cookie)]);
    const results = await Promise.all(responses.map((r) => r.json()));
    assert.ok(results[0].answer, JSON.stringify(results));
    assert.equal(results[0].answer.verdict, "PARTIAL_DOCUMENT");
    assert.match(results[0].answer.text, /two-thirds/);
    assert.match(results[0].answer.text, /reading checks disagreed/);
    assert.equal(
      s.calls.length,
      2,
      "one key health and one inference, even concurrently",
    );
    assert.equal(s.captures.length, 1);
    assert.deepEqual(results[0], results[1]);
    console.log(
      "AUDIT_CAPTURE",
      JSON.stringify({
        bytes: Buffer.byteLength(s.captures[0].messages[0].content),
        responseFormat: s.captures[0].response_format.type,
        provider: s.captures[0].provider,
      }),
    );
  } finally {
    await s.close();
  }
});
test("missing paid activation, bad cap, missing expiry or insufficient budget cannot reach inference; failures never retry", async () => {
  for (const options of [
    { env: { VM_REVIEW_PAID: "off" } },
    { env: { VM_REVIEW_API_KEY: "" } },
    { key: { limit: 5 } },
    { key: { limit_reset: "daily" } },
    { key: { expires_at: null } },
    { key: { expires_at: new Date(Date.now() + 65 * 60000).toISOString() } },
    { key: { limit_remaining: 0.02 } },
    { fail: true },
    { reject: true },
  ]) {
    const s = await setup(options);
    try {
      const cookie = await s.login();
      const first = await (await s.run(cookie)).json();
      const n = s.calls.length;
      assert.equal(first.answer ?? null, null);
      await s.run(cookie);
      assert.equal(
        s.calls.length,
        n,
        "no retry after failed or rejected check",
      );
    } finally {
      await s.close();
    }
  }
});

test("deployment entrypoint in PR preview mode never starts production routes or inherited providers", async () => {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const script = `globalThis.fetch=()=>{throw Error('Unexpected external request')}; const m=await import('./server.mjs'); await new Promise(r=>m.server.listen(0,'127.0.0.1',r)); const http=await import('node:http'); const result=await new Promise((resolve,reject)=>http.get('http://127.0.0.1:'+m.server.address().port+'/healthz',res=>{let body='';res.on('data',c=>body+=c);res.on('end',()=>resolve(body))}).on('error',reject)); console.log(result); await new Promise(r=>m.server.close(r));`;
  const result = await promisify(execFile)(
    process.execPath,
    ["--input-type=module", "-e", script],
    {
      cwd: new URL("..", import.meta.url).pathname,
      timeout: 10000,
      env: {
        ...process.env,
        IS_PULL_REQUEST: "true",
        VM_REVIEW_PASSWORD: "",
        OPENROUTER_API_KEY: "must-not-activate",
        BOLNA_API_KEY: "must-not-activate",
        VM_BOLNA_PUBLIC: "on",
      },
    },
  );
  const health = JSON.parse(result.stdout);
  assert.equal(health.service, "isolated-public-review");
  assert.equal(health.active, false);
  assert.equal(health.inference, false);
});

test("one-hour provider backup expiry does not extend the25-minute page or inference window", async () => {
  const s = await setup({
    key: { expires_at: new Date(Date.now() + 55 * 60000).toISOString() },
  });
  try {
    const cookie = await s.login();
    assert.ok((await (await s.run(cookie)).json()).answer);
    s.expire();
    assert.equal((await s.run(cookie)).status, 503);
    assert.equal(s.captures.length, 1);
  } finally {
    await s.close();
  }
});
