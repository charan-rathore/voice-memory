import test from "node:test";
import assert from "node:assert/strict";
import { createLocalServer } from "../src/server.mjs";
import { createVoiceAdapter } from "../src/voice-adapter.mjs";
import { importBundle } from "../dist/engine.mjs";
import { NORTHSTAR_DOCS } from "../examples/corpus-northstar.mjs";
import { raw } from "./http-raw.mjs";

async function start() {
  const voice = createVoiceAdapter({ ttlMs: 60000 });
  const server = createLocalServer({ voice, port: 0 });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { voice, server, base };
}
const call = async (base, { token, host, body } = {}) => {
  const r = await raw(base, "/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: "Bearer " + token } : {}),
      ...(host ? { host } : {}),
    },
    body: JSON.stringify(
      body ?? {
        model: "x",
        stream: true,
        messages: [{ role: "user", content: "What is the engagement fee?" }],
      },
    ),
  });
  return { status: r.status, text: () => r.body, raw: r };
};

test("missing and wrong bearer capability are refused with 401", async () => {
  const { server, base } = await start();
  try {
    assert.equal((await call(base)).status, 401);
    assert.equal((await call(base, { token: "wrong" })).status, 401);
  } finally {
    server.close();
  }
});

test("valid capability streams SSE without cookie, CSRF or local Host", async () => {
  const { voice, server, base } = await start();
  try {
    const token = voice.bind(importBundle(NORTHSTAR_DOCS));
    const res = await call(base, { token, host: "public.example" });
    assert.equal(res.status, 200);
    const text = res.text();
    assert.match(text, /^data: /m, "SSE deltas on the wire");
    assert.match(text, /"content":"/);
  } finally {
    server.close();
  }
});

test("revoked capability (rotation on new start) is refused", async () => {
  const { voice, server, base } = await start();
  try {
    const token = voice.bind(importBundle(NORTHSTAR_DOCS));
    voice.revoke(token);
    assert.equal((await call(base, { token })).status, 401);
  } finally {
    server.close();
  }
});

test("non-streaming or malformed requests are 400; GET is 405", async () => {
  const { voice, server, base } = await start();
  try {
    const token = voice.bind(importBundle(NORTHSTAR_DOCS));
    assert.equal(
      (
        await call(base, {
          token,
          body: {
            model: "x",
            stream: false,
            messages: [{ role: "user", content: "hi" }],
          },
        })
      ).status,
      400,
    );
    const get = await raw(base, "/v1/chat/completions", {
      headers: { authorization: "Bearer " + token },
    });
    assert.equal(get.status, 405);
  } finally {
    server.close();
  }
});

test("operator-provided capability works and still revokes", async () => {
  const { voice, server, base } = await start();
  try {
    const bundle = importBundle(NORTHSTAR_DOCS);
    const token = voice.bind(bundle, "x".repeat(48));
    const res = await call(base, { token: "x".repeat(48) });
    assert.equal(res.status, 200);
    assert.throws(() => voice.bind(bundle, "short"));
    voice.revoke("x".repeat(48));
    assert.equal((await call(base, { token: "x".repeat(48) })).status, 401);
  } finally {
    server.close();
  }
});

test("public Host still 403s every browser route", async () => {
  const { server, base } = await start();
  try {
    const res = await raw(base, "/api/session", {
      headers: { host: "public.example" },
    });
    assert.equal(res.status, 403);
  } finally {
    server.close();
  }
});
