# Voice Memory landing page

Static site: `index.html`, `site.css`, `site.js`, self-hosted fonts. No build step
on Vercel and no third-party requests (CSP is `'self'` only).

Motion lives in `src/` and is bundled, with its open-source libraries, into
committed modules by `npm run build:site` (a test fails if they are stale):

| Bundle | Libraries | Loads |
| --- | --- | --- |
| `motion.bundle.mjs` | anime.js, Motion + `src/landing-motion.mjs` | with the page (~43 KB gzipped) |
| `graph3d.bundle.mjs` | three.js, postprocessing (bloom), three.quarks | when the memory-graph band nears the viewport; skipped for reduced motion |
| `tune.bundle.mjs` | Tweakpane | only with `?tune` |

What the math does, component by component:

- **Hero card:** the preliminary 5 travels a Catmull-Rom path (sampled by arc
  length, timed by a CSS-equivalent cubic-bezier solver) into the amended
  report and becomes the first digit of 50; the card leans toward the pointer
  on a critically damped spring.
- **Stats:** count-ups use the same cubic-bezier as the CSS transitions.
- **How it works:** a question travels an unseen spline through the four
  steps at constant speed; each card springs as it passes.
- **Live call:** the voice meter is a Catmull-Rom waveform through the real
  audio levels, smoothed with frame-rate independent exponential decay.
- **Memory graph:** the camera rides a closed spline; a `corrects` edge carries
  a particle comet from the old value to the new one along an arched spline,
  a `not comparable` edge one that stalls halfway.

Deployed on Vercel from this repo with Root Directory = `site`; every push to
`main` redeploys. Every answer shown in the hero replay is the current build's
real output on the fictional Northstar documents, and the quoted document lines
are verbatim from `examples/corpus-md/`. Keep it that way when copy changes.
