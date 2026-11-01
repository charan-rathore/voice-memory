// Motion math for the landing page. Pure functions, no DOM, so the same file
// runs in the browser and under `node --test` (motion-math.test.mjs).
//
// References (Freya Holmér):
//   - "Lerp smoothing is broken" — `a = lerp(a, b, k)` per frame depends on the
//     frame rate. The fix is exponential decay with dt:
//     a = b + (a - b) * exp(-decay * dt).  https://acegikmo.substack.com/p/lerp-smoothing-is-broken
//   - "The Beauty of Bézier Curves" / "The Continuity of Splines" — cubic
//     Bézier evaluation, derivatives, and why `t` is not distance: a curve
//     sampled at even `t` moves at uneven speed, so anything that travels or
//     draws at a steady pace needs an arc-length table.

export const lerp = (a, b, t) => a + (b - a) * t;
export const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
export const invLerp = (a, b, v) => (a === b ? 0 : (v - a) / (b - a));
export const remap = (a, b, c, d, v) => lerp(c, d, invLerp(a, b, v));

// ------------------------------------------------------------ easing
export const smoothstep = (t) => ((t = clamp01(t)), t * t * (3 - 2 * t));
export const easeOutCubic = (t) => 1 - Math.pow(1 - clamp01(t), 3);
export const easeInOutCubic = (t) => {
  t = clamp01(t);
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
};

// ------------------------------------------------------------ damping
/** Frame-rate independent smoothing toward `b`. `decay` ≈ 1 (slow) … 25 (snappy). */
export const expDecay = (a, b, decay, dt) => b + (a - b) * Math.exp(-decay * dt);
/** Decay constant that halves the remaining distance every `halfLife` seconds. */
export const decayFromHalfLife = (halfLife) => Math.LN2 / halfLife;

/**
 * Critically damped spring (no overshoot), the closed-form approximation from
 * Game Programming Gems 4 §1.10 that Unity's SmoothDamp uses. Mutates `s`
 * ({ x, v }) toward `target`; `smoothTime` ≈ time to reach the target.
 */
export function smoothDamp(s, target, smoothTime, dt) {
  const omega = 2 / Math.max(1e-4, smoothTime);
  const x = omega * dt;
  const exp = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
  const change = s.x - target;
  const temp = (s.v + omega * change) * dt;
  s.v = (s.v - omega * temp) * exp;
  let out = target + (change + temp) * exp;
  // never pass the target (the approximation can by a hair at large dt)
  if (target - s.x > 0 === out > target) {
    out = target;
    s.v = 0;
  }
  s.x = out;
  return s;
}

// ------------------------------------------------------------ cubic Bézier
/** Point on a cubic Bézier: Bernstein form. Points are [x, y]. */
export function bezier(p0, p1, p2, p3, t) {
  const u = 1 - t,
    a = u * u * u,
    b = 3 * u * u * t,
    c = 3 * u * t * t,
    d = t * t * t;
  return [
    a * p0[0] + b * p1[0] + c * p2[0] + d * p3[0],
    a * p0[1] + b * p1[1] + c * p2[1] + d * p3[1],
  ];
}
/** First derivative (velocity) of the cubic at t. */
export function bezierDeriv(p0, p1, p2, p3, t) {
  const u = 1 - t,
    a = 3 * u * u,
    b = 6 * u * t,
    c = 3 * t * t;
  return [
    a * (p1[0] - p0[0]) + b * (p2[0] - p1[0]) + c * (p3[0] - p2[0]),
    a * (p1[1] - p0[1]) + b * (p2[1] - p1[1]) + c * (p3[1] - p2[1]),
  ];
}

/**
 * Arc-length lookup table: cumulative distance at n+1 evenly spaced t.
 * With n = 64 the error against the true length is well under 0.1% for the
 * gentle S-curves drawn here (checked in the test).
 */
