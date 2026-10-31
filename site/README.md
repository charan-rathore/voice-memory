# Voice Memory landing page

Static site: `index.html`, `site.css`, `site.js`, self-hosted fonts. No build step,
no third-party requests (CSP is `'self'` only).

Deployed on Vercel from this repo with Root Directory = `site`; every push to
`main` redeploys. Every answer shown in the hero replay is the current build's
real output on the fictional Northstar documents, and the quoted document lines
are verbatim from `corpus-md/`. Keep it that way when copy changes.
