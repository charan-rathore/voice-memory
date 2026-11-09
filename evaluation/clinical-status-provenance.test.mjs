// Exposed source-authority regression, not a clinical entailment certificate.
import test from "node:test";
import assert from "node:assert/strict";
import { reportMeta, seriesFor } from "../clinical/observations.mjs";
import { createLocalServer } from "../src/server.mjs";
test("report authority comes from a complete status field or standalone header label, not a word in prose", () => {
  for (const prose of [
    "This is not an AMENDED report.",
    "Earlier FINAL report is attached.",
    "Awaiting AMENDED version",
    "Report status: amended if approved",
    "Previous report status: AMENDED",
    "Report status: not final",
    "Collected: DO NOT USE Reported: PRIOR Report status: AMENDED",
  ]) {
    assert.equal(
      reportMeta(`# LAB RESULT\n${prose}\nPatient: Asha Sinha, ID AX-113`)
        .status,
      "unknown",
      prose,
    );
  }
  for (const [line, status] of [
    ["Report status: FINAL", "final"],
    ["Report status AMENDED", "amended"],
    ["PRELIMINARY CHEMISTRY", "preliminary"],
    ["AMENDED / FINAL CORRECTED VERSION", "amended"],
    ["Report status: provisional", "preliminary"],
    ["PRELIMINARY GENERAL MEDICINE CHEMISTRY AND HEMATOLOGY", "preliminary"],
    ["AMENDED / FINAL CORRECTED VERSION OF 22 OCT SAMPLE", "amended"],
    [
      "Collected : 14/3/2025 9:10:00AM    Reported : 14/3/2025 6:00:00PM    Report Status : Amended",
      "amended",
    ],
    [
      "Patient: Asha Sinha, ID AX-113 Collected: 10 October 2026 Reported: 11 October 2026 Report status: FINAL",
      "final",
    ],
  ])
    assert.equal(reportMeta(`# LAB RESULT\n${line}`).status, status, line);
});
test("FINAL rank without amendment cannot invent correction history", () => {
  const make = (status, raw) => ({
    sourceId: status,
    meta: { patient: { id: "AX-113" }, collected: "2026-10-10", status },
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
  const final = make("final", "1.10"),
    unknown = make("unknown", "9.90");
  for (const order of [
    [final, unknown],
    [unknown, final],
  ]) {
    const [s] = seriesFor(order, "tsh", "AX-113");
    assert.equal(s.current.raw, "1.10");
    assert.deepEqual(s.superseded, []);
  }
  const [amended] = seriesFor(
    [make("amended", "2.20"), final],
    "tsh",
    "AX-113",
  );
  assert.equal(amended.superseded[0].raw, "1.10");
});
test("actual HTTP cannot promote a negated amended mention into a correction", async () => {
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
      ["first", "Chemistry panel", "1.10"],
      ["second", "This is not an AMENDED report.", "9.90"],
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
    assert.match(r.final.text, /conflict/i);
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
