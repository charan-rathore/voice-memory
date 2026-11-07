import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const exec = promisify(execFile);
test("PDF text, scan, mixed and rotation extraction never load the canvas renderer", async () => {
  const { stdout } = await exec(
    process.execPath,
    [
      "--require",
      new URL("./render-import-hook.cjs", import.meta.url).pathname,
      new URL("./pdf-no-render-runner.mjs", import.meta.url).pathname,
    ],
    { timeout: 30000 },
  );
  assert.ok(stdout.includes("canvasImports=0"), stdout);
});
