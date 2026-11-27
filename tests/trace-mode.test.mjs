import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import assert from "node:assert/strict";
import test from "node:test";

// Exercise the shipped renderer without duplicating its mode-selection logic.
const source = readFileSync(
  new URL("../public/workspace.js", import.meta.url),
  "utf8",
);
const start = source.indexOf("function renderTrace(r) {");
const end = source.indexOf("\nfunction renderSignals", start);
assert.ok(start >= 0 && end > start);
function render(response) {
  const nodes = new Map();
  const node = () => ({
    hidden: false,
    textContent: "",
    children: [],
    style: {},
    append(...items) {
      this.children.push(...items);
    },
    replaceChildren() {
      this.children = [];
    },
  });
  const $ = (id) => {
    if (!nodes.has(id)) nodes.set(id, node());
    return nodes.get(id);
  };
  const el = (tag, cls, text) =>
    Object.assign(node(), { tag, cls, textContent: text });
  runInNewContext(`${source.slice(start, end)}\nrenderTrace(response);`, {
    $,
    el,
    response,
  });
  return {
    label: $("mode").textContent,
    hidden: $("trace-panel").hidden,
    rows: $("trace").children,
  };
}
const stages = { keyword: [{ title: "Synthetic lease", score: 1, rank: 1 }] };
for (const [actualMode, method] of Object.entries({
  keyword: "keyword search",
  dense: "semantic search",
  hybrid: "keyword and semantic search",
})) {
  test(`trace describes the actual ${actualMode} retrieval mode`, () => {
    const result = render({ actualMode, retrievalStages: stages });
    assert.equal(
      result.label,
      `Search mode: ${method} over this session's documents. Scores below are keyword-stage candidates only.`,
    );
    assert.equal(result.hidden, false);
    assert.equal(result.rows.length, 1);
  });
  test(`${actualMode} mode remains visible without keyword candidates`, () => {
    const result = render({ actualMode, retrievalStages: { keyword: [] } });
    assert.equal(result.hidden, false);
    assert.equal(
      result.label,
      `Search mode: ${method} over this session's documents.`,
    );
    assert.doesNotMatch(result.label, /found|scores|candidates/i);
  });
}
for (const actualMode of [undefined, "future-mode", "__proto__"]) {
  test(`unrecognized mode ${actualMode} does not invent a search method`, () => {
    const result = render({ actualMode, retrievalStages: stages });
    assert.equal(
      result.label,
      "Search over this session's documents. Scores below are keyword-stage candidates only.",
    );
    assert.equal(result.hidden, false);
  });
}
test("ambiguity warning survives in every mode", () => {
  for (const actualMode of ["keyword", "dense", "hybrid", undefined]) {
    assert.match(
      render({
        actualMode,
        evidenceStatus: "ambiguous",
        retrievalStages: stages,
      }).label,
      /Several sources were similarly relevant, so no single answer is treated as settled\.$/,
    );
  }
});
test("empty responses keep the trace hidden", () => {
  assert.equal(render({}).hidden, true);
});
test("query expansion keeps the trace visible without candidates", () => {
  assert.equal(
    render({ queryTransform: { expanded: "synthetic search" } }).hidden,
    false,
  );
});
