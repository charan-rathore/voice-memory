// Small canvas sketches that make the stats and the "what it catches" cards
// show their point instead of stating it. Each is a pure drawing of time t;
// the math does the work (golden-angle spiral, value-noise flow field,
// damped pendulums, beat frequencies, hand-drawn Catmull-Rom strokes).
// A sketch runs only while its canvas is on screen; with reduced motion it
// draws its final frame once.
import { catmullRom, noise2, phyllotaxis, clamp01, easeOutCubic } from "../motion-math.mjs";
import { animate, onVisible, reducedMotion } from "../motion-loop.mjs";

const C = {
  ink: "#161c2d",
  ink3: "#80859a",
  coral: "#e8735a",
  red: "#c2412f",
  teal: "#1f9e8f",
  mark: "#f4dc4a",
  amber: "#b7791f",
  plum: "#7a4fa3",
  sky: "#3b6fd8",
};
const back = (t, s = 2.2) => 1 + (s + 1) * Math.pow(t - 1, 3) + s * Math.pow(t - 1, 2); // easeOutBack

// A hand-drawn stroke: a Catmull-Rom spline through the points, each nudged
// by value noise, so lines wobble like ink rather than sitting on the grid.
export function roughStroke(ctx, pts, { seed = 1, amp = 1.4, width = 2, color = C.ink, progress = 1 } = {}) {
  const j = pts.map(([x, y], i) => [x + noise2(i * 0.7, seed, seed) * amp, y + noise2(seed, i * 0.7, seed + 3) * amp]);
  const segs = catmullRom(j);
  const n = Math.max(1, Math.ceil(segs.length * clamp01(progress)));
  ctx.beginPath();
  ctx.moveTo(...j[0]);
  segs.slice(0, n).forEach(([, c1, c2, p], i) => {
    if (i === n - 1 && progress < 1) {
      const f = segs.length * progress - (n - 1);
      const [p0] = segs[i];
      ctx.lineTo(p0[0] + (p[0] - p0[0]) * f, p0[1] + (p[1] - p0[1]) * f);
    } else ctx.bezierCurveTo(...c1, ...c2, ...p);
  });
  ctx.lineWidth = width;
  ctx.lineCap = ctx.lineJoin = "round";
  ctx.strokeStyle = color;
  ctx.stroke();
}
const text = (ctx, s, x, y, { size = 12, color = C.ink3, weight = 500, align = "left", font = "Plex, system-ui, sans-serif" } = {}) => {
  ctx.font = `${weight} ${size}px ${font}`;
  ctx.fillStyle = color;
  ctx.textAlign = align;
  ctx.fillText(s, x, y);
};
const dot = (ctx, x, y, r, color) => {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
};

