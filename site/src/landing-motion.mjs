// Landing motion. Splines and springs applied inside the existing
// components, never drawn as decoration:
//   - hero card: the preliminary 5 travels a Catmull-Rom path into the
//     amended report and becomes the first digit of 50; the card leans
//     toward the pointer on a critically damped spring;
//   - stats: count-ups timed by the same cubic-bezier as the CSS;
//   - how it works: a question travels an unseen spline through the four
//     steps, and each card reacts as it passes;
//   - live call: the voice meter is a Catmull-Rom waveform through the real
//     audio levels;
//   - catch cards: the question flies to the answer desk (Motion spring).
// Bundled by scripts/build-site-motion.mjs into site/motion.bundle.mjs.
import { createTimeline, animate as anime } from "animejs";
import { animate as motionAnimate } from "motion";
import {
  catmullRom,
  pathOf,
  travel,
  cubicBezierTiming,
  smoothDamp,
  expDecay,
  lerp,
} from "../motion-math.mjs";
import { animate as loop, onVisible, reducedMotion } from "../motion-loop.mjs";

// Tunable from the ?tune panel (scripts/../src/tune.mjs).
export const P = {
  flightMs: 1150,
  flightEase: [0.65, 0, 0.35, 1],
  lift: 64,
  tiltDeg: 5,
  tiltSmooth: 0.18,
  tokenSpeed: 520,
  meterSamples: 28,
};
const still = reducedMotion();
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const rgb = (el) =>
  getComputedStyle(el)
    .color.match(/\d+(\.\d+)?/g)
    .slice(0, 3)
    .map(Number);
const rel = (r, base) => ({ x: r.left - base.left, y: r.top - base.top, w: r.width, h: r.height });

// ------------------------------------------------------------ hero card
export async function heroFlight() {
  const card = $(".hero-card");
  if (!card || still) return;
  const from = $(".hc-val.prelim .hc-num s", card);
  const to5 = $(".hc-val.amended .hc-d5", card);
  const to0 = $(".hc-val.amended .hc-d0", card);
  const amended = $(".hc-val.amended", card);
  if (!from || !to5 || !to0) return;
  // JS owns the amended box's entrance, so its layout is final when the
  // flight path is measured (the CSS version slid it 10px).
  card.classList.add("hc-motion");
  await document.fonts?.ready;
  const base = card.getBoundingClientRect();
  const a = rel(from.getBoundingClientRect(), base);
  const b = rel(to5.getBoundingClientRect(), base);
  const ghost = document.createElement("span");
  ghost.className = "hc-ghost";
  ghost.textContent = "5";
  const fs = getComputedStyle(from);
  Object.assign(ghost.style, { fontSize: fs.fontSize, lineHeight: fs.lineHeight, fontFamily: fs.fontFamily, letterSpacing: fs.letterSpacing });
  ghost.setAttribute("aria-hidden", "true");
  card.appendChild(ghost);
  const c0 = rgb(from),
    c1 = rgb(to5);
  // Path through the glyphs' top-left corners: lift off the struck value,
  // arc over the arrow, settle into the first digit of the amended value.
  const pts = [
    [a.x, a.y],
    [a.x + 18, a.y - P.lift * 0.75],
    [(a.x + b.x) / 2, Math.min(a.y, b.y) - P.lift],
    [b.x - 20, b.y - P.lift * 0.45],
    [b.x, b.y],
  ];
  const path = pathOf(catmullRom(pts));
  const ease = cubicBezierTiming(...P.flightEase);
  const place = (u) => {
    const { p, tangent } = travel(path, path.total * u);
    // lean into the direction of travel, upright again on landing
    const lean = Math.atan2(tangent[1], tangent[0]) * 0.18 * Math.sin(Math.PI * u);
    const c = c0.map((v, i) => Math.round(lerp(v, c1[i], u)));
    ghost.style.transform = `translate3d(${p[0]}px, ${p[1]}px, 0) rotate(${lean}rad) scale(${1 + 0.12 * Math.sin(Math.PI * u)})`;
    ghost.style.color = `rgb(${c})`;
  };
  place(0);
  ghost.style.opacity = "0";
  const flight = { u: 0 };
  createTimeline()
    .add(ghost, { opacity: [0, 1], duration: 160, ease: "linear" }, 1050)
    .add(amended, { opacity: [0, 1], duration: 420, ease: "out(3)" }, 1250)
    .add(
      flight,
      {
        u: [0, 1],
        duration: P.flightMs,
        ease, // the bezier solver, so JS and CSS curves agree
        onUpdate: () => place(flight.u),
      },
      1100,
    )
    .call(() => {
      to5.style.opacity = "1";
      ghost.remove();
    }, 1100 + P.flightMs)
    .add(to0, { opacity: [0, 1], scale: [0.55, 1], duration: 520, ease: "outBack(2.2)" }, 1100 + P.flightMs + 20);
}

