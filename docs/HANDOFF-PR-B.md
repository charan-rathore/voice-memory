# Handoff: PR B — interactive evidence journey (not started)

Base: `fix/canonical-question-plan` (PR A). Branch to create:
`feat/interactive-evidence-journey`. Nothing for PR B is implemented yet.
Written so another engineer or agent can start cold.

## Defects to repair first (located)

| Defect                                                             | Where                                                                                                |
| ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| Page strip is decorative, `aria-hidden`                            | `site/reading.js` `skeleton()`: `<div class="rd-pages" aria-hidden="true">` (~line 370)              |
| "2:00 budget" is a hard-coded promise                              | `site/reading.js` ~362-364 (`.rd-budget*`), painted in `paint()` ~475-480; CSS in `site/reading.css` |
| Numbered processing frames are static cards                        | `site/reading.js` `paintEngine()` (~687)                                                             |
| `lookup` is built from a document fact, not the visitor's question | `src/index-digest.mjs` `digestFor()`: `probe` / `probeLabel` / `lookup` block                        |
| Replay can read as live                                            | `site/reading.js` `replay` state and the `replay at N×` label in `paint()`                           |

## Plan

1. `src/index-digest.mjs`: drop `lookup` from the digest or rename it
   `indexExample` and keep `label: "Example of how indexing works — not your search."`
   attached in the payload itself, so no consumer can render it unlabelled.
2. Page strip: one `<button type="button" class="rd-page" data-page="n"
aria-label="Open page n of FILE">` per page; ≥44×44 px; `:focus-visible`
   ring; `aria-pressed` for the selected page; click/Enter/Space open the
   existing source viewer at that page. OCR-flagged pages get a text label
   ("OCR uncertain: …") and an "Open page to review" button.
3. Stages as `<details>` (or button + `aria-expanded` region): File received
   (name, type, bytes, received time), Pages read (count, per-page state),
   Records identified (boundaries, safe subject label, printed status, page
   links), Facts extracted (rows + exact citations), Evidence indexed
   (passage count, coverage; no score), Ready (focus `#q`, name workspace).
   All values from `entry.digest` / `entry.doc` / upload log — none invented.
4. Query activity: after a real ask, render from `final` (PR A):
   `citations` = admitted, `relatedEvidence` = related, `admittedText === null`
   = "No supported answer". Use the request id the server already returns.
   Never call the top candidate "the answer" unless it equals a citation.
5. Lab explanation order: What is this / What it measures / What this report
   showed / Against this lab's printed interval / What changed (a correction
   is a correction) / Why we trust this record. Points and corrections are
   buttons that open their source line.
6. Palette: canvas `#F6F5F1`, ink `#263448`, verified `#187D72`, pending
   `#AF7929`, conflict `#B6524C`, muted grey; every colour paired with text
   and a shape/icon.

## Motion rules (from emilkowalski/skills, `emil-design-eng`)

- Animate only `transform` and `opacity`; no `transition: all`.
- Enter/exit: ease-out `cubic-bezier(0.23, 1, 0.32, 1)`, under 300 ms;
  disclosures 150-250 ms. Never `ease-in`.
- Pressable tiles: `:active { transform: scale(0.97) }`, 100-160 ms.
- Never animate from `scale(0)`; start at `scale(0.95)` + `opacity: 0`.
- Hover effects only under `@media (hover: hover) and (pointer: fine)`.
- Use CSS transitions (interruptible), not keyframes, for state toggles.
- `prefers-reduced-motion: reduce`: keep opacity/colour, drop movement.
- No animation for keyboard-initiated actions or anything seen many times a
  minute; no idle/ambient motion (remove pings, glows, packet animation).
- Numbers that update: `font-variant-numeric: tabular-nums`.
- Stress with long file names, 100+ pages, 0 pages, failed OCR (`break-ui`).

## Tests to add

Playwright via `scripts/site-dev.mjs` (port 4500, as `tests/site-check.mjs`
does) at 320, 390, 768 and 1280 px: page tile opens matching page; every
stage shows real data; keyboard activation; tile ≥44 px; nothing clipped
under the viewer; OCR warning links to the right page; the example is
labelled; a real query maps to `final.citations`; unsupported/ambiguous
never render as confident; typed/voice parity still holds.
Screenshots before/after at 1280 and 390 px.

## Environment note

This sandbox has no npm registry. `node_modules` here is a local shim over
preinstalled tools (see `node_modules/README-SHIM.md`, not committed);
`playwright` and Chrome are available, so `test:browser` and
`test:call-ui` can be tried here; CI is the source of truth.
