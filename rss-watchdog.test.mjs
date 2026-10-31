import test from "node:test";
import assert from "node:assert/strict";
import { createRssWatchdog, MIB } from "./rss-watchdog.mjs";

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