// ------------------------------------------------------------ stats
const SCENES = {
  // 68.6%: people as a sunflower (golden-angle) spiral; 68.6% light up from the
  // centre out, each landing with a small overshoot.
  spiral(ctx, w, h, t) {
    // 500 dots so each stays visible; 343 of 500 is the same 68.6%
    const n = 500,
      R = Math.min(w, h) * 0.48,
      cx = w / 2,
      cy = h / 2,
      lit = 343;
    const p = clamp01((t - 0.15) / 1.8);
    const spin = t * 0.04;
    for (let i = 0; i < n; i++) {
      const [x, y] = phyllotaxis(i, n);
      const a = Math.atan2(y, x) + spin,
        r = Math.hypot(x, y) * R;
      const on = i < lit * easeOutCubic(p);
      const age = clamp01((p * lit - i) / 60);
      const s = on ? 1.3 + 0.7 * back(age) : 1;
      dot(ctx, cx + Math.cos(a) * r, cy + Math.sin(a) * r, s, on ? C.coral : "rgba(22,28,45,0.13)");
    }
    return t < 2.4;
  },
  // 1 in 3: three reports; two read cleanly, the third's lines won't settle.
  sheets(ctx, w, h, t) {
    const sw = Math.min(70, w / 4.2),
      sh = sw * 1.3,
      gap = (w - sw * 3) / 4,
      y0 = (h - sh) / 2;
    for (let k = 0; k < 3; k++) {
      const x0 = gap + k * (sw + gap);
      const lost = k === 2;
      ctx.fillStyle = lost ? "#f3ecff" : "#ffffff";
      ctx.fillRect(x0, y0, sw, sh);
      roughStroke(ctx, [[x0, y0], [x0 + sw, y0], [x0 + sw, y0 + sh], [x0, y0 + sh], [x0, y0]], {
        seed: k + 2,
        amp: 1.2,
        width: 1.4,
        color: lost ? C.plum : C.ink3,
      });
      for (let l = 0; l < 5; l++) {
        const ly = y0 + 14 + l * (sh - 22) / 4;
        const pts = [];
        for (let s = 0; s <= 6; s++) {
          const x = x0 + 9 + (s / 6) * (sw - 18) * (l === 4 ? 0.6 : 1);
          const wob = lost ? Math.sin(s * 1.7 + t * 3 + l) * 3.2 * (0.6 + 0.4 * Math.sin(t * 0.9)) : 0;
          pts.push([x, ly + wob]);
        }
        roughStroke(ctx, pts, { seed: k * 10 + l, amp: lost ? 1.6 : 0.6, width: 1.6, color: lost ? "rgba(122,79,163,0.55)" : "rgba(22,28,45,0.35)" });
      }
      if (lost) text(ctx, "?", x0 + sw - 4, y0 - 6 + Math.sin(t * 2) * 3, { size: 22, color: C.plum, weight: 600, font: "Newsreader, Georgia, serif" });
      else roughStroke(ctx, [[x0 + sw - 20, y0 + sh - 14], [x0 + sw - 14, y0 + sh - 8], [x0 + sw - 4, y0 + sh - 22]], { seed: k + 9, width: 2.2, color: C.teal });
    }
    return true;
  },
};

// 40M+: questions streaming through a value-noise flow field toward a
// hazard sign; drawn with trails (the canvas is faded, not cleared).
function flowScene() {
  const P = Array.from({ length: 140 }, (_, i) => ({ x: (i * 53) % 400, y: (i * 97) % 140, life: (i * 7) % 90 }));
  return (ctx, w, h, t, dt, first) => {
    if (first) ctx.clearRect(0, 0, w, h);
    ctx.globalCompositeOperation = "destination-out";
    ctx.fillStyle = "rgba(0,0,0,0.08)";
    ctx.fillRect(0, 0, w, h);
    ctx.globalCompositeOperation = "source-over";
    const tx = w * 0.82,
      ty = h * 0.52;
    for (const p of P) {
      const a = noise2(p.x * 0.012, p.y * 0.012 + t * 0.15, 5) * Math.PI;
      const pull = Math.atan2(ty - p.y, tx - p.x);
      const ang = a * 0.55 + pull * 0.45;
      const v = 42 + 30 * noise2(p.y * 0.05, t, 2);
      p.x += Math.cos(ang) * v * dt;
      p.y += Math.sin(ang) * v * dt;
      if (Math.hypot(tx - p.x, ty - p.y) < 14 || p.x > w || p.y < 0 || p.y > h) {
        p.x = Math.random() * w * 0.25;
        p.y = Math.random() * h;
      }
      dot(ctx, p.x, p.y, 1.4, Math.hypot(tx - p.x, ty - p.y) < 60 ? C.coral : C.amber);
    }
    // hazard sign, hand-drawn
    const s = 18 + Math.sin(t * 2.4) * 1.2;
    ctx.save();
    ctx.globalCompositeOperation = "source-over";
    roughStroke(ctx, [[tx, ty - s], [tx + s, ty + s * 0.8], [tx - s, ty + s * 0.8], [tx, ty - s]], { seed: 3, width: 2.4, color: C.red });
    text(ctx, "!", tx, ty + s * 0.55, { size: 16, color: C.red, weight: 700, align: "center" });
    ctx.restore();
    return true;
  };
}

