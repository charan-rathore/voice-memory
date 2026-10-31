import { test } from "node:test";
import assert from "node:assert/strict";

test("dense model refuses to load without headroom and reports why", async () => {
  process.env.VM_MEMORY_LIMIT_MB = "256"; // less than the model needs
  const d = await import("./dense.mjs?guard=" + Date.now());
  assert.equal(d.memoryHeadroomOk(100 * 1048576), false);
  assert.equal(d.embedQueryReady("fee"), null); // keyword path, no load
  const st = d.denseStatus();
  assert.equal(st.ready, false);
  assert.match(st.memory.guard ?? "", /not loaded/);
  assert.equal(d.memoryHeadroomOk(10 * 1048576), false);
  process.env.VM_MEMORY_LIMIT_MB = "1024";
  assert.equal(d.memoryHeadroomOk(100 * 1048576), true);
  delete process.env.VM_MEMORY_LIMIT_MB;
});

test("dense fails closed when no memory limit is readable", async () => {
  delete process.env.VM_MEMORY_LIMIT_MB;
  const d = await import("./dense.mjs?guard-null=" + Date.now());
  // This host may or may not expose a cgroup limit; force the unreadable
  // case by checking the contract only when the limit is actually null,
  // and always checking the env-override path enables dense again.
  if (d.memoryLimitBytes() === null) {
    assert.equal(d.memoryHeadroomOk(100 * 1048576), false);
    assert.equal(d.embedQueryReady("fee"), null); // no load kick
    assert.match(
      d.denseStatus().memory.guard ?? "",
      /no memory limit readable/,
    );
  }
  process.env.VM_MEMORY_LIMIT_MB = "1024";
  assert.equal(d.memoryHeadroomOk(100 * 1048576), true);
  delete process.env.VM_MEMORY_LIMIT_MB;
});

test("denseCacheSuffix tracks resident model and embedding coverage", async () => {
  const d = await import("./dense.mjs?suffix=" + Date.now());
  const row = (emb) => ({
    chunk: {
      text: "t",
      embedding: emb ? "[0.1]" : null,
      embedding_model: emb ? d.DENSE_MODEL_ID : null,
    },
  });
  const bundle = { rows: [row(true), row(false), row(false)] };
  // Model not resident: keyword execution regardless of embeddings.
  assert.equal(d.denseCacheSuffix(bundle, false), ":k");
  // Resident, partial coverage: unique per coverage, never ":d".
  assert.equal(d.denseCacheSuffix(bundle, true), ":p1of3");
  bundle.rows[1].chunk.embedding = "[0.2]";
  bundle.rows[1].chunk.embedding_model = d.DENSE_MODEL_ID;
  assert.equal(d.denseCacheSuffix(bundle, true), ":p2of3");
  // Full coverage + resident: hybrid.
  bundle.rows[2].chunk.embedding = "[0.3]";
  bundle.rows[2].chunk.embedding_model = d.DENSE_MODEL_ID;
  assert.equal(d.denseCacheSuffix(bundle, true), ":d");
  // Shed (resident -> false) returns to keyword even with embeddings kept.
  assert.equal(d.denseCacheSuffix(bundle, false), ":k");
  // Empty and missing bundles are keyword.
  assert.equal(d.denseCacheSuffix({ rows: [] }, true), ":k");
  assert.equal(d.denseCacheSuffix(null, true), ":k");
});
