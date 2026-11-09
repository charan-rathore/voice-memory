// Post-exposure shared-route cases. These assert source-owned outcomes,
// not old count/only-matching-test defaults or inferred family mappings.
import test from "node:test";
import assert from "node:assert/strict";
import { createLocalServer } from "../src/server.mjs";
import {
  patientDecision,
  clinicalAnswer,
  identityReportsFor,
} from "../clinical/answer.mjs";
import { ingestFile } from "../ingest/index.mjs";
import { extractReport, subjectOf } from "../clinical/observations.mjs";
import { visualFor } from "../src/visual-summary.mjs";

const lab = async (id, name) => {
  const r = await ingestFile(
    Buffer.from(
      `Patient: ${name}, ID ${id}\nCollected: 10 October 2026\nTest Name    Results    Units    Reference range\nTSH    7.8    mIU/L    0.4 - 4.0\n`,
    ),
    "synthetic.txt",
  );
  return { sourceId: id, title: id, ...extractReport(r.doc) };
};
test("distinct names, siblings, date-like first names and caller scaffolding do not manufacture identity", async () => {
  const a = await lab("AL-101", "Alice Smith"),
    b = await lab("BJ-202", "Bob Jones");
  assert.equal(patientDecision("Was her sugar checked?", [a, b]).clarify, true);
  for (const who of ["sister", "brother", "sibling", "sister-in-law"])
    assert.equal(
      patientDecision(`What is my ${who}'s TSH?`, [a, b], "AL-101").clarify,
      true,
    );
  const may = await lab("MR-101", "May Rao"),
    jane = await lab("JL-202", "Jane Lee");
  assert.notEqual(
    patientDecision("What tests were done in May?", [may, jane]).patient,
    "MR-101",
  );
  const ta = await lab("TA-101", "Test Person A"),
    tc = await lab("TC-202", "Test Person C");
  assert.equal(
    patientDecision("sugar wala test kitna aaya", [ta, tc], "TA-101").patient,
    "TA-101",
  );
  assert.equal(
    patientDecision(
      "What are Alice Smith and Bob Jones's TSH results?",
      [a, b],
      "AL-101",
    ).multiple,
    true,
  );
  assert.equal(
    patientDecision(
      "What are AL-101 and BJ-202's TSH results?",
      [a, b],
      "AL-101",
    ).multiple,
    true,
  );
  const d = clinicalAnswer("I want to ask my doctor about her report.", [a]);
  assert.match(d.spoken, /for them\?/);
  assert.doesNotMatch(d.spoken, /for me\?/);
});

test("document-only patient records validate selection and isolate final facts", async () => {
  process.env.VM_COUNTERS_ALLOW_FILE = "on";
  const s = createLocalServer({ port: 0 });
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${s.address().port}/api/public`;
  try {
    const ws = await (
      await fetch(base + "/workspace", { method: "POST" })
    ).json();
    for (const [id, name, date] of [
      ["AL-101", "Alice Smith", "24 Oct 2026"],
      ["BJ-202", "Bob Jones", "30 Oct 2026"],
    ]) {
      const text = `# Discharge summary\n\nPatient: ${name}, ID ${id}\n\n| Field | Value |\n| --- | --- |\n| Patient ID | ${id} |\n| Discharged | ${date} |\n| Signatory | Dr. Synthetic |\n`;
      await fetch(`${base}/workspace/${ws.id}/upload`, {
        method: "POST",
        headers: { "x-file-name": id + ".md", "content-type": "text/markdown" },
        body: text,
      });
    }
    for (let i = 0; i < 300; i++) {
      const st = await (await fetch(`${base}/workspace/${ws.id}`)).json();
      if (
        st.documents.length === 2 &&
        st.documents.every((x) => x.status === "ready")
      )
        break;
      await new Promise((r) => setTimeout(r, 100));
    }
    const ask = async (patient) =>
      await (
        await fetch(base + "/ask", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            case: ws.id,
            question: "When was she discharged?",
            patient,
          }),
        })
      ).json();
    const multi = await (
      await fetch(base + "/ask", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          case: ws.id,
          question: "When were AL-101 and BJ-202 discharged?",
          patient: "AL-101",
        }),
      })
    ).json();
    assert.match(multi.final.text, /24 Oct/);
    assert.match(multi.final.text, /30 Oct/);
    assert.ok(
      multi.final.citations.some((c) => c.record?.patientId === "AL-101"),
    );
    assert.ok(
      multi.final.citations.some((c) => c.record?.patientId === "BJ-202"),
    );
    const unselected = await ask(null);
    assert.equal(unselected.final.verdict, "AMBIGUOUS_PATIENT");
    assert.deepEqual(unselected.final.citations, []);
    for (const patient of ["BJ-202", "AL-101", "BJ-202"]) {
      const a = await ask(patient);
      assert.match(a.final.text, patient === "AL-101" ? /24 Oct/ : /30 Oct/);
      assert.doesNotMatch(
        a.final.text,
        patient === "AL-101" ? /30 Oct/ : /24 Oct/,
      );
    }
  } finally {
    await new Promise((r) => s.close(r));
  }
});

