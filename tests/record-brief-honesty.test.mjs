// Answer-honesty invariants for the records-brief layer: the spoken text
// must never assert something the source facts do not support. Synthetic
// source-bound bundles; every record carries real offsets into its source.
import { test } from "node:test";
import assert from "node:assert/strict";
import { briefAnswer } from "../src/record-brief.mjs";

const cite = (src, span) => ({ source: src.id, ...span });

function entry(id, lines, recBase) {
  const text = lines.join("\n");
  const facts = [];
  const rec = { ...recBase, start: 0, end: text.length, facts };
  for (const ln of lines) {
    const at = text.indexOf(ln);
    const sep = ln.indexOf(": ");
    facts.push({
      label: ln.slice(0, sep),
      value: ln.slice(sep + 2),
      start: at,
      end: at + ln.length,
      ...(recBase.lineLabels?.includes(ln.slice(0, sep)) ? { line: true } : {}),
      ...(recBase.concepts?.[ln.slice(0, sep)]
        ? { concept: recBase.concepts[ln.slice(0, sep)] }
        : {}),
    });
  }
  delete rec.lineLabels;
  delete rec.concepts;
  delete rec.patientId;
  const e = { source: { id, text }, records: [rec], recordSubjects: new Map() };
  e.recordSubjects.set(rec, recBase.patientId ?? "P-100");
  return e;
}

const bundleOf = (...entries) => ({
  records: entries,
  sources: entries.map((e) => e.source),
});

const clinicianBundle = (draftValue, signedValue) =>
  bundleOf(
    entry("s-draft", [`Signatory: ${draftValue}`], {
      index: 0,
      title: "Admission note",
      status: "draft",
      authority: "provisional",
      pages: [1],
      patientId: "P-100",
    }),
    entry("s-signed", [`Attending Physician: ${signedValue}`], {
      index: 1,
      title: "Discharge summary",
      status: "signed",
      authority: "authoritative",
      pages: [2],
      patientId: "P-100",
    }),
  );

test("two records naming two different clinicians are both named, with no uniqueness claim", () => {
  const out = briefAnswer(
    "which doctor treated her?",
    clinicianBundle("Dr. A. Sharma", "Dr. B. Verma"),
    cite,
    {},
  );
  assert.ok(out, "an answer is expected");
  assert.match(out.spoken, /Dr\. B\. Verma/);
  assert.match(out.spoken, /Dr\. A\. Sharma/);
  assert.doesNotMatch(out.spoken, /only clinician/);
  // "signing" is never asserted from an attending-physician label either.
  assert.doesNotMatch(out.spoken, /signing/);
  const sources = new Set(out.citations.map((c) => c.source));
  assert.ok(sources.has("s-signed") && sources.has("s-draft"));
});

test("two records naming the same printed name never assert uniqueness either", () => {
  const out = briefAnswer(
    "which doctor treated her?",
    clinicianBundle("Dr. B. Verma", "Dr. B. Verma"),
    cite,
    {},
  );
  assert.ok(out, "an answer is expected");
  assert.match(out.spoken, /Dr\. B\. Verma/);
  // The same printed name twice does not prove one person, so no uniqueness
  // or identity claim is made; both records are simply named.
  assert.doesNotMatch(out.spoken, /only clinician/);
  assert.doesNotMatch(out.spoken, /signing/);
});

test("a single clinician fact names it without any uniqueness claim", () => {
  const out = briefAnswer(
    "which doctor treated her?",
    bundleOf(
      entry("s-signed", ["Attending Physician: Dr. B. Verma"], {
        index: 0,
        title: "Discharge summary",
        status: "signed",
        authority: "authoritative",
        pages: [2],
        patientId: "P-100",
      }),
    ),
    cite,
    {},
  );
  assert.ok(out, "an answer is expected");
  assert.match(out.spoken, /Dr\. B\. Verma \(attending physician\)/);
  assert.doesNotMatch(out.spoken, /only clinician/);
  // An attending-physician label does not prove signing.
  assert.doesNotMatch(out.spoken, /signing/);
});

