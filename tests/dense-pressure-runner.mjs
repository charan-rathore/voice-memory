import assert from "node:assert/strict";
const scenario = process.argv[2];
const MiB = 1048576;
process.env.VM_MEMORY_LIMIT_MB = "512";
process.env.VM_DENSE_MODEL_MB = "360";
delete process.env.VM_DENSE;
let rss = 100 * MiB;
const original = process.memoryUsage;
process.memoryUsage = () => ({ ...original(), rss });
globalThis.probe = { loads: 0, calls: 0, disposals: 0 };
const d = await import("../src/dense.mjs");
const row = () => ({
  title: "synthetic",
  chunk: { text: "source fact", embedding: null, embedding_model: null },
});
if (scenario === "load-pressure") {
  probe.load = () => {
    rss = 480 * MiB;
  };
  assert.equal(await d.warmDense([row()]), false);
  assert.equal(
    d.denseStatus().ready,
    false,
    "over-pressure model must not be kept after background load",
  );
  assert.equal(probe.disposals, 1);
  assert.equal(probe.calls, 0);
  assert.match(d.denseStatus().memory.guard, /dropped/);
  assert.equal(d.embedQueryReady("question"), null);
  assert.equal(probe.loads, 1, "high RSS must not immediately reload");
} else if (scenario === "warm-pressure") {
  probe.infer = () => {
    rss = 470 * MiB;
  };
  const rows = [row(), row()];
  assert.equal(await d.warmDense(rows), false);
  await new Promise((r) => setImmediate(r));
  assert.equal(d.denseStatus().ready, false);
  assert.equal(probe.calls, 1, "stop before second chunk");
  assert.equal(probe.disposals, 1);
  assert.equal(rows[1].chunk.embedding, null);
} else if (scenario === "query-pressure") {
  await d.warmDense([]);
  probe.infer = () => {
    rss = 470 * MiB;
  };
  assert.deepEqual(await d.embedQueryReady("question"), [0.25, 0.75]);
  await new Promise((r) => setImmediate(r));
  assert.equal(
    d.denseStatus().ready,
    false,
    "query completion must shed without another query",
  );
  assert.equal(probe.disposals, 1);
} else if (scenario === "text-pressure") {
  await d.warmDense([]);
  probe.infer = () => {
    rss = 470 * MiB;
  };
  assert.equal(await d.embedTextsReady(["first", "second"]), null);
  await new Promise((r) => setImmediate(r));
  assert.equal(probe.calls, 1);
  assert.equal(probe.disposals, 1);
  assert.equal(d.denseStatus().ready, false);
} else if (scenario === "drain-before-dispose") {
  await d.warmDense([]);
  let finish;
  probe.infer = () =>
    new Promise((r) => {
      finish = r;
    });
  const inFlight = d.embedQueryReady("first");
  await new Promise((r) => setImmediate(r));
  rss = 470 * MiB;
  assert.equal(d.embedQueryReady("second"), null);
  assert.equal(
    probe.disposals,
    0,
    "active inference owns pipeline until settled",
  );
  finish();
  await inFlight;
  await new Promise((r) => setImmediate(r));
  assert.equal(probe.disposals, 1);
  assert.equal(d.denseStatus().ready, false);
} else if (scenario === "normal") {
  const rows = [row(), row()];
  assert.equal(await d.warmDense(rows), true);
  assert.deepEqual(await d.embedQueryReady("question"), [0.25, 0.75]);
  assert.equal(d.denseStatus().ready, true);
  assert.equal(probe.disposals, 0);
  assert.equal(probe.calls, 3);
} else throw Error("unknown scenario");
console.log(scenario + " PASS " + JSON.stringify(probe));
