// trimEvidenceQuote: display-layer excerpt trimming for diagnostic evidence.
// The invariants that matter: an untrimmed quote never loses context; a
// trimmed quote stays an exact slice of the original at shifted offsets;
// the cut only ever happens at a source-printed record/section heading, so
// the kept excerpt is whole records, never a cropped mid-record fragment;
// and a salient token early in the quote (e.g. repeated in an unrelated
// estimate) blocks trimming entirely - contradictory context is never
// cropped to look relevant.
import test from "node:test";
import assert from "node:assert/strict";
import { trimEvidenceQuote } from "../src/library.mjs";

const REC = (name, id, body) =>
  `Patient name: ${name} Patient ID: ${id}\n\nDOB: 04 Dec 1968 Sex: Female\n\n${body}`;

test("a chunk crossing a record boundary trims to the matching record", () => {
  const before = REC("Other Person", "X-1", "Hemoglobin 13.1 g/dL\n\n");
  const match = REC("Maya Sharma", "HLG-P1048", "HbA1c 6.9 %\n");
  const pad = "x".repeat(310 - before.length) + "\n"; // push the match past 300
  const quote = before + pad + match;
  const q = "What is Maya's HbA1c?";
  const t = trimEvidenceQuote(quote, q);
  assert.ok(t.dropped > 0);
  // exact slice at shifted offsets: source.slice(start+dropped, end)
  assert.equal(t.quote, quote.slice(t.dropped));
  assert.equal(t.quote, match);
  // nothing from the matching record is lost: it starts at its own heading
  assert.ok(t.quote.startsWith("Patient name: Maya Sharma"));
});

test("status and amendment lines inside the matching record are kept", () => {
  const before = REC("Other Person", "X-1", "notes\n") + "y".repeat(300) + "\n";
  const match = REC(
    "Maya Sharma",
    "HLG-P1048",
    "Report status: AMENDED\n\nAmended: HbA1c corrected 7.1 to 6.9\n\nHbA1c 6.9 %\n",
  );
  const t = trimEvidenceQuote(before + match, "What is Maya's HbA1c?");
  assert.equal(t.quote, match);
  assert.match(t.quote, /Report status: AMENDED/);
  assert.match(t.quote, /corrected 7\.1 to 6\.9/);
});

test("a salient token in an unrelated prefix blocks trimming entirely", () => {
  // "Maya" repeats in an earlier estimate record: the first occurrence is
  // near the start, so the excerpt is kept whole - cropping could hide that
  // the question's words also match a record the answer did not use.
  const estimate = REC("Maya Sharma", "HLG-P1047", "HbA1c not done\n");
  const pad = "z".repeat(320) + "\n";
  const other = REC("Maya Sharma", "HLG-P1048", "HbA1c 6.9 %\n");
  const quote = estimate + pad + other;
  const t = trimEvidenceQuote(quote, "What is Maya's HbA1c?");
  assert.equal(t.dropped, 0);
  assert.equal(t.quote, quote);
});

test("no record heading before the match: quote kept whole", () => {
  const prose = "Background notes without any record header. ".repeat(12);
  const quote = prose + "the ferritin is 82";
  const t = trimEvidenceQuote(quote, "What is her ferritin?");
  assert.deepEqual(t, { quote, dropped: 0 });
});

test("salient content near the start is never touched", () => {
  const quote = REC("Maya Sharma", "HLG-P1048", "HbA1c 6.9 %\n");
  const t = trimEvidenceQuote(quote, "What is Maya's HbA1c?");
  assert.deepEqual(t, { quote, dropped: 0 });
});

test("no question terms means no trim decision", () => {
  const quote = "anything at all " + "w".repeat(400);
  assert.deepEqual(trimEvidenceQuote(quote, ""), { quote, dropped: 0 });
});
