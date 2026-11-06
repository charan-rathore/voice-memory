import { test } from "node:test";
import assert from "node:assert/strict";
import { createLocalServer } from "../src/server.mjs";

test("workspace answer cache invalidates when uploads change a stable workspace scope", async () => {
  const server = createLocalServer({ port: 0 });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}/api/public`;
  const post = async (path, body) => {
    const response = await fetch(base + path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    assert.equal(response.status, 200);
    return response.json();
  };
  try {
    const { id } = await post("/workspace", {});
    const upload = async (name, text, count) => {
      const r = await fetch(`${base}/workspace/${id}/upload`, {
        method: "POST",
        headers: { "x-file-name": name },
        body: text,
      });
      assert.equal(r.status, 202);
      for (let i = 0; i < 100; i++) {
        const status = await fetch(`${base}/workspace/${id}`).then((r) =>
          r.json(),
        );
        if (
          status.documents.length === count &&
          status.documents.every((d) => d.status === "ready")
        )
          return;
        await new Promise((r) => setTimeout(r, 50));
      }
      throw Error("upload readiness timeout");
    };
    await upload(
      "calendar.txt",
      "The office calendar lists the quarterly picnic in September. Lunch is served in the east courtyard near the office.",
      1,
    );
    const ask = () =>
      post("/ask", {
        case: id,
        question: "Who owns the security review?",
        context: null,
      });
    const missing = await ask();
    assert.doesNotMatch(missing.lead?.text ?? "", /Maya/);
    await upload(
      "security.txt",
      "Maya owns the security review. The security review must be completed before the pilot launch on Tuesday.",
      2,
    );
    const added = await ask();
    assert.match(
      added.lead?.text ?? "",
      /Maya/,
      "a cached missing-fact answer must not survive a second upload",
    );
    assert.ok(added.lead.citations.length);
    assert.match(
      (await ask()).lead.text,
      /Maya/,
      "unchanged snapshot still answers correctly",
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
