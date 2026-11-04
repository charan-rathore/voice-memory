// Patient identity across the evidence engine and both graphs. RED on main
// 6edac74:
//  - clinicalGraph drew every report without a printed ID under one
//    `patient:unidentified` node with shared `test:unidentified:<key>` topics.
//  - A masked identifier ("Lab No. : XXXXXXXXX", as in public lab samples)
//    was read as a real patient ID, so two different men (36 and 25) became
//    one subject: the engine answered "the result was corrected from 1.20 to
//    7.80" with one person's TSH "correcting" the other's.
// Reports here are synthetic text laid out like a chain-lab report.
import test from "node:test";
import assert from "node:assert/strict";
import { ingestFile } from "../ingest/index.mjs";
import { extractReport, subjectOf } from "../clinical/observations.mjs";
import { isMaskedIdentity } from "../clinical/lab-lines.mjs";
import { clinicalAnswer } from "../clinical/answer.mjs";
import { importBundle } from "../dist/engine.mjs";
import { clinicalGraph } from "../src/public-api.mjs";
import { buildGraph } from "../memory/graph.mjs";
import { createMemory } from "../memory/memory.mjs";

const report = (head, tsh, status = "Final") =>
  [
    head,
    `Collected : 14/3/2025 9:10:00AM    Reported : 14/3/2025 6:00:00PM    Report Status : ${status}`,
    "",
    "Test Name    Results    Units    Bio. Ref. Interval",
    "",
    "THYROID PROFILE",
    `TSH    ${tsh}    µIU/mL    0.35 - 5.50`,
    "Creatinine    0.90    mg/dL    0.67 - 1.17",
    "",
  ].join("\n");

async function load(texts) {
  const entries = [];
  for (const [i, t] of texts.entries()) {
    const r = await ingestFile(Buffer.from(t), `r${i}.txt`);
    assert.ok(r.ok, r.message);
    entries.push({ title: `r${i}.txt`, doc: r.doc });
  }
  const bundle = importBundle(
    entries.map((e) => ({ title: e.title, text: e.doc.text })),
  );
  bundle.clinical = entries.map((e, i) => ({
    title: e.title,
    sourceId: bundle.sources[i].id,
    ...extractReport(e.doc),
  }));
  return bundle;
}

const UNPROVEN = {
  "no name or ID": [
    report("City Lab (synthetic)    Age : 52 Years    Gender : Male", "7.80"),
    report("Town Lab (synthetic)    Age : 31 Years    Gender : Female", "1.20"),
  ],
  "masked lab number": [
    report("Lab No. : XXXXXXXXX    Age : 36 Years    Gender : Male", "7.80"),
    report("Lab No. : XXXXXXXXX    Age : 25 Years    Gender : Male", "1.20"),
  ],
  "masked name": [
    report("Name : XXXXXXXXX    Age : 36 Years    Gender : Male", "7.80"),
    report("Name : XXXXXXXXX    Age : 25 Years    Gender : Male", "1.20"),
  ],
};

test("masked identity fields are recognised", () => {
  for (const v of ["XXXXXXXXX", "xxxx", "****", "XXXXX1234", "XX XX XX"])
    assert.ok(isMaskedIdentity(v), v);
  for (const v of ["SYN0001", "WM14S", "Rao", "AX12", null, ""])
    assert.ok(!isMaskedIdentity(v), String(v));
});

for (const [label, texts] of Object.entries(UNPROVEN)) {
  test(`${label}: two reports stay two people in engine and graphs`, async () => {
    const b = await load(texts);
    const [a, c] = b.clinical;
    assert.equal(subjectOf(a), `doc:${a.sourceId}`);
    assert.equal(subjectOf(c), `doc:${c.sourceId}`);

    const g = clinicalGraph(b);
    const patients = g.nodes.filter((n) => n.kind === "patient");
    assert.deepEqual(
      patients.map((n) => n.id).sort(),
      [`patient:doc:${a.sourceId}`, `patient:doc:${c.sourceId}`].sort(),
    );
    assert.ok(patients.every((n) => n.verified === false));
    assert.ok(!g.nodes.some((n) => /unidentified|XXXX/i.test(n.id)));
    const tshTopics = g.nodes.filter(
      (n) => n.kind === "topic" && /^test:.*:tsh$/.test(n.id),
    );
    assert.equal(tshTopics.length, 2, "one TSH topic per report");
    // no edge links one report's reading to the other's
    assert.ok(
      !g.edges.some((e) => /^obs:/.test(e.from) && /^obs:/.test(e.to)),
      JSON.stringify(g.edges.filter((e) => /^obs:/.test(e.from))),
    );
    // each reading keeps its exact row, its own source and its date
    for (const [r, v] of [
      [a, "7.80"],
      [c, "1.20"],
    ]) {
      const n = g.nodes.find((x) => x.id === `obs:${r.sourceId}:tsh`);
      assert.equal(n.evidence.sourceId, r.sourceId);
      assert.match(
        n.evidence.quote,
        new RegExp(`^TSH\\s+${v.replace(".", "\\.")}`),
      );
      assert.equal(n.date, "2025-03-14");
    }

    // owner graph: one lab topic per unverified report
    const own = buildGraph(b, createMemory(), "overview");
    const labTopics = own.nodes.filter((n) => /^topic:lab:/.test(n.id));
    assert.equal(labTopics.length, 2);
    assert.ok(labTopics.every((n) => /^topic:lab:unverified:/.test(n.id)));

    // the engine asks whose results instead of merging or "correcting"
    const ans = clinicalAnswer("Was the TSH corrected?", b.clinical);
    assert.doesNotMatch(ans.spoken, /corrected from|1\.20.*7\.80|7\.80.*1\.20/);
    assert.match(ans.spoken, /more than one person/);
  });
}

test("a verified patient ID still links an amended report to its preliminary", async () => {
  const b = await load([
    report("Patient: Synthetic Person, ID: SYN0009", "7.80", "Preliminary"),
    report("Patient: Synthetic Person, ID: SYN0009", "1.20", "Amended"),
  ]);
  const [pre, amd] = b.clinical;
  assert.equal(subjectOf(pre), "SYN0009");
  assert.equal(subjectOf(amd), "SYN0009");
  const g = clinicalGraph(b);
  assert.deepEqual(
    g.nodes.filter((n) => n.kind === "patient").map((n) => [n.id, n.verified]),
    [["patient:SYN0009", true]],
  );
  const corrects = g.edges.filter((e) => e.kind === "corrects");
  assert.ok(
    corrects.some(
      (e) =>
        e.from === `obs:${amd.sourceId}:tsh` &&
        e.to === `obs:${pre.sourceId}:tsh`,
    ),
    JSON.stringify(corrects),
  );
});
