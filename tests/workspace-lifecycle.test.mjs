import { test } from "node:test";
import assert from "node:assert/strict";
import { createLocalServer } from "../src/server.mjs";
test("workspace capacity evicts least recently used, preserving a recently accessed upload session", async () => {
  const old = process.env.VM_WS_PER_IP_HOUR;
  process.env.VM_WS_PER_IP_HOUR = "100";
  const server = createLocalServer({ port: 0 });
  if (old === undefined) delete process.env.VM_WS_PER_IP_HOUR;
  else process.env.VM_WS_PER_IP_HOUR = old;
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}/api/public/workspace`;
  const realNow = Date.now;
  let time = realNow();
  Date.now = () => time++;
  try {
    const ids = [];
    for (let i = 0; i < 12; i++) {
      const r = await fetch(base, { method: "POST" });
      assert.equal(r.status, 200);
      ids.push((await r.json()).id);
    }
    assert.equal((await fetch(base + "/" + ids[0])).status, 200);
    assert.equal((await fetch(base, { method: "POST" })).status, 200);
    assert.equal(
      (await fetch(base + "/" + ids[0])).status,
      200,
      "recently accessed workspace survives capacity sweep",
    );
    assert.equal(
      (await fetch(base + "/" + ids[1])).status,
      404,
      "least recently accessed workspace is evicted",
    );
  } finally {
    Date.now = realNow;
    await new Promise((r) => server.close(r));
  }
});
