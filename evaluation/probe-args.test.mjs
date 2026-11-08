// probe-case.mjs argument validation: unsupported flags must fail loudly.
// A silently ignored "--holdout" flag once re-ran the MAIN question file
// while being reported as a holdout pass - a false validation record.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

const SCRIPT = new URL("../scripts/probe-case.mjs", import.meta.url).pathname;

const run = (args) =>
  spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });

test("unsupported flags exit non-zero with a named error", () => {
  for (const args of [["--holdout"], ["--bogus"], ["positional"]]) {
    const r = run(args);
    assert.notEqual(r.status, 0, `${args}: must not silently run`);
    assert.match(r.stderr, /probe-case: /, `${args}: error names the problem`);
    assert.equal(r.stdout.includes("passed"), false, `${args}: no suite ran`);
  }
});

test("malformed --only values exit non-zero", () => {
  for (const args of [["--only"], ["--only", "abc"], ["--only", "0"]]) {
    const r = run(args);
    assert.notEqual(r.status, 0, `${args}`);
    assert.match(r.stderr, /--only/, `${args}`);
  }
});
