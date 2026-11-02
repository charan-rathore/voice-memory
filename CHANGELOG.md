# Changelog

Each entry says what changed, why, and how it was checked.

## 2026-11-02 (branch `ux-v2`)

### Voice and conversation
- **Mixed questions** in one breath ("ferritin and also the deal fee", Hindi or
  Hinglish) are split by domain and answered part by part (`splitMixed`,
  `domainOf` in `src/conversation.mjs`). Typed questions about the other demo
  case come back as an `also` block with a one-click switch.
- **Help, upload and goodbye intents** in English, Hindi and Hinglish. "How do
  I upload my own reports?" switches the page to *Your documents* and
  highlights the drop zone (`runAction` in `site/site.js`).
- The assistant speaks in the first person with feminine Hindi forms
  throughout. "critical" is no longer misheard as Creatinine.
- Checked by replaying the five real Bolna call turns that failed
  (`evaluation/call-replay.mjs`); all now answer correctly.

### Evidence on the page
- The cited sentence, and only that sentence, is highlighted in the opened
  document (whitespace-tolerant span match; the whole-document highlight is gone).
- **Reworded questions: built, measured, kept off.** A "closest line, not an
  answer" pointer (opens the line in its document) with a single-file
  discovery gate and the promotion refusals, plus a new rule: no line from a
  preliminary or draft report the record amends. On outside data it was right
  65% (meetings) and 82% (contracts) of the time when shown, below the 90%
  bar, so it is off by default (`VM_CLOSEST_LINE=on`). The old gate's flaw it
  exposed (it showed a line for 86% of absent clauses) is fixed.

### Charts
- The overview became two or three report charts instead of many strips: a
  donut of where results sit against their printed ranges, each result on its
  own range with previous → current movement, a report timeline, and, for
  records, a decision donut and swimlanes. Every mark opens a detail panel.
  Browser-checked in `scripts/site-shots.mjs`.

### Landing page
- **Hero rebuilt** as a white evidence card (BoardUI/Cardboard references):
  one OKLCH colour family for supported, refused and proposed. Its motion
  physics: a critically damped tab thumb, an orbiting light while listening,
  an arc-length Catmull-Rom digit flight, gauge needles with galvanometer
  dynamics (ζ 0.42), and a minimum-jerk funnel tethered back before sign-off.
  New math (`minJerk`, `springImpulse`, `springTo`) is unit-tested.
- The "1 in 3" stats figure is calm again: no per-frame text changes.
- **For teams** section: use cases, MCP / Bolna / REST snippets, a pilot
  request template (`.github/ISSUE_TEMPLATE/pilot.yml`).
- First load 582 KB → 514 KB: saved memory graphs moved to a lazy
  `snapshot-graphs.js`; the budget test tightened to 530 KB.

### Integration and evaluation
- **MCP server** (`mcp/server.mjs`, zero dependencies, stdio), tested
  end to end against the engine.
- **Outside-authored benchmark** (`evaluation/outside-bench.mjs`): QMSum and
  CUAD at pinned commits. Hybrid top-1 42.1% and 50.0% (keyword 40.6% and
  44.0%; chance 5.3% and 1.2%), plus the discovery gate's calibration sweep.

### Known and not fixed here
- Production Listen says "Voice unavailable": no `VM_SARVAM_API_KEY` or
  `ELEVENLABS_API_KEY` is set on the host (`/api/public/status` reports
  `voiceOut.enabled: false`). The button is now hidden when voice is off.
