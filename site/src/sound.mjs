// Small synthesized sounds (Web Audio, no files): a tick for picks, a soft
// swipe when an answer arrives, a two-note confirm for the verdict, a marker for
// the highlighted line, a chime when a call connects. Quiet by design,
// played only after the visitor has interacted with the page (browsers
// block audio before that anyway), and switchable from the nav.
let ctx = null,
  master = null;
const KEY = "vm-sound";
let on = true;
try {
  on = localStorage.getItem(KEY) !== "off";
} catch {}

function audio() {
  if (!on) return null;
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = 0.22;
    master.connect(ctx.destination);
  }
  if (ctx.state === "suspended") ctx.resume().catch(() => {});
  return ctx;
}
export const soundOn = () => on;
export function setSound(v) {
  on = v;
  try {
    localStorage.setItem(KEY, v ? "on" : "off");
  } catch {}
  if (!v && ctx) ctx.suspend().catch(() => {});
}

function env(g, t, a, d, peak = 1) {
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(peak, t + a);
  g.gain.exponentialRampToValueAtTime(0.0001, t + a + d);
}
function tone(freq, { type = "sine", a = 0.004, d = 0.08, peak = 0.6, glideTo = null, at = 0 } = {}) {
  const c = audio();
  if (!c) return;
  const t = c.currentTime + at;
  const o = c.createOscillator(),
    g = c.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, t);
  if (glideTo) o.frequency.exponentialRampToValueAtTime(glideTo, t + a + d);
  env(g, t, a, d, peak);
  o.connect(g).connect(master);
  o.start(t);
  o.stop(t + a + d + 0.02);
}
let noiseBuf = null;
function noise({ d = 0.12, f0 = 1200, f1 = null, q = 0.8, peak = 0.5, at = 0 } = {}) {
  const c = audio();
  if (!c) return;
  if (!noiseBuf) {
    noiseBuf = c.createBuffer(1, c.sampleRate * 0.6, c.sampleRate);
    const ch = noiseBuf.getChannelData(0);
    for (let i = 0; i < ch.length; i++) ch[i] = Math.random() * 2 - 1;
  }
  const t = c.currentTime + at;
  const s = c.createBufferSource(),
    bp = c.createBiquadFilter(),
    g = c.createGain();
  s.buffer = noiseBuf;
  bp.type = "bandpass";
  bp.Q.value = q;
  bp.frequency.setValueAtTime(f0, t);
  if (f1) bp.frequency.exponentialRampToValueAtTime(f1, t + d);
  env(g, t, 0.01, d, peak);
  s.connect(bp).connect(g).connect(master);
  s.start(t);
  s.stop(t + d + 0.05);
}

export const sfx = {
  tick: () => tone(1900, { d: 0.035, peak: 0.25 }),
  pop: () => tone(620, { glideTo: 210, d: 0.12, peak: 0.45 }),
  swipe: () => noise({ d: 0.18, f0: 700, f1: 2200, q: 0.7, peak: 0.22 }),
  confirm: () => {
    tone(880, { d: 0.06, peak: 0.22 });
    tone(1320, { d: 0.1, peak: 0.16, at: 0.05 });
  },
  marker: () => noise({ d: 0.32, f0: 2200, f1: 4200, q: 4, peak: 0.18 }),
  chime: () => {
    tone(660, { d: 0.5, peak: 0.35 });
    tone(990, { d: 0.6, peak: 0.25, at: 0.09 });
  },
  hang: () => {
    tone(520, { d: 0.25, peak: 0.3 });
    tone(390, { d: 0.35, peak: 0.25, at: 0.12 });
  },
};

/** A nav toggle (button[data-sound]) that shows and flips the setting. */
export function mountToggle() {
  for (const b of document.querySelectorAll("[data-sound]")) {
    const paint = () => {
      b.setAttribute("aria-pressed", String(on));
      b.title = on ? "Sound on" : "Sound off";
      b.classList.toggle("off", !on);
    };
    paint();
    b.addEventListener("click", () => {
      setSound(!on);
      paint();
      if (on) sfx.tick();
    });
  }
}
