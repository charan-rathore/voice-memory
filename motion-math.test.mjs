// The landing page's motion math (site/motion-math.mjs): frame-rate
// independence, springs that never overshoot, arc-length accuracy, spline
// continuity, and CSS-equivalent cubic-bezier timing.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  expDecay,
  lerp,
  smoothDamp,
  bezier,
  arcTable,
  tAtDistance,
  pointAtDistance,
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

test("cubic-bezier timing matches the CSS reference curves", async () => {
  const { cubicBezierTiming } = await import("./site/motion-math.mjs");
  const ease = cubicBezierTiming(0.25, 0.1, 0.25, 1);
  // Chromium/WebKit value for `ease` at 50%
  assert.ok(Math.abs(ease(0.5) - 0.8024033877399112) < 1e-5);
  const linear = cubicBezierTiming(0, 0, 1, 1);
  for (const t of [0, 0.1, 0.37, 0.9, 1])
    assert.ok(Math.abs(linear(t) - t) < 1e-6);
  const site = cubicBezierTiming(0.2, 0.7, 0.2, 1);
  let prev = 0;
  for (let i = 1; i <= 100; i++) {
    const v = site(i / 100);
    assert.ok(v >= prev - 1e-9, "monotone");
    prev = v;
  }
  assert.equal(site(1), 1);
});

test("travel along a multi-segment path is continuous and ends at the end", async () => {
  const { catmullRom, pathOf, travel } = await import("./site/motion-math.mjs");
  const pts = [
    [0, 0],
    [40, -60],
    [120, -50],
    [160, 0],
  ];
  const path = pathOf(catmullRom(pts));
  const end = travel(path, path.total).p;
  assert.ok(Math.hypot(end[0] - 160, end[1]) < 1e-6);
  let last = travel(path, 0).p;
  for (let i = 1; i <= 200; i++) {
    const { p, tangent } = travel(path, (path.total * i) / 200);
    assert.ok(
      Math.hypot(p[0] - last[0], p[1] - last[1]) < (path.total / 200) * 1.05,
    );
    assert.ok(Math.abs(Math.hypot(...tangent) - 1) < 1e-9);
    last = p;
  }
});
