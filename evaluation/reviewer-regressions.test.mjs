import test from "node:test";
import assert from "node:assert/strict";
import { importBundle, answer, draft } from "../dist/engine.mjs";
import { NORTHSTAR_DOCS } from "../corpus-northstar.mjs";

const doc = (title, date, lines) => ({
  title,
  text:
    `# ${title.replace(/_/g, " ").replace(/\.md$/, "")}\n` +
    `Author: Test. Date: ${date}. Type: note.\n` +
    lines.map((l, i) => `${i + 1}. ${l}`).join("\n"),
});

// FAILURE 1: null engagement tokens skip isolation - an unrelated engagement's
// revised fee must not supersede another engagement's record.
test("unrelated engagement with no shared token never supersedes (Falstaff vs Bluebird)", () => {
  const docs = [
    doc("Bluebird_Proposal.md", "2026-09-04", [
      "The proposed engagement fee is $50,000, invoiced 50% on signing.",
    ]),
    doc("Falstaff_Revision.md", "2026-09-18", [
      "Following review, the revised fee is $60,000 for the Falstaff program.",
    ]),
  ];
  const r = answer("What is the engagement fee?", importBundle(docs));
  assert.equal(r.unresolved, true, r.answer);
  assert.match(r.answer, /\$50,000/);
  assert.match(r.answer, /\$60,000/);
  assert.doesNotMatch(r.answer, /superseded record\(s\): \$50,000/i);
});

// FAILURE 2: not every dollar amount is an engagement fee - an approved
// travel budget must not become the authoritative fee.
test("approved unrelated budget is not treated as the engagement fee", () => {
  const docs = [
    doc("Bluebird_Proposal.md", "2026-09-04", [
      "The proposed engagement fee is $50,000, invoiced 50% on signing.",
    ]),
    doc("Bluebird_Travel_Note.md", "2026-09-20", [
      "The travel budget of $3,000 for onsite workshops is approved by the client.",
    ]),
  ];
  const r = answer("What is the engagement fee?", importBundle(docs));
  assert.doesNotMatch(r.answer, /approved record \$3,000/);
  assert.match(r.answer, /\$50,000/);
});

// FAILURE 3: approval wording wins over revision wording inside one sentence.
test("an approved and countersigned revised fee is labeled approved, not proposed", () => {
  const docs = [
    doc("Bluebird_Proposal.md", "2026-09-04", [
      "The proposed engagement fee is $50,000.",
    ]),
    doc("Bluebird_Final_Memo.md", "2026-09-18", [
      "The revised fee of $45,000 is approved and countersigned by both parties.",
    ]),
  ];
  const r = answer("What is the engagement fee?", importBundle(docs));
  assert.match(r.answer, /approved record \$45,000/);
  assert.doesNotMatch(
    r.answer,
    /status: proposed[^)]*\$45,000|\$45,000 \([^)]*status: proposed/,
  );
});

// FAILURE 4: unresolved answers must block drafts on EVERY path (engine draft,
// /api/draft, voice email branch), not only the UI.
test("unresolved conflict blocks draft() identically to refusal", () => {
  const r = answer(
    "What payment terms did we finally agree to?",
    importBundle(NORTHSTAR_DOCS),
  );
  assert.equal(r.unresolved, true);
  assert.throws(
    () => draft(r, importBundle(NORTHSTAR_DOCS)),
    /evidence|review|unresolved/i,
  );
});

// FAILURE 5: "signed off" must engage the sign-off question guards.
test("'signed off' phrasing engages the sign-off question guard", () => {
  const r = answer(
    "Has anyone signed off on the new terms?",
    importBundle(NORTHSTAR_DOCS),
  );
  assert.match(
    r.answer,
    /not a named approver|not evidence that sign-off has occurred|no .*sign/i,
  );
  assert.doesNotMatch(r.answer, /Maya|A\. Fernandes/);
});

// FAILURE 6: spaced present-tense "sign off" must also engage the sign-off
// guards - a REQUIREMENT question ("who has to") gets the scoped record
// answer (named team + condition), never a refusal or a named approver.
test("'sign off' requirement question returns the recorded condition", () => {
  const r = answer(
    "Who has to sign off the revised terms?",
    importBundle(NORTHSTAR_DOCS),
  );
  assert.equal(r.supported, true, r.answer);
  assert.match(r.answer, /client finance/i);
  assert.match(r.answer, /not evidence that sign-off has occurred/i);
});