// ------------------------------------------------------------ catch cards
const CATCH = {
  // the 5 is struck by hand, then 50 springs in
  fix(ctx, w, h, t) {
    const c = (t % 3.4) / 3.4;
    text(ctx, "5", w * 0.28, h * 0.68, { size: 40, color: C.coral, font: "Newsreader, Georgia, serif", align: "center" });
    roughStroke(ctx, [[w * 0.2, h * 0.5], [w * 0.28, h * 0.47], [w * 0.36, h * 0.44]], { seed: 4, width: 3, color: C.red, progress: clamp01(c / 0.25) });
    const g = clamp01((c - 0.3) / 0.3);
    roughStroke(ctx, [[w * 0.42, h * 0.5], [w * 0.5, h * 0.42], [w * 0.56, h * 0.5]], { seed: 5, width: 1.6, color: C.ink3, progress: g });
    if (c > 0.45) {
      const s = back(clamp01((c - 0.45) / 0.25));
      ctx.save();
      ctx.translate(w * 0.72, h * 0.62);
      ctx.scale(s, s);
      text(ctx, "50", 0, 8, { size: 40, color: C.teal, font: "Newsreader, Georgia, serif", align: "center" });
      ctx.restore();
    }
    return true;
  },
  // two rulers with incommensurate ticks slide past each other: the marks
  // drift in and out of line (a beat), and the values are never joined
  units(ctx, w, h, t) {
    const y1 = h * 0.35,
      y2 = h * 0.68,
      s1 = 11,
      s2 = s1 * 1.6180339887;
    for (const [y, s, off, label, col] of [
      [y1, s1, (t * 14) % s1, "mg/dL", C.coral],
      [y2, s2, (-t * 9) % s2, "µmol/L", C.teal],
    ]) {
      roughStroke(ctx, [[8, y], [w - 8, y]], { seed: y | 0, width: 1.4, color: col });
      for (let x = off - s; x < w; x += s) {
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x, y + (y === y1 ? -7 : 7));
        ctx.strokeStyle = col;
        ctx.lineWidth = 1.2;
        ctx.stroke();
      }
      text(ctx, label, 10, y + (y === y1 ? -10 : 20), { size: 11, color: col });
    }
    const bx = w * 0.5 + Math.sin(t * 1.3) * w * 0.25;
    ctx.beginPath();
    ctx.arc(bx, (y1 + y2) / 2, 10, 0, Math.PI * 2);
    ctx.fillStyle = "#fff";
    ctx.fill();
    ctx.strokeStyle = C.red;
    ctx.stroke();
    text(ctx, "≠", bx, (y1 + y2) / 2 + 5, { size: 15, color: C.red, weight: 700, align: "center" });
    return true;
  },
  // two patients orbit their own centres; their records never cross
  who(ctx, w, h, t) {
    const cs = [
      [w * 0.33, h * 0.5, C.sky, "SYN-0001"],
      [w * 0.67, h * 0.5, C.plum, "SYN-0003"],
    ];
    cs.forEach(([cx, cy, col, label], k) => {
      ctx.setLineDash([3, 4]);
      ctx.beginPath();
      ctx.arc(cx, cy, h * 0.3, 0, Math.PI * 2);
      ctx.strokeStyle = col + "55";
      ctx.stroke();
      ctx.setLineDash([]);
      const a = t * (k ? -1.1 : 1.3) + k;
      dot(ctx, cx + Math.cos(a) * h * 0.3, cy + Math.sin(a) * h * 0.3, 5, col);
      text(ctx, label, cx, cy + 4, { size: 10.5, color: col, align: "center", weight: 600 });
    });
    // the question mark between them, asking which
    text(ctx, "?", w / 2, h * 0.58 + Math.sin(t * 2.2) * 3, { size: 20, color: C.ink, weight: 600, align: "center", font: "Newsreader, Georgia, serif" });
    return true;
  },
  // a price tag swings on a damped pendulum; "approved" never lands on it
  price(ctx, w, h, t, dt, first, st) {
    st.th ??= 0.9;
    st.om ??= 0;
    const g = 9.8,
      L = 0.9;
    // semi-implicit Euler, re-kicked every few seconds
    st.om += (-(g / L) * Math.sin(st.th) - 0.6 * st.om) * dt;
    st.th += st.om * dt;
    if (Math.abs(st.th) < 0.01 && Math.abs(st.om) < 0.02) st.th = 0.9;
    const px = w * 0.62,
      py = 6,
      len = h * 0.55;
    const x = px + Math.sin(st.th) * len,
      y = py + Math.cos(st.th) * len;
    roughStroke(ctx, [[px, py], [x, y]], { seed: 7, width: 1.2, color: C.ink3 });
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(-st.th * 0.6);
    ctx.fillStyle = "#fff6d6";
    ctx.fillRect(-26, 0, 52, 22);
    roughStroke(ctx, [[-26, 0], [26, 0], [26, 22], [-26, 22], [-26, 0]], { seed: 8, width: 1.3, color: C.amber });
    text(ctx, "$42k", 0, 15, { size: 12, color: C.ink, weight: 600, align: "center" });
    ctx.restore();
    text(ctx, "$48k", w * 0.18, h * 0.6, { size: 13, color: C.coral, weight: 600, align: "center" });
    roughStroke(ctx, [[w * 0.08, h * 0.55], [w * 0.28, h * 0.5]], { seed: 9, width: 2, color: C.red });
    const sy = h * 0.2 + Math.sin(t * 1.6) * 4;
    text(ctx, "APPROVED?", w * 0.25, sy, { size: 10, color: "rgba(31,158,143,0.6)", weight: 700, align: "center" });
    return true;
  },
  // 40/60 and 50/50 swing at slightly different rates and never sync
  swing(ctx, w, h, t) {
    [
      [w * 0.33, 1.0, "40/60", C.sky],
      [w * 0.67, 1.083, "50/50", C.amber],
    ].forEach(([px, f, label, col], k) => {
      const a = Math.sin(t * 2.2 * f + k * 0.4) * 0.6,
        len = h * 0.55;
      const x = px + Math.sin(a) * len,
        y = 6 + Math.cos(a) * len;
      roughStroke(ctx, [[px, 6], [x, y]], { seed: 11 + k, width: 1.2, color: C.ink3 });
      dot(ctx, x, y, 11, col);
      text(ctx, label, x, y + 4, { size: 9.5, color: "#fff", weight: 700, align: "center" });
    });
    return true;
  },
  // a pen writes a signature on the line, and it fades: none on record
  sign(ctx, w, h, t) {
    const c = (t % 4) / 4;
    const base = h * 0.7;
    roughStroke(ctx, [[w * 0.12, base], [w * 0.88, base]], { seed: 13, width: 1.4, color: C.ink3 });
    text(ctx, "×", w * 0.1, base - 4, { size: 14, color: C.ink3 });
    const pts = [];
    for (let i = 0; i <= 24; i++) {
      const u = i / 24;
      pts.push([w * 0.18 + u * w * 0.6, base - 10 - Math.sin(u * 13) * 9 * (1 - u * 0.5) - Math.cos(u * 5) * 4]);
    }
    ctx.globalAlpha = c < 0.55 ? 1 : 1 - clamp01((c - 0.55) / 0.3);
    roughStroke(ctx, pts, { seed: 14, amp: 0.8, width: 1.8, color: C.ink, progress: clamp01(c / 0.5) });
    ctx.globalAlpha = 1;
    if (c > 0.85) text(ctx, "no signature on record", w / 2, base + 16, { size: 10.5, color: C.red, align: "center", weight: 600 });
    return true;
  },
};

