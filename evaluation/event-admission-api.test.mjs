// Exposed synthetic event assertions, never frozen semantic cases or providers.
import test from "node:test";
import assert from "node:assert/strict";
import { createLocalServer } from "../src/server.mjs";
test("actual HTTP wrong signature inference is blocked; certified event requirements retain supported facts and full compound coverage", async () => {
  const names = [
    "VM_SHARED_VOICE_REASONING",
    "VM_BYO_VOICE",
    "VM_COUNTERS_ALLOW_FILE",
  ];
  const saved = Object.fromEntries(names.map((n) => [n, process.env[n]]));
  Object.assign(process.env, {
    VM_SHARED_VOICE_REASONING: "on",
    VM_BYO_VOICE: "on",
    VM_COUNTERS_ALLOW_FILE: "on",
  });
  let calls = 0;
  const forbidden = async () => {
    calls++;
    throw Error("No provider permission");
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
  const ws = () =>
    fetch(base + "/workspace", { method: "POST" }).then((r) => r.json());
  const upload = async (w, name, body) => {
    assert.equal(
      (
        await fetch(`${base}/workspace/${w.id}/upload`, {
          method: "POST",
          headers: { "x-file-name": name },
          body,
        })
      ).status,
      202,
    );
    for (let i = 0; i < 200; i++) {
      const x = await fetch(`${base}/workspace/${w.id}`).then((r) => r.json());
      if (x.ready && x.documents.every((d) => d.status === "ready")) return;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw Error("not ready");
  };
  const ask = async (w, question) => {
    const r = await fetch(base + "/ask", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ case: w.id, question, semantic: false }),
    });
    assert.equal(r.status, 200);
    return r.json();
  };
  try {
    const original = await ws();
    await upload(
      original,
      "Ledger.txt",
      "Payment ledger\nArjun paid $1,500 to Nimbus.\nNimbus owes $5,000 to Arjun.\nPriya approved the commercial scope.\nKamal signed the delivery plan.",
    );
    const wrong = await ask(original, "Did Priya sign the commercial scope?");
    assert.equal(
      wrong.final.kind,
      "abstained",
      "approval cannot satisfy a signature requirement",
    );
    assert.equal(wrong.final.citations.length, 0);
    assert.equal(wrong.admission.outcomes[0].status, "not_established");
    assert.equal(wrong.questionPlan.requirements[0].slots.action, "sign");
    const wrongActor = await ask(original, "Who signed the commercial scope?");
    assert.equal(
      wrongActor.final.kind,
      "abstained",
      "signature actor must not come from approval",
    );
    assert.equal(wrongActor.final.citations.length, 0);
    const w = await ws();
    await upload(
      w,
      "Assertions.txt",
      "Arjun paid $1,500 to Nimbus.\nPriya approved the commercial scope.\nKamal did not sign the delivery plan.",
    );
    const key = await fetch(base + "/llm/key", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ case: w.id }),
    }).then((r) => r.json());
    const voice = async (question) => {
      const r = await fetch(base + "/llm/v1/chat/completions", {
        method: "POST",
        headers: {
          authorization: "Bearer " + key.apiKey,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          stream: true,
          messages: [{ role: "user", content: question }],
        }),
      });
      assert.equal(r.status, 200);
      const raw = await r.text();
      return [...raw.matchAll(/^data: (.+)$/gm)]
        .filter((m) => m[1] !== "[DONE]")
        .map((m) => JSON.parse(m[1]).choices?.[0]?.delta?.content ?? "")
        .join("");
    };
    for (const q of [
      "Did Arjun pay $1,500 to Nimbus?",
      "Has Arjun paid $1,500 to Nimbus?",
      "Did Priya approve the commercial scope?",
      "Has Priya approved the commercial scope?",
      "Was the commercial scope approved by Priya?",
      "Who approved the commercial scope?",
      "Who paid $1,500 to Nimbus?",
      "Was the delivery plan signed by Kamal?",
      "Did Kamal sign the delivery plan?",
      "Did Arjun pay $1,500 to Nimbus and did Priya sign the commercial scope?",
    ]) {
      const r = await ask(w, q);
      assert.ok(
        r.admission?.userReady,
        `${q} must retain independently admitted source support`,
      );
      assert.equal(r.questionPlan.originalQuestion, q);
      assert.equal(await voice(q), r.final.text, q);
      if (q.includes(" and did ")) {
        assert.equal(r.final.kind, "partial");
        assert.deepEqual(
          r.admission.outcomes.map((o) => o.status),
          ["answered", "not_established"],
        );
        assert.match(r.final.text, /Did Priya sign/);
      } else {
        assert.equal(r.final.kind, "answered");
        assert.equal(r.final.citations.length, 1);
      }
    }
    for (const q of [
      "Did Nimbus pay $1,500 to Arjun?",
      "Did Arjun pay $5,000 to Nimbus?",
      "Did Priya sign the commercial scope?",
      "Has Priya signed the commercial scope?",
      "Was the commercial scope signed by Priya?",
      "Who signed the commercial scope?",
      "Who signed the delivery plan?",
    ]) {
      const r = await ask(w, q);
      assert.equal(r.final.kind, "abstained", q);
      assert.equal(r.final.citations.length, 0);
    }
    await upload(
      w,
      "Contradiction.txt",
      "Arjun did not pay $1,500 to Nimbus.\nPriya approved the commercial scope.",
    );
    const conflict = await ask(
      w,
      "Did Arjun pay $1,500 to Nimbus and did Priya approve the commercial scope?",
    );
    assert.equal(conflict.final.kind, "partial");
    assert.deepEqual(
      conflict.admission.outcomes.map((o) => o.status),
      ["clarify", "answered"],
    );
    await upload(
      w,
      "Purchase.txt",
      "# PURCHASE ORDER PO-55120\n\nAPPROVED / SIGNED\nApproved by: Priya Nair, Head of Procurement Approval date: 03 Nov 2026",
    );
    const role = await ask(w, "Who approved the purchase order?");
    assert.equal(role.final.verdict, "SCHEMA_FIELDS");
    assert.match(role.final.text, /Priya Nair/);
    assert.match(role.final.text, /not confirmation that the event occurred/);
    assert.equal(
      await voice("Who approved the purchase order?"),
      role.final.text,
    );
    const notSigned = await ask(w, "Who signed the purchase order?");
    assert.equal(notSigned.final.kind, "abstained");
    assert.equal(calls, 0);
  } finally {
    s.closeAllConnections();
    await new Promise((r) => s.close(r));
    for (const n of names)
      if (saved[n] === undefined) delete process.env[n];
      else process.env[n] = saved[n];
  }
});
