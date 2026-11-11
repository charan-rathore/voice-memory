// The one-minute developer demo must keep working: it is the integration
// guide's first instruction. Runs it as a separate process.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

test(
  "examples/client/returning-caller-demo.mjs tells the whole story",
  { timeout: 120_000 },
  async () => {
    const env = { PATH: process.env.PATH, HOME: process.env.HOME };
    const { stdout } = await promisify(execFile)(
      process.execPath,
      ["examples/client/returning-caller-demo.mjs"],
      {
        cwd: new URL("..", import.meta.url).pathname,
        env,
        timeout: 110_000,
      },
    );
    assert.match(
      stdout,
      /CALL 1[\s\S]*The windscreen excess is ₹1,000 per claim\./,
    );
    assert.match(
      stdout,
      /CALL 2[\s\S]*language=hinglish[\s\S]*unchanged → The windscreen excess is ₹1,000/,
    );
    assert.match(
      stdout,
      /CALL 3[\s\S]*CHANGED → The windscreen excess is ₹2,500[\s\S]*A different document set now applies/,
    );
    assert.match(
      stdout,
      /Receipt\s+rcpt_[0-9a-f]+ · insurance-2026 · 01_DriveSure_Wording_2026\.md/,
    );
    assert.match(
      stdout,
      /NO POLICY DATE[\s\S]*Which policy are you asking about\?/,
    );
    assert.match(stdout, /DELETE[\s\S]*Memory\s+\{\}/);
  },
);
