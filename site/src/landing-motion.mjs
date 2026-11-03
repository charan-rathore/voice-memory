// Landing motion. Splines and springs applied inside the existing
// components, never drawn as decoration:
//   - hero card: a looping replay of one call (question with a live
//     waveform, the page scanned, the preliminary 5 flown along a
//     Catmull-Rom path into 50, the answer spoken word by word); the card
//     leans toward the pointer on a critically damped spring;
//   - stats: count-ups timed by the same cubic-bezier as the CSS;
//   - how it works: a question travels an unseen spline through the four
//     steps, and each card reacts as it passes;
//   - live call: the voice meter is a Catmull-Rom waveform through the real
//     audio levels;
//   - catch cards: the question flies to the answer desk (Motion spring).
// Bundled by scripts/build-site-motion.mjs into site/motion.bundle.mjs.
import { animate as anime } from "animejs";
import { animate as motionAnimate } from "motion";
import {
  catmullRom,
  pathOf,
  travel,
  cubicBezierTiming,
  smoothDamp,
  expDecay,
  lerp,
  minJerk,
  springImpulse,
  springStep,
  springSettle,
  springTo,
} from "../motion-math.mjs";
import { animate as loop, onVisible, reducedMotion } from "../motion-loop.mjs";

// Tunable from the ?tune panel (scripts/../src/tune.mjs).
export const P = {
  flightMs: 1150,
  flightEase: [0.65, 0, 0.35, 1],
  lift: 64,
  tiltDeg: 1.5,
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
// One white evidence card, three short stories, each a real engine answer in
// the language it was asked: a corrected value (English), two units that must
// not be compared (Hinglish), a proposal that was never approved (Hindi).
//   ask    - the question arrives (live waveform; an orbiting light runs
//            round the field at constant angular speed);
//   scan   - the record is read (status spinner; the cited line highlights);
//   fix    - the decision: the preliminary 5 flies along an arc-length
//            Catmull-Rom path into 50; two gauge needles swing to their own
//            readings with galvanometer dynamics (underdamped spring,
//            zeta 0.42) and the ≠ springs in; the funnel fills on a
//            minimum-jerk profile to "proposed", is pushed toward sign-off
//            and tethered back by a damped impulse response;
//   landed - the status ticks and the verdict chip springs in;
//   answer - the answer arrives word by word (no blur, always readable);
//   rest   - then the next story.
// The tab thumb is a critically damped spring (c = 2√k). Tabs jump; hover or
// focus pauses. Steps are CSS states on [data-step]; JS owns geometry/timing.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SVG = "http://www.w3.org/2000/svg";
const svgEl = (tag, attrs) => {
  const el = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
};
// Gauge: a 180° arc centred at (80, 84), radius 64. Ticks and labels come
// from data-min/max so each dial shows its own unit's numbers.
const G = { cx: 80, cy: 84, r: 64 }; // needle reaches r = 32, labels sit at r ≈ 42
function buildGauge(g) {
  const ticks = $(".hg-ticks", g);
  if (!ticks || ticks.childElementCount) return;
  const min = +g.dataset.min,
    max = +g.dataset.max;
  for (let i = 0; i <= 20; i++) {
    const f = i / 20,
      th = Math.PI * (1 - f),
      big = i % 5 === 0;
    const r1 = G.r - 9,
      r0 = r1 - (big ? 7 : 4);
    const c = Math.cos(th),
      sn = Math.sin(th);
    ticks.append(svgEl("line", { x1: G.cx + r0 * c, y1: G.cy - r0 * sn, x2: G.cx + r1 * c, y2: G.cy - r1 * sn, class: big ? "big" : "" }));
    if (i % 10 === 0) {
      const rt = r0 - 6;
      const t = svgEl("text", { x: G.cx + rt * c, y: G.cy - rt * sn + 3, "text-anchor": i === 0 ? "start" : i === 20 ? "end" : "middle" });
      t.textContent = +(min + f * (max - min)).toFixed(2);
      ticks.append(t);
    }
  }
}
// fraction of the dial for the gauge's own reading
const gaugeFrac = (g) => (+g.dataset.v - +g.dataset.min) / (+g.dataset.max - +g.dataset.min);
const setGauge = (g, f) => {
  g.style.setProperty("--f", Math.max(0, Math.min(1, f)).toFixed(4));
  g.style.setProperty("--deg", `${(-90 + 180 * f).toFixed(2)}deg`);
};

export async function heroFlight() {
  const card = $(".hero-card");
  if (!card) return;
  const scenes = $$(".hc-scene", card);
  const tabs = $$(".hc-tab", card);
  const ind = $(".hx-ind", card);
  const order = scenes.map((s) => s.dataset.scene);
  let current = order[0];
  let jump = null;

  // tab indicator: two critically damped springs (left edge, width)
  const ix = { x: 0, v: 0 },
    iw = { x: 0, v: 0 };
  let tgt = { x: 0, w: 0 },
    indRun = null;
  const placeInd = (snap) => {
    const t = tabs.find((x) => x.dataset.scene === current);
    if (!t || !ind) return;
    tgt = { x: t.offsetLeft, w: t.offsetWidth };
    if (snap || still || !iw.x) {
      ix.x = tgt.x;
      iw.x = tgt.w;
      ix.v = iw.v = 0;
      ind.style.setProperty("--ix", `${ix.x}px`);
      ind.style.setProperty("--iw", `${iw.x}px`);
      return;
    }
    indRun ??= loop((dt) => {
      springTo(ix, tgt.x, 320, 1, dt);
      springTo(iw, tgt.w, 320, 1, dt);
      ind.style.setProperty("--ix", `${ix.x.toFixed(2)}px`);
      ind.style.setProperty("--iw", `${iw.x.toFixed(2)}px`);
      if (Math.abs(ix.x - tgt.x) + Math.abs(iw.x - tgt.w) + Math.abs(ix.v) + Math.abs(iw.v) < 0.05) {
        indRun = null;
        return false;
      }
      return true;
    });
  };
  const show = (name) => {
    current = name;
    for (const sc of scenes) {
      const on = sc.dataset.scene === name;
      sc.classList.toggle("on", on);
      sc.setAttribute("aria-hidden", String(!on));
      sc.inert = !on;
    }
    for (const t of tabs) {
      const on = t.dataset.scene === name;
      t.setAttribute("aria-selected", "false");
      if (on) {
        void t.offsetWidth; // restart the progress animation
        t.setAttribute("aria-selected", "true");
      }
    }
    placeInd(false);
  };
  // Tabs always work, motion or not.
  tabs.forEach((t) =>
    t.addEventListener("click", () => {
      jump = t.dataset.scene;
      show(jump);
    }),
  );
  card.addEventListener("keydown", (e) => {
    if (!e.target.matches?.(".hc-tab") || !/^Arrow(Left|Right)$/.test(e.key)) return;
    const i = (order.indexOf(current) + (e.key === "ArrowRight" ? 1 : order.length - 1)) % order.length;
    tabs[i].focus();
    tabs[i].click();
  });
  addEventListener("resize", () => placeInd(true));
  const gauges = $$(".hg", card);
  gauges.forEach(buildGauge);
  const dealScene = scenes.find((sc) => sc.dataset.scene === "deal");
  const bar = $(".hf-bar", dealScene);
  const P_PROPOSED = 2 / 3; // end of the second stage
  const setBar = (p) => bar?.style.setProperty("--p", p.toFixed(4));
  const restFrames = () => {
    gauges.forEach((g) => setGauge(g, gaugeFrac(g)));
    setBar(P_PROPOSED);
  };
  // needles: x(t) = f · step(ω, ζ, t), the second dial a beat behind
  const NEEDLE = { omega: 11, zeta: 0.42, lag: 0.14 };
  const swingGauges = () =>
    new Promise((done) => {
      let t = 0;
      const T = springSettle(NEEDLE.omega, NEEDLE.zeta, 0.004) + NEEDLE.lag;
      const stop = loop((d) => {
        t += d;
        gauges.forEach((g, i) => setGauge(g, gaugeFrac(g) * springStep(NEEDLE.omega, NEEDLE.zeta, Math.max(0, t - i * NEEDLE.lag))));
        if (t >= T) return restFrames(), done(), false;
        return true;
      });
      setTimeout(() => (stop(), restFrames(), done()), T * 1000 + 400);
    });
  // funnel: minimum-jerk fill to "proposed", then a push the record cannot
  // carry: p = 2/3 + A · impulse(ω, ζ, t), which returns to 2/3 by itself
  const PUSH = { omega: 10, zeta: 0.3, amp: 0.07, T1: 0.85 };
  const fillFunnel = () =>
    new Promise((done) => {
      let t = 0;
      const T2 = springSettle(PUSH.omega, PUSH.zeta, 0.01);
      const stop = loop((d) => {
        t += d;
        if (t < PUSH.T1) setBar(P_PROPOSED * minJerk(t / PUSH.T1));
        else {
          setBar(P_PROPOSED + PUSH.amp * Math.max(0, springImpulse(PUSH.omega, PUSH.zeta, t - PUSH.T1)));
          if (t - PUSH.T1 >= T2) return setBar(P_PROPOSED), done(), false;
        }
        return true;
      });
      setTimeout(() => (stop(), setBar(P_PROPOSED), done()), (PUSH.T1 + T2) * 1000 + 400);
    });

  show(current);
  placeInd(true);
  restFrames();
  if (still) return;
  const fixScene = scenes.find((sc) => sc.dataset.scene === "fix");
  const from = $(".hc-val.prelim .hc-num s", fixScene);
  const to5 = $(".hc-val.amended .hc-d5", fixScene);
  const to0 = $(".hc-val.amended .hc-d0", fixScene);
  if (!from || !to5 || !to0) return;
  card.classList.add("hc-motion", "hc-loop");
  // every answer, word by word
  for (const ans of $$(".hc-answer", card)) {
    const chip = $(".verdict-chip", ans);
    const text = [...ans.childNodes].filter((n) => n !== chip).map((n) => n.textContent).join("").replace(/\s+/g, " ").trim();
    ans.innerHTML = "";
    ans.append(chip, " ");
    text.split(/\s+/).forEach((w, i) => {
      const sp = document.createElement("span");
      sp.className = "hc-w";
      sp.style.setProperty("--w", i);
      sp.textContent = w;
      ans.append(sp, " ");
    });
  }
  // one live voice waveform, moved into the asking scene
  const wave = document.createElement("canvas");
  wave.className = "hc-wave";
  wave.setAttribute("aria-hidden", "true");
  const W = 46,
    H = 18,
    dpr = Math.min(2, devicePixelRatio || 1);
  wave.width = W * dpr;
  wave.height = H * dpr;
  const wctx = wave.getContext("2d");
  wctx.scale(dpr, dpr);
  let level = 0,
    target = 0,
    t = 0;
  const drawWave = (dt) => {
    t += dt;
    level = expDecay(level, target, 10, dt);
    wctx.clearRect(0, 0, W, H);
    const pts = [];
    for (let i = 0; i <= 8; i++) {
      const x = (i / 8) * W;
      const env = Math.sin((Math.PI * i) / 8);
      const y = H / 2 - env * level * (H / 2 - 2) * Math.sin(t * 9 + i * 1.7) * (0.6 + 0.4 * Math.sin(t * 3.1 + i));
      pts.push([x, y]);
    }
    wctx.beginPath();
    wctx.moveTo(...pts[0]);
    for (const [, c1, c2, p] of catmullRom(pts)) wctx.bezierCurveTo(...c1, ...c2, ...p);
    wctx.strokeStyle = "#111317";
    wctx.lineWidth = 1.6;
    wctx.lineCap = "round";
    wctx.stroke();
    return true;
  };
  let stopWave = null;
  await document.fonts?.ready;
  placeInd(true);

  // The flight runs on its own clock with a timer backstop: if frames stall
  // (a background tab, a busy main thread) the 5 still lands and the ghost is
  // always removed.
  const fly = () =>
    new Promise((done) => {
      const base = card.getBoundingClientRect();
      const a = rel(from.getBoundingClientRect(), base);
      const b = rel(to5.getBoundingClientRect(), base);
      const ghost = document.createElement("span");
      ghost.className = "hc-ghost";
      ghost.textContent = "5";
      const fs = getComputedStyle(from);
      Object.assign(ghost.style, { fontSize: fs.fontSize, lineHeight: fs.lineHeight, fontFamily: fs.fontFamily, letterSpacing: fs.letterSpacing, opacity: "0" });
      ghost.setAttribute("aria-hidden", "true");
      card.appendChild(ghost);
      const c0 = rgb(from),
        c1 = rgb(to5);
      const path = pathOf(
        catmullRom([
          [a.x, a.y],
          [a.x + 18, a.y - P.lift * 0.75],
          [(a.x + b.x) / 2, Math.min(a.y, b.y) - P.lift],
          [b.x - 20, b.y - P.lift * 0.45],
          [b.x, b.y],
        ]),
      );
      const ease = cubicBezierTiming(...P.flightEase);
      const place = (u) => {
        const { p, tangent } = travel(path, path.total * u);
        const lean = Math.atan2(tangent[1], tangent[0]) * 0.18 * Math.sin(Math.PI * u);
        const c = c0.map((v, i) => Math.round(lerp(v, c1[i], u)));
        ghost.style.transform = `translate3d(${p[0]}px, ${p[1]}px, 0) rotate(${lean}rad) scale(${1 + 0.12 * Math.sin(Math.PI * u)})`;
        ghost.style.color = `rgb(${c})`;
      };
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        clearTimeout(backstop);
        to5.style.opacity = "1";
        ghost.remove();
        to0.animate([{ opacity: 0, transform: "scale(0.55)" }, { opacity: 1, transform: "scale(1.06)", offset: 0.7 }, { opacity: 1, transform: "none" }], { duration: 520, easing: "cubic-bezier(0.34, 1.56, 0.64, 1)" });
        to0.style.opacity = "1";
        done();
      };
      const backstop = setTimeout(finish, P.flightMs + 350);
      const t0 = performance.now();
      place(0);
      const frame = (now) => {
        if (finished) return;
        const k = Math.min(1, (now - t0) / P.flightMs);
        ghost.style.opacity = String(Math.min(1, (now - t0) / 140));
        place(ease(k));
        if (k < 1) requestAnimationFrame(frame);
        else finish();
      };
      requestAnimationFrame(frame);
    });
  let alive = false,
    running = false,
    paused = false;
  card.addEventListener("pointerenter", () => ((paused = true), card.classList.add("hc-paused")));
  card.addEventListener("pointerleave", () => ((paused = false), card.classList.remove("hc-paused")));
  card.addEventListener("focusin", () => ((paused = true), card.classList.add("hc-paused")));
  card.addEventListener("focusout", () => ((paused = false), card.classList.remove("hc-paused")));
  // waits that stop the clock while paused and end early on a tab jump
  // (elapsed time is measured, so timer drift never stretches a story)
  const wait = async (ms) => {
    let left = ms;
    while (left > 0 && alive && !jump) {
      const t0 = performance.now();
      await sleep(Math.min(paused ? 100 : left, 250));
      if (!paused) left -= performance.now() - t0;
    }
  };
  const DUR = { fix: 1300 + 1100 + 250 + P.flightMs + 450 + 4200 + 600, units: 1300 + 1100 + 1500 + 450 + 4200 + 600, deal: 1300 + 1100 + 2000 + 450 + 4200 + 600 };
  const play = async (name) => {
    show(name);
    card.style.setProperty("--scene-ms", `${DUR[name] ?? 8000}ms`);
    const sc = scenes.find((x) => x.dataset.scene === name);
    $(".hx-ask", sc)?.append(wave);
    card.dataset.step = "ask";
    to5.style.opacity = "0";
    to0.style.opacity = "0";
    if (name === "units") gauges.forEach((g) => setGauge(g, 0));
    if (name === "deal") setBar(0);
    target = 1;
    stopWave ??= loop(drawWave);
    await wait(1300);
    target = 0.08;
    card.dataset.step = "scan";
    await wait(1100);
    card.dataset.step = "fix";
    if (name === "fix") {
      await wait(250);
      if (!jump && alive) await fly();
    } else if (name === "units") {
      if (!jump && alive) await swingGauges();
    } else if (!jump && alive) await fillFunnel();
    if (jump) restFrames(); // a jump mid-story leaves complete frames behind
    card.dataset.step = "landed";
    await wait(450);
    card.dataset.step = "answer";
    await wait(4200);
    card.dataset.step = "rest";
    target = 0;
    await wait(600);
  };
  const cycle = async () => {
    running = true;
    while (alive) {
      const name = jump ?? current;
      jump = null;
      await play(name);
      if (!jump && alive) current = order[(order.indexOf(name) + 1) % order.length];
    }
    stopWave?.();
    stopWave = null;
    running = false;
  };
  onVisible(card, (vis) => {
    alive = vis && !document.hidden;
    if (alive && !running) cycle();
  }, "0px");
  document.addEventListener("visibilitychange", () => {
    alive = !document.hidden && card.getBoundingClientRect().bottom > 0;
    if (alive && !running) cycle();
  });
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
  const H = 26,
    dpr = Math.min(2, devicePixelRatio || 1);
  let W = 92;
  box.appendChild(cv);
  box.classList.add("spline");
  const ctx = cv.getContext("2d");
  // the waveform spans whatever width the call bar gives it
  const size = () => {
    W = Math.max(60, Math.round(box.clientWidth || 92));
    cv.width = W * dpr;
    cv.height = H * dpr;
    cv.style.width = W + "px";
    cv.style.height = H + "px";
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  };
  size();
  new ResizeObserver(() => {
    size();
    draw();
  }).observe(box);
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
      const demo = $(".catch-q", card) ?? card;
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
