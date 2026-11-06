import { test } from "node:test";
import assert from "node:assert/strict";
import { importBundle } from "../dist/engine.mjs";
import { documentGraph } from "../memory/document-graph.mjs";
import { fullGraph } from "../src/public-api.mjs";
import { createMemory } from "../memory/memory.mjs";
const text =
  "# Event processing\n\n## Ownership\n" +
  "A lease identifies the worker responsible for a partition. ".repeat(30) +
  "\n\n## Backpressure\n" +
  "A bounded queue pauses producers while consumers catch up. ".repeat(30);
const make = (docs, scope = "workspace-a") => importBundle(docs, { scope });
test("arbitrary uploaded prose has connected, exactly grounded passages", () => {
  const b = make([{ id: "a", title: "Design", text }]);
  const g = fullGraph(b, createMemory());
  const chunks = g.nodes.filter((n) => n.kind === "chunk");
  assert.equal(chunks.length, b.rows.length);
  assert.ok(
    g.nodes.some((n) => n.kind === "section" && n.label === "Backpressure"),
  );
  for (const n of chunks)
    assert.equal(
      b.sources[0].text.slice(n.evidence.start, n.evidence.end),
      n.evidence.quote,
    );
  const ids = new Set(g.nodes.map((n) => n.id));
  for (const e of g.edges) assert.ok(ids.has(e.from) && ids.has(e.to));
  assert.equal(
    g.edges.filter((e) => e.kind === "next in document").length,
    chunks.length - 1,
  );
});
test("source and unchanged passage identities survive added documents, never cross workspaces", () => {
  const d = { id: "a", title: "Design", text };
  const a = make([d]);
  const b = make([d, { ...d, id: "b" }]);
  const other = make([d], "workspace-b");
  assert.equal(a.sources[0].id, b.sources[0].id);
  assert.deepEqual(
    a.rows.map((r) => r.chunk.id),
    b.rows
      .filter((r) => r.chunk.document_id === a.sources[0].id)
      .map((r) => r.chunk.id),
  );
  assert.notEqual(a.sources[0].id, other.sources[0].id);
  assert.notEqual(b.sources[0].id, b.sources[1].id);
});
test("span intersection handles repeated headings and a passage spanning sections", () => {
  const source = {
    id: "s",
    title: "Notes",
    text: "# Same\nFirst paragraph is here.\n# Same\nSecond paragraph is here.",
    hash: "h",
  };
  const b = {
    sources: [source],
    rows: [
      { chunk: { id: "c", document_id: "s", ordinal: 0, heading: "Same" } },
    ],
    anchors: new Map([["c", { start: 7, end: source.text.length }]]),
  };
  const g = documentGraph(b);
  assert.equal(g.nodes.filter((n) => n.kind === "section").length, 2);
  assert.equal(g.edges.filter((e) => e.kind === "overlaps passage").length, 2);
});
test("duplicate paragraphs remain distinct; no-heading notes work; rendering budget is explicit", () => {
  const b = make([
    {
      id: "a",
      title: "Notes",
      text: "A queue preserves event ordering and checkpoints the last committed offset.\n\n".repeat(
        100,
      ),
    },
  ]);
  assert.equal(new Set(b.rows.map((r) => r.chunk.id)).size, b.rows.length);
  const g = documentGraph(b, { maxChunks: 2 });
  assert.equal(g.coverage.shownChunks, 2);
  assert.ok(g.coverage.omittedChunks > 0);
  assert.ok(g.nodes.some((n) => n.kind === "section" && n.label === "Notes"));
});

test("new generations replace stale passages and sequence edges after source edits/removal", () => {
  const a = make([
    { id: "a", title: "Notes", text },
    { id: "b", title: "Other", text },
  ]);
  const ga = documentGraph(a);
  const b = make([
    {
      id: "a",
      title: "Notes",
      text:
        "Newly OCR recovered paragraph before the existing text.\n\n" + text,
    },
  ]);
  const gb = documentGraph(b);
  assert.notEqual(ga.generation, gb.generation);
  const removed = a.sources[1].id;
  assert.ok(!gb.nodes.some((n) => n.id.includes(removed)));
  const chunks = gb.nodes.filter((n) => n.kind === "chunk");
  const sequence = gb.edges.filter((e) => e.kind === "next in document");
  for (let i = 1; i < chunks.length; i++)
    assert.ok(
      sequence.some(
        (e) => e.from === chunks[i - 1].id && e.to === chunks[i].id,
      ),
    );
  b.sources[0].provisional = true;
  assert.ok(
    documentGraph(b)
      .nodes.filter((n) => n.kind === "chunk")
      .every((n) => n.provisional),
  );
  assert.notEqual(documentGraph(b).generation, gb.generation);
});
