import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Regression: the web-call SDK rejects call.start()'s promise when the
// session mint fails (e.g. server briefly unconfigured during a deploy
// swap -> HTTP 503). That rejection does NOT surface as the SDK's "error"
// event; un-awaited it escapes the surrounding try/catch as an uncaught
// promise rejection and the UI stays on "Preparing call…" forever with the
// start button disabled. Observed live on the hosted deployment.
const src = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");

test("call.start() is awaited so a mint failure lands in the catch", () => {
  assert.ok(
    /await\s+c\.start\(\)\.catch\(/.test(src),
    "c.start() must be awaited (with a generation-guarded catch) so SDK rejections reach the catch",
  );
});

test("the start-flow catch surfaces the error and re-enables the button", () => {
  const start = src.indexOf('$("call-start").onclick');
  const end = src.indexOf('$("call-end").onclick');
  assert.ok(start > -1 && end > start, "call-start onclick block found");
  const onclick = src.slice(start, end);
  const catchAt = onclick.indexOf("catch (e)");
  assert.ok(catchAt > -1, "onclick has a catch (e) block");
  const tail = onclick.slice(catchAt);
  assert.ok(
    tail.includes("setCall("),
    "catch shows the failure in call status",
  );
  assert.ok(
    tail.includes('$("call-start").disabled = false'),
    "catch re-enables the start button",
  );
});
