// Cairngorms honest-abstention REGRESSIONS derived from a real public
// document. These pin behavior on verbatim excerpts; they are NOT
// full unseen-PDF ingest/voice validation (that evidence lives in the
// review receipts, not in this suite).
// Source: Cairngorms
// National Park Authority Planning Committee minutes, 24 January 2025,
// cairngorms-planning-minutes-2025-01-24.pdf; sentences below are verbatim
// from the published minutes). Out-of-domain questions must abstain or
// cite the record - never fabricate fees, invoices, or declarations.
import test from "node:test";
import assert from "node:assert/strict";
import { importBundle, answer } from "../dist/engine.mjs";
import { spokenTurn } from "../src/spoken.mjs";
import { extractiveSpoken } from "../src/spoken-extract.mjs";

const MINUTES = [
  "Planning Committee Meeting Minutes",
  "Held at Cairngorms National Park Authority HQ, Grantown on Spey",
  "In person at 11 am on 24 January 2025",
  "Bill Lobban declared an interest in Item 5 of the agenda, as a close neighbour of the application site.",
  "Bill Lobban declared an interest in Item 6, as the Highland Council, along with the applicant, are shareholders of the development company.",
  "Bill Lobban left the meeting at 11.08am.",
  "Agenda Item 5 Application 2024/0226/DET Erection of 3 houses.",
  "10. The Committee approved the application.",
  "Agenda Item 6 Application 2024/0297/DET Erection of a dwelling.",
  "15. The Committee approved the application.",
  "20. Date of the next meeting is 14 March 2025.",
].join("\n");
const bundle = () =>
  importBundle([
    { title: "cairngorms-planning-minutes-2025-01-24.pdf", text: MINUTES },
  ]);
// The layered path the server runs: spokenTurn first, then the
// engine-evidence extractive fallback.
const ask = (b, q) =>
  spokenTurn(q, b, b.fields ?? [], {})?.spoken ??
  extractiveSpoken(q, answer(q, b), b)?.spoken ??
  null;

test("out-of-domain fee question fabricates nothing", () => {
  const b = bundle();
  const spoken = ask(b, "What is the fee?");
  if (spoken) {
    assert.doesNotMatch(spoken, /\$|USD|\bfee of\b/i);
  }
  const eng = answer("What is the fee?", b);
  assert.ok(
    eng.refused || !/\$|USD|\bfee of\b/i.test(eng.answer ?? ""),
    "engine must refuse or stay silent on fees here",
  );
});

test("a person's name never routes to the invoice absence path", () => {
  const a = ask(bundle(), "What did Bill Lobban declare?");
  assert.match(a, /declared an interest in Item 5/);
  assert.doesNotMatch(a, /invoice/i);
});

test("ASR-lowercased name also stays out of the invoice path", () => {
  const a = ask(bundle(), "what did bill lobban declare?");
  assert.match(a, /declared an interest in Item 5/);
  assert.doesNotMatch(a, /invoice/i);
});

test("actual bill/invoice nouns still reach the invoice family", () => {
  assert.match(
    ask(bundle(), "What is the bill amount?"),
    /These documents don't record an invoice\./,
  );
  assert.match(
    ask(bundle(), "Was the bill of lading received?"),
    /These documents don't record a payment\./,
  );
});

test("leave time is retrieved from the actual record (decimal-time sentence)", () => {
  const a = ask(bundle(), "When did Bill Lobban leave?");
  assert.match(a, /left the meeting at 11\.08am/);
  assert.doesNotMatch(a, /declared an interest/);
});

test("a bare payment ask gets the documents-scoped absence", () => {
  assert.equal(
    ask(bundle(), "Did Bill pay?"),
    "These documents don't record a payment.",
  );
});

test("plural applications ask is not answered as a singular blanket", () => {
  const a = ask(bundle(), "Were the planning applications approved?");
  assert.match(a, /The Committee approved the application/);
  assert.match(a, /each of the 2 applications|2 decisions/);
});

