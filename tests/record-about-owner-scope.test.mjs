// Regression: recordAbout answers must not cite another patient's record
// when the caller bound a patient scope (ChatGPT pre-push review P1).
import test from "node:test";
import assert from "node:assert/strict";
import { parseBuffer } from "../ingest/parse.mjs";
import { importBundle } from "../dist/engine.mjs";
import { attachRecords } from "../src/record-facts.mjs";
import { briefAnswer } from "../src/record-brief.mjs";
process.env.VM_DENSE = "off";

const mk = async (id, name, extra) =>
  (
    await parseBuffer(
      Buffer.from(
        `DISCHARGE SUMMARY\nPatient name: ${name}\nPatient ID: ${id}\nDate of birth: 12 January 1980\nStatus: signed final\n${extra}`,
      ),
      id + ".txt",
    )
  ).doc;

const docs = [
  await mk("AL-101", "Alice Smith", "Medications: AlphaOnlyDrug 10 mg daily."),
  await mk("AL-101", "Alice Smith", "Follow-up: review in 7 days."),
  await mk("BJ-202", "Bob Jones", "Draft note: serum iron 4.2 low, recheck."),
];
const b = importBundle(
  docs.map((d, i) => ({ title: "discharge" + i, text: d.text })),
);
attachRecords(
  b,
  docs.map((doc) => ({ doc })),
);
const cite = (src, span) => ({
  quote: src.text.slice(span.start, span.end),
  start: span.start,
  end: span.end,
});
const patientIds = b.records
  .flatMap((e) => e.records.map((r) => r.patient))
  .filter(Boolean);
const alice = patientIds.find((p) => /AL-101/.test(p));

test("recordAbout with bound patient never cites the other patient's record", () => {
  const r = briefAnswer(
    "what did the discharge summary say about iron?",
    b,
    cite,
    { patient: alice },
  );
  if (r) {
    assert.ok(
      !/4\.2|serum iron/i.test(r.spoken),
      "must not quote Bob's iron fact: " + r.spoken,
    );
    assert.ok(
      r.citations.every((c) => !/4\.2|serum iron/i.test(c.quote)),
      "no cross-patient citation",
    );
  }
});
test("recordAbout still answers within the bound patient's own records", () => {
  const r = briefAnswer(
    "what did the discharge summary say about medications?",
    b,
    cite,
    { patient: alice },
  );
  assert.ok(r, "expected an answer from Alice's records");
  assert.match(r.spoken, /AlphaOnlyDrug/);
  assert.ok(!/BetaOnlyDrug/.test(r.spoken));
});
