// Exposed duplicate-source-row regression, not clinical qualification.
import test from "node:test";
import assert from "node:assert/strict";
import { createLocalServer } from "../src/server.mjs";
import { seriesFor } from "../clinical/observations.mjs";
test("same report same-test same-unit contradictions cannot be first-row selected", () => {
  const row = (raw, unit = "mIU/L") => ({
    key: "tsh",
    test: "TSH",
    raw,
    value: Number(raw),
    unit,
    comparator: null,
  });
  const report = (observations) => ({
    sourceId: "same",
    meta: {
      patient: { id: "AX-113" },
      collected: "2026-10-10",
      status: "final",
    },
    observations,
  });
  for (const values of [
    [row("1.10"), row("9.90")],
    [row("9.90"), row("1.10")],
  ]) {
    const [s] = seriesFor([report(values)], "tsh", "AX-113");
    assert.ok(s.current.authorityConflict);
    assert.equal(s.conflicts.length, 2);
    assert.equal(s.superseded.length, 0);
  }
  const [secondary] = seriesFor(
    [report([row("2", "%"), row("1.10"), row("9.90")])],
    "tsh",
    "AX-113",
  );
  assert.ok(secondary.current.authorityConflict);
  const [identical] = seriesFor(
    [report([row("1.10"), row("1.10")])],
    "tsh",
    "AX-113",
  );
  assert.equal(identical.conflicts.length, 0);
});
test("actual HTTP cannot hide contradictory duplicate rows behind the first result", async () => {
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
    const text =
      "Patient: Asha Sinha, ID AX-113\nCollected: 10 October 2026\nReport status: FINAL\nTest Name    Results    Units    Reference range\nTSH    1.10    mIU/L    0.4 - 4.0\nTSH    9.90    mIU/L    0.4 - 4.0\n";
    assert.equal(
      (
        await fetch(`${base}/workspace/${w.id}/upload`, {
          method: "POST",
          headers: { "x-file-name": "duplicate.txt" },
          body: text,
        })
      ).status,
      202,
    );
    let ready = false;
    for (let i = 0; i < 200; i++) {
      const r = await fetch(`${base}/workspace/${w.id}`).then((r) => r.json());
      if (
        r.documents.length === 1 &&
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
    assert.match(r.final.text, /conflicting values/i);
    assert.ok(r.final.citations.some((c) => c.quote.includes("1.10")));
    assert.ok(r.final.citations.some((c) => c.quote.includes("9.90")));
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
