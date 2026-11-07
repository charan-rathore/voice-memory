import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const exec = promisify(execFile);
for (const scenario of [
  "load-pressure",
  "warm-pressure",
  "query-pressure",
  "text-pressure",
  "drain-before-dispose",
  "normal",
])
  test("dense pressure boundary: " + scenario, async () => {
    const { stdout } = await exec(
      process.execPath,
      [
        "--experimental-loader",
        new URL("./dense-pressure-loader.mjs", import.meta.url).pathname,
        new URL("./dense-pressure-runner.mjs", import.meta.url).pathname,
        scenario,
      ],
      { timeout: 15000 },
    );
    assert.match(stdout, /PASS/);
  });
