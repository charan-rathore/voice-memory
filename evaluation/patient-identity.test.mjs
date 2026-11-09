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

// ---- Identity contract (review of PR #50 head d0f181a, all RED there) ----
// Only a printed patient identifier links reports. A shared printed name or
// a shared lab/accession number never does; a patient ID contradicted by the
// reports themselves (sex, impossible ages) does not either.
import {
  dobRelation,
  markIdentityConflicts,
} from "../clinical/observations.mjs";
import { clinicalAnswer as ask2 } from "../clinical/answer.mjs";
import { readFileSync } from "node:fs";
import vm from "node:vm";
const box = { window: {} };
vm.runInNewContext(
  readFileSync(new URL("../site/status-labels.js", import.meta.url), "utf8"),
  box,
);
const label = box.window.VM_STATUS.statusLabel;
const reportOn = (head, tsh, date = "14/3/2025", status = "Final") =>
  report(head, tsh, status).replace(/14\/3\/2025/g, date);
const loadSet = async (texts) => {
  const b = await load(texts);
  markIdentityConflicts(b.clinical);
  return b;
};
const separate = (b) => {
  const ids = b.clinical.map((r) => subjectOf(r));
  assert.equal(new Set(ids).size, ids.length, ids.join(" | "));
  assert.ok(ids.every((id) => id.startsWith("doc:")));
  const g = clinicalGraph(b);
  assert.ok(
    g.nodes
      .filter((n) => n.kind === "patient")
      .every((n) => n.verified === false),
  );
  assert.ok(!g.edges.some((e) => /^obs:/.test(e.from) && /^obs:/.test(e.to)));
  return g;
};

test("two John Smiths (36 and 25), no patient IDs: two people, never verified", async () => {
  const b = await loadSet([
    reportOn("Name : John Smith    Age : 36 Years    Gender : Male", "7.80"),
    reportOn(
      "Name : John Smith    Age : 25 Years    Gender : Male",
      "1.20",
      "20/3/2025",
    ),
  ]);
  const g = separate(b);
  assert.ok(
    g.nodes
      .filter((n) => n.kind === "patient")
      .every((n) => /John Smith: name only, not linked/.test(n.label)),
  );
  const a = ask2("Has John Smith's TSH changed?", b.clinical).spoken;
  assert.match(a, /more than one person/);
  assert.match(a, /John Smith \(r0\.txt\).*John Smith \(r1\.txt\)/);
  assert.doesNotMatch(a, /1\.20.*7\.80|7\.80.*1\.20/);
});

test("two labs printing the same Lab No. are two people; Lab No. is not a patient ID", async () => {
  const b = await loadSet([
    reportOn(
      "City Lab    Name : Asha Rao    Lab No. : ABC123    Age : 41 Years    Gender : Female",
      "7.80",
    ),
    reportOn(
      "Town Lab    Name : Ravi Iyer    Lab No. : ABC123    Age : 63 Years    Gender : Male",
      "1.20",
    ),
  ]);
  for (const r of b.clinical) {
    assert.equal(r.meta.patient?.id ?? null, null);
    assert.equal(r.meta.accession, "ABC123");
  }
  separate(b);
});

test("one person, different lab numbers, no patient ID: not linked, the engine asks", async () => {
  const b = await loadSet([
    reportOn(
      "Name : Meera Das    Lab No. : L-1001    Age : 52 Years    Gender : Female",
      "7.80",
      "13/9/2025",
    ),
    reportOn(
      "Name : Meera Das    Lab No. : L-2002    Age : 52 Years    Gender : Female",
      "6.10",
      "14/10/2025",
    ),
  ]);
  separate(b);
  assert.match(
    ask2("Has the TSH changed?", b.clinical).spoken,
    /more than one person/,
  );
});

test("a shared patient ID contradicted by the reports (sex) does not link", async () => {
  const b = await loadSet([
    reportOn(
      "Patient: Synthetic Person, ID: SYN0042    Age : 36 Years    Gender : Male",
      "7.80",
    ),
    reportOn(
      "Patient: Synthetic Person, ID: SYN0042    Age : 36 Years    Gender : Female",
      "1.20",
    ),
  ]);
  separate(b);
});

