// Motion primitives, from first principles (after Freya Holmér's talks on
// lerp smoothing, splines and continuity). Small, dependency-free, testable.
//
//  - expDecay: frame-rate independent smoothing. The naive a = lerp(a, b, k)
//    per frame converges faster at higher frame rates; b + (a-b)·e^(-λ·dt)
//    covers the same distance per second at any frame rate. λ = ln2 / halfLife.
//  - Spring: damped harmonic oscillator x'' = -ω²(x-target) - 2ζω·x',
//    parameterized by angular frequency ω and damping ratio ζ (ζ = 1 settles
//    without overshoot; ζ < 1 overshoots a little, which reads as "alive").
//    Integrated with semi-implicit Euler in fixed substeps (stable for large
//    dt, deterministic across frame rates).
//  - smootherstep: C2-continuous easing (zero velocity AND acceleration at
//    both ends), so sweeps start and stop without a visible jolt.
//  - bezier: cubic Bézier point/tangent for curved graph edges.
//  - loop: one requestAnimationFrame driver that sleeps when nothing moves.

export const LN2 = Math.log(2);
export const decayFromHalfLife = (halfLife) => LN2 / halfLife;

export function expDecay(a, b, lambda, dt) {
  return b + (a - b) * Math.exp(-lambda * dt);
}

export const clamp01 = (t) => (t < 0 ? 0 : t > 1 ? 1 : t);
export const smoothstep = (t) => ((t = clamp01(t)), t * t * (3 - 2 * t));
export const smootherstep = (t) => (
  (t = clamp01(t)),
  t * t * t * (t * (6 * t - 15) + 10)
);

export function bezier(p0, p1, p2, p3, t) {
  const u = 1 - t;
  const a = u * u * u,
    b = 3 * u * u * t,
    c = 3 * u * t * t,
    d = t * t * t;
  return [
    a * p0[0] + b * p1[0] + c * p2[0] + d * p3[0],
    a * p0[1] + b * p1[1] + c * p2[1] + d * p3[1],
  ];
}

export class Spring {
  /** @param {{frequency?: number, damping?: number, value?: number}} o
   *  frequency in Hz (oscillations per second), damping ratio ζ. */
  constructor({ frequency = 3, damping = 1, value = 0 } = {}) {
    this.omega = 2 * Math.PI * frequency;
    this.zeta = damping;
    this.value = value;
    this.target = value;
    this.velocity = 0;
  }
  set(target) {
    this.target = target;
    return this;
  }
  snap(value) {
    this.value = this.target = value;
    this.velocity = 0;
    return this;
  }
  step(dt) {
    const h = 1 / 240; // fixed substep: same trajectory at any frame rate
    let left = Math.min(dt, 0.1);
    while (left > 1e-9) {
      const s = Math.min(h, left);
      const acc =
        -this.omega * this.omega * (this.value - this.target) -
        2 * this.zeta * this.omega * this.velocity;
      this.velocity += acc * s;
      this.value += this.velocity * s;
      left -= s;
    }
    return this.value;
  }
  get settled() {
    return (
      Math.abs(this.value - this.target) < 1e-3 &&
      Math.abs(this.velocity) < 1e-3
    );
  }
}

export const prefersReducedMotion = () =>
  typeof matchMedia === "function" &&
  matchMedia("(prefers-reduced-motion: reduce)").matches;

/** One rAF driver. tick(dt) returns true while it still needs frames. */
export function loop(tick) {
  let last = 0;
  let id = 0;
  const frame = (t) => {
    const dt = last ? Math.min((t - last) / 1000, 0.1) : 1 / 60;
    last = t;
    if (tick(dt)) id = requestAnimationFrame(frame);
    else {
      id = 0;
      last = 0;
    }
  };
  return {
    wake() {
      if (!id) id = requestAnimationFrame(frame);
    },
    stop() {
      if (id) cancelAnimationFrame(id);
      id = 0;
      last = 0;
    },
  };
}

/** Animate an element's opacity/translate/scale with a spring (0 -> 1). */
export function springIn(
  el,
  { frequency = 2.6, damping = 0.72, rise = 10, scale = 0.96 } = {},
) {
  if (prefersReducedMotion()) {
    el.style.opacity = "1";
    el.style.transform = "none";
    return;
  }
  const s = new Spring({ frequency, damping, value: 0 }).set(1);
  const l = loop((dt) => {
    const v = s.step(dt);
    el.style.opacity = String(clamp01(v * 1.4));
    el.style.transform = `translateY(${((1 - v) * rise).toFixed(2)}px) scale(${(scale + (1 - scale) * v).toFixed(4)})`;
    if (s.settled) {
      el.style.transform = "none";
      return false;
    }
    return true;
  });
  l.wake();
}
