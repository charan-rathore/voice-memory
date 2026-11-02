// Contextual chunk headers: what a chunk is embedded as (title + heading
// path + text), and the VM_DENSE_CONTEXT=off escape hatch used by the A/B
// bench. The stored chunk text is never changed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { passageText } from "../src/dense.mjs";

// Off by default (it measured worse on the hybrid bench; see dense.mjs).
process.env.VM_DENSE_CONTEXT = "on";

test("chunks are embedded with their document title and heading path", () => {
  const row = {
    title: "03_commercial_revision.md",
    chunk: {
      text: "Approved by: pending client finance sign-off.",
      heading: "Approvals",
    },
  };
  assert.equal(
    passageText(row),
    "03 commercial revision > Approvals\nApproved by: pending client finance sign-off.",
  );
  assert.equal(row.chunk.text, "Approved by: pending client finance sign-off.");
});

test("a heading already at the start of the chunk is not repeated", () => {
  const row = {
    title: "Lab report.pdf",
    chunk: { text: "Results\nFerritin 50", heading: "Results" },
  };
  assert.equal(passageText(row), "Lab report\nResults\nFerritin 50");
});

test("default (unset) embeds the bare chunk", () => {
  delete process.env.VM_DENSE_CONTEXT;
  try {
    assert.equal(
      passageText({ title: "T", chunk: { text: "x", heading: "H" } }),
      "x",
    );
  } finally {
    process.env.VM_DENSE_CONTEXT = "on";
  }
});
