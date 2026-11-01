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

/**
 * Control points for a tether from a word (p0) to a line on a page (p1).
 * It leaves the word heading `out` with a short handle (so it doesn't loop
 * back through the sentence) and arrives at the line heading `into` with a
 * longer one. Both handles grow with distance but are capped, so a long
 * tether stays calm instead of ballooning.
 */
export function tether(p0, p1, out = [0, 1], into = [1, 0], k0 = 0.28, k1 = 0.45) {
  const d = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]);
  const a = Math.min(140, k0 * d),
    b = Math.min(260, k1 * d);
  const n = Math.hypot(out[0], out[1]) || 1,
    m = Math.hypot(into[0], into[1]) || 1;
  return [
    p0,
    [p0[0] + (out[0] / n) * a, p0[1] + (out[1] / n) * a],
    [p1[0] - (into[0] / m) * b, p1[1] - (into[1] / m) * b],
    p1,
  ];
}
export const pathD = ([p0, p1, p2, p3]) =>
  `M${f(p0[0])} ${f(p0[1])}C${f(p1[0])} ${f(p1[1])} ${f(p2[0])} ${f(p2[1])} ${f(p3[0])} ${f(p3[1])}`;
const f = (n) => Math.round(n * 10) / 10;

// ------------------------------------------------------------ answer ↔ source
const norm = (s) => String(s ?? "").replace(/μ/g, "µ");
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Find, for each citation, the words in the answer that rest on it, so the
 * hero can tie them together. Uses only the cited table row (value + unit):
 * "50 ng/mL" first, then the bare value as a whole number that is not part of
 * a date, then the unit. Returns [{ cite, start, end }] in citation order;
 * a citation with no matching words is left out rather than guessed.
 */
export function anchorTokens(text, citations) {
  const t = norm(text);
  const used = [];
  const free = (s, e) => used.every(([a, b]) => e <= a || s >= b);
  const out = [];
  citations.forEach((c, i) => {
    const cells = c?.location?.focus?.rows?.[0]?.cells;
    if (!cells) return;
    const value = norm(cells[1]).trim(),
      unit = norm(cells[2]).trim();
    const tries = [];
    if (value && unit) tries.push(new RegExp(`${esc(value)}\\s?${esc(unit)}`, "g"));
    if (value)
      tries.push(
        new RegExp(
          `(?<![\\d.,])${esc(value)}(?![\\d.,]|\\s(?:January|February|March|April|May|June|July|August|September|October|November|December))`,
          "g",
        ),
      );
    if (unit) tries.push(new RegExp(`(?<![\\w/])${esc(unit)}(?![\\w/])`, "g"));
    for (const re of tries) {
      let m,
        hit = null;
      while ((m = re.exec(t))) {
        if (free(m.index, m.index + m[0].length)) {
          hit = m;
          break;
        }
      }
      if (hit) {
        used.push([hit.index, hit.index + hit[0].length]);
        out.push({ cite: i, start: hit.index, end: hit.index + hit[0].length });
        return;
      }
    }
  });
  return out;
}

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