test("verified patient ID across visits: amendment linked; 'latest' only for the latest collection", async () => {
  const b = await loadSet([
    reportOn(
      "Patient: Synthetic Person, ID: SYN0009",
      "4.10",
      "13/9/2025",
      "Final",
    ),
    reportOn(
      "Patient: Synthetic Person, ID: SYN0009",
      "7.80",
      "14/10/2025",
      "Preliminary",
    ),
    reportOn(
      "Patient: Synthetic Person, ID: SYN0009",
      "1.20",
      "14/10/2025",
      "Amended",
    ),
  ]);
  const [sep, pre, amd] = b.clinical;
  assert.deepEqual(
    [sep, pre, amd].map((r) => subjectOf(r)),
    ["SYN0009", "SYN0009", "SYN0009"],
  );
  const g = clinicalGraph(b);
  const n = (r) => g.nodes.find((x) => x.id === `obs:${r.sourceId}:tsh`);
  assert.equal(n(sep).date, "2025-09-13");
  assert.equal(n(amd).date, "2025-10-14");
  assert.ok(
    g.edges.some(
      (e) =>
        e.kind === "corrects" && e.from === n(amd).id && e.to === n(pre).id,
    ),
  );
  assert.ok(
    g.edges.some(
      (e) => e.kind === "then" && e.from === n(sep).id && e.to === n(amd).id,
    ),
  );
  // RED on d0f181a: September final and October amended both read
  // "latest reported reading".
  assert.equal(label(n(sep)), "reported reading (earlier collection)");
  assert.equal(label(n(amd)), "latest reported reading");
  assert.equal(label(n(pre)), "corrected (replaced by the amended report)");
  // no chronology established -> neutral
  assert.equal(
    label({ id: "obs:x:tsh", status: "current" }),
    "reported reading",
  );
});

// Same patient ID with two confidently different printed birth dates is an
// identity conflict (RED before dobKey: the reports merged and a bare trend
// question drew one person's change across two people). Equivalent dates in
// different unambiguous formats never split; all-numeric dates are too
// ambiguous to prove either a conflict or a match.
test("a shared patient ID contradicted by printed DOBs does not link or trend", async () => {
  const b = await loadSet([
    reportOn(
      "Patient: Asha Rao, ID AR-100\nDOB: 12 Jan 1980    Gender : Female",
      "7.80",
    ),
    reportOn(
      "Patient: Asha Rao, ID AR-100\nDOB: 03 Jul 1965    Gender : Female",
      "1.20",
      "20/3/2025",
    ),
  ]);
  separate(b);
  const a = ask2("Has Asha's TSH changed?", b.clinical).spoken;
  assert.match(a, /more than one person/);
  assert.doesNotMatch(a, /went from|higher than before|rose|dropped/i);
});

test("the same DOB in ISO and alphabetic formats stays one person", async () => {
  const b = await loadSet([
    reportOn(
      "Patient: Asha Rao, ID AR-101\nDOB: 12 Jan 1980    Gender : Female",
      "7.80",
    ),
    reportOn(
      "Patient: Asha Rao, ID AR-101\nDOB: 1980-01-12    Gender : Female",
      "1.20",
      "20/3/2025",
    ),
  ]);
  const ids = new Set(b.clinical.map((r) => subjectOf(r)));
  assert.deepEqual([...ids], ["AR-101"]);
  assert.ok(b.clinical.every((r) => !r.meta.patient?.idConflict));
});

// Printed DOB semantics under one patient ID: unambiguous formats compare
// semantically; genuinely ambiguous ones (03/07: 3 July or 7 March) never
// prove a match - reports whose printed birth dates cannot be shown to
// agree stay apart and abstain, with the kind recorded for review.
test("unambiguous numeric dates compare semantically, not textually", () => {
  assert.equal(dobRelation("15/03/1965", "03/15/1965"), "same"); // d/m vs m/d
  assert.equal(dobRelation("20/03/1965", "03/15/1965"), "conflict");
  assert.equal(dobRelation("12 Jan 1980", "1980-01-12"), "same");
  assert.equal(dobRelation("03/07/1965", "07/03/1965"), "undecidable");
  assert.equal(dobRelation("01/12/1980", "1980-12-01"), "undecidable");
  assert.equal(dobRelation("03/07/1965", "1980-01-12"), "conflict");
  assert.equal(dobRelation("03/07/1965", "03/07/1965"), "undecidable");
});

