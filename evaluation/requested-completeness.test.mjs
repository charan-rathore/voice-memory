import test from "node:test";
import assert from "node:assert/strict";
import { importBundle, answer } from "../dist/engine.mjs";
const text =
  "Order PK-101\nTracking number: TRK-8273\nReceiver: Maya Rao\nShipment weight: 17 kg\nShipment dispatch status: pending carrier collection.";
const questions = [
  "Who received order PK-101 and what is its tracking number?",
  "What is the tracking number and weight for order PK-101?",
  "What is the tracking number and who approved order PK-101?",
];
test("a positive requested field cannot certify complete coverage of coordinated requirements", () => {
  for (const q of questions) {
    const b = importBundle([{ title: "Shipment", text }]);
    const r = answer(q, b);
    assert.equal(r.supported, false, q);
    assert.equal(r.requestedCoverage, "coordination_unresolved");
    assert.equal(r.requestedChecked, true);
    assert.equal(r.unresolved, true);
    assert.equal(r.evidence.length, 0);
    assert.ok(r.reviewEvidence.length);
  }
  for (const q of [
    "Who received order PK-101?",
    "What is the tracking number for order PK-101?",
    "What is the weight for order PK-101?",
  ]) {
    const r = answer(q, importBundle([{ title: "Shipment", text }]));
    assert.equal(r.supported, true, q);
    assert.equal(r.requestedCoverage, "single_field_only");
  }
});

test("actual upload/ask keeps the whole coordinated request unresolved and independent single-field positives", async () => {
  const { createLocalServer } = await import("../src/server.mjs");
  let calls = 0;
  const forbidden = async () => {
    calls++;
    throw Error("no provider");
  };
  const s = createLocalServer({
    port: 0,
    gemini: {
      enabled: () => true,
      searchEnabled: () => false,
      interpret: forbidden,
      planClaims: forbidden,
      documentRead: forbidden,
      documentAudit: forbidden,
    },
  });
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${s.address().port}/api/public`;
  try {
    const w = await fetch(base + "/workspace", { method: "POST" }).then((r) =>
      r.json(),
    );
    assert.equal(
      (
        await fetch(`${base}/workspace/${w.id}/upload`, {
          method: "POST",
          headers: { "x-file-name": "shipment.txt" },
          body: text,
        })
      ).status,
      202,
    );
    for (let i = 0; i < 200; i++) {
      const x = await fetch(`${base}/workspace/${w.id}`).then((r) => r.json());
      if (x.ready && x.documents.every((d) => d.status === "ready")) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    const ask = (q) =>
      fetch(base + "/ask", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ case: w.id, question: q, semantic: false }),
      }).then((r) => r.json());
    for (const q of questions) {
      const r = await ask(q);
      assert.equal(r.final.kind, "abstained", q);
      assert.equal(r.final.citations.length, 0);
      assert.equal(r.admission?.reason, "requirement_coverage_unverified");
      assert.equal(r.questionPlan.originalQuestion, q);
      assert.equal(r.questionPlan.coverageEstablished, false);
      assert.ok(r.evidence.length);
      assert.ok(r.final.relatedEvidence.length);
      assert.match(r.final.text, /whole request/);
    }
    for (const [q, fact] of [
      ["Who received order PK-101?", "Maya Rao"],
      ["What is the tracking number for order PK-101?", "TRK-8273"],
      ["What is the weight for order PK-101?", "17 kg"],
    ]) {
      const r = await ask(q);
      assert.equal(r.final.kind, "answered", q);
      assert.match(r.final.text, new RegExp(fact));
    }
    assert.equal(calls, 0);
  } finally {
    s.closeAllConnections();
    await new Promise((r) => s.close(r));
  }
});
