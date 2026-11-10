// Post-exposure safety regression, not document-understanding qualification.
import test from "node:test";
import assert from "node:assert/strict";
import { importBundle, answer, validateEvidence } from "../dist/engine.mjs";
import { ownerView, originalCitation } from "../src/owner-view.mjs";
import { semanticRescue } from "../src/semantic/route.mjs";
import { createLocalServer } from "../src/server.mjs";

function corpus() {
  const a =
    "Patient: Alice Smith, ID AL-101\nDischarged: 24 October 2026. The special transport arrangements require a blue vehicle.\n";
  const b =
    "Patient: Bob Jones, ID BJ-202\nDischarged: 30 October 2026. The private marker is BOB-SECRET-9876.\n";
  const unknown =
    "Unidentified draft\nMedicines: UnknownDrug999. Paid: USD 99999. Owner not stated.\n";
  const bundle = importBundle(
    [{ title: "Mixed packet", text: a + b + unknown }],
    { scope: "owner-contract" },
  );
  const src = bundle.sources[0];
  bundle.sourceRecords = [
    {
      sourceId: src.id,
      span: { start: 0, end: a.length },
      meta: { patient: { id: "AL-101", name: "Alice Smith" } },
    },
    {
      sourceId: src.id,
      span: { start: a.length, end: a.length + b.length },
      meta: { patient: { id: "BJ-202", name: "Bob Jones" } },
    },
  ];
  bundle.records = [];
  bundle.clinical = [];
  return { bundle, a, b, unknown };
}
test("derived index masks excluded and unknown records with stable offsets and original-source verification", () => {
  const { bundle, a, b } = corpus(),
    view = ownerView(bundle, "AL-101");
  assert.equal(view.sources[0].text.length, bundle.sources[0].text.length);
  assert.equal(view.sources[0].text.slice(0, a.length), a);
  for (const text of [
    view.sources.map((s) => s.text).join(" "),
    view.rows.map((r) => r.chunk.text).join(" "),
  ])
    assert.doesNotMatch(text, /Bob Jones|BOB-SECRET|UnknownDrug|99999/);
  assert.equal(view.sources[0].id, bundle.sources[0].id);
  assert.ok(
    view.rows.every(
      (r) => r.slug === bundle.sources[0].id && r.chunk.document_id === r.slug,
    ),
  );
  const start = a.indexOf("Discharged"),
    end = a.indexOf(". The");
  const ev = {
    sourceId: view.sources[0].id,
    hash: view.sources[0].hash,
    start,
    end,
    quote: a.slice(start, end),
  };
  const allowed = (c) => c.start >= 0 && c.end <= a.length;
  const original = originalCitation(ev, bundle, view, allowed);
  assert.ok(original);
  assert.equal(validateEvidence(original, bundle), true);
  assert.equal(original.hash, bundle.sources[0].hash);
  assert.equal(
    originalCitation({ ...ev, end: a.length + 10 }, bundle, view, allowed),
    null,
  );
  assert.equal(
    originalCitation({ ...ev, quote: b }, bundle, view, allowed),
    null,
  );
  assert.equal(
    bundle.sources[0].text.includes("BOB-SECRET"),
    true,
    "view never mutates original",
  );
  assert.equal(ownerView(bundle, "AL-101"), view);
  assert.notEqual(ownerView(bundle, "BJ-202"), view);
});

test("semantic rescue receives only the selected derived source catalog and retrieval", async () => {
  const { bundle } = corpus(),
    view = ownerView(bundle, "AL-101"),
    calls = [];
  const gemini = {
    enabled: () => true,
    searchEnabled: () => false,
    interpret: async (...args) => {
      calls.push(args);
      return null;
    },
    planClaims: async (...args) => {
      calls.push(args);
      return null;
    },
  };
  const raw = answer(
    "What special transport arrangements were required?",
    view,
  );
  await semanticRescue({
    question: "Which transport arrangement was required?",
    bundle: view,
    lead: null,
    raw,
    ctx: null,
    gemini,
    consent: true,
    rerun: async () => null,
    validate: () => true,
  });
  assert.ok(calls.length > 0);
  assert.doesNotMatch(
    JSON.stringify(calls),
    /Bob Jones|BOB-SECRET|UnknownDrug|99999/,
  );
});

