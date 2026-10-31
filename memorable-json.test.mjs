import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";

test("memoRABLE JSON import gives the same plain-language diagnostics under zod 4", async () => {
  const out = await build({
    entryPoints: [
      new URL("./vendor-tests/memorable-json.ts", import.meta.url).pathname,
    ],
    bundle: true,
    write: false,
    format: "esm",
    platform: "node",
    logLevel: "silent",
  });
  const mod = await import(
    "data:text/javascript;base64," +
      Buffer.from(out.outputFiles[0].text).toString("base64")
  );
  const r = mod.run();
  assert.deepEqual(r.valid, ["ok"]);
  assert.ok(
    r.badKind.some((d) => d.startsWith("json.unknown-kind|")),
    JSON.stringify(r.badKind),
  );
  assert.ok(
    r.badType.some(
      (d) => d === "json.invalid-field|Expected string but found number.",
    ),
    JSON.stringify(r.badType),
  );
  assert.ok(
    r.extra.some((d) => d.startsWith('json.unknown-key|Unknown key "colour"')),
    JSON.stringify(r.extra),
  );
  assert.ok(
    r.badVersion.some((d) => d.startsWith("json.unsupported-version|")),
    JSON.stringify(r.badVersion),
  );
});
