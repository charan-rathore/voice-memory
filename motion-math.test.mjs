// The landing page's motion math (site/motion-math.mjs): frame-rate
// independence, springs that never overshoot, arc-length accuracy, and the
// answer-to-source anchoring the hero tethers rely on, checked against the
// real saved engine answers in site/snapshot.js.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import {
  expDecay,
  lerp,
  smoothDamp,
  bezier,
  arcTable,
  tAtDistance,
  pointAtDistance,
  tether,
  anchorTokens,
  decayFromHalfLife,
} from "./site/motion-math.mjs";

const run = (hz, seconds, step) => {
  let x = 0;
  const dt = 1 / hz;
  for (let i = 0; i < Math.round(hz * seconds); i++) x = step(x, dt);
  return x;
};

test("exponential decay lands in the same place at 30, 60 and 144 Hz", () => {
  const at = (hz) => run(hz, 0.5, (x, dt) => expDecay(x, 100, 8, dt));
  assert.ok(Math.abs(at(30) - at(60)) < 1e-9);
  assert.ok(Math.abs(at(60) - at(144)) < 1e-9);
});

test("per-frame lerp does not (the bug exponential decay fixes)", () => {
  const at = (hz) => run(hz, 0.25, (x) => lerp(x, 100, 0.1));
  assert.ok(
    Math.abs(at(60) - at(144)) > 5,
    "naive lerp is frame-rate dependent",
  );
});

test("half-life decay halves the distance in exactly one half-life", () => {
  const x = run(120, 0.25, (x, dt) =>
    expDecay(x, 1, decayFromHalfLife(0.25), dt),
  );
  assert.ok(Math.abs(x - 0.5) < 1e-9);
});

test("critically damped spring never overshoots and settles", () => {
  for (const hz of [24, 60, 144]) {
    const s = { x: 0, v: 0 };
    let max = 0;
    for (let i = 0; i < hz * 2; i++) {
      smoothDamp(s, 1, 0.3, 1 / hz);
      max = Math.max(max, s.x);
    }
    assert.ok(max <= 1 + 1e-12, `overshoot at ${hz} Hz: ${max}`);
    assert.ok(Math.abs(s.x - 1) < 1e-3, `settled at ${hz} Hz`);
  }
});

// A tether-like curve with a long handle at one end, so raw t bunches up.
const C = [
  [0, 0],
  [0, 260],
  [300, 400],
  [520, 400],
];

test("arc-length table matches a dense measurement within 0.1%", () => {
  const coarse = arcTable(...C, 64).total;
  const fine = arcTable(...C, 8192).total;
  assert.ok(Math.abs(coarse - fine) / fine < 0.001, `${coarse} vs ${fine}`);
});

test("travelling by distance gives even steps, travelling by t does not", () => {
  const tb = arcTable(...C, 128);
  const byS = [],
    byT = [];
  for (let i = 0; i <= 20; i++) {
    byS.push(pointAtDistance(tb, (tb.total * i) / 20));
    byT.push(bezier(...C, i / 20));
  }
  const steps = (ps) =>
    ps.slice(1).map((p, i) => Math.hypot(p[0] - ps[i][0], p[1] - ps[i][1]));
  const spread = (xs) => (Math.max(...xs) - Math.min(...xs)) / Math.max(...xs);
  assert.ok(spread(steps(byS)) < 0.02, "arc-length steps are even");
  assert.ok(spread(steps(byT)) > 0.1, "raw-t steps are uneven");
  assert.equal(tAtDistance(tb, -1), 0);
  assert.equal(tAtDistance(tb, tb.total + 1), 1);
});

test("tether handles stay bounded for long tethers", () => {
  const [, c1, c2] = tether([0, 0], [2000, 900]);
  assert.ok(Math.hypot(c1[0], c1[1]) <= 260 + 1e-9);
  assert.ok(Math.hypot(2000 - c2[0], 900 - c2[1]) <= 260 + 1e-9);
});

// ------------------------------------------------------------ anchoring
const sandbox = { window: {} };
vm.runInNewContext(
  readFileSync(new URL("./site/snapshot.js", import.meta.url), "utf8"),
  sandbox,
);
const snap = sandbox.window.VM_SNAPSHOT;
const lead = (k) => snap.answers[k].lead;
const words = (l) =>
  anchorTokens(l.text, l.citations).map((a) => ({
    title: l.citations[a.cite].title,
    word: l.text.replace(/μ/g, "µ").slice(a.start, a.end),
    start: a.start,
  }));

test("ferritin: 50 ng/mL ties to the amended row, the 5 to the preliminary row", () => {
  const l = lead("health|What is SYN-0001's ferritin result?");
  const w = words(l);
  assert.deepEqual(
    w.map((x) => [x.title, x.word]),
    [
      ["a-2026-10-amended.pdf", "50 ng/mL"],
      ["a-2026-10-prelim.pdf", "5"],
    ],
  );
  assert.ok(l.text.slice(w[1].start - 5, w[1].start + 6).includes("from 5 to"));
});

test("creatinine: each unit ties to the report that uses it, dates are never anchors", () => {
  const l = lead("health|Has creatinine gone up since September?");
  assert.deepEqual(
    words(l).map((x) => [x.title, x.word]),
    [
      ["a-2026-10-amended.pdf", "µmol/L"],
      ["a-2026-09.pdf", "mg/dL"],
    ],
  );
});

test("every saved answer's anchors are real words in the answer, never inside a date", () => {
  for (const [k, a] of Object.entries(snap.answers)) {
    const l = a.lead;
    if (!l?.citations?.length) continue;
    for (const x of words(l)) {
      assert.ok(x.word.trim().length > 0, k);
      assert.doesNotMatch(
        l.text.slice(x.start, x.start + x.word.length + 10),
        /^\d+ (January|February|March|April|May|June|July|August|September|October|November|December)/,
        k,
      );
    }
  }
});

test("Catmull-Rom passes through every station with a continuous tangent", async () => {
  const { catmullRom, bezierDeriv } = await import("./site/motion-math.mjs");
  const pts = [
    [60, 150],
    [330, 128],
    [600, 172],
    [870, 138],
    [1140, 150],
  ];
  const segs = catmullRom(pts);
  assert.equal(segs.length, 4);
  segs.forEach((s, i) => {
    assert.deepEqual(s[0], pts[i]);
    assert.deepEqual(s[3], pts[i + 1]);
  });
  for (let i = 0; i < segs.length - 1; i++) {
    const a = bezierDeriv(...segs[i], 1),
      b = bezierDeriv(...segs[i + 1], 0);
    assert.ok(
      Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-9,
      "C1 at station " + (i + 1),
    );
  }
});