export function heroTilt() {
  const card = $(".hero-card");
  if (!card || still || !matchMedia("(hover: hover)").matches) return;
  const rx = { x: 0, v: 0 },
    ry = { x: 0, v: 0 };
  let tx = 0,
    ty = 0,
    running = null;
  const step = (dt) => {
    smoothDamp(rx, tx, P.tiltSmooth, dt);
    smoothDamp(ry, ty, P.tiltSmooth, dt);
    card.style.transform = `perspective(1100px) rotateX(${rx.x}deg) rotateY(${ry.x}deg)`;
    const settled = Math.abs(rx.x - tx) + Math.abs(ry.x - ty) + Math.abs(rx.v) + Math.abs(ry.v) < 0.002;
    if (settled && tx === 0 && ty === 0) {
      card.style.transform = "";
      running = null;
      return false;
    }
    return true;
  };
  const wake = () => (running ??= loop(step));
  card.addEventListener("pointermove", (e) => {
    const r = card.getBoundingClientRect();
    const nx = (e.clientX - r.left) / r.width - 0.5,
      ny = (e.clientY - r.top) / r.height - 0.5;
    tx = -ny * P.tiltDeg;
    ty = nx * P.tiltDeg;
    wake();
  });
  card.addEventListener("pointerleave", () => {
    tx = ty = 0;
    wake();
  });
}

// ------------------------------------------------------------ stats
export function statCounts() {
  const ease = cubicBezierTiming(0.2, 0.7, 0.2, 1); // --ease in site.css
  for (const num of $$(".stat-num[data-count]")) {
    if (still) continue;
    const to = Number(num.dataset.count),
      pre = num.dataset.prefix ?? "",
      suf = num.dataset.suffix ?? "",
      dec = String(to).includes(".") ? 1 : 0;
    const final = num.textContent;
    const stop = onVisible(
      num,
      (vis) => {
        if (!vis) return;
        stop();
        const o = { v: 0 };
        anime(o, {
          v: to,
          duration: 1300,
          ease,
          onUpdate: () => (num.textContent = pre + o.v.toFixed(dec) + suf),
          onComplete: () => (num.textContent = final),
        });
      },
      "0px",
    );
  }
}

// ------------------------------------------------------------ how it works
export function pipelineToken() {
  const pipe = $(".pipe");
  if (!pipe || still) return;
  const items = $$("li", pipe);
  const host = pipe.parentElement;
  host.style.position = "relative";
  const dot = document.createElement("span");
  dot.className = "pipe-token";
  dot.setAttribute("aria-hidden", "true");
  host.appendChild(dot);
  const springs = items.map(() => ({ x: 0, v: 0, target: 0 }));
  let running = null;
  const play = () => {
    if (running) return;
    const hb = host.getBoundingClientRect();
    // anchors: just above each step's number, so the question visibly
    // "arrives" at each step in order (Catmull-Rom passes through all)
    const anchors = items.map((li) => {
      const n = $(".pipe-n", li).getBoundingClientRect();
      return [n.left - hb.left + 8, n.top - hb.top - 12];
    });
    const start = [anchors[0][0] - 60, anchors[0][1] - 30],
      end = [anchors.at(-1)[0] + 60, anchors.at(-1)[1] - 30];
    const path = pathOf(catmullRom([start, ...anchors, end]));
    let s = 0;
    dot.style.opacity = "1";
    // the reveal transition would smear per-frame transforms
    items.forEach((li) => (li.style.transition = "opacity 600ms"));
    running = loop((dt) => {
      s += P.tokenSpeed * dt; // constant speed: distance, not t
      const { p } = travel(path, s);
      dot.style.transform = `translate3d(${p[0]}px, ${p[1]}px, 0)`;
      anchors.forEach((q, i) => {
        if (Math.hypot(q[0] - p[0], q[1] - p[1]) < 26) springs[i].target = 1;
      });
      let moving = s < path.total;
      items.forEach((li, i) => {
        const sp = springs[i];
        smoothDamp(sp, sp.target, 0.16, dt);
        if (sp.target === 1 && sp.x > 0.98) sp.target = 0; // kick, then settle
        li.style.transform = `translateY(${-6 * sp.x}px)`;
        li.style.boxShadow = sp.x > 0.01 ? `0 ${10 * sp.x}px ${24 * sp.x}px -16px rgba(22,28,45,${0.5 * sp.x})` : "";
        if (Math.abs(sp.x) > 0.001 || sp.target) moving = true;
      });
      if (s >= path.total) dot.style.opacity = "0";
      if (!moving) {
        items.forEach((li) => (li.style.transform = li.style.boxShadow = li.style.transition = ""));
        running = null;
        return false;
      }
      return true;
    });
  };
  const stop = onVisible(pipe, (vis) => vis && (stop(), setTimeout(play, 1150)), "-20% 0px");
  let last = 0;
  pipe.addEventListener("pointerenter", () => {
    if (performance.now() - last > 4000) ((last = performance.now()), play());
  });
}