// Counterexamples from the independent reviewer's collision probe: lossy
// name normalization treated each pair as one clinician. The answer must
// name both printed clinicians without deciding their identity.
for (const [a, b] of [
  ["Dr. 李明", "Dr. 王伟"],
  ["Dr. José", "Dr. Jos"],
]) {
  test(`distinct printed names ${a} / ${b} are both named, no uniqueness claim`, () => {
    const out = briefAnswer(
      "which doctor treated her?",
      clinicianBundle(a, b),
      cite,
      {},
    );
    assert.ok(out, "an answer is expected");
    assert.ok(out.spoken.includes(a), a);
    assert.ok(out.spoken.includes(b), b);
    assert.doesNotMatch(out.spoken, /only clinician/);
    const sources = new Set(out.citations.map((c) => c.source));
    assert.ok(sources.has("s-signed") && sources.has("s-draft"));
  });
}

const billBundle = (estimatePharmacy) =>
  bundleOf(
    entry(
      "s-est",
      [
        "Estimated total: USD 5,000",
        "Imaging (IMG-100): USD 500",
        `Pharmacy (PHR-200): ${estimatePharmacy}`,
      ],
      {
        index: 0,
        title: "Estimate",
        status: "estimate",
        authority: "provisional",
        pages: [1],
        patientId: "P-100",
        lineLabels: ["Imaging (IMG-100)", "Pharmacy (PHR-200)"],
        concepts: { "Estimated total": "total charges" },
      },
    ),
    entry(
      "s-fin",
      [
        "Total charges: USD 4,600",
        "Imaging scan (IMG-100): USD 450",
        "Pharmacy items (PHR-200): USD 300",
      ],
      {
        index: 1,
        title: "Final bill",
        status: "final",
        authority: "authoritative",
        pages: [2],
        patientId: "P-100",
        lineLabels: ["Imaging scan (IMG-100)", "Pharmacy items (PHR-200)"],
        concepts: { "Total charges": "total charges" },
      },
    ),
  );

test("a non-numeric estimate line is never reported as a zero-amount difference", () => {
  const out = briefAnswer(
    "why did the bill change?",
    billBundle("covered by package"),
    cite,
    {},
  );
  assert.ok(out, "an answer is expected");
  // The real, numeric difference is still reported.
  assert.match(out.spoken, /500/);
  assert.match(out.spoken, /450/);
  // No fabricated amount may be attached to the unpriced line.
  assert.doesNotMatch(out.spoken, /PHR-200\)?\s*0\s*→/);
  assert.doesNotMatch(out.spoken, /Pharmacy \(PHR-200\) 0/);
});

test("numeric estimate lines still diff against the final bill", () => {
  const out = briefAnswer(
    "why did the bill change?",
    billBundle("USD 350"),
    cite,
    {},
  );
  assert.ok(out, "an answer is expected");
  assert.match(out.spoken, /350/);
  assert.match(out.spoken, /300/);
});

// Amounts are recorded in either segment order; the currency marker owns the
// amount segment. These cases pin every observed order plus the conservative
// ambiguous case.
const amountBundle = (
  estLine,
  finLine,
  totals = ["INR 18,000", "INR 16,000"],
) =>
  bundleOf(
    entry("s-est", [`Estimated total: ${totals[0]}`, estLine], {
      index: 0,
      title: "Estimate",
      status: "estimate",
      authority: "provisional",
      pages: [1],
      patientId: "P-100",
      lineLabels: [estLine.split(": ")[0]],
      concepts: { "Estimated total": "total charges" },
    }),
    entry("s-fin", [`Total charges: ${totals[1]}`, finLine], {
      index: 1,
      title: "Final bill",
      status: "final",
      authority: "authoritative",
      pages: [2],
      patientId: "P-100",
      lineLabels: [finLine.split(": ")[0]],
      concepts: { "Total charges": "total charges" },
    }),
  );

test("price-first annotated values price from the marked segment, not the annotation", () => {
  const out = briefAnswer(
    "why did the bill change?",
    amountBundle(
      "Room charges: INR 18,000.00",
      "Room charges: INR 16,000.00 · 4 nights",
    ),
    cite,
    {},
  );
  assert.ok(out, "an answer is expected");
  assert.match(out.spoken, /Room charges 18,000 → Room charges 16,000/);
  assert.doesNotMatch(out.spoken, /Room charges \d+,?\d* → Room charges 4\b/);
});

test("quantity-first values keep pricing from the last segment", () => {
  const out = briefAnswer(
    "why did the bill change?",
    amountBundle(
      "Ergonomic chair: 40 · USD 11,200.00",
      "Ergonomic chair: 40 · USD 10,800.00",
    ),
    cite,
    {},
  );
  assert.ok(out, "an answer is expected");
  assert.match(out.spoken, /11,200 → Ergonomic chair 10,800/);
  assert.doesNotMatch(out.spoken, /\b40 → /);
});

