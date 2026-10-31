// Motion math is tested like any other code: frame-rate independence,
// continuity and stability are properties, not vibes.
import test from "node:test";
import assert from "node:assert/strict";
import {
  expDecay,
  decayFromHalfLife,
  Spring,
  smootherstep,
  smoothstep,
  bezier,
} from "./public/motion.js";

test("expDecay is frame-rate independent (naive per-frame lerp is not)", () => {
  const lambda = decayFromHalfLife(0.25);
  const run = (fps, step) => {
    let a = 0;
    for (let i = 0; i < fps; i++) a = step(a, 1 / fps);
    return a;
  };
  const at30 = run(30, (a, dt) => expDecay(a, 1, lambda, dt));
  const at144 = run(144, (a, dt) => expDecay(a, 1, lambda, dt));
  assert.ok(Math.abs(at30 - at144) < 1e-9, `${at30} vs ${at144}`);
  assert.ok(
    Math.abs(at30 - (1 - 2 ** -4)) < 1e-9,
    "four half-lives in one second",
  );
  const naive30 = run(30, (a) => a + (1 - a) * 0.1);
  const naive144 = run(144, (a) => a + (1 - a) * 0.1);
  assert.ok(
    Math.abs(naive30 - naive144) > 0.03,
    "the naive form really does differ",
  );
});

test("half-life means half the remaining distance", () => {
  assert.ok(
    Math.abs(expDecay(0, 1, decayFromHalfLife(0.2), 0.2) - 0.5) < 1e-12,
  );
});

test("critically damped spring never overshoots; underdamped overshoots a little; both settle", () => {
  const crit = new Spring({ frequency: 3, damping: 1 }).set(1);
  const bouncy = new Spring({ frequency: 3, damping: 0.6 }).set(1);
  let maxC = 0,
    maxB = 0;
  for (let i = 0; i < 240; i++) {
    maxC = Math.max(maxC, crit.step(1 / 60));
    maxB = Math.max(maxB, bouncy.step(1 / 60));
  }
  assert.ok(maxC <= 1 + 1e-6, `critical overshoot ${maxC}`);
  assert.ok(maxB > 1.02 && maxB < 1.2, `underdamped overshoot ${maxB}`);
  assert.ok(crit.settled && bouncy.settled);
});

test("spring trajectory is the same at 30 and 144 fps (fixed substeps)", () => {
  const at = (fps) => {
    const s = new Spring({ frequency: 2.5, damping: 0.7 }).set(1);
    for (let i = 0; i < Math.round(fps * 0.4); i++) s.step(1 / fps);
    return s.value;
  };
  assert.ok(Math.abs(at(30) - at(144)) < 0.01, `${at(30)} vs ${at(144)}`);
});

test("spring stays stable on a long frame (tab switch)", () => {
  const s = new Spring({ frequency: 8, damping: 0.5 }).set(1);
  s.step(5);
  assert.ok(Number.isFinite(s.value) && Math.abs(s.value) < 2);
});

test("smootherstep is C2: zero slope and curvature at both ends; smoothstep is only C1", () => {
  const d = (f, t, h = 1e-4) => (f(t + h) - f(t - h)) / (2 * h);
  const d2 = (f, t, h = 1e-3) => (f(t + h) - 2 * f(t) + f(t - h)) / (h * h);
  for (const t of [0.0005, 0.9995]) {
    assert.ok(Math.abs(d(smootherstep, t)) < 1e-3);
    assert.ok(Math.abs(d2(smootherstep, t)) < 0.1);
  }
  assert.ok(
    Math.abs(d2(smoothstep, 0.001)) > 5,
    "smoothstep has a curvature jump at the ends",
  );
  assert.equal(smootherstep(0.5), 0.5);
});

test("cubic Bézier hits its endpoints and is symmetric", () => {
  const P = [
    [0, 0],
    [0, 1],
    [1, 1],
    [1, 0],
  ];
  assert.deepEqual(bezier(...P, 0), [0, 0]);
  assert.deepEqual(bezier(...P, 1), [1, 0]);
  const m = bezier(...P, 0.5);
  assert.ok(Math.abs(m[0] - 0.5) < 1e-12 && Math.abs(m[1] - 0.75) < 1e-12);
});
