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