test("numeric DOBs that cannot be shown to match still abstain", async () => {
  const b = await loadSet([
    reportOn(
      "Patient: Asha Rao, ID AR-102\nDOB: 03/07/1965    Gender : Female",
      "7.80",
    ),
    reportOn(
      "Patient: Asha Rao, ID AR-102\nDOB: 07/03/1965    Gender : Female",
      "1.20",
      "20/3/2025",
    ),
  ]);
  separate(b);
  assert.ok(
    b.clinical.every(
      (r) => r.meta.patient?.idConflictKind === "dob-undecidable",
    ),
  );
  // the printed strings survive for review
  assert.deepEqual(b.clinical.map((r) => r.meta.dob).sort(), [
    "03/07/1965",
    "07/03/1965",
  ]);
  const a = ask2("Has Asha's TSH changed?", b.clinical).spoken;
  assert.match(a, /more than one person/);
  assert.doesNotMatch(a, /went from|higher than before|rose|dropped/i);
});

test("an ambiguous numeric DOB against an ISO date abstains too", async () => {
  const b = await loadSet([
    reportOn(
      "Patient: Asha Rao, ID AR-103\nDOB: 01/12/1980    Gender : Female",
      "7.80",
    ),
    reportOn(
      "Patient: Asha Rao, ID AR-103\nDOB: 1980-12-01    Gender : Female",
      "1.20",
      "20/3/2025",
    ),
  ]);
  separate(b);
  const a = ask2("Has Asha's TSH changed?", b.clinical).spoken;
  assert.match(a, /more than one person/);
  assert.doesNotMatch(a, /went from|higher than before|rose|dropped/i);
});

test("resolvable numeric formats naming the same day stay one person", async () => {
  const b = await loadSet([
    reportOn(
      "Patient: Asha Rao, ID AR-104\nDOB: 15/03/1965    Gender : Female",
      "7.80",
    ),
    reportOn(
      "Patient: Asha Rao, ID AR-104\nDOB: 03/15/1965    Gender : Female",
      "1.20",
      "20/3/2025",
    ),
  ]);
  assert.ok(b.clinical.every((r) => !r.meta.patient?.idConflict));
  assert.deepEqual(
    [...new Set(b.clinical.map((r) => subjectOf(r)))],
    ["AR-104"],
  );
});

// Sol round 2: two different printed DOB strings that neither parser can
// reconcile ("Jan 12, 1980" style, ordinals, 2-digit years) are
// undecidable - the reports stay apart and abstain, never silently merge.
test("unparseable but different printed DOBs abstain, not merge", async () => {
  // month-first and ordinal forms parse unambiguously now
  assert.equal(dobRelation("Jan 12, 1980", "1980-01-12"), "same");
  assert.equal(dobRelation("Jan 12, 1980", "03 Jul 1965"), "conflict");
  assert.equal(dobRelation("12th Jan 1980", "1980-01-12"), "same");
  // still-unparseable different strings abstain instead of merging
  assert.equal(dobRelation("01/02/80", "1980-02-01"), "undecidable");
  // invalid calendar dates never establish identity either
  assert.equal(dobRelation("2020-02-30", "30 Feb 2020"), "undecidable");
  assert.equal(dobRelation("1980-00-00", "1980-01-12"), "undecidable");
  assert.equal(dobRelation("29/02/2024", "2024-02-29"), "same"); // real leap day
  const b = await loadSet([
    reportOn(
      "Patient: Asha Rao, ID AR-105\nDOB: Jan 12, 1980    Gender : Female",
      "7.80",
    ),
    reportOn(
      "Patient: Asha Rao, ID AR-105\nDOB: 03 Jul 1965    Gender : Female",
      "1.20",
      "20/3/2025",
    ),
  ]);
  separate(b);
  const a = ask2("Has Asha's TSH changed?", b.clinical).spoken;
  assert.match(a, /more than one person/);
  assert.doesNotMatch(a, /went from|higher than before|rose|dropped/i);
});

