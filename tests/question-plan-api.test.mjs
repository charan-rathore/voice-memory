import test from "node:test";
import assert from "node:assert/strict";
import { createLocalServer } from "../src/server.mjs";

test("HTTP responses preserve exact original request before normalization and normalized cache replay", async () => {
  const server = createLocalServer({
    port: 0,
    gemini: { enabled: () => false, searchEnabled: () => false },
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}/api/public`;
  try {
    const ws = await fetch(base + "/workspace", { method: "POST" }).then((r) =>
      r.json(),
    );
    const upload = await fetch(`${base}/workspace/${ws.id}/upload`, {
      method: "POST",
      headers: { "x-file-name": "policy.txt" },
      body: "Pilot policy. The retention window is 17 days. Approval remains pending.",
    });
    assert.equal(upload.status, 202);
    let status;
    for (let i = 0; i < 200; i++) {
      status = await fetch(`${base}/workspace/${ws.id}`).then((r) => r.json());
      if (status.ready) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.ok(status.ready);
    const original = "What is the retention window?";
    const ask = async (question) =>
      fetch(base + "/ask", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ case: ws.id, question, semantic: false }),
      }).then((r) => r.json());
    const first = await ask(original),
      replay = await ask(original.toUpperCase());
    for (const [body, text] of [
      [first, original],
      [replay, original.toUpperCase()],
    ]) {
      assert.equal(body.question, text);
      assert.equal(body.questionPlan.originalQuestion, text);
      assert.equal(body.questionPlan.requirements[0].protectedText, text);
      assert.equal(body.questionPlan.coverageEstablished, false);
      assert.equal(body.questionPlan.semanticQualification, "unresolved");
    }
    assert.notEqual(
      first.questionPlan.key,
      replay.questionPlan.key,
      "cache cannot replace current exact question identity",
    );
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
});