test("date-first values keep pricing from the last segment", () => {
  const out = briefAnswer(
    "why did the bill change?",
    amountBundle(
      "Consult fee: 22 Oct · USD 440.00",
      "Consult fee: 24 Oct · USD 460.00",
    ),
    cite,
    {},
  );
  assert.ok(out, "an answer is expected");
  assert.match(out.spoken, /440 → Consult fee 460/);
});

test("a lettered annotation no longer hides a real price change", () => {
  const out = briefAnswer(
    "why did the bill change?",
    amountBundle(
      "Laboratory: INR 4,500.00",
      "Laboratory: INR 5,100.00 · incl. repeat sample",
      ["INR 4,500", "INR 5,100"],
    ),
    cite,
    {},
  );
  assert.ok(out, "an answer is expected");
  assert.match(out.spoken, /Laboratory 4,500 → Laboratory 5,100/);
  assert.doesNotMatch(out.spoken, /Laboratory 4,500 → Laboratory 0/);
});

test("several different bare numbers with no currency marker are ambiguous and skipped", () => {
  const out = briefAnswer(
    "why did the bill change?",
    amountBundle("Misc items: 2 · 5", "Misc items: 2 · 6", ["USD 7", "USD 8"]),
    cite,
    {},
  );
  assert.ok(out, "an answer is expected");
  assert.doesNotMatch(out.spoken, /Misc items/);
});

test("the currency label only names a currency the records use", () => {
  const inr = briefAnswer(
    "why did the bill change?",
    amountBundle(
      "Room charges: INR 18,000.00",
      "Room charges: INR 16,000.00 · 4 nights",
    ),
    cite,
    {},
  );
  assert.match(inr.spoken, /differ \(INR\)/);
  assert.doesNotMatch(inr.spoken, /\(USD\)/);
  const mixed = briefAnswer(
    "why did the bill change?",
    amountBundle("Room charges: INR 18,000.00", "Room charges: USD 220.00"),
    cite,
    {},
  );
  assert.ok(mixed, "an answer is expected");
  assert.doesNotMatch(mixed.spoken, /differ \((USD|INR)\)/);
});

// Independent reviewer's v3 mechanism probe, run on the actual repo module
// (probe vm-v3-amount-review-probe; its clinical accessor stub is replaced
// here by the shared entry() helper over the real imports).
test("probe: unmarked annotation with two bare numbers is ambiguous and skipped", () => {
  const out = briefAnswer(
    "why did the bill change?",
    amountBundle(
      "Room charges: 16000 and 4 nights",
      "Room charges: 17000 and 5 nights",
    ),
    cite,
    {},
  );
  assert.ok(out, "an answer is expected");
  assert.doesNotMatch(out.spoken, /Room charges/);
});

test("probe: two marked amounts in one value have no safe pick and skip", () => {
  const out = briefAnswer(
    "why did the bill change?",
    amountBundle(
      "Room charges: USD 100 · EUR 90",
      "Room charges: USD 110 · EUR 80",
    ),
    cite,
    {},
  );
  assert.ok(out, "an answer is expected");
  assert.doesNotMatch(out.spoken, /Room charges/);
  assert.doesNotMatch(out.spoken, /differ \(/);
});

test("probe: one unmarked side reports the change but names no currency", () => {
  const out = briefAnswer(
    "why did the bill change?",
    amountBundle("Room charges: 18000", "Room charges: INR 16000"),
    cite,
    {},
  );
  assert.ok(out, "an answer is expected");
  assert.match(out.spoken, /Room charges 18,000 → Room charges 16,000/);
  assert.doesNotMatch(out.spoken, /differ \(/);
});

test("probe: a negative amount keeps its sign and the change is reported", () => {
  const out = briefAnswer(
    "why did the bill change?",
    amountBundle("Room charges: USD -500", "Room charges: USD 500"),
    cite,
    {},
  );
  assert.ok(out, "an answer is expected");
  assert.match(out.spoken, /Room charges -500 → Room charges 500/);
});

test("probe: a quantity before the marker in one segment prices the marked amount", () => {
  const out = briefAnswer(
    "why did the bill change?",
    amountBundle(
      "Room charges: 4 nights USD 16000",
      "Room charges: 5 nights USD 18000",
    ),
    cite,
    {},
  );
  assert.ok(out, "an answer is expected");
  assert.match(out.spoken, /Room charges 16,000 → Room charges 18,000/);
  assert.doesNotMatch(out.spoken, /Room charges 4 → Room charges 5/);
});