test("DOB validation precedes raw equality and accepts uppercase ordinals", () => {
  assert.equal(dobRelation("2020-02-30", "2020-02-30"), "undecidable");
  assert.equal(dobRelation("01/02/80", "01/02/80"), "undecidable");
  assert.equal(dobRelation("12TH Jan 1980", "1980-01-12"), "same");
  assert.equal(dobRelation("Jan 1ST, 1980", "1980-01-01"), "same");
  assert.equal(dobRelation("03/07/1965", "04/08/1965"), "undecidable");
});

test("text-month invalid dates never establish identity, even identical", () => {
  for (const d of [
    "30 Feb 2020",
    "31 Apr 1980",
    "29 Feb 2023",
    "30th February 2020",
  ])
    assert.equal(dobRelation(d, d), "undecidable", d);
});

test("a named person overrides stale selection for summaries and sample dates", async () => {
  const b = await loadSet([
    report(
      "Patient: Alice Smith, ID AL-101\nDOB: 12 Jan 1980 Gender: Female",
      "7.8",
    ),
    report(
      "Patient: Bob Jones, ID BJ-202\nDOB: 12 Jan 1980 Gender: Female",
      "1.2",
    ),
  ]);
  for (const q of [
    "Summarise Bob Jones's results",
    "Summarize Bob's results",
    "What are Bob Jones's thyroid results?",
  ]) {
    const a = clinicalAnswer(q, b.clinical, "AL-101");
    assert.doesNotMatch(a.spoken, /7\.8/, q);
    assert.ok(
      a.used.every((o) => subjectOf(o.report) === "BJ-202"),
      q,
    );
  }
});

test("kinship cannot map an old selected person, including summaries and dates", async () => {
  const b = await loadSet([
    report(
      "Patient: Alice Smith, ID AL-101\nDOB: 12 Jan 1980 Gender: Female",
      "7.8",
    ),
    report(
      "Patient: Bob Jones, ID BJ-202\nDOB: 12 Jan 1980 Gender: Female",
      "1.2",
    ),
  ]);
  for (const q of [
    "Summarise my mother's results",
    "What is my mother's TSH?",
    "When was my mother's sample collected?",
  ]) {
    const a = clinicalAnswer(q, b.clinical, "AL-101");
    assert.equal(a.verdict, "AMBIGUOUS_PATIENT", q);
    assert.deepEqual(a.used, []);
  }
  for (const q of [
    "Summarise Alice Smith and Bob Jones's results",
    "Summarise AL-101 and BJ-202",
  ]) {
    const a = clinicalAnswer(q, b.clinical, "AL-101");
    assert.ok(
      a.used.some((o) => subjectOf(o.report) === "BJ-202"),
      q,
    );
  }
});

test("mixed doctor prompts without flags do not assign a relative-only pronoun", async () => {
  const b = await loadSet([
    report(
      "Patient: Alice Smith, ID AL-101\nDOB: 12 Jan 1980 Gender: Female",
      "1.8",
    ),
  ]);
  for (const q of [
    "What should I ask the doctor about my mother's and my HbA1c results?",
    "What should I ask the doctor about my mother's HbA1c and mine?",
    "meri maa aur mera sugar result doctor se kya poochun?",
    "मेरी माँ और मेरी HbA1c रिपोर्ट डॉक्टर से क्या पूछूं?",
  ]) {
    const a = clinicalAnswer(q, b.clinical, "AL-101");
    assert.equal(a.intent, "ASK_DOCTOR", q);
    assert.doesNotMatch(
      a.spoken,
      /for them|their history|for you|your history|उनकी|उनके|आपकी|unke|aapki/,
      q,
    );
  }
});