// ------------------------------------------------------------ live call meter
export function splineMeter() {
  const box = $(".call-meter");
  if (!box) return;
  const cv = document.createElement("canvas");
  const W = 92,
    H = 26,
    dpr = Math.min(2, devicePixelRatio || 1);
  cv.width = W * dpr;
  cv.height = H * dpr;
  cv.style.width = W + "px";
  cv.style.height = H + "px";
  box.appendChild(cv);
  box.classList.add("spline");
  const ctx = cv.getContext("2d");
  ctx.scale(dpr, dpr);
  const N = P.meterSamples;
  const buf = new Float32Array(N);
  let level = 0,
    target = 0,
    running = null,
    ended = true;
  const color = getComputedStyle(document.documentElement).getPropertyValue("--mark").trim() || "#f4dc4a";
  const draw = () => {
    ctx.clearRect(0, 0, W, H);
    const mid = H / 2;
    // top envelope through the samples, then the mirror image back
    const top = [...buf].map((v, i) => [(i / (N - 1)) * W, mid - Math.min(mid - 1, 1 + v * (mid - 2))]);
    const bot = top.map(([x, y]) => [x, 2 * mid - y]).reverse();
    const segsT = catmullRom(top),
      segsB = catmullRom(bot);
    ctx.beginPath();
    ctx.moveTo(...top[0]);
    for (const [, c1, c2, p] of segsT) ctx.bezierCurveTo(...c1, ...c2, ...p);
    ctx.lineTo(...bot[0]);
    for (const [, c1, c2, p] of segsB) ctx.bezierCurveTo(...c1, ...c2, ...p);
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.globalAlpha = 0.9;
    ctx.fill();
  };
  draw();
  let acc = 0;
  const step = (dt) => {
    // smooth the raw level (frame-rate independent), shift a sample in at
    // a fixed 30 Hz so the waveform scrolls at the same speed everywhere
    level = expDecay(level, target, 14, dt);
    target = expDecay(target, 0, 3, dt);
    acc += dt;
    while (acc > 1 / 30) {
      acc -= 1 / 30;
      buf.copyWithin(0, 1);
      buf[N - 1] = still ? 0 : level * (0.75 + 0.25 * Math.sin(performance.now() / 90));
    }
    draw();
    const quiet = buf.every((v) => v < 0.01);
    if (ended && quiet) {
      running = null;
      return false;
    }
    return true;
  };
  document.addEventListener("vm:level", (e) => {
    const v = e.detail;
    if (v < 0) ended = true;
    else ((ended = false), (target = Math.max(target, Math.min(1, v * 1.6))));
    running ??= loop(step);
  });
}

// ------------------------------------------------------------ catch cards
export function catchFlights() {
  if (still) return;
  document.addEventListener(
    "click",
    (e) => {
      const card = e.target.closest?.(".catch[data-ask]");
      if (!card) return;
      const demo = $(".catch-demo", card) ?? card;
      const r = demo.getBoundingClientRect();
      const ghost = demo.cloneNode(true);
      ghost.className = "catch-ghost";
      Object.assign(ghost.style, { left: r.left + "px", top: r.top + "px", width: r.width + "px" });
      document.body.appendChild(ghost);
      // after the page has scrolled to the desk, fly into the answer box
      setTimeout(() => {
        const t = $("#answer").getBoundingClientRect();
        const g = ghost.getBoundingClientRect();
        motionAnimate(
          ghost,
          { x: t.left + 20 - g.left, y: t.top + 16 - g.top, scale: 0.92, opacity: [1, 0] },
          { type: "spring", stiffness: 140, damping: 20, mass: 1 },
        ).then(() => ghost.remove());
      }, 420);
    },
    true,
  );
}

// The 3D memory graph (~190 KB gzipped) loads only when its band is near
// the viewport, and not at all for reduced motion; the 2D canvas remains.
export function graphBand() {
  const cv = $("#graph-mini");
  if (!cv || still) return;
  const stop = onVisible(
    cv,
    (vis) => {
      if (!vis) return;
      stop();
      const graph = window.VM_SNAPSHOT?.graphs?.health;
      import(new URL("graph3d.bundle.mjs", import.meta.url).href)
        .then((m) => m.mount(cv, graph))
        .catch(() => {});
    },
    "400px",
  );
}

export function start() {
  graphBand();
  heroFlight();
  heroTilt();
  statCounts();
  pipelineToken();
  splineMeter();
  catchFlights();
  if (new URLSearchParams(location.search).has("tune"))
    import(new URL("tune.bundle.mjs", import.meta.url).href).then((m) => m.mount(P)).catch(() => {});
}
