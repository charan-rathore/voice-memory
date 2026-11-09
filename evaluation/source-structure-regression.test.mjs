import assert from "node:assert/strict";
import test from "node:test";
import { createLocalServer } from "../src/server.mjs";
// Authored and first run on 88a before this regression file. Exposed synthetic
// source-mutation checks, not a sealed holdout or arbitrary-language score.
test("source structure keeps recorded observations separate from event truth and unknown conditions", async () => {
  const names = [
    "VM_COUNTERS_ALLOW_FILE",
    "VM_DENSE",
    "VM_SHARED_VOICE_REASONING",
  ];
  const saved = Object.fromEntries(names.map((n) => [n, process.env[n]]));
  Object.assign(process.env, {
    VM_COUNTERS_ALLOW_FILE: "on",
    VM_DENSE: "off",
    VM_SHARED_VOICE_REASONING: "on",
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
  const sources = [
    {
      id: "assertions",
      text: "Arjun paid $1,500 to Nimbus.\nNimbus paid $5,000 to Arjun.\nPriya approved the commercial scope.\nKamal signed the delivery plan.",
      questions: [
        ["Who approved the commercial scope?", "positive"],
        ["Who signed the commercial scope?", "must_not_answer"],
        ["How much did Nimbus pay to Arjun?", "positive"],
        ["How much did Arjun not pay to Nimbus?", "must_not_answer"],
        ["How much did Arjun pay to Nimbus yesterday?", "must_not_answer"],
        ["How much did Arjun pay to Nimbus and when?", "partial"],
      ],
    },
    {
      id: "conditional",
      text: "Commercial decision record\nPriya would approve the commercial scope if funding arrived.\nFunding has not arrived. Kamal has not signed the commercial scope.",
      questions: [
        ["Did Priya approve the commercial scope?", "must_not_answer"],
        ["Who approved the commercial scope?", "must_not_answer"],
        ["Was the commercial scope signed?", "must_not_answer"],
      ],
    },
    {
      id: "role-fields",
      text: "# PURCHASE ORDER PO-552\nDRAFT / NOT APPROVED\nApproved by: Priya Nair\nThis is a proposed approver, not a completed approval.",
      questions: [
        ["Who approved the purchase order?", "field_observation_only"],
        ["Did Priya approve the purchase order?", "must_not_answer"],
        ["Who signed the purchase order?", "must_not_answer"],
      ],
    },
    {
      id: "field-condition",
      text: "# WORKFLOW\n| Field | Value |\n| --- | --- |\n| Approver | Priya |\n\nThe listed approver is a proposed role assignment. No approval occurred.",
      questions: [
        ["What is the Approver?", "field_observation_only"],
        ["Did Priya approve the scope?", "must_not_answer"],
        ["Who approved the scope?", "must_not_answer"],
      ],
    },
    {
      id: "debt",
      text: "Debt ledger\nArjun owes $1,500.\nNimbus owes $5,000.",
      questions: [
        ["How much does Arjun owe?", "legacy_positive"],
        ["How much does Arjun not owe?", "must_not_answer"],
        ["How much does Arjun never owe?", "must_not_answer"],
        ["What amount does Nimbus not owe?", "must_not_answer"],
      ],
    },
    {
      id: "prose-amendment",
      text: "Commercial scope history\nPriya approved the commercial scope.\nThat approval was withdrawn. The commercial scope is not approved.\nKamal signed the delivery plan.",
      questions: [
        ["Is the commercial scope approved?", "must_not_answer"],
        ["Who approved the commercial scope?", "must_not_answer"],
        ["Did Priya approve the commercial scope?", "must_not_answer"],
      ],
    },
  ];
  try {
    for (const fixture of sources) {
      const w = await fetch(base + "/workspace", { method: "POST" }).then((r) =>
        r.json(),
      );
      assert.ok(w.id);
      const upload = await fetch(`${base}/workspace/${w.id}/upload`, {
        method: "POST",
        headers: { "x-file-name": fixture.id + ".txt" },
        body: fixture.text,
      });
      assert.equal(upload.status, 202);
      let ready = false;
      for (let i = 0; i < 200; i++) {
        const x = await fetch(`${base}/workspace/${w.id}`).then((r) =>
          r.json(),
        );
        if (
          x.documents.length === 1 &&
          x.documents.every((d) => d.status === "ready")
        ) {
          ready = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 20));
      }
      assert.ok(ready, fixture.id);
      for (const [question, expectation] of fixture.questions) {
        const response = await fetch(base + "/ask", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ case: w.id, question, semantic: false }),
        });
        assert.equal(response.status, 200);
        const r = await response.json();
        assert.ok(r.final);
        assert.equal(r.questionPlan.originalQuestion, question);
        const label = fixture.id + ": " + question;
        for (const citation of r.final.citations) {
          assert.ok(citation.quote, label);
          assert.ok(fixture.text.includes(citation.quote), label);
        }
        if (expectation === "must_not_answer") {
          assert.notEqual(r.final.kind, "answered", label);
          assert.equal(r.final.citations.length, 0, label);
        } else if (expectation === "partial") {
          assert.equal(r.final.kind, "partial", label);
          assert.match(r.final.text, /\$1,500/, label);
          assert.match(r.final.text, /and when.*could not establish/, label);
          assert.ok(
            r.final.citations.some(
              (c) => c.quote === "Arjun paid $1,500 to Nimbus.",
            ),
            label,
          );
          assert.equal(r.questionPlan.coverageEstablished, false);
          assert.equal(r.requirementCoverage.semanticAdmissionVerified, false);
        } else if (expectation === "field_observation_only") {
          assert.equal(r.final.kind, "answered", label);
          assert.match(
            r.final.text,
            /not confirmation that the event occurred|not a finding that surrounding conditions were met/,
            label,
          );
        } else if (expectation === "positive") {
          assert.equal(r.final.kind, "answered", label);
          assert.equal(r.admission.complete, true, label);
          const expected = question.startsWith("Who")
            ? "Priya approved the commercial scope."
            : "Nimbus paid $5,000 to Arjun.";
          assert.ok(
            r.final.citations.some((c) => c.quote === expected),
            label,
          );
          assert.ok(r.final.text.includes(expected), label);
        } else {
          assert.equal(r.final.kind, "answered", label);
          assert.match(r.final.text, /Arjun owes \$1,500/, label);
        }
      }
    }
    assert.equal(calls, 0);
  } finally {
    s.closeAllConnections();
    await new Promise((r) => s.close(r));
    for (const n of names)
      if (saved[n] === undefined) delete process.env[n];
      else process.env[n] = saved[n];
  }
});
