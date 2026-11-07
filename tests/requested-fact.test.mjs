import { test } from "node:test";
import assert from "node:assert/strict";
import {
  capture,
  corpus,
  questions,
} from "../evaluation/requested-fact/reproduce.mjs";

const needed = [
  "The client asks to retain the original 15 November deadline for the pilot.",
  "Weekly reporting is confirmed",
  "Finance approval for any revised fee or payment schedule remains pending",
];
test("public upload + HTTP ask + default HTTP SSE carry requested support, not only topical passages", async () => {
  const rows = await capture(await corpus());
  rows.forEach((row, i) => {
    for (const text of [
      row.typed.lead?.text,
      row.typed.answer,
      row.spokenTurn?.spoken,
    ])
      assert.ok(text?.includes(needed[i]), `${row.question}: ${text}`);
    for (const citations of [
      row.typed.lead?.citations,
      row.typed.evidence,
      row.spokenTurn?.citations,
    ])
      assert.ok(citations?.some((c) => c.quote.includes(needed[i])));
    assert.equal(row.result.actualMode, "keyword");
    if (i === 1)
      assert.match(
        row.result.evidence[0].quote,
        /^Weekly reporting is confirmed/,
      );
  });
});

import {
  answer,
  draft,
  importBundle,
  answerFromRetrieval,
  constrainRequestedEvidence,
  retrieveFromRows,
} from "../dist/engine.mjs";
const bundleOf = (text) =>
  importBundle([
    { title: "Cedar.md", text: "# Cedar project records\n\n" + text },
  ]);
const facts = [
  {
    q: questions[0],
    missing:
      "The internal deadline is 3 March 2031. The client has not requested a deadline.",
    changed:
      "The client asks to keep the original 9 April 2032 deadline for the trial.",
    want: /9 April 2032/,
  },
  {
    q: questions[1],
    missing:
      "Weekly billing is confirmed. Progress reporting was discussed without a cadence.",
    changed:
      "Monthly progress reporting is confirmed; finance approval is pending.",
    want: /Monthly progress reporting is confirmed/,
  },
  {
    q: questions[2],
    missing:
      "The proposed fee is $700. The commercial proposal requires a countersignature. The supplier finance team approved its own budget.",
    changed: "Client finance has signed off on the revised commercial terms.",
    want: /Client finance has signed off/,
  },
];
for (const f of facts) {
  test(`missing-support control: ${f.q}`, () => {
    const a = answer(f.q, bundleOf(f.missing));
    assert.equal(a.refused, true);
    assert.equal(a.evidence.length, 0);
  });
  test(`changed support is quoted, not a memorized answer: ${f.q}`, () => {
    const b = bundleOf(f.changed),
      a = answer(f.q, b);
    assert.equal(a.refused, false);
    assert.match(a.answer, f.want);
    assert.doesNotMatch(
      a.answer,
      /15 November|22 November|Weekly|48,000|42,000/,
    );
    for (const e of a.evidence)
      assert.equal(b.sources[0].text.slice(e.start, e.end), e.quote);
  });
}
test("a proposed reporting cadence is never promoted to confirmed; changed and conflicting support is retained", () => {
  const a = answer(
    questions[1],
    bundleOf("Weekly progress reporting is proposed, not agreed."),
  );
  assert.equal(a.supported, true);
  assert.match(a.spoken, /proposed, not agreed/);
  const b = answer(
    questions[1],
    bundleOf(
      "Monthly progress reporting is confirmed. Weekly reporting is confirmed.",
    ),
  );
  assert.equal(b.reviewEvidence.length, 2);
  assert.equal(b.supported, false);
  assert.equal(b.unresolved, true);
  assert.match(b.spoken, /Monthly/);
  assert.match(b.spoken, /Weekly/);
});
test("conditional, draft, wrong-role and wrong-owner finance support cannot become client signoff", () => {
  for (const text of [
    "Client finance would approve the terms if the audit passed.",
    "Client finance approval is proposed, not recorded.",
    "The client approved delivery. Supplier finance has signed off on its own terms.",
    "Client finance approval remains pending for the renewal. The expansion fee is $900.",
  ]) {
    const q = text.includes("renewal")
      ? "Has the expansion money side been signed off by the client's accountants?"
      : questions[2];
    assert.equal(answer(q, bundleOf(text)).refused, true, text);
  }
});
test("unbound requested modifiers do not disappear; unrelated ordinary positives stay on their routes", () => {
  const b = bundleOf(
    "Weekly reporting is confirmed. The client asks to keep the original 9 April 2032 deadline. The Copper parking permit number is PP-204. Shipment SH-123: tracking number: ZZ-204.",
  );
  for (const q of [
    "How often is security progress reported?",
    "What deadline does the Violet client want to keep?",
  ])
    assert.equal(answer(q, b).refused, true);
  const permit = answer("What is the Copper parking permit number?", b);
  assert.equal(permit.requestedFact, false);
  assert.match(permit.answer, /PP-204/);
  const identifier = answer("What is the Violet parking permit number?", b);
  assert.equal(identifier.refused, true);
});
test("support overflow and scan overflow refuse instead of silently losing contrary records", () => {
  const a = answer(
    questions[1],
    bundleOf(
      "Daily reporting is confirmed. Weekly reporting is confirmed. Monthly reporting is confirmed. Quarterly reporting is confirmed.",
    ),
  );
  assert.equal(a.refused, true);
  const b = importBundle(
    Array.from({ length: 3 }, (_, i) => ({
      title: `large${i}.md`,
      text:
        "Unrelated statement. ".repeat(10000) +
        "Weekly reporting is confirmed.",
    })),
  );
  assert.equal(answer(questions[1], b).refused, true);
});
test("external retrieval policy never promotes an insufficient pack from a source scan", () => {
  const b = bundleOf("Weekly reporting is confirmed; the client asked for it."),
    q = questions[1];
  const found = retrieveFromRows({
    query: q,
    queryVector: null,
    mode: "keyword",
    topK: 3,
    embeddingModel: null,
    rows: b.rows,
    storage: {
      backend: "ephemeral",
      durable: false,
      denseAvailable: false,
      warning: null,
    },
    corpusScope: { kind: "corpus", corpusId: b.scope },
  });
  const r = answerFromRetrieval(
    q,
    b,
    { ...found, evidence: "insufficient" },
    { actualMode: "keyword", embeddingModel: null },
  );
  assert.equal(constrainRequestedEvidence(q, b, r).refused, true);
});
test("public and default SSE controls preserve absence, proposal qualifiers, changed values and conflicting support", async () => {
  const docs = [
    {
      title: "Cedar.md",
      text: "# Cedar project records\n\nThe client asks to keep the original 9 April 2032 deadline for the trial. Monthly progress reporting is proposed, not confirmed. Client finance has signed off on the revised commercial terms.",
    },
  ];
  const changed = await capture(docs);
  changed.forEach((row, i) => {
    for (const text of [
      row.typed.lead.text,
      row.typed.answer,
      row.spokenTurn.spoken,
    ])
      assert.match(
        text,
        i === 1
          ? /Monthly progress reporting is proposed, not confirmed/
          : facts[i].want,
      );
    assert.equal(row.typed.lead.verdict, "QUOTED");
  });
  const absent = await capture([
    {
      title: "Cedar.md",
      text: "# Cedar project records\n\nThere is an internal deadline of 3 March 2031. Weekly billing is confirmed. The proposed commercial fee is $700 and no agreement is signed.",
    },
  ]);
  for (const row of absent) {
    assert.equal(row.typed.lead?.verdict, "UNKNOWN");
    assert.equal(row.spokenTurn.verdict, "UNKNOWN");
    assert.equal(row.spokenTurn.citations.length, 0);
    assert.equal(row.typed.evidence.length, 0);
  }
});

