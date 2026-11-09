// Exposed source-linkage regression, not a version entailment certificate.
import test from "node:test";
import assert from "node:assert/strict";
import { createLocalServer } from "../src/server.mjs";
import { seriesFor } from "../clinical/observations.mjs";
test("different specimen identifiers cannot be erased by higher status for the same date", () => {
  const make = (accession, status, raw) => ({
    sourceId: accession,
    meta: {
      patient: { id: "AX-113" },
      collected: "2026-10-10",
      accession,
      status,
    },
    observations: [
      {
        key: "tsh",
        test: "TSH",
        raw,
        value: Number(raw),
        unit: "mIU/L",
        comparator: null,
      },
    ],
  });
  const f = make("ACC-111", "final", "1.10"),
    a = make("ACC-222", "amended", "9.90");
  for (const order of [
    [f, a],
    [a, f],
  ]) {
    const [r] = seriesFor(order, "tsh", "AX-113");
    assert.ok(r.current.authorityConflict);
    assert.equal(r.conflicts.length, 2);
    assert.equal(r.superseded.length, 0);
  }
  const [same] = seriesFor(
    [f, make("ACC-111", "amended", "9.90")],
    "tsh",
    "AX-113",
  );
  assert.equal(same.current.raw, "9.90");
  assert.equal(same.superseded[0].raw, "1.10");
});
test("actual HTTP cannot treat different printed accessions as a correction", async () => {
  const names = [
    "VM_COUNTERS_ALLOW_FILE",
    "VM_SHARED_VOICE_REASONING",
    "VM_BYO_VOICE",
  ];
  const saved = Object.fromEntries(names.map((n) => [n, process.env[n]]));
  Object.assign(process.env, {
    VM_COUNTERS_ALLOW_FILE: "on",
    VM_SHARED_VOICE_REASONING: "on",
    VM_BYO_VOICE: "on",
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
  try {
    const w = await fetch(base + "/workspace", { method: "POST" }).then((r) =>
      r.json(),
    );
    assert.ok(w.id);
    for (const [name, note, value] of [
      ["first", "Accession: ACC-111\nReport status: FINAL", "1.10"],
      ["second", "Accession: ACC-222\nReport status: AMENDED", "9.90"],
    ]) {
      const text = `Patient: Asha Sinha, ID AX-113\nCollected: 10 October 2026\n${note}\nTest Name    Results    Units    Reference range\nTSH    ${value}    mIU/L    0.4 - 4.0\n`;
      assert.equal(
        (
          await fetch(`${base}/workspace/${w.id}/upload`, {
            method: "POST",
            headers: { "x-file-name": name + ".txt" },
            body: text,
          })
        ).status,
        202,
      );
    }
    let ready = false;
    for (let i = 0; i < 200; i++) {
      const r = await fetch(`${base}/workspace/${w.id}`).then((r) => r.json());
      if (
        r.documents.length === 2 &&
        r.documents.every((d) => d.status === "ready")
      ) {
        ready = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.ok(ready);
    const r = await fetch(base + "/ask", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        case: w.id,
        question: "What is AX-113's TSH result?",
        semantic: false,
      }),
    }).then((r) => r.json());
    assert.match(r.final.text, /different printed accession/i);
    assert.ok(r.final.citations.some((c) => c.quote.includes("ACC-111")));
    assert.ok(r.final.citations.some((c) => c.quote.includes("ACC-222")));
    const list = await fetch(base + "/ask", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        case: w.id,
        question: "What are AX-113's TSH and sodium results?",
        semantic: false,
      }),
    }).then((r) => r.json());
    assert.equal(list.final.kind, "abstained");
    assert.equal(list.final.citations.length, 0);
    assert.ok(
      list.requirementCoverage.outcomes.every(
        (o) => o.status === "not_established",
      ),
    );
    const key = await fetch(base + "/llm/key", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ case: w.id }),
    }).then((r) => r.json());
    assert.ok(key.apiKey);
    const streamed = await fetch(base + "/llm/v1/chat/completions", {
      method: "POST",
      headers: {
        authorization: "Bearer " + key.apiKey,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        stream: true,
        messages: [{ role: "user", content: "What is AX-113's TSH result?" }],
      }),
    });
    assert.equal(streamed.status, 200);
    const raw = await streamed.text();
    const spoken = [...raw.matchAll(/^data: (.+)$/gm)]
      .filter((m) => m[1] !== "[DONE]")
      .map((m) => JSON.parse(m[1]).choices?.[0]?.delta?.content ?? "")
      .join("");
    assert.equal(spoken, r.final.text);
    assert.equal(calls, 0);
    assert.doesNotMatch(r.final.text, /corrected from|result is 9.90/);
  } finally {
    s.closeAllConnections();
    await new Promise((r) => s.close(r));
    for (const n of names)
      if (saved[n] === undefined) delete process.env[n];
      else process.env[n] = saved[n];
  }
});