// ------------------------------------------------------------ mounting
function mount(cv, draw, { loop: keep = true, trails = false } = {}) {
  const ctx = cv.getContext("2d");
  const dpr = Math.min(2, devicePixelRatio || 1);
  let w = 0,
    h = 0;
  const size = () => {
    w = cv.clientWidth;
    h = cv.clientHeight;
    cv.width = Math.round(w * dpr);
    cv.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  };
  size();
  new ResizeObserver(size).observe(cv);
  const state = {};
  let t = 0,
    stop = null,
    first = true;
  const frame = (dt) => {
    t += dt;
    if (!trails) ctx.clearRect(0, 0, w, h);
    const more = draw(ctx, w, h, t, dt, first, state);
    first = false;
    return keep ? true : more;
  };
  if (reducedMotion()) {
    frame(3);
    return;
  }
  onVisible(cv, (vis) => {
    if (vis && !stop) stop = animate((dt) => frame(dt));
    else if (!vis && stop) (stop(), (stop = null));
  });
}

export function mountSketches() {
  for (const cv of document.querySelectorAll("canvas[data-art]")) {
    const name = cv.dataset.art;
    if (name === "flow") mount(cv, flowScene(), { trails: true });
    else if (SCENES[name]) mount(cv, SCENES[name], { loop: name !== "spiral" });
    else if (CATCH[name]) mount(cv, CATCH[name]);
  }
}