test("opaque identifiers remain whole qualifiers, never prefixes of other records", () => {
  const b = bundleOf(
    "Weekly progress reporting is confirmed for record SH-8-A.",
  );
  assert.equal(
    answer("How often is progress reported for record SH-8?", b).refused,
    true,
  );
  assert.equal(
    answer("How often is progress reported for record SH-8-A?", b).supported,
    true,
  );
});
test("an oversized contrary assertion refuses instead of disappearing from the evidence pack", () => {
  const b = bundleOf(
    "Weekly progress reporting is confirmed. Monthly progress reporting is confirmed " +
      "with additional qualifications ".repeat(30) +
      ".",
  );
  assert.equal(answer(questions[1], b).refused, true);
});

test("conflicting requested support cannot authorize a draft", () => {
  for (const text of [
    "Monthly progress reporting is confirmed. Weekly reporting is confirmed.",
    "Client finance has signed off on the terms. Client finance has not yet signed off on the terms.",
    "The client asks to retain the original 9 April 2032 deadline. The client asks to keep the original 10 April 2032 deadline.",
  ]) {
    const b = bundleOf(text),
      q = text.includes("reporting")
        ? questions[1]
        : text.includes("finance")
          ? questions[2]
          : questions[0];
    const a = answer(q, b);
    assert.equal(a.unresolved, true);
    assert.equal(a.evidenceStatus, "ambiguous");
    assert.throws(() => draft(a, b));
  }
});

test("HTTP and default SSE expose conflicting statements as ambiguous, never an approved current fact", async () => {
  const rows = await capture([
    {
      title: "Cedar.md",
      text: "# Cedar project records\n\nThe client asks to keep the original 9 April 2032 deadline. The client asks to retain the original 10 April 2032 deadline. Weekly reporting is confirmed. Monthly reporting is confirmed. Client finance has signed off on the terms. Client finance has not yet signed off on the terms.",
    },
  ]);
  for (const row of rows) {
    assert.equal(row.result.unresolved, true);
    assert.equal(row.result.supported, false);
    assert.equal(row.typed.lead.verdict, "AMBIGUOUS");
    assert.equal(row.spokenTurn.verdict, "AMBIGUOUS");
    assert.equal(row.typed.lead.citations.length, 2);
    assert.match(row.spokenTurn.spoken, /Conflicting source statements/);
  }
});
