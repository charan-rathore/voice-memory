import test from "node:test";
import assert from "node:assert/strict";
import { createRssWatchdog, MIB } from "../src/rss-watchdog.mjs";

const rig = (mb, opts = {}) => {
  const events = [];
  const exits = [];
  let clock = 0;
  const w = createRssWatchdog({
    rss: () => mb * MIB,
    now: () => clock,
    onEvent: (e) => events.push(e),
    exit: (c) => exits.push(c),
    intervalMs: 1e9,
    ...opts,
  });
  w.stop();
  return { w, events, exits, advance: (ms) => (clock += ms) };
};

test("admits expensive work below the high-water mark", () => {
  const { w, events } = rig(300);
  assert.equal(w.admit(), true);
  assert.equal(events.length, 0);
});

test("refuses expensive work at the admission high-water mark", () => {
  const { w, events } = rig(461);
  assert.equal(w.admit(), false);
  assert.equal(events.at(-1).type, "admission-refused");
});

test("restarts immediately when idle above the restart mark", () => {
  const { w, events, exits } = rig(497);
  w.tick();
  assert.deepEqual(exits, [1]);
  assert.equal(events.at(-1).type, "restart");
  assert.equal(events.at(-1).dropped, 0);
});

test("defers restart while requests are in flight, then restarts on drain", () => {
  const { w, events, exits } = rig(497);
  w.beginRequest();
  w.tick();
  assert.deepEqual(exits, []);
  assert.equal(events.at(-1).type, "pressure");
  w.endRequest();
  assert.deepEqual(exits, [1]);
  assert.equal(events.at(-1).dropped, 0);
});

test("forces exit after the grace window and honestly logs dropped requests", () => {
  const { w, events, exits, advance } = rig(497);
  w.beginRequest();
  w.beginRequest();
  w.tick();
  advance(31000);
  w.tick();
  assert.deepEqual(exits, [1]);
  assert.equal(events.at(-1).type, "forced-restart");
  assert.equal(events.at(-1).dropped, 2);
});

test("pressure recovers without restart when RSS falls back", () => {
  let mb = 497;
  const events = [];
  const exits = [];
  const w = createRssWatchdog({
    rss: () => mb * MIB,
    onEvent: (e) => events.push(e),
    exit: (c) => exits.push(c),
    intervalMs: 1e9,
  });
  w.stop();
  w.beginRequest();
  w.tick();
  assert.equal(events.at(-1).type, "pressure");
  mb = 300;
  w.tick();
  w.endRequest();
  assert.deepEqual(exits, []);
  assert.equal(w.state().overSince, null);
});

test("reads the real host memory limit from cgroup v2", async () => {
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "cgroup-"));
  const v2 = join(dir, "memory.max");
  writeFileSync(v2, "536870912\n");
  const { readHostMemoryLimit } = await import("../src/rss-watchdog.mjs");
  assert.deepEqual(
    readHostMemoryLimit({ v2Path: v2, v1Path: join(dir, "none") }),
    {
      bytes: 536870912,
      source: "cgroup-v2",
    },
  );
});

test("falls back to cgroup v1 and treats its unlimited sentinel as no limit", async () => {
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "cgroup-"));
  const v2 = join(dir, "memory.max");
  const v1 = join(dir, "memory.limit_in_bytes");
  const { readHostMemoryLimit } = await import("../src/rss-watchdog.mjs");
  writeFileSync(v2, "max\n");
  writeFileSync(v1, "500000000\n");
  assert.deepEqual(readHostMemoryLimit({ v2Path: v2, v1Path: v1 }), {
    bytes: 500000000,
    source: "cgroup-v1",
  });
  writeFileSync(v1, "9223372036854771712\n");
  assert.deepEqual(readHostMemoryLimit({ v2Path: v2, v1Path: v1 }), {
    bytes: null,
    source: null,
  });
  assert.deepEqual(
    readHostMemoryLimit({
      v2Path: join(dir, "none"),
      v1Path: join(dir, "none2"),
    }),
    { bytes: null, source: null },
  );
});

test("watchdog state reports the host limit once read", async () => {
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "cgroup-"));
  const v2 = join(dir, "memory.max");
  writeFileSync(v2, "536870912\n");
  const w = createRssWatchdog({
    rss: () => 10,
    limitPaths: { v2Path: v2, v1Path: join(dir, "none") },
  });
  assert.deepEqual(w.state().hostLimit, {
    bytes: 536870912,
    source: "cgroup-v2",
  });
});