export function arcTable(p0, p1, p2, p3, n = 64) {
  const lengths = new Float64Array(n + 1);
  let prev = p0,
    total = 0;
  for (let i = 1; i <= n; i++) {
    const p = bezier(p0, p1, p2, p3, i / n);
    total += Math.hypot(p[0] - prev[0], p[1] - prev[1]);
    lengths[i] = total;
    prev = p;
  }
  return { lengths, total, n, pts: [p0, p1, p2, p3] };
}
/** The t at which the curve has travelled distance s (binary search + lerp). */
export function tAtDistance(table, s) {
  const { lengths, n, total } = table;
  if (s <= 0) return 0;
  if (s >= total) return 1;
  let lo = 0,
    hi = n;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (lengths[mid] < s) lo = mid;
    else hi = mid;
  }
  const seg = lengths[hi] - lengths[lo];
  return (lo + (seg > 0 ? (s - lengths[lo]) / seg : 0)) / n;
}
export const pointAtDistance = (table, s) =>
  bezier(...table.pts, tAtDistance(table, s));

export const pathD = ([p0, p1, p2, p3]) =>
  `M${f(p0[0])} ${f(p0[1])}C${f(p1[0])} ${f(p1[1])} ${f(p2[0])} ${f(p2[1])} ${f(p3[0])} ${f(p3[1])}`;
const f = (n) => Math.round(n * 10) / 10;

// ------------------------------------------------------------ splines
/**
 * Uniform Catmull-Rom spline through `pts`, as cubic Bézier segments. The
 * curve passes through every point with a continuous tangent (C1), which is
 * what lets the pipeline line flow through its stations without kinks.
 * Endpoints are mirrored so the first and last segments are well defined.
 */
export function catmullRom(pts) {
  const p = (i) => {
    if (i < 0) return [2 * pts[0][0] - pts[1][0], 2 * pts[0][1] - pts[1][1]];
    const n = pts.length - 1;
    if (i > n) return [2 * pts[n][0] - pts[n - 1][0], 2 * pts[n][1] - pts[n - 1][1]];
    return pts[i];
  };
  const segs = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = p(i - 1),
      p1 = p(i),
      p2 = p(i + 1),
      p3 = p(i + 2);
    segs.push([
      p1,
      [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6],
      [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6],
      p2,
    ]);
  }
  return segs;
}
export const segsD = (segs) =>
  segs
    .map((s, i) => (i ? pathD(s).replace(/^M[^C]+/, "") : pathD(s)))
    .join("");

// ------------------------------------------------------------ timing curves
/**
 * CSS-style cubic-bezier(x1, y1, x2, y2) timing function: for progress t,
 * find s with Bx(s) = t (Newton-Raphson, falling back to bisection, as
 * browser engines do), then return By(s). Lets JS-driven motion land on
 * exactly the same curve as the page's CSS transitions.
 */
export function cubicBezierTiming(x1, y1, x2, y2) {
  const cx = 3 * x1,
    bx = 3 * (x2 - x1) - cx,
    ax = 1 - cx - bx;
  const cy = 3 * y1,
    by = 3 * (y2 - y1) - cy,
    ay = 1 - cy - by;
  const X = (s) => ((ax * s + bx) * s + cx) * s;
  const Y = (s) => ((ay * s + by) * s + cy) * s;
  const dX = (s) => (3 * ax * s + 2 * bx) * s + cx;
  const solve = (t) => {
    let s = t;
    for (let i = 0; i < 8; i++) {
      const e = X(s) - t;
      if (Math.abs(e) < 1e-7) return s;
      const d = dX(s);
      if (Math.abs(d) < 1e-6) break;
      s -= e / d;
    }
    let lo = 0,
      hi = 1;
    s = t;
    while (hi - lo > 1e-7) {
      if (X(s) < t) lo = s;
      else hi = s;
      s = (lo + hi) / 2;
    }
    return s;
  };
  return (t) => (t <= 0 ? 0 : t >= 1 ? 1 : Y(solve(t)));
}

// ------------------------------------------------------------ paths
/** Measure a chain of Bézier segments once, for travel by distance. */
export function pathOf(segs, n = 48) {
  const tables = segs.map((s) => arcTable(...s, n));
  return { tables, total: tables.reduce((a, t) => a + t.total, 0) };
}
/** Point and unit tangent at distance s along a measured path. */
export function travel(path, s) {
  let rest = Math.max(0, Math.min(path.total, s));
  for (const tb of path.tables) {
    if (rest <= tb.total || tb === path.tables.at(-1)) {
      const t = tAtDistance(tb, rest);
      const p = bezier(...tb.pts, t);
      const d = bezierDeriv(...tb.pts, t);
      const m = Math.hypot(d[0], d[1]) || 1;
      return { p, tangent: [d[0] / m, d[1] / m] };
    }
    rest -= tb.total;
  }
}