test("every report-date parser rejects impossible calendar dates", async () => {
  const { genericMeta } = await import("../clinical/lab-lines.mjs");
  for (const d of [
    "2026-02-30",
    "30 Feb 2026",
    "31 Apr 2026",
    "30/02/2026",
    "02/30/2026",
  ]) {
    const m = genericMeta(
      `Patient ID: TEST-123\nCollected: ${d}\nReported: ${d}`,
    );
    assert.equal(m.collected, null, d);
    assert.equal(m.reported, null, d);
  }
});

test("mixed full-name, shorthand and ID references preserve every requested person", async () => {
  const b = await loadSet([
    report("Patient: Alice Smith, ID AL-101", "7.8"),
    report("Patient: Bob Jones, ID BJ-202", "1.2"),
  ]);
  for (const q of [
    "Summarise Bob Jones's and Alice's results",
    "Summarise AL-101 and Bob Jones's results",
    "Summarise Alice's and BJ-202's results",
  ]) {
    const a = clinicalAnswer(q, b.clinical, "AL-101");
    assert.deepEqual(
      new Set(a.used.map((o) => subjectOf(o.report))),
      new Set(["AL-101", "BJ-202"]),
      q,
    );
  }
  for (const who of [
    "aunt",
    "uncle",
    "cousin",
    "niece",
    "nephew",
    "partner",
    "chachi",
    "bua",
  ]) {
    const q = `What is my ${who}'s TSH?`,
      a = clinicalAnswer(q, b.clinical, "AL-101");
    assert.equal(a.verdict, "AMBIGUOUS_PATIENT", q);
    assert.deepEqual(a.used, []);
  }
  for (const q of [
    "What should I ask the doctor about my uncle's report?",
    "mere chacha ki report doctor se kya poochun?",
    "मेरी मौसी की रिपोर्ट डॉक्टर से क्या पूछूं?",
  ]) {
    const a = clinicalAnswer(q, [b.clinical[0]]);
    assert.equal(a.intent, "ASK_DOCTOR", q);
    assert.doesNotMatch(a.spoken, /for me|मेरे लिए|mere liye/, q);
  }
});

test("shared identity decision does not choose the sole matching test or a count-majority person", async () => {
  const { patientDecision } = await import("../clinical/answer.mjs");
  const b = await loadSet([
    report("Patient: Same Person, ID SP-101", "7.8"),
    report("Patient: Same Person, ID SP-202", "1.2"),
  ]);
  for (const q of [
    "Was her sugar checked?",
    "When was she discharged?",
    "What's her patient ID?",
    "What should I ask her doctor?",
    "Summarise her records for me",
  ]) {
    assert.equal(patientDecision(q, b.clinical, "SP-999").clarify, true, q);
    assert.equal(patientDecision(q, b.clinical, "SP-202").patient, "SP-202", q);
  }
  assert.equal(
    patientDecision("What is SP-202's TSH?", b.clinical, "SP-101").patient,
    "SP-202",
  );
});

test("calendar validation holds through synthetic, plain, table and stacked date layouts", async () => {
  for (const layout of [
    "Patient: Layout Person, ID LP-101\nCollected: 30 Feb 2026\nReported: 31 Apr 2026",
    "Patient ID: LP-101\nCollected: 30/02/2026\nReported: 31/04/2026",
    "| Patient ID | Collected | Reported |\n| --- | --- | --- |\n| LP-101 | 30 Feb 2026 | 31 Apr 2026 |",
    "PATIENT NAME PATIENT ID\nLayout Person LP-101\nSAMPLE COLLECTED REPORT ISSUED\n30 Feb 2026 09:00 31 Apr 2026 10:00",
  ]) {
    const r = await ingestFile(
      Buffer.from(
        layout +
          "\nTest Name    Results    Units    Bio. Ref. Interval\nTSH    1.2    mIU/L    0.4 - 4.0\n",
      ),
      "invalid-layout.txt",
    );
    assert.ok(r.ok);
    const m = extractReport(r.doc).meta;
    assert.equal(m.collected, null, layout);
    assert.equal(m.reported, null, layout);
  }
});
