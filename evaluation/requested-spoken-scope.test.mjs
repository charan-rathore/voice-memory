import test from "node:test";
import assert from "node:assert/strict";
import {
  importBundle,
  answer,
  answerFromRetrieval,
  constrainRequestedEvidence,
} from "../dist/engine.mjs";
import { extractiveSpoken } from "../src/spoken-extract.mjs";
const a =
  "Parcel PINE-62; Tracking number: 555021; Recipient: Mira Chen; Units: 12.";
const b =
  "Parcel PINE-63; Tracking number: 555022; Recipient: Noor Vale; Units: 24.";
for (const reverse of [false, true])
  test(
    "actual returned spoken text stays local under record reversal " + reverse,
    () => {
      const bundle = importBundle([
        { title: "dispatch", text: (reverse ? [b, a] : [a, b]).join("\n") },
      ]);
      for (const [q, yes, no] of [
        ["What is the tracking number for PINE-62?", "555021", "555022"],
        ["Who is the recipient for PINE-63?", "Noor Vale", "Mira Chen"],
        ["How many units for PINE-62?", "12", "24"],
      ]) {
        const r = answer(q, bundle);
        const speech = extractiveSpoken(q, r, bundle);
        assert.equal(r.supported, true);
        assert.ok(speech, q);
        assert.ok(speech.spoken.includes(yes), JSON.stringify(speech));
        assert.ok(!speech.spoken.includes(no), JSON.stringify(speech));
        assert.ok(
          r.evidence.every((e) => !e.quote.includes(no)),
          JSON.stringify(r.evidence),
        );
        for (const e of [...r.evidence, ...speech.citations]) {
          const source = bundle.sources.find((s) => s.id === e.sourceId);
          assert.equal(source.text.slice(e.start, e.end), e.quote);
          assert.equal(e.hash, source.hash);
        }
      }
    },
  );
test("recipient absence is spoken as the actual absent field, not an ID-only utterance", () => {
  const bundle = importBundle([
    {
      title: "dispatch",
      text: "Order ORCHID-34; Recipient: not specified; Tracking number: not recorded; Account manager Noor Vale.",
    },
  ]);
  const q = "Who received order ORCHID-34?";
  const r = answer(q, bundle);
  const speech = extractiveSpoken(q, r, bundle);
  assert.equal(r.supported, true);
  assert.ok(speech);
  assert.match(speech.spoken, /Recipient: not specified/i);
  assert.doesNotMatch(speech.spoken, /Noor Vale/);
});
test("missing fields never create order-ID-only spoken replies", () => {
  const bundle = importBundle([
    {
      title: "dispatch",
      text: "Order ORCHID-33; Account manager Noor Vale; Internal reference 771204; ready for pickup.",
    },
  ]);
  for (const q of [
    "Who received order ORCHID-33?",
    "What is the tracking number for ORCHID-33?",
  ]) {
    const r = answer(q, bundle);
    assert.equal(r.supported, false);
    assert.equal(extractiveSpoken(q, r, bundle), null);
  }
});
for (const [name, text] of [
  ["blank-line", b + "\n\n" + a],
  ["markdown-rule", b + "\n\n---\n\n" + a],
  [
    "record-heading",
    "## Record PINE-63\nTracking number: 555022; Recipient: Noor Vale; Units: 24.\n\n## Record PINE-62\nTracking number: 555021; Recipient: Mira Chen; Units: 12.",
  ],
])
  test("exact field spans under " + name, () => {
    const bundle = importBundle([{ title: "dispatch", text }]);
    const q = "What is the tracking number for PINE-62?";
    const r = answer(q, bundle);
    const speech = extractiveSpoken(q, r, bundle);
    assert.equal(r.supported, true);
    assert.ok(speech);
    assert.match(speech.spoken, /555021/);
    assert.doesNotMatch(speech.spoken, /555022/);
    assert.deepEqual(
      r.evidence.map((e) => e.quote),
      ["Tracking number: 555021"],
    );
    for (const e of r.evidence)
      assert.equal(
        bundle.sources
          .find((s) => s.id === e.sourceId)
          .text.slice(e.start, e.end),
        e.quote,
      );
  });
