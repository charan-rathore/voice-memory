// Figures for the problem stats and the "What it catches" grid. Each one is
// drawn from real numbers, with the math doing the work:
//   - 68.6%: exactly 686 of 1,000 dots, lit by a noisy wavefront (distance
//     field + smoothstep), the frontier briefly marked in highlighter yellow;
//   - 1 in 3: three real result rows, the third one unreadable (glyph scramble
//     driven by value noise), clearing for a moment now and then;
//   - 40M+ a day: questions travel Bézier streamlines into one point at
//     constant speed (arc-length parameterisation, not t), with a live count;
//   - catch cards: CSS keyframe scenes whose easing is a real damped spring,
//     sampled into a CSS linear() function (springCSS in motion-math).
// Everything pauses off-screen; reduced motion gets a single still frame.
import { springCSS, noise2, smoothstep, easeOutCubic, arcTable, pointAtDistance, expDecay, clamp01 } from "../motion-math.mjs";
import { animate, reducedMotion, onVisible } from "../motion-loop.mjs";

const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const still = reducedMotion();
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

function canvasFor(cv) {
  const dpr = Math.min(2, devicePixelRatio || 1);
  const ctx = cv.getContext("2d");
  const size = { w: 0, h: 0 };
  const fit = () => {
    const r = cv.getBoundingClientRect();
    if (!r.width) return false;
    size.w = r.width;
    size.h = r.height;
    cv.width = Math.round(r.width * dpr);
    cv.height = Math.round(r.height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return true;
  };
  return { ctx, size, fit };
}

/** Run `step(dt, t)` only while `el` is on screen; one frame for reduced motion. */
function whileVisible(el, step) {
  let stop = null,
    t = 0;
  onVisible(el, (vis) => {
    if (vis && !stop) {
      if (still) return void step(10, 10);
      stop = animate((dt) => {
        t += dt;
        step(dt, t);
        return true;
      });
    } else if (!vis && stop) {
      stop();
      stop = null;
    }
  });
}

// ------------------------------------------------------------ 68.6%: 686 of 1,000
function waffle(cv) {
  const { ctx, size, fit } = canvasFor(cv);
  const COLS = 50,
    ROWS = 20,
    LIT = 686;
  const ink = css("--ink") || "#161c2d",
    mark = css("--mark") || "#f4dc4a";
  // distance field from a seed point, roughened by value noise, so the
  // wavefront has an organic edge; rank by distance and light exactly 686
  const ox = COLS * 0.2,
    oy = ROWS * 0.55;
  const cells = [];
  for (let y = 0; y < ROWS; y++)
    for (let x = 0; x < COLS; x++) cells.push({ x, y, d: Math.hypot(x - ox, (y - oy) * 1.15) + 3.2 * noise2(x * 0.18, y * 0.18, 7) });
  const order = [...cells].sort((a, b) => a.d - b.d);
  order.forEach((c, i) => (c.lit = i < LIT));
  const dMax = order[LIT - 1].d;
  const pointer = { x: -1e3, y: -1e3, tx: -1e3, ty: -1e3 };
  cv.closest(".stat")?.addEventListener("pointermove", (e) => {
    const r = cv.getBoundingClientRect();
    pointer.tx = e.clientX - r.left;
    pointer.ty = e.clientY - r.top;
  });
  cv.closest(".stat")?.addEventListener("pointerleave", () => (pointer.tx = pointer.ty = -1e3));
  let flash = null,
    nextFlash = 3.2;
  whileVisible(cv, (dt, t) => {
    if (!size.w && !fit()) return;
    const { w, h } = size;
    const pitch = Math.min(w / COLS, h / ROWS),
      r0 = pitch * 0.3;
    pointer.x = expDecay(pointer.x, pointer.tx, 12, dt);
    pointer.y = expDecay(pointer.y, pointer.ty, 12, dt);
    const R = (dMax + 2.5) * easeOutCubic(clamp01((t - 0.15) / 2.2));
    // after the wave lands: now and then one more person opens their results
    if (!still && t > nextFlash) {
      const lit = order.slice(0, LIT);
      flash = { c: lit[(Math.random() * LIT) | 0], t };
      nextFlash = t + 0.9 + Math.random() * 1.6;
    }
    ctx.clearRect(0, 0, w, h);
    for (const c of cells) {
      const px = c.x * pitch + pitch / 2,
        py = c.y * pitch + pitch / 2;
      const a = c.lit ? smoothstep((R - c.d) / 2.2) : 0;
      const front = a * (1 - a) * 4; // 1 at the middle of the transition
      const near = smoothstep(1 - Math.hypot(px - pointer.x, py - pointer.y) / 46);
      let fl = 0;
      if (flash && flash.c === c) fl = Math.max(0, 1 - (t - flash.t) / 0.9);
      const rr = r0 * (1 + 0.55 * front + 0.45 * near + 0.7 * fl);
      ctx.beginPath();
      ctx.arc(px, py, rr, 0, Math.PI * 2);
      if (front > 0.15 || fl > 0.05) {
        ctx.fillStyle = mark;
        ctx.globalAlpha = 1;
      } else {
        ctx.fillStyle = ink;
        ctx.globalAlpha = 0.13 + 0.87 * a;
      }
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  });
  addEventListener("resize", () => (size.w = 0));
}

// ------------------------------------------------------------ 1 in 3: an unreadable result
function scramble(root) {
  const els = $$("[data-scramble]", root).map((el) => ({ el, text: el.textContent }));
  if (!els.length) return;
  const LOW = "abcdefghijklmnopqrstuvwxyz",
    DIG = "0123456789";
  const swap = (ch, k) => {
    if (/[0-9]/.test(ch)) return DIG[k % 10];
    if (/[a-z]/.test(ch)) return LOW[k % 26];
    if (/[A-Z]/.test(ch)) return LOW[k % 26].toUpperCase();
    return ch;
  };
  let acc = 0;
  whileVisible(root, (dt, t) => {
    if (still) return;
    acc += dt;
    if (acc < 1 / 14) return;
    acc = 0;
    // every 6 s the row resolves for a moment: what an explanation does
    const phase = t % 6;
    const clear = phase > 4.4 && phase < 5.4 ? 1 - Math.abs(phase - 4.9) / 0.5 : 0;
    els.forEach(({ el, text }, j) => {
      let out = "";
      for (let i = 0; i < text.length; i++) {
        const n = noise2(i * 0.7 + t * 3, j * 3.1, 11) * 0.5 + 0.5;
        out += n > 0.32 + clear * 0.8 ? swap(text[i], (Math.random() * 260) | 0) : text[i];
      }
      el.textContent = out;
    });
  });
}

// ------------------------------------------------------------ 40M+ a day: streams into one point
function streams(cv) {
  const { ctx, size, fit } = canvasFor(cv);
  const ink = css("--ink") || "#161c2d",
    mark = css("--mark") || "#f4dc4a",
    ink3 = css("--ink-3") || "#80859a";
  let curves = [],
    target = [0, 0];
  const build = () => {
    const { w, h } = size;
    target = [w - 26, h * 0.5];
    const N = 22;
    curves = [];
    for (let i = 0; i < N; i++) {
      const y0 = h * (0.06 + (0.88 * i) / (N - 1)) + noise2(i * 0.9, 0, 3) * 6;
      const p0 = [0, y0],
        p1 = [w * 0.38, y0 + noise2(i, 1, 5) * 10],
        p2 = [w * 0.62, target[1] + (y0 - target[1]) * 0.22],
        p3 = target;
      curves.push(arcTable(p0, p1, p2, p3, 48));
    }
  };
  // particles carry a distance along their curve, not a t: equal speed on
  // every curve regardless of how the control points bunch up
  const parts = Array.from({ length: 46 }, (_, i) => ({ c: i % 22, s: Math.random(), v: 0.75 + Math.random() * 0.5 }));
  let ring = 0;
  whileVisible(cv, (dt) => {
    if (!size.w) {
      if (!fit()) return;
      build();
    }
    const { w, h } = size;
    ctx.clearRect(0, 0, w, h);
    ctx.lineWidth = 1;
    ctx.strokeStyle = ink;
    ctx.globalAlpha = 0.09;
    for (const tb of curves) {
      const [p0, p1, p2, p3] = tb.pts;
      ctx.beginPath();
      ctx.moveTo(...p0);
      ctx.bezierCurveTo(...p1, ...p2, ...p3);
      ctx.stroke();
    }
    for (const p of parts) {
      const tb = curves[p.c];
      p.s += (dt * 70 * p.v) / tb.total;
      if (p.s >= 1) {
        p.s -= 1;
        p.c = (Math.random() * curves.length) | 0;
        ring = 1;
      }
      for (let k = 0; k < 5; k++) {
        const s = p.s * tb.total - k * 3.2;
        if (s < 0) break;
        const [x, y] = pointAtDistance(tb, s);
        ctx.globalAlpha = (0.25 + 0.75 * p.s) * (1 - k / 5);
        ctx.fillStyle = ink;
        ctx.beginPath();
        ctx.arc(x, y, k ? 1 : 1.6, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ring = expDecay(ring, 0, 5, dt);
    ctx.globalAlpha = 0.5 * ring;
    ctx.strokeStyle = ink;
    ctx.beginPath();
    ctx.arc(...target, 7 + 12 * (1 - ring), 0, Math.PI * 2);
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.fillStyle = mark;
    ctx.beginPath();
    ctx.arc(...target, 7, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = ink;
    ctx.beginPath();
    ctx.arc(...target, 2.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = ink3;
    ctx.font = "11px Plex, system-ui, sans-serif";
    ctx.textAlign = "right";
    ctx.fillText("one chatbot", w - 4, target[1] + 26);
  });
  addEventListener("resize", () => (size.w = 0));
}

function sinceCounter() {
  const el = document.querySelector("[data-since]");
  if (!el) return;
  const t0 = performance.now(),
    perSecond = 40e6 / 86400;
  const tick = () => (el.textContent = Math.floor(((performance.now() - t0) / 1000) * perSecond).toLocaleString("en-US"));
  tick();
  let timer = null;
  onVisible(el, (vis) => {
    clearInterval(timer);
    if (vis) timer = setInterval(tick, 120);
  });
}

// ------------------------------------------------------------ catch figures + spotlight
function springEasing() {
  const { easing, ms } = springCSS(15, 0.6, 40);
  if (CSS.supports?.("animation-timing-function", easing)) {
    document.documentElement.style.setProperty("--spring", easing);
    document.documentElement.style.setProperty("--spring-ms", ms + "ms");
  }
}
function playFigures() {
  if (still) return;
  for (const fig of $$(".fig")) {
    onVisible(fig, (vis) => fig.classList.toggle("play", vis), "-10% 0px");
    // pointing at a card replays its scene from the start
    fig.closest(".catch")?.addEventListener("pointerenter", () => {
      fig.classList.remove("play");
      void fig.offsetWidth;
      fig.classList.add("play");
    });
  }
}
function spotlight() {
  for (const el of $$(".stat, .catch")) {
    el.addEventListener("pointermove", (e) => {
      const r = el.getBoundingClientRect();
      el.style.setProperty("--mx", e.clientX - r.left + "px");
      el.style.setProperty("--my", e.clientY - r.top + "px");
    });
  }
}

export function mountFigures() {
  springEasing();
  spotlight();
  playFigures();
  sinceCounter();
  for (const cv of $$("canvas[data-art='waffle']")) waffle(cv);
  for (const cv of $$("canvas[data-art='streams']")) streams(cv);
  for (const el of $$(".fig-results")) scramble(el);
}