test("invoice absence answer stays scoped to these documents", () => {
  const a = ask(bundle(), "What is the invoice amount?");
  assert.match(a, /These documents don't record an invoice\./);
});

test("next-meeting question: correct date or honest abstention, no invention", () => {
  const a = ask(bundle(), "When is the next meeting?") ?? "";
  // Retrieval currently abstains here (safe); the only unacceptable
  // outcome is an invented date.
  assert.match(a, /14 March 2025|don't see that|could not find/i);
  assert.doesNotMatch(a, /\b(January|February|April|May|June|July)\s+\d/);
});

// SYNTHETIC control fixture (authored for these tests, not from the
// minutes): two NAMED applications with MIXED outcomes, a conditional
// approval that states no decision, an OCR/lowercased document, and a
// decimal-currency record.
const CONTROL = [
  "Planning Committee Meeting Minutes",
  "Agenda Item 4 Application 2024/0111/DET New build at Carrbridge.",
  "Recommendation: Approve subject to conditions",
  "The panel would approve if condition 3 were met.",
  "8. The Committee refused the application.",
  "Agenda Item 5 Application 2024/0222/DET New build at Anagach.",
  "12. The Committee approved the application.",
  "The application fee was $42.50.",
].join("\n");
const controlBundle = () =>
  importBundle([{ title: "control-minutes.pdf", text: CONTROL }]);

const OCR_MINUTES = MINUTES.toLowerCase();
const ocrBundle = () =>
  importBundle([{ title: "cairngorms-minutes.pdf", text: OCR_MINUTES }]);

test("OCR/lowercased document: name ask does not become an invoice ask", () => {
  const a = ask(ocrBundle(), "what did bill lobban declare?");
  assert.match(a ?? "", /declared an interest in item 5/i);
  assert.doesNotMatch(a ?? "", /invoice/i);
});

test("line-split name + possessive ask stays out of the invoice path", () => {
  const split = MINUTES.replace(/Bill Lobban/g, "Bill\nLobban");
  const b = importBundle([{ title: "minutes.pdf", text: split }]);
  const a = ask(b, "What was Bill’s declaration?");
  assert.doesNotMatch(a ?? "", /invoice/i);
  // Split-name records may abstain; a one-word fragment is never an answer.
  assert.doesNotMatch(a ?? "", /: Bill$/);
});

test("OCR/lowercased document: actual bill noun still reaches invoice family", () => {
  const a = ask(ocrBundle(), "What is the bill amount?");
  assert.match(a ?? "", /don't record an invoice/i);
});

test("named target ask never quotes another application's decision", () => {
  const a = ask(controlBundle(), "Was Carrbridge approved?");
  assert.doesNotMatch(a ?? "", /Committee approved the application/);
  const b = ask(controlBundle(), "Was Anagach refused?");
  assert.doesNotMatch(b ?? "", /Committee refused the application/);
});

test("all-lowercase OCR document still binds a capitalized target", () => {
  const b = importBundle([
    { title: "control-minutes.pdf", text: CONTROL.toLowerCase() },
  ]);
  const a = ask(b, "Was Carrbridge approved?");
  // The asker's capitalization marks the proper name; the answer must be
  // Carrbridge's refusal or an abstention, never Anagach's approval.
  assert.doesNotMatch(a ?? "", /committee approved the application/);
});

test("lowercase OCR document AND lowercase ASR ask together still bind", () => {
  const b = importBundle([
    { title: "control-minutes.pdf", text: CONTROL.toLowerCase() },
  ]);
  const a = ask(b, "was carrbridge approved?");
  assert.doesNotMatch(a ?? "", /committee approved the application/);
});

test("target named with article binds to its own decision clause only", () => {
  const a = ask(controlBundle(), "Was the Carrbridge application approved?");
  assert.doesNotMatch(a ?? "", /Committee approved the application/);
  const b = ask(controlBundle(), "was the carrbridge application approved?");
  assert.doesNotMatch(b ?? "", /Committee approved the application/);
});

test("lowercase ASR target binds exactly like the capitalized name", () => {
  const a = ask(controlBundle(), "was carrbridge approved?");
  assert.doesNotMatch(a ?? "", /Committee approved the application/);
});

test("full casing matrix: no combination quotes the other item's decision", () => {
  for (const docText of [CONTROL, CONTROL.toLowerCase()])
    for (const q of [
      "Was Carrbridge approved?",
      "was carrbridge approved?",
      "Was the Carrbridge application approved?",
      "was the carrbridge application approved?",
      "Is Carrbridge approved?",
      "Did Carrbridge get approved?",
    ]) {
      const b = importBundle([{ title: "control-minutes.pdf", text: docText }]);
      const a = ask(b, q) ?? "";
      assert.doesNotMatch(a, /Committee approved the application/, `${JSON.stringify(q)} on ${docText === CONTROL ? "normal" : "lowercase"} doc quoted Anagach approval: ${a}`);
    }
});

test("positive control: the named item's own decision still answers", () => {
  const a = ask(controlBundle(), "Was Anagach approved?");
  assert.match(a ?? "", /approved/i);
  const b = ask(controlBundle(), "Was Carrbridge refused?");
  assert.match(b ?? "", /refused/i);
  const low = importBundle([
    { title: "control-minutes.pdf", text: CONTROL.toLowerCase() },
  ]);
  const c = ask(low, "was anagach approved?");
  assert.match(c ?? "", /approved/i);
});

test("one unit carrying both outcomes abstains on a polar ask", () => {
  const MIXED = [
    "Planning Committee Meeting Minutes, 24 January 2025.",
    "Agenda Item 4 Application 2024/0111/DET New build at Carrbridge.",
    "Agenda Item 5 Application 2024/0222/DET New build at Anagach.",
    "The Committee approved item 4 and refused item 5.",
  ].join("\n");
  const b = importBundle([{ title: "mixed-minutes.pdf", text: MIXED }]);
  const a = ask(b, "Was Carrbridge approved?");
  assert.doesNotMatch(a ?? "", /approved item 4 and refused item 5/);
});

test("a fresh agenda item without a name inherits no prior decision", () => {
  const DOC = [
    "Planning Committee Meeting Minutes",
    "Agenda Item 4 Application 2024/0111/DET New build at Carrbridge.",
    "8. The Committee refused the application.",
    "Agenda Item 6 Procedural update.",
    "9. The Committee approved the minutes of the previous meeting.",
  ].join("\n");
  const b = importBundle([{ title: "minutes.pdf", text: DOC }]);
  // Item 6 is not Carrbridge: its approval must not bind to Carrbridge,
  // and item 4's refusal must not bind to item 6.
  const a = ask(b, "Was Carrbridge approved?");
  assert.doesNotMatch(a ?? "", /approved the minutes/i);
  assert.match(a ?? "", /refused the application/i);
});

test("stale antecedent: a second decision without a naming line never binds", () => {
  const DOC = [
    "Planning Committee Meeting Minutes",
    "Agenda Item 5 Application 2024/0333/DET New build at Anagach Woods.",
    "7. The Committee approved the application.",
    "8. The Committee refused the application for a retail park.",
  ].join("\n");
  const b = importBundle([{ title: "minutes.pdf", text: DOC }]);
  const a = ask(b, "Was Anagach approved?");
  assert.match(a ?? "", /approved the application/i);
  assert.doesNotMatch(a ?? "", /refused/i);
  const r = ask(b, "Was the retail park refused?");
  assert.doesNotMatch(r ?? "", /approved the application/i);
});

test("plural ask over mixed outcomes enumerates, never blankets", () => {
  const a = ask(controlBundle(), "Were the planning applications approved?");
  assert.match(a ?? "", /mixed/i);
  assert.match(a ?? "", /refused the application/);
  assert.match(a ?? "", /approved the application/);
});

test("conditional approval wording asserts no decision", () => {
  const a = ask(controlBundle(), "Did the panel approve the application?");
  assert.doesNotMatch(a ?? "", /would approve if condition 3/i);
});

test("decimal-currency record survives sentence splitting", () => {
  const a = ask(controlBundle(), "What was the application fee?");
  assert.match(a ?? "", /42\.50/);
});
