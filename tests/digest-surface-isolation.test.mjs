import test from "node:test";
import assert from "node:assert/strict";
import { digestFor } from "../src/index-digest.mjs";

function digest(id, text) {
  const bundle = { sources: [{ id, title: "Report", text }], rows: [{ title: "Report", slug: id, chunk: { text, ordinal: 0 } }], records: [] };
  return digestFor(bundle, 0, { doc: { text, elements: [] } });
}

test("display forms are derived only from the current document bundle", () => {
  const a = digest("first", "discharged");
  const b = digest("second", "discharge");
  assert.ok(a.passage.vector.some(x => x.t === "discharged"));
  assert.ok(b.passage.vector.some(x => x.t === "discharge"));
  assert.ok(!b.passage.vector.some(x => x.t === "discharged"));
});
