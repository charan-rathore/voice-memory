import test from "node:test";
import assert from "node:assert/strict";
import { importBundle, validateEvidence } from "../dist/engine.mjs";
import { semanticRescue } from "../src/semantic/route.mjs";
import { sourceOutline } from "../src/source-outline.mjs";
import { briefAnswer } from "../src/record-brief.mjs";
test("unfamiliar engineering summary offers exact source headings, never contract-shaped probes or a completed summary", async () => {
  const bundle = importBundle([
    {
      title: "Synthetic engineering incident",
      text: "# Incident record\nDatabase requests timed out.\n## Detection\nAlert fired at 03:14.\n## Remaining uncertainty\nCause remains under investigation.",
    },
  ]);
  let reruns = 0;
  const r = await semanticRescue({
    question: "Summarize these documents",
    bundle,
    lead: null,
    raw: {},
    consent: false,
    gemini: { enabled: () => false },
    validate: (ev) => validateEvidence(ev, bundle),
    rerun: async () => {
      reruns++;
      return {
        text: "Unrelated fee is 5000",
        verdict: "QUOTED",
        citations: [],
      };
    },
  });
  assert.equal(reruns, 0);
  assert.equal(r.lead.verdict, "SOURCE_OUTLINE");
  assert.match(r.lead.text, /not established a complete summary/);
  assert.match(r.lead.text, /Detection/);
  assert.match(r.lead.text, /Remaining uncertainty/);
  assert.doesNotMatch(r.lead.text, /fee|deadline|signed contract/);
  assert.ok(r.lead.citations.every((ev) => validateEvidence(ev, bundle)));
});
test("headings are explicit source spans, repeated headings remain source positioned and no prose is guessed as a heading", () => {
  const bundle = importBundle([
    {
      title: "Synthetic policy",
      text: "POLICY IN FORCE\nNot a heading.\n# Exceptions\nFirst clause.\n# Exceptions\nSecond clause.",
    },
  ]);
  const o = sourceOutline(bundle, (ev) => validateEvidence(ev, bundle));
  assert.equal(o.citations.length, 2);
  assert.notEqual(o.citations[0].start, o.citations[1].start);
  assert.doesNotMatch(o.text, /POLICY IN FORCE/);
  assert.equal(
    sourceOutline(
      importBundle([
        {
          title: "No headings",
          text: "A plain prose source with no explicit source headings.",
        },
      ]),
      () => true,
    ),
    null,
  );
});
test("record briefs cannot let a frequent patient identity choose facts from multiple identities", () => {
  const source = {
    id: "source",
    title: "Synthetic packet",
    text: "| Medication | Iron |\n".repeat(5),
  };
  const record = (patient) => ({
    patient,
    start: 0,
    end: 21,
    title: "Record",
    pages: [1],
    authority: "authoritative",
    facts: [{ label: "Medication", value: "Iron", start: 0, end: 21 }],
  });
  const bundle = {
    sources: [source],
    records: [
      {
        source,
        records: [
          record("A-100"),
          record("A-100"),
          record("A-100"),
          record("B-200"),
        ],
      },
    ],
  };
  assert.equal(
    briefAnswer("What medicines are recorded?", bundle, (s, p) => ({
      sourceId: s.id,
      ...p,
      quote: s.text.slice(p.start, p.end),
    })),
    null,
  );
  assert.equal(
    briefAnswer("Summarize everything", bundle, () => ({})),
    null,
  );
  assert.equal(
    briefAnswer("What medicines are recorded?", bundle, () => ({}), {
      patient: "missing",
    }),
    null,
  );
});

test("shared source-bound identity map overrides stale raw patient fields without mutating records", () => {
  const source = {
    id: "source",
    title: "Synthetic",
    text: "Patient: A Person, ID A-100\n",
  };
  const records = [0, 1, 2].map(() => ({
    patient: "A-100",
    start: 0,
    end: source.text.length,
    title: "Record",
    facts: [
      { label: "Medication", value: "Iron", start: 0, end: source.text.length },
    ],
  }));
  const entry = {
    source,
    records,
    recordSubjects: new Map([
      [records[0], "A-100"],
      [records[1], "A-100"],
      [records[2], "B-200"],
    ]),
  };
  assert.equal(
    briefAnswer(
      "What medicines are recorded?",
      { sources: [source], records: [entry] },
      () => ({}),
    ),
    null,
  );
  assert.equal(
    records[2].patient,
    "A-100",
    "resolver must not mutate cached raw metadata",
  );
});
