// The canary must tell "engine waking", "cases loading", "ready" and
// "deployed version mismatch" apart, and wait through loading.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyStatus,
  versionCheck,
  waitReady,
} from "../scripts/canary-state.mjs";

const loaded = { cases: { health: true, deal: true } };
const loading = { cases: { health: false, deal: true } };

function run(seq, opts = {}) {
  let t = 0,
    i = 0;
  return waitReady(
    async () => {
      const s = seq[Math.min(i++, seq.length - 1)];
      if (s instanceof Error) throw s;
      return s;
    },
    { sleep: async (ms) => void (t += ms), now: () => t, ...opts },
  );
}

test("a 200 with cases not yet loaded is waited through, not a failure", async () => {
  // RED on main: canary.mjs threw "engine up but cases not loaded" on the
  // first such response (run 41923964422).
  const r = await run([
    new Error("fetch failed"),
    { status: 503 },
    { status: 200, body: loading },
    { status: 200, body: loaded },
  ]);
  assert.equal(r.state, "ready");
  assert.deepEqual(r.seen, ["waking", "waking", "loading", "ready"]);
});

test("loading that never finishes ends as loading, within the deadline", async () => {
  const r = await run([{ status: 200, body: loading }], { deadlineMs: 60000 });
  assert.equal(r.state, "loading");
  assert.equal(r.timedOut, true);
  assert.ok(r.ms >= 60000 && r.ms < 80000, `bounded: ${r.ms}`);
});

test("an engine that never answers ends as waking, not loading", async () => {
  const r = await run([new Error("timeout")], { deadlineMs: 30000 });
  assert.equal(r.state, "waking");
});

test("a 4xx is an error at once, not retried as waking", async () => {
  assert.equal(classifyStatus({ status: 404 }).state, "error");
  assert.equal(classifyStatus({ status: 429 }).state, "waking");
});

test("deployed version: match, mismatch, unreported, unchecked", () => {
  assert.equal(
    versionCheck({ commit: "fb4b2c2311408969" }, "fb4b2c2").state,
    "match",
  );
  assert.equal(
    versionCheck({ commit: "3ea29bc" }, "fb4b2c2").state,
    "mismatch",
  );
  assert.equal(versionCheck({ commit: null }, "fb4b2c2").state, "mismatch");
  assert.equal(versionCheck({ commit: "x" }, undefined).state, "unchecked");
});