test("public name-only selection excludes unidentified facts and retains concurrent context isolation", async () => {
  process.env.VM_COUNTERS_ALLOW_FILE = "on";
  const seen = [];
  const gemini = {
    enabled: () => true,
    searchEnabled: () => false,
    interpret: async (...a) => {
      seen.push(a);
      return null;
    },
    planClaims: async (...a) => {
      seen.push(a);
      return null;
    },
  };
  const server = createLocalServer({ port: 0, gemini });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}/api/public`;
  try {
    const ws = await fetch(base + "/workspace", { method: "POST" }).then((r) =>
      r.json(),
    );
    for (const [filename, text] of [
      [
        "alice.txt",
        "Discharge summary\nPatient: Alice Smith\nDischarged: 24 October 2026\nThe special transport arrangements require a blue vehicle.",
      ],
      [
        "bob.txt",
        "Discharge summary\nPatient: Bob Jones\nDischarged: 30 October 2026\nThe special transport arrangements require BOB-SECRET-9876.",
      ],
      [
        "unknown.txt",
        "Unidentified draft\nMedicines: UnknownDrug999\nPaid: USD 99999\nThe owner of this draft is not stated.",
      ],
    ])
      assert.equal(
        (
          await fetch(`${base}/workspace/${ws.id}/upload`, {
            method: "POST",
            headers: { "x-file-name": filename },
            body: text,
          })
        ).status,
        202,
      );
    let st;
    for (let i = 0; i < 300; i++) {
      st = await fetch(`${base}/workspace/${ws.id}`).then((r) => r.json());
      if (
        st.documents.length === 3 &&
        st.documents.every((d) => d.status === "ready")
      )
        break;
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.ok(st.documents.every((d) => d.status === "ready"));
    const ask = async (question, extra = {}) => {
      const r = await fetch(base + "/ask", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ case: ws.id, question, ...extra,
          documentConsent: extra.semantic ? { generation: st.bundleGeneration, provider: "Google Gemini", model: null } : undefined,
        }),
      });
      assert.equal(r.status, 200);
      return r.json();
    };
    const a = await ask("When was Alice discharged?"),
      b = await ask("When was Bob discharged?");
    assert.match(a.final.text, /24 Oct/);
    assert.match(b.final.text, /30 Oct/);
    const ambiguous = await ask("When was she discharged?");
    assert.equal(ambiguous.final.verdict, "AMBIGUOUS_PATIENT");
    const absent = await ask("When were Alice and Carol discharged?");
    assert.equal(absent.final.kind, "clarify");
    assert.doesNotMatch(absent.final.text, /24 Oct/);
    const unknown = await ask("What medicines did Alice take?");
    assert.doesNotMatch(JSON.stringify(unknown), /UnknownDrug999|99999/);
    await ask("Which transport arrangement was required for Alice?", {
      semantic: true,
    });
    assert.doesNotMatch(JSON.stringify(seen), /BOB-SECRET|UnknownDrug|99999/);
    const results = await Promise.all(
      ["Alice", "Bob", "Alice", "Bob"].map((name) =>
        ask(`When was ${name} discharged?`),
      ),
    );
    results.forEach((r, i) => {
      assert.match(r.final.text, i % 2 ? /30 Oct/ : /24 Oct/);
      assert.doesNotMatch(r.final.text, i % 2 ? /24 Oct/ : /30 Oct/);
    });
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test("opaque underscore and dot IDs survive exact selection, concurrent person context and replay", async () => {
  process.env.VM_COUNTERS_ALLOW_FILE = "on";
  const server = createLocalServer({
    port: 0,
    gemini: { enabled: () => false },
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}/api/public`;
  try {
    const ws = await fetch(base + "/workspace", { method: "POST" }).then((r) =>
      r.json(),
    );
    for (const [id, name, date] of [
      ["AL_101", "Alice Smith", "24 October 2026"],
      ["BJ.202", "Bob Jones", "30 October 2026"],
    ]) {
      assert.equal(
        (
          await fetch(`${base}/workspace/${ws.id}/upload`, {
            method: "POST",
            headers: { "x-file-name": id + ".txt" },
            body: `Discharge summary\nPatient: ${name}, ID ${id.toLowerCase()}\nDischarged: ${date}\nSignatory: Dr. Synthetic.`,
          })
        ).status,
        202,
      );
    }
    let st;
    for (let i = 0; i < 300; i++) {
      st = await fetch(`${base}/workspace/${ws.id}`).then((r) => r.json());
      if (
        st.documents.length === 2 &&
        st.documents.every((d) => d.status === "ready")
      )
        break;
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.ok(st.documents.every((d) => d.status === "ready"));
    const ask = async (extra) => {
      const r = await fetch(base + "/ask", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          case: ws.id,
          question: "When was she discharged?",
          ...extra,
        }),
      });
      assert.equal(r.status, 200);
      return r.json();
    };
    const variants = [
      { patient: "AL_101" },
      { patient: "BJ.202" },
      { context: "person:AL_101" },
      { context: "person:BJ.202" },
      { context: "person:AL_101" },
      { context: "person:BJ.202" },
    ];
    const results = await Promise.all(variants.map(ask));
    results.forEach((r, i) => {
      assert.match(r.final.text, i % 2 ? /30 Oct/ : /24 Oct/);
      assert.doesNotMatch(r.final.text, i % 2 ? /24 Oct/ : /30 Oct/);
    });
    const neutral = await ask({ context: "person:UNKNOWN_111" });
    assert.equal(neutral.final.kind, "clarify");
    assert.deepEqual(neutral.final.citations, []);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test("patient count is an explicit source-identity count, never a retrieved draft-plan sentence", async () => {
  process.env.VM_COUNTERS_ALLOW_FILE = "on";
  const server = createLocalServer({ port: 0 });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}/api/public`;
  try {
    const ws = await fetch(base + "/workspace", { method: "POST" }).then((r) =>
      r.json(),
    );
    for (const id of ["MY-101", "MY-202"])
      await fetch(`${base}/workspace/${ws.id}/upload`, {
        method: "POST",
        headers: { "x-file-name": id + ".txt" },
        body: `Patient: Maya Sharma, ID ${id}\nDraft plan: patient may leave on 23 October 2026. This is not a final discharge notice.`,
      });
    let st;
    for (let i = 0; i < 300; i++) {
      st = await fetch(`${base}/workspace/${ws.id}`).then((r) => r.json());
      if (
        st.documents.length === 2 &&
        st.documents.every((d) => d.status === "ready")
      )
        break;
      await new Promise((r) => setTimeout(r, 20));
    }
    for (const question of [
      "how many patients are there",
      "how many people are in these records?",
    ]) {
      const a = await fetch(base + "/ask", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ case: ws.id, question }),
      }).then((r) => r.json());
      assert.match(a.final.text, /2 record identities/);
      assert.match(a.final.text, /not a proven count of physical people/);
      assert.doesNotMatch(a.final.text, /may leave|23 October/);
      assert.equal(a.final.citations.length, 2);
    }
    for (const question of [
      "How many patients have high ferritin?",
      "How many patients were discharged in October?",
      "How many patients are there and when were they discharged?",
    ]) {
      const a = await fetch(base + "/ask", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ case: ws.id, question }),
      }).then((r) => r.json());
      assert.equal(a.final.kind, "clarify", question);
      assert.doesNotMatch(a.final.text, /2 record identities/);
      assert.deepEqual(a.final.citations, []);
    }
  } finally {
    await new Promise((r) => server.close(r));
  }
});
