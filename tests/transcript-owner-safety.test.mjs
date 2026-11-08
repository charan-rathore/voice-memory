import test from "node:test";
import assert from "node:assert/strict";
import { vocabularyOf, repairRecordTerms } from "../src/transcript-fix.mjs";
const vocab = (ids) =>
  vocabularyOf(
    ids.map((id) => ({ meta: { patient: { id } }, observations: [] })),
  );
test("exact and unknown opaque identifiers are not fuzzy-rebound in either document order", () => {
  for (const ids of [
    ["RX-0001", "RY-0001"],
    ["RY-0001", "RX-0001"],
  ])
    for (const id of ["RX-0001", "RY-0001", "RZ-0001"]) {
      const q = `What is Creatinine for ${id}?`;
      assert.equal(repairRecordTerms(q, vocab(ids)).text, q);
    }
});
test("spelled identifiers need exact complete letters and digits, not a nearest owner", () => {
  assert.equal(
    repairRecordTerms(
      "show ar why zero zero zero one",
      vocab(["RX-0001", "RY-0001"]),
    ).text,
    "show RY-0001",
  );
  assert.equal(
    repairRecordTerms(
      "show ar zed zero zero zero one",
      vocab(["RX-0001", "RY-0001"]),
    ).text,
    "show ar zed zero zero zero one",
  );
});
test("an exact alphanumeric test name is never partially repaired into HbA1cc", () => {
  const v = vocabularyOf([
    {
      meta: { patient: { id: "SYN-0007" } },
      observations: [{ test: "HbA1c", canon: "hba1c" }],
    },
  ]);
  assert.equal(
    repairRecordTerms("What is the HbA1c for SYN-0007?", v).text,
    "What is the HbA1c for SYN-0007?",
  );
});
test("legacy voice candidates preserve literal exact and unknown identifiers", async () => {
  const { voiceQuestions } = await import("../src/spoken-repair.mjs");
  for (const id of ["SIN-0001", "SYN-001", "SYM-0001"]) {
    const q = `What is Creatinine for ${id}?`;
    const out = voiceQuestions([{ role: "user", content: q }], {
      reports: [],
      ids: ["SYN-0001", "SIN-0001"],
      aliasesFor: () => [],
      text: (x) => x,
    });
    assert.equal(out[0], q);
  }
});
