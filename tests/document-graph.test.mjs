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

test("untrusted document IDs cannot collapse sources; scoped stable IDs must be unique", () => {
  const docs = [
    { id: "duplicate", title: "One", text },
    { id: "duplicate", title: "Two", text },
  ];
  const fresh = importBundle(docs);
  assert.notEqual(fresh.sources[0].id, fresh.sources[1].id);
  assert.throws(() => importBundle(docs, { scope: "workspace-a" }), /unique/);
});

test("fenced examples never create section nodes and actual heading offsets survive", () => {
  const body =
    '# Runtime\n\nWorkers checkpoint offsets after each batch.\n\n````markdown\n## Example heading only\n```\n## Still inside the example\n```\n````\n\n   ~~~python\n# Configuration comment\nprint("ready")\n   ~~~\n\n## Recovery ###\n\nA replacement worker resumes from the committed checkpoint and preserves partition order.';
  const b = make([{ id: "readme", title: "Runtime guide", text: body }]);
  const g = documentGraph(b);
  const sections = g.nodes.filter((n) => n.kind === "section");
  assert.deepEqual(
    sections.map((n) => n.label),
    ["Runtime", "Recovery"],
  );
  const recovery = sections.find((n) => n.label === "Recovery");
  assert.equal(recovery.start, body.indexOf("## Recovery"));
  assert.ok(
    !g.nodes.some((n) =>
      /Example heading only|Still inside the example|Configuration comment/.test(
        n.label,
      ),
    ),
  );
});

test("large source headings cannot multiply unbounded labels across graph passages", () => {
  const b = make([
    {
      id: "long-heading",
      title: "Notes",
      text:
        "# " +
        "A".repeat(5000) +
        "\n\nWorkers checkpoint offsets and resume safely after a restart.",
    },
  ]);
  const g = documentGraph(b);
  assert.ok(g.nodes.filter((n) => n.kind === "chunk").length > 0);
  for (const n of g.nodes)
    assert.ok(
      String(n.label).length <= 180,
      "display labels stay bounded independently of source text",
    );
});

test("section coverage reports real omissions rather than an exactly full budget", () => {
  const b = make([
    {
      id: "two",
      title: "Guide",
      text: "# First\nWorkers preserve their checkpoint after each batch.\n\n## Second\nConsumers resume reading from the committed offset.",
    },
  ]);
  const exact = documentGraph(b, { maxSections: 2 });
  assert.equal(exact.coverage.limited, false);
  const limited = documentGraph(b, { maxSections: 1 });
  assert.equal(limited.coverage.limited, true);
  assert.equal(limited.coverage.omittedSections, 1);
  assert.notEqual(exact.generation, limited.generation);
});
