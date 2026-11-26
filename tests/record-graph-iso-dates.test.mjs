import test from "node:test";
import assert from "node:assert/strict";
import { recordGraph } from "../src/record-graph.mjs";
function fixture(a, b) {
  const source = { id: "contract", text: a + "\n" + b };
  const rec = (index, value, start, authority, status) => ({
    index,
    title: status,
    authority,
    status,
    start,
    end: start + value.length,
    facts: [
      {
        id: String(index),
        label: "Delivery date",
        concept: "delivery",
        value,
        start,
        end: start + value.length,
      },
    ],
  });
  return {
    records: [
      {
        source,
        records: [
          rec(1, a, 0, "provisional", "draft"),
          rec(2, b, a.length + 1, "authoritative", "approved"),
        ],
      },
    ],
  };
}
const count = (a, b) =>
  recordGraph(fixture(a, b)).edges.filter((e) => e.kind === "supersedes").length;
test("ISO dates preserve real changes and normalize equivalent date formats", () => {
  assert.equal(count("2026-11-15", "2026-11-26"), 1);
  assert.equal(count("26 Nov 2026", "2026-11-26"), 0);
  assert.equal(count("15 Nov 2026", "26 Nov 2026"), 1);
});
