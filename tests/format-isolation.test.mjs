import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const exec = promisify(execFile);
test("TXT, DOCX, PNG and JPEG ingest without loading the PDF runtime", async () => {
  const { stdout } = await exec(
    process.execPath,
    [
      "--experimental-loader",
      new URL("./nonpdf-loader.mjs", import.meta.url).pathname,
      new URL("./nonpdf-runner.mjs", import.meta.url).pathname,
    ],
    { cwd: new URL("..", import.meta.url).pathname, timeout: 30000 },
  );
  for (const f of ["notes.txt", "minutes.docx", "printed.png", "printed.jpg"])
    assert.ok(stdout.includes(f + " ready"));
});