test("public API preserves both requested people against stale selection and scoped group counts", async () => {
  process.env.VM_COUNTERS_ALLOW_FILE = "on";
  const s = createLocalServer({ port: 0 });
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${s.address().port}/api/public`;
  try {
    const ws = await (
      await fetch(base + "/workspace", { method: "POST" })
    ).json();
    for (const [id, name, date, tsh, hba] of [
      ["AL-101", "Alice Smith", "10 October 2026", "7.8", "5.1"],
      ["BJ-202", "Bob Jones", "10 September 2026", "1.5", "5.8"],
      ["BJ-202", "Bob Jones", "10 October 2026", "2.5", "6.4"],
    ]) {
      const text = `Patient: ${name}, ID ${id}\nCollected: ${date}\nTest Name    Results    Units    Reference range\nTSH    ${tsh}    mIU/L    0.4 - 4.0\nHbA1c    ${hba}    %    4.0 - 5.6\n`;
      const up = await fetch(`${base}/workspace/${ws.id}/upload`, {
        method: "POST",
        headers: {
          "x-file-name": `${id}-${date}.txt`,
          "content-type": "text/plain",
        },
        body: text,
      });
      assert.equal(up.status, 202);
    }
    let ready = false;
    for (let i = 0; i < 300; i++) {
      const st = await (await fetch(`${base}/workspace/${ws.id}`)).json();
      if (
        st.documents.length === 3 &&
        st.documents.every((x) => x.status === "ready")
      ) {
        ready = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(ready);
    const ask = async (question, patient) =>
      await (
        await fetch(base + "/ask", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ case: ws.id, question, patient }),
        })
      ).json();
    for (const question of [
      "What are AL-101 and BJ-202's TSH results?",
      "What are Alice Smith and Bob Jones's TSH results?",
    ]) {
      const a = await ask(question, "AL-101");
      assert.notEqual(a.final.verdict, "AMBIGUOUS_PATIENT", question);
      assert.match(a.final.text, /7\.8/);
      assert.match(a.final.text, /2\.5/);
      assert.match(a.final.text, /Alice Smith/);
      assert.match(a.final.text, /Bob Jones/);
      assert.ok(
        a.final.citations.some((c) => c.record?.patientId === "AL-101"),
      );
      assert.ok(
        a.final.citations.some((c) => c.record?.patientId === "BJ-202"),
      );
    }
    const g = await ask("What are the sugar results?", "AL-101");
    assert.match(g.final.text, /5\.1/);
    assert.doesNotMatch(g.final.text, /5\.8|6\.4|since|went from/);
    const neutral = await ask("HbA1c kitna hai?", null);
    assert.equal(neutral.final.verdict, "AMBIGUOUS_PATIENT");
  } finally {
    await new Promise((r) => s.close(r));
  }
});

test("name-only document records participate in shared identity without merging names", () => {
  const a = {
    id: "a",
    text: "Patient: Alice Smith\nDischarged: 24 October 2026",
  };
  const b = {
    id: "b",
    text: "Patient: Bob Jones\nDischarged: 30 October 2026",
  };
  const identities = identityReportsFor({
    records: [a, b].map((source) => ({
      source,
      records: [{ start: 0, end: source.text.length }],
    })),
  });
  assert.equal(identities.length, 2);
  assert.equal(
    patientDecision("When was she discharged?", identities).clarify,
    true,
  );
  assert.notEqual(subjectOf(identities[0]), subjectOf(identities[1]));
});

test("selected visual fallback cannot display a different person without lead.used", async () => {
  const a = await lab("AL-101", "Alice Smith"),
    b = await lab("BJ-202", "Bob Jones");
  for (const verdict of ["OVERVIEW", "FLAGGED", "SUMMARY"]) {
    const v = visualFor(
      "overview",
      { clinical: [a, b] },
      { verdict, used: [] },
      "AL-101",
    );
    assert.deepEqual(
      v.subjects.map((s) => s.id),
      ["AL-101"],
    );
  }
});

test("a known name never erases an unresolved coordinated requested owner", async () => {
  const a = await lab("AL-101", "Alice Smith");
  for (const q of [
    "When were Alice and Carol discharged?",
    "when were alice and carol discharged?",
    "What are Alice and Carol's results?",
    "When were Carol and Alice discharged?",
    "what are carol and alice's results?",
  ]) {
    const d = patientDecision(q, [a], "AL-101");
    assert.equal(d.clarify, true, q);
    assert.equal(d.patient, null);
    assert.match(d.spoken, /could not bind/i);
  }
});