test("repeated target blocks stay disjoint rather than enclosing foreign record", () => {
  const bundle = importBundle([
    { title: "dispatch", text: a + "\n" + b + "\n" + a },
  ]);
  const q = "What is the tracking number for PINE-62?";
  const r = answer(q, bundle);
  assert.equal(r.supported, true);
  assert.equal(r.evidence.length, 2);
  assert.deepEqual(
    r.evidence.map((e) => e.quote),
    ["Tracking number: 555021", "Tracking number: 555021"],
  );
  assert.ok(r.evidence[0].end < r.evidence[1].start);
  assert.doesNotMatch(r.answer, /555022/);
});
test("a positive receiver cannot answer who did not receive the record", () => {
  const bundle = importBundle([
    {
      title: "dispatch",
      text: "Order ORCHID-33; Recipient: Isha Sen; Document recorded for review.",
    },
  ]);
  for (const q of [
    "Who did not receive order ORCHID-33?",
    "Who didn't receive order ORCHID-33?",
    "Who never received order ORCHID-33?",
  ]) {
    const r = answer(q, bundle);
    assert.equal(r.supported, false, q);
    assert.equal(extractiveSpoken(q, r, bundle), null);
    assert.ok(r.reviewEvidence.length);
  }
});
test("mixed count relations in one clause refuse rather than speak both counts", () => {
  const bundle = importBundle([
    {
      title: "dispatch",
      text: "Parcel PINE-62; 14 closed safety items and 3 open safety items.",
    },
  ]);
  const q = "How many open safety items for PINE-62?";
  const r = answer(q, bundle);
  assert.equal(r.supported, false);
  assert.equal(extractiveSpoken(q, r, bundle), null);
});
test("carrier reference and tracking number remain distinct labelled fields", () => {
  const bundle = importBundle([
    {
      title: "dispatch",
      text: "Parcel PINE-62; Carrier reference: XX-12; Tracking number: YY-13.",
    },
  ]);
  for (const [q, yes, no] of [
    ["What is the carrier reference for PINE-62?", "XX-12", "YY-13"],
    ["What is the tracking number for PINE-62?", "YY-13", "XX-12"],
  ]) {
    const r = answer(q, bundle);
    const speech = extractiveSpoken(q, r, bundle);
    assert.equal(r.supported, true);
    assert.ok(speech);
    assert.ok(speech.spoken.includes(yes));
    assert.ok(!speech.spoken.includes(no));
    assert.ok(!r.answer.includes(no));
  }
});
test("an internal tracking subtype does not establish an explicitly different carrier field", () => {
  for (const [text, q] of [
    [
      "Parcel PINE-62; Tracking number: YY-13.",
      "What is the carrier reference for PINE-62?",
    ],
    [
      "Parcel PINE-62; Carrier reference: XX-12.",
      "What is the tracking number for PINE-62?",
    ],
  ]) {
    const b = importBundle([
      { title: "dispatch", text: text + " Document recorded for review." },
    ]);
    const r = answer(q, b);
    assert.equal(r.supported, false);
    assert.equal(extractiveSpoken(q, r, b), null);
  }
});
test("literal separators keep distinct identity; normalized aliases refuse collisions across the entire bundle", () => {
  for (const split of [false, true]) {
    const one =
      "Parcel PINE-62; Tracking number: 555021; Recipient: Mira Chen.";
    const two =
      "Parcel PINE_62; Tracking number: 555022; Recipient: Noor Vale.";
    const b = importBundle(
      split
        ? [
            { title: "one", text: one },
            { title: "two", text: two },
          ]
        : [{ title: "dispatch", text: two + "\n" + one }],
    );
    for (const [q, yes, no] of [
      ["What is the tracking number for PINE-62?", "555021", "555022"],
      ["What is the tracking number for PINE_62?", "555022", "555021"],
    ]) {
      const r = answer(q, b);
      // Separate-file retrieval can already be ambiguous. Never promote that
      // upstream refusal; literal preference applies to a supported scope.
      if (split && r.refused) {
        assert.equal(extractiveSpoken(q, r, b), null);
        continue;
      }
      assert.equal(r.supported, true);
      assert.ok(r.evidence.every((e) => !e.quote.includes(no)));
      const t = extractiveSpoken(q, r, b);
      assert.ok(t);
      assert.ok(t.spoken.includes(yes));
      assert.ok(!t.spoken.includes(no));
    }
    const q = "What is the tracking number for Pine 62?";
    const r = answer(q, b);
    assert.equal(r.supported, false);
    assert.equal(extractiveSpoken(q, r, b), null);
  }
});

test("normalized alias refuses when another printed root is outside retrieved evidence", () => {
  const text = "Parcel PINE-62; Tracking number: 555021; Recipient: Mira Chen.";
  const b = importBundle([
    { title: "one", text },
    {
      title: "two",
      text: "Parcel PINE_62; Tracking number: 555022; Recipient: Noor Vale.",
    },
  ]);
  const source = b.sources[0];
  const q = "What is the tracking number for Pine 62?";
  const raw = answerFromRetrieval(
    q,
    b,
    {
      actualMode: "keyword",
      corpusId: b.scope,
      corpusScope: "corpus",
      evidence: "positive",
      chunks: [
        {
          chunkId: "single",
          documentId: source.id,
          text: source.text,
          title: source.title,
          corpusId: b.scope,
          rank: 1,
          score: 1,
        },
      ],
    },
    { actualMode: "keyword", embeddingModel: null },
  );
  assert.equal(raw.supported, true);
  const r = constrainRequestedEvidence(q, b, raw);
  assert.equal(r.supported, false);
  assert.equal(extractiveSpoken(q, r, b), null);
});
