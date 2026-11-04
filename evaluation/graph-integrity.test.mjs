// Memory-graph integrity. RED on main 6edac74 (first test): value ids were
// `field + amount`, so "$42,000 proposed" for one engagement and "$42,000
// approved" for an unrelated one became ONE node, `value:fee:42-000`, status
// approved, with the unapproved proposal drawn as evidence for it. The rest
// pin behaviour that was already right (deletion, replacement, stale
// questions) so it stays right.
import test from "node:test";
import assert from "node:assert/strict";
import { importBundle, answer } from "../dist/engine.mjs";
import { fullGraph } from "../src/public-api.mjs";
import { buildGraph } from "../memory/graph.mjs";
import { createMemory, recordTurn } from "../memory/memory.mjs";
import { NORTHSTAR_DOCS } from "../examples/corpus-northstar.mjs";

const ALDER = {
  title: "Alder_Engagement_Proposal.md",
  text: "# Alder Logistics engagement\nDate: 2026-09-01\n\nThe proposed engagement fee for Alder Logistics is $42,000. It is not approved.",
};
const BIRCH = {
  title: "Birch_Steering_Decision.md",
  text: "# Birch Health engagement\nDate: 2026-09-05\n\nThe Birch Health steering committee approved the engagement fee of $42,000.",
};
const feeValues = (g) =>
  g.nodes.filter((n) => n.kind === "value" && n.field === "fee");
const docOf = (b, edge) =>
  b.sources.find((s) => `doc:${s.id}` === edge.from)?.title;

test("identical amounts in unrelated engagements stay separate values", () => {
  const b = importBundle([ALDER, BIRCH]);
  const g = fullGraph(b, createMemory());
  const vals = feeValues(g);
  assert.deepEqual(vals.map((v) => v.id).sort(), [
    "value:fee:42-000@alder-logistics",
    "value:fee:42-000@birch-health",
  ]);
  const alder = vals.find((v) => v.id.endsWith("@alder-logistics"));
  const birch = vals.find((v) => v.id.endsWith("@birch-health"));
  assert.equal(alder.status, "proposed");
  assert.equal(birch.status, "approved");
  const into = (v) =>
    g.edges.filter((e) => e.to === v.id && e.from.startsWith("doc:"));
  assert.deepEqual(
    into(alder).map((e) => [docOf(b, e), e.kind]),
    [["Alder_Engagement_Proposal.md", "proposed"]],
  );
  assert.deepEqual(
    into(birch).map((e) => [docOf(b, e), e.kind]),
    [["Birch_Steering_Decision.md", "approved"]],
  );
  // every evidence edge quotes its own document exactly
  for (const e of g.edges.filter((e) => e.evidence)) {
    const src = b.sources.find((s) => s.id === e.evidence.sourceId);
    assert.equal(
      src.text.slice(e.evidence.start, e.evidence.end),
      e.evidence.quote,
    );
  }
  // a single-engagement corpus keeps its plain ids
  const ns = fullGraph(importBundle(NORTHSTAR_DOCS), createMemory());
  assert.ok(ns.nodes.some((n) => n.id === "value:fee:42-000"));
  assert.ok(!ns.nodes.some((n) => /^value:.*@/.test(n.id)));
});

test("a value focus with an engagement suffix resolves", () => {
  const b = importBundle([ALDER, BIRCH]);
  const g = buildGraph(b, createMemory(), "value:fee:42-000@birch-health");
  const v = g.nodes.find((n) => n.kind === "value");
  assert.equal(v?.id, "value:fee:42-000@birch-health");
  assert.ok(
    g.nodes.some((n) => n.kind === "evidence" && /Birch Health/.test(n.label)),
  );
  assert.ok(
    !g.nodes.some((n) => n.kind === "evidence" && /Alder/.test(n.label)),
  );
});

function asked(b, q) {
  const mem = createMemory();
  const r = answer(q, b);
  recordTurn(mem, { question: q, lead: null, result: r });
  return mem;
}

test("a deleted document leaves no node, value or question behind", () => {
  const before = importBundle([ALDER, BIRCH]);
  const mem = asked(
    before,
    "What fee did the Birch Health steering committee approve?",
  );
  const g1 = buildGraph(before, mem, "overview");
  assert.ok(
    g1.nodes.some((n) => n.kind === "question"),
    "question recorded",
  );
  const after = importBundle([ALDER]);
  const g2 = fullGraph(after, mem);
  assert.ok(!g2.nodes.some((n) => /Birch/i.test(n.label ?? "")));
  assert.ok(
    !g2.nodes.some((n) => n.kind === "question"),
    "stale question dropped",
  );
  assert.deepEqual(
    feeValues(g2).map((v) => [v.id, v.status]),
    [["value:fee:42-000", "proposed"]],
  );
  const ids = new Set(g2.nodes.map((n) => n.id));
  assert.ok(
    g2.edges.every((e) => ids.has(e.from) && ids.has(e.to)),
    "no dangling edges",
  );
});

test("a replaced document drops questions that cited its old text", () => {
  const before = importBundle([ALDER, BIRCH]);
  const mem = asked(
    before,
    "What fee did the Birch Health steering committee approve?",
  );
  const replaced = {
    ...BIRCH,
    text: "# Birch Health engagement\nDate: 2026-09-12\n\nThe Birch Health steering committee deferred the engagement fee decision.",
  };
  const after = importBundle([ALDER, replaced]);
  const g = fullGraph(after, mem);
  assert.ok(
    !g.nodes.some((n) => n.kind === "question"),
    "question on old text dropped",
  );
  assert.ok(
    !feeValues(g).some((v) => v.status === "approved"),
    "no stale approval",
  );
});
