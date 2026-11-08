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

test("source replacement during legacy semantic work cannot return old retrieval evidence or answer plans", async () => {
  let unblock, entered;
  const started = new Promise((r) => {
    entered = r;
  });
  const pending = new Promise((r) => {
    unblock = r;
  });
  let interpretCalls = 0;
  const server = createLocalServer({
    port: 0,
    gemini: {
      enabled: () => true,
      searchEnabled: () => false,
      interpret: async () => {
        interpretCalls++;
        entered();
        await pending;
        return {
          intent: "UNCLEAR",
          clarify: "Was the earlier notice the intended scope?",
        };
      },
      planClaims: async () => null,
    },
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}/api/public`;
  try {
    const ws = await fetch(base + "/workspace", { method: "POST" }).then((r) =>
      r.json(),
    );
    const upload = async (name, body) => {
      const r = await fetch(`${base}/workspace/${ws.id}/upload`, {
        method: "POST",
        headers: { "x-file-name": name },
        body,
      });
      assert.equal(r.status, 202);
    };
    const ready = async (count) => {
      for (let i = 0; i < 300; i++) {
        const state = await fetch(`${base}/workspace/${ws.id}`).then((r) =>
          r.json(),
        );
        if (
          state.ready &&
          state.documents.length === count &&
          state.documents.every((d) => d.status === "ready")
        )
          return state;
        await new Promise((r) => setTimeout(r, 20));
      }
      assert.fail("source parsing did not complete");
    };
    await upload(
      "pilot.txt",
      "The pilot retention window is 17 days. Approval remains pending.",
    );
    const state = await ready(1);
    const original = "Which satellite recorded the pilot policy?";
    const answering = fetch(base + "/ask", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        case: ws.id,
        question: original,
        semantic: true,
        documentConsent: {
          generation: state.bundleGeneration,
          model: null,
          provider: "Google Gemini",
        },
      }),
    }).then((r) => r.json());
    await Promise.race([
      started,
      new Promise((_, reject) =>
        setTimeout(
          () => reject(Error("semantic boundary was not reached")),
          3000,
        ),
      ),
    ]);
    await upload(
      "new-notice.txt",
      "The pilot retention window is now 21 days. This new notice replaces the old window.",
    );
    const next = await ready(2);
    assert.notEqual(next.bundleGeneration, state.bundleGeneration);
    unblock();
    const out = await answering;
    assert.equal(interpretCalls, 1);
    assert.equal(out.final.kind, "abstained");
    assert.deepEqual(out.final.citations, []);
    assert.deepEqual(
      out.evidence,
      [],
      "stale related evidence cannot escape through fallback rendering",
    );
    assert.equal(out.visual, null);
    assert.equal(out.closest, null);
    assert.equal(out.admission.reason, "stale_or_wrong_request");
    assert.match(out.final.text, /source scope changed/i);
    assert.equal(out.questionPlan.originalQuestion, original);
  } finally {
    unblock();
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
});
