import { test } from "node:test";
import assert from "node:assert/strict";
import { denseMemoryBudget } from "../src/dense-memory-budget.mjs";
const MiB = 1048576;
const read =
  (v2 = "max", v1 = "max") =>
  (path) =>
    path.endsWith("memory.max") ? v2 : v1;
test("configured ceiling cannot override a smaller enforced cgroup limit", () => {
  const b = denseMemoryBudget({
    configuredMb: "1024",
    read: read(String(512 * MiB)),
  });
  assert.equal(b.limitBytes, 512 * MiB);
  assert.equal(b.source, "cgroup-v2");
  assert.equal(b.hostBytes, 512 * MiB);
  assert.equal(b.configuredBytes, 1024 * MiB);
});
test("stricter configured ceiling remains distinct from host enforcement", () => {
  const b = denseMemoryBudget({
    configuredMb: "256",
    read: read(String(512 * MiB)),
  });
  assert.equal(b.limitBytes, 256 * MiB);
  assert.equal(b.source, "configured");
  assert.equal(b.hostSource, "cgroup-v2");
});
test("v1 limit, unlimited sentinels and unavailable host are distinguished", () => {
  assert.equal(
    denseMemoryBudget({
      configuredMb: "",
      read: read("max", String(500000000)),
    }).limitBytes,
    500000000,
  );
  assert.equal(
    denseMemoryBudget({
      configuredMb: "512",
      read: read("max", String(2 ** 62)),
    }).source,
    "configured",
  );
  assert.equal(
    denseMemoryBudget({
      configuredMb: "",
      read: () => {
        throw Error("unavailable");
      },
    }).limitBytes,
    null,
  );
});
for (const configuredMb of ["Infinity", "NaN", "-2", "0", "invalid"])
  test("invalid configured memory cap fails closed: " + configuredMb, () => {
    const b = denseMemoryBudget({
      configuredMb,
      read: read(String(512 * MiB)),
    });
    assert.equal(b.limitBytes, null);
    assert.equal(b.source, "invalid-config");
  });
