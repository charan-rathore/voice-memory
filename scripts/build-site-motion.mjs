// Bundles the landing's motion code and its open-source libraries into
// self-hosted ES modules under site/ (the site has no build step on Vercel
// and its CSP only allows its own origin, so the bundles are committed):
//   site/motion.bundle.mjs   anime.js + Motion + landing-motion (eager, small)
//   site/graph3d.bundle.mjs  three + postprocessing + three.quarks (lazy)
//   site/tune.bundle.mjs     Tweakpane panel for ?tune (lazy)
//   node scripts/build-site-motion.mjs
import { build } from "esbuild";

const common = {
  bundle: true,
  format: "esm",
  minify: true,
  target: "es2022",
  legalComments: "eof",
  logLevel: "info",
};
await build({
  ...common,
  entryPoints: { "motion.bundle": "site/src/entry.mjs" },
  outdir: "site",
  outExtension: { ".js": ".mjs" },
});
await build({
  ...common,
  entryPoints: { "graph3d.bundle": "site/src/graph3d.mjs" },
  outdir: "site",
  outExtension: { ".js": ".mjs" },
});
await build({
  ...common,
  entryPoints: { "tune.bundle": "site/src/tune.mjs" },
  outdir: "site",
  outExtension: { ".js": ".mjs" },
});
