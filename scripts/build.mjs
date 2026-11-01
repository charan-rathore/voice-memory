import { build } from "esbuild";
import path from "node:path";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url),
  memo = path.resolve("vendor/memorable/src");
await build({
  entryPoints: {
    engine: "src/engine.ts",
    "query-expand": "src/query-expand.ts",
    "evaluation/baseline-entry": "evaluation/baseline-entry.ts",
  },
  bundle: true,
  platform: "node",
  format: "esm",
  outdir: "dist",
  outExtension: { ".js": ".mjs" },
  plugins: [
    {
      name: "memo-alias",
      setup(b) {
        b.onResolve({ filter: /^@\// }, (args) => {
          const p = path.join(memo, args.path.slice(2));
          return {
            path: existsSync(p + ".ts") ? p + ".ts" : path.join(p, "index.ts"),
          };
        });
        b.onResolve({ filter: /^zod$/ }, () => ({
          path: require.resolve("zod"),
        }));
      },
    },
  ],
});
