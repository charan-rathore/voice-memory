// Voice Memory — buildathon film. 1920x1080 composition, rendered at 2x for 4K.
// Timing follows the narrator's own cadence: every scene boundary is a word
// time from the cleaned voiceover (src/captions.json), offset by VO.
import React from "react";
import { AbsoluteFill, Img, OffthreadVideo, Sequence, interpolate, spring, staticFile, useCurrentFrame, useVideoConfig, Easing } from "remotion";
import captions from "./captions.json";

export const FPS = 30;
export const VO = 1.0; // voiceover starts here (seconds)
const VO_LEN = 70.8;
export const SPEED = 1.06; // voiceover tempo (pitch kept), for pace
// Real-product inserts, in voiceover seconds: the voice pauses, the product plays.
export const GAPS = [
  { at: 27.3, len: 7.6 }, // after "Bolna handles the speech": a real Bolna call
  { at: 61.95, len: 10.0 }, // after "its exact source on screen": typed questions, live
];
const v = (x: number) => VO + x / SPEED + GAPS.filter((g) => x >= g.at).reduce((a, g) => a + g.len, 0);
const gapStart = (i: number) => VO + GAPS[i].at / SPEED + GAPS.slice(0, i).reduce((a, g) => a + g.len, 0);
/** Film seconds -> voiceover seconds, or null inside an insert. */
const filmToVo = (t: number) => {
  let shift = 0;
  for (let i = 0; i < GAPS.length; i++) {
    const g0 = gapStart(i);
    if (t < g0) break;
    if (t < g0 + GAPS[i].len) return null;
    shift = GAPS.slice(0, i + 1).reduce((a, g) => a + g.len, 0);
  }
  return (t - VO - shift) * SPEED;
};
export const END = v(VO_LEN) + 7.4; // outro: impact + call to action
export const TOTAL = Math.ceil(END * FPS);
const s = (sec: number) => Math.round(sec * FPS);

const C = {
  bg: "#07080d",
  ink: "#eceae0",
  ink2: "#a5aabb",
  ink3: "#6d7389",
  cream: "#f5f1e3",
  creamInk: "#161c2d",
  coral: "#ff7a5c",
  teal: "#2ec4b0",
  red: "#e5484d",
  mark: "#f4dc4a",
  blue: "#8fa3ff",
  violet: "#b69cff",
};
const SERIF = "Instrument, Newsreader, Georgia, serif";
const DISPLAY = "Bricolage, Plex, system-ui, sans-serif";
const SANS = "Plex, Deva, system-ui, sans-serif";

const clamp = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;
const io = Easing.bezier(0.45, 0, 0.2, 1);
const out = Easing.bezier(0.16, 1, 0.3, 1);
function k(t: number, ts: number[], vs: number[], e = io) {
  return interpolate(t, ts, vs, { ...clamp, easing: e });
}

// ---------------------------------------------------------------- primitives
const Fonts: React.FC = () => (
  <style>{`
    @font-face { font-family: Newsreader; src: url(${staticFile("fonts/newsreader.woff2")}) format("woff2"); font-weight: 200 800; }
    @font-face { font-family: Newsreader; src: url(${staticFile("fonts/newsreader-italic.woff2")}) format("woff2"); font-weight: 200 800; font-style: italic; }
    @font-face { font-family: Instrument; src: url(${staticFile("fonts/instrument.woff2")}) format("woff2"); font-weight: 400; }
    @font-face { font-family: Instrument; src: url(${staticFile("fonts/instrument-italic.woff2")}) format("woff2"); font-weight: 400; font-style: italic; }
    @font-face { font-family: Bricolage; src: url(${staticFile("fonts/bricolage.woff2")}) format("woff2"); font-weight: 200 800; }
    @font-face { font-family: Plex; src: url(${staticFile("fonts/plex-sans-400.woff2")}) format("woff2"); font-weight: 400; }
    @font-face { font-family: Deva; src: url(${staticFile("fonts/deva.woff2")}) format("woff2"); font-weight: 400 600; }
    @font-face { font-family: Plex; src: url(${staticFile("fonts/plex-sans-500.woff2")}) format("woff2"); font-weight: 500; }
    @font-face { font-family: Plex; src: url(${staticFile("fonts/plex-sans-600.woff2")}) format("woff2"); font-weight: 600; }
  `}</style>
);

/** Scene window with soft cross-fade in/out and a tiny zoom, in film seconds. */
const Scene: React.FC<{ a: number; b: number; fade?: number; children: (t: number, d: number) => React.ReactNode; bg?: string }> = ({ a, b, fade = 0.35, children, bg }) => {
  return (
    <Sequence from={s(a)} durationInFrames={Math.max(1, s(b) - s(a))} layout="none">
      <SceneInner d={b - a} fade={fade} bg={bg}>
        {children}
      </SceneInner>
    </Sequence>
  );
};
const SceneInner: React.FC<{ d: number; fade: number; bg?: string; children: (t: number, d: number) => React.ReactNode }> = ({ d, fade, bg, children }) => {
  const f = useCurrentFrame();
  const t = f / FPS;
  const op = Math.min(k(t, [0, fade], [0, 1], out), k(t, [d - fade, d], [1, 0]));
  return <AbsoluteFill style={{ opacity: op, background: bg }}>{children(t, d)}</AbsoluteFill>;
};

/** A 3D camera over a stage: keyframes of x, y, zoom and rotations. */
type Key = { t: number; x?: number; y?: number; z?: number; rx?: number; ry?: number; rz?: number };
const Camera: React.FC<{ t: number; keys: Key[]; children: React.ReactNode; persp?: number }> = ({ t, keys, children, persp = 1800 }) => {
  const ts = keys.map((q) => q.t);
  const val = (p: keyof Key, d: number) => (keys.length < 2 ? (keys[0]?.[p] as number) ?? d : k(t, ts, keys.map((q) => (q[p] as number) ?? d)));
  const x = val("x", 0), y = val("y", 0), z = val("z", 1), rx = val("rx", 0), ry = val("ry", 0), rz = val("rz", 0);
  return (
    <AbsoluteFill style={{ perspective: persp, overflow: "hidden" }}>
      <AbsoluteFill style={{ transform: `translate(${x}px, ${y}px) scale(${z}) rotateX(${rx}deg) rotateY(${ry}deg) rotateZ(${rz}deg)` }}>{children}</AbsoluteFill>
    </AbsoluteFill>
  );
};

/** Kinetic headline: each word slides up out of a mask, its letters
 * arriving with a tiny skew and stagger, then a gentle tracking settle. */
const Rise: React.FC<{ t: number; at: number; text: string; size: number; color?: string; serif?: boolean; stagger?: number; weight?: number; italic?: boolean; style?: React.CSSProperties }> = ({ t, at, text, size, color = C.ink, serif = true, stagger = 0.07, weight = 400, italic, style }) => {
  let ci = 0;
  return (
    <div style={{ fontFamily: serif ? SERIF : DISPLAY, fontSize: size, lineHeight: 1.06, color, fontWeight: weight, fontStyle: italic ? "italic" : undefined, letterSpacing: "normal", ...style }}>
      {text.split(" ").map((w, i) => {
        const w0 = at + i * stagger;
        const settle = k(t, [w0 + 0.2, w0 + 1.1], [0.04, serif ? -0.012 : -0.02], out);
        return (
          <span key={i} style={{ display: "inline-block", overflow: "hidden", verticalAlign: "top", paddingBottom: "0.12em", marginRight: "0.22em", letterSpacing: `${settle}em` }}>
            {[...w].map((ch, j) => {
              const c0 = w0 + j * 0.018 + (ci++ % 3) * 0.004;
              const p = k(t, [c0, c0 + 0.55], [0, 1], out);
              return (
                <span key={j} style={{ display: "inline-block", transform: `translateY(${(1 - p) * 105}%) skewY(${(1 - p) * 8}deg) rotate(${(1 - p) * 4}deg)`, opacity: Math.min(1, p * 2) }}>
                  {ch}
                </span>
              );
            })}
          </span>
        );
      })}
    </div>
  );
};

/** Odometer: digits roll from one figure to another. */
const Odometer: React.FC<{ t: number; at: number; from: string; to: string; size: number; color: string }> = ({ t, at, from, to, size, color }) => (
  <span style={{ display: "inline-flex", fontFamily: SERIF, fontSize: size, color, lineHeight: 1, letterSpacing: "-0.02em" }}>
    {[...to].map((ch, i) => {
      const a = from[i] ?? ch;
      if (!/\d/.test(ch) || !/\d/.test(a) || a === ch) return <span key={i}>{ch}</span>;
      const steps = (Number(ch) - Number(a) + 10) % 10 || 10;
      const p = k(t, [at + i * 0.06, at + 0.9 + i * 0.06], [0, 1], out);
      const pos = p * steps;
      return (
        <span key={i} style={{ display: "inline-block", height: "1em", overflow: "hidden", position: "relative" }}>
          <span style={{ display: "flex", flexDirection: "column", transform: `translateY(${-pos}em)` }}>
            {new Array(steps + 1).fill(0).map((_, j) => (
              <span key={j} style={{ height: "1em", lineHeight: 1 }}>{(Number(a) + j) % 10}</span>
            ))}
          </span>
        </span>
      );
    })}
  </span>
);

const Label: React.FC<{ children: React.ReactNode; color?: string; style?: React.CSSProperties }> = ({ children, color = C.ink2, style }) => (
  <div style={{ fontFamily: DISPLAY, fontSize: 19, fontWeight: 600, letterSpacing: "0.16em", textTransform: "uppercase", color, ...style }}>{children}</div>
);
const Tag: React.FC<{ text: string; color: string; t: number; at: number; style?: React.CSSProperties }> = ({ text, color, t, at, style }) => {
  const p = k(t, [at, at + 0.4], [0, 1], out);
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 10, padding: "8px 18px", borderRadius: 999, background: color + "22", color, border: `1.5px solid ${color}66`, fontFamily: DISPLAY, fontWeight: 600, fontSize: 24, letterSpacing: "0.01em", lineHeight: 1.2, whiteSpace: "nowrap", opacity: p, transform: `scale(${0.85 + 0.15 * p})`, ...style }}>
      <span style={{ width: 11, height: 11, borderRadius: 6, background: color }} />
      {text}
    </span>
  );
};
const Foot: React.FC<{ children: React.ReactNode; t: number; at?: number; dark?: boolean }> = ({ children, t, at = 0.6, dark }) => (
  <div style={{ position: "absolute", left: 80, bottom: 52, fontFamily: SANS, fontSize: 17, color: dark ? "#6b6553" : C.ink3, opacity: k(t, [at, at + 0.5], [0, 1]), maxWidth: 1100 }}>{children}</div>
);
const Badge: React.FC<{ text: string; t: number; dark?: boolean }> = ({ text, t, dark }) => (
  <div style={{ position: "absolute", right: 80, top: 54, fontFamily: SANS, fontSize: 16, fontWeight: 600, letterSpacing: "0.12em", color: dark ? "#6b6553" : C.ink3, opacity: k(t, [0.3, 0.8], [0, 1]), display: "flex", gap: 10, alignItems: "center" }}>
    <span style={{ width: 8, height: 8, borderRadius: 4, background: text.startsWith("LIVE") ? C.teal : C.coral }} />
    {text}
  </div>
);

const Grain: React.FC = () => {
  const f = useCurrentFrame();
  return (
    <AbsoluteFill
      style={{
        pointerEvents: "none",
        opacity: 0.07,
        mixBlendMode: "overlay",
        backgroundImage: `url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='240' height='240'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2' stitchTiles='stitch'/></filter><rect width='100%' height='100%' filter='url(%23n)'/></svg>")`,
        backgroundPosition: `${(f * 37) % 240}px ${(f * 53) % 240}px`,
      }}
    />
  );
};
const Vignette: React.FC = () => <AbsoluteFill style={{ pointerEvents: "none", background: "radial-gradient(ellipse at center, rgba(0,0,0,0) 55%, rgba(0,0,0,0.55) 100%)" }} />;

/** Real app screenshot as a floating 3D card. */
const Shot: React.FC<{ src: string; w: number; style?: React.CSSProperties; radius?: number }> = ({ src, w, style, radius = 22 }) => (
  <Img src={staticFile(src)} style={{ width: w, borderRadius: radius, boxShadow: "0 60px 120px -40px rgba(0,0,0,0.75), 0 0 0 1px rgba(255,255,255,0.06)", display: "block", ...style }} />
);

// ---------------------------------------------------------------- captions
type Cap = { text: string; s: number; e: number; words: { t: string; s: number; e: number }[] };
const CAPS = captions as Cap[];
const Captions: React.FC = () => {
  const f = useCurrentFrame();
  const tv = filmToVo(f / FPS);
  if (tv === null) return null;
  const t = tv;
  const cap = CAPS.find((c, i) => t >= c.s - 0.15 && t <= Math.min(c.e + 0.35, (CAPS[i + 1]?.s ?? 1e9) - 0.12));
  if (!cap) return null;
  const p = k(t, [cap.s - 0.15, cap.s + 0.1], [0, 1], out);
  return (
    <div style={{ position: "absolute", left: 0, right: 0, bottom: 64, display: "flex", justifyContent: "center", pointerEvents: "none" }}>
      <div style={{ maxWidth: 1500, padding: "14px 28px 16px", borderRadius: 18, background: "rgba(8,10,16,0.72)", backdropFilter: "blur(10px)", boxShadow: "0 0 0 1px rgba(255,255,255,0.07)", opacity: p, transform: `translateY(${(1 - p) * 14}px)`, textAlign: "center", fontFamily: SANS, fontWeight: 500, fontSize: 40, lineHeight: 1.3, color: "rgba(236,234,224,0.62)" }}>
        {cap.words.map((w, i) => {
          const on = t >= w.s - 0.03;
          return (
            <span key={i} style={{ color: on ? "#fffdf2" : undefined, marginRight: "0.26em", textShadow: on ? "0 0 18px rgba(244,220,74,0.18)" : undefined }}>
              {w.t}
            </span>
          );
        })}
      </div>
    </div>
  );
};

// ---------------------------------------------------------------- scenes
// S1 hook: results arrive before the doctor; 2 in 3 say they understood.
const Hook: React.FC<{ t: number }> = ({ t }) => {
  const notif = spring({ frame: Math.round(t * FPS) - 4, fps: FPS, config: { damping: 14, mass: 0.8 } });
  const big = k(t, [v(2.6), v(3.4)], [0, 1], out);
  const dots = [0, 1, 2];
  const flip = k(t, [v(8.2), v(8.8)], [0, 1], out);
  return (
    <Camera t={t} keys={[{ t: 0, z: 1.08, ry: -8, x: 60 }, { t: 3.6, z: 1, ry: 0, x: 0 }, { t: 11.2, z: 1.06, ry: 4, x: -30 }]}>
      <AbsoluteFill style={{ background: `radial-gradient(1000px 600px at 30% 30%, #151a2e 0%, ${C.bg} 60%)` }} />
      {/* phone notification */}
      <div style={{ position: "absolute", left: 120, top: 150, width: 560, transform: `translateY(${(1 - notif) * -80}px) scale(${0.9 + 0.1 * notif}) rotateY(10deg)`, opacity: Math.min(notif, k(t, [v(2.4), v(3.0)], [1, 0.35])) }}>
        <div style={{ borderRadius: 30, background: "rgba(30,34,52,0.85)", border: "1px solid rgba(255,255,255,0.1)", padding: "26px 30px", boxShadow: "0 40px 80px -30px #000" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 14, fontFamily: SANS, color: C.ink2, fontSize: 20 }}>
            <span style={{ width: 38, height: 38, borderRadius: 10, background: C.teal, display: "inline-block" }} />
            PATIENT PORTAL · now
          </div>
          <div style={{ fontFamily: SANS, color: C.ink, fontSize: 30, fontWeight: 600, marginTop: 14 }}>Your lab results are ready</div>
          <div style={{ fontFamily: SANS, color: C.ink2, fontSize: 24, marginTop: 6 }}>Your clinician hasn't reviewed them yet.</div>
        </div>
      </div>
      {/* 2 in 3 */}
      <div style={{ position: "absolute", left: 780, top: 170, opacity: big, transform: `translateY(${(1 - big) * 40}px)` }}>
        <div style={{ fontFamily: DISPLAY, fontWeight: 700, fontSize: 280, lineHeight: 0.9, letterSpacing: "-0.06em", color: C.ink }}>
          2 <span style={{ fontFamily: SERIF, fontWeight: 400, fontStyle: "italic", fontSize: 150, color: C.ink2, letterSpacing: "0" }}>in</span> 3
        </div>
        <div style={{ display: "flex", gap: 30, marginTop: 30 }}>
          {dots.map((i) => {
            const on = i < 2 ? 1 : flip;
            const col = i < 2 ? C.teal : C.coral;
            const p = k(t, [v(3.3) + i * 0.15, v(3.8) + i * 0.15], [0, 1], out);
            return (
              <svg key={i} width="110" height="150" viewBox="0 0 110 150" style={{ opacity: p }}>
                <circle cx="55" cy="38" r="30" fill={on ? col : "#2a2f45"} />
                <path d="M10 150 C10 95 100 95 100 150 Z" fill={on ? col : "#2a2f45"} />
              </svg>
            );
          })}
        </div>
        <div style={{ fontFamily: SANS, fontSize: 32, color: C.ink2, marginTop: 26, width: 900 }}>
          said they understood the results <b style={{ color: C.ink, fontWeight: 500 }}>they read before talking to a clinician.</b>
        </div>
        <div style={{ marginTop: 22, fontFamily: SERIF, fontStyle: "italic", fontSize: 54, color: C.coral, opacity: flip, transform: `translateX(${(1 - flip) * -30}px)` }}>
          1 in 3 didn't understand them well.
        </div>
      </div>
      <Foot t={t} at={v(3)}>
        Sources: ASTP/ONC analysis of NIH HINTS 2024 (JMIR, 2026) · Bather et al., JAMA Network Open, Aug 2026, n = 4,982: 68.6% viewed results before a clinician; 26.8% understood them only fairly well, 6.6% poorly.
      </Foot>
    </Camera>
  );
};

// S2 the report changes: two real pages, preliminary 5 -> amended 50.
const Change: React.FC<{ t: number; d: number }> = ({ t }) => {
  const swap = k(t, [4.3, 5.4], [0, 1]);
  const row = (top: number, color: string, show: number) => (
    <div style={{ position: "absolute", left: "8.6%", width: "54%", top: `${top}%`, height: "3.4%", background: color + "55", outline: `3px solid ${color}`, borderRadius: 4, transform: `scaleX(${show})`, transformOrigin: "left", mixBlendMode: "multiply" }} />
  );
  const fy = ((263.4 - 4) / 400) * 100;
  return (
    <Camera t={t} keys={[{ t: 0, z: 0.86, rx: 14, ry: -12, y: 40 }, { t: 2.6, z: 1.0, rx: 6, ry: -6 }, { t: 5.5, z: 1.25, rx: 0, ry: 0, x: -120, y: -40 }, { t: 7.6, z: 1.3, x: -160, y: -50 }]}>
      <AbsoluteFill style={{ background: `radial-gradient(900px 600px at 70% 40%, #1a1630 0%, ${C.bg} 65%)` }} />
      <Rise t={t} at={0.15} text="Now imagine the report itself changes." size={64} style={{ position: "absolute", left: 120, top: 70, width: 1500 }} />
      {/* preliminary page */}
      <div style={{ position: "absolute", left: 160, top: 250, width: 760, transform: `translateZ(${-swap * 140}px) rotateY(${swap * -8}deg)`, opacity: 1 - swap * 0.45 }}>
        <div style={{ position: "relative" }}>
          <Shot src="ui/a-2026-10-prelim.png" w={760} radius={12} />
          {row(fy, C.coral, k(t, [1.4, 2.0], [0, 1], out))}
        </div>
        <div style={{ marginTop: 20, display: "flex", gap: 16, alignItems: "center" }}>
          <Tag text="Preliminary · 13 Oct" color={C.coral} t={t} at={1.2} />
          <span style={{ fontFamily: SERIF, fontSize: 92, color: C.coral, opacity: k(t, [1.6, 2.1], [0, 1]), textDecoration: swap > 0.5 ? "line-through" : undefined, textDecorationThickness: 6 }}>5</span>
          <span style={{ fontFamily: SANS, fontSize: 26, color: C.ink2, opacity: k(t, [1.6, 2.1], [0, 1]) }}>ng/mL ferritin</span>
        </div>
      </div>
      {/* amended page */}
      <div style={{ position: "absolute", left: 1000, top: 250, width: 760, opacity: k(t, [3.6, 4.6], [0, 1], out), transform: `translateX(${(1 - swap) * 120}px) rotateY(${(1 - swap) * 18}deg)` }}>
        <div style={{ position: "relative" }}>
          <Shot src="ui/a-2026-10-amended.png" w={760} radius={12} />
          {row(fy, C.teal, k(t, [5.0, 5.6], [0, 1], out))}
        </div>
        <div style={{ marginTop: 20, display: "flex", gap: 16, alignItems: "center" }}>
          <Tag text="Amended · 15 Oct" color={C.teal} t={t} at={4.6} />
          <span style={{ fontFamily: SERIF, fontSize: 92, color: C.teal, opacity: k(t, [5.2, 5.7], [0, 1]) }}>50</span>
          <span style={{ fontFamily: SANS, fontSize: 26, color: C.ink2, opacity: k(t, [5.2, 5.7], [0, 1]) }}>ng/mL ferritin</span>
        </div>
      </div>
      <Badge t={t} text="SYNTHETIC REPORTS · SYN-0001" />
    </Camera>
  );
};

// S3 which number should an AI say?
const Question: React.FC<{ t: number }> = ({ t }) => {
  const glitch = Math.floor(t * 9) % 2 === 0;
  const bad = k(t, [1.6, 2.0], [0, 1], out);
  return (
    <Camera t={t} keys={[{ t: 0, z: 1.1, rz: -1 }, { t: 5.2, z: 1, rz: 0.6 }]}>
      <AbsoluteFill style={{ background: C.bg }} />
      <div style={{ position: "absolute", left: 120, top: 120, display: "flex", gap: 22 }}>
        <Tag text="Same patient · SYN-0001" color={C.ink2} t={t} at={0.0} />
        <Tag text="Same collection · 12 Oct" color={C.ink2} t={t} at={0.9} />
      </div>
      <div style={{ position: "absolute", left: 120, top: 260, width: 820, opacity: bad, transform: `translateY(${(1 - bad) * 30}px)` }}>
        <div style={{ fontFamily: SANS, fontSize: 20, color: C.ink3, letterSpacing: "0.1em", marginBottom: 12 }}>A GENERIC CHATBOT</div>
        <div style={{ borderRadius: 26, padding: "26px 30px", background: "#191d2c", border: `1.5px solid ${C.red}55`, fontFamily: SANS, fontSize: 34, color: C.ink, lineHeight: 1.35 }}>
          “Your ferritin is <b style={{ color: C.red }}>{glitch ? "5" : "50"}</b> ng/mL{glitch ? ", which is very low." : ", which is normal."}”
        </div>
        <div style={{ marginTop: 14, fontFamily: SANS, fontSize: 22, color: C.red }}>Fluent either way. Right only by luck.</div>
      </div>
      <Rise t={t} at={2.3} text="Which number should an AI say aloud?" size={92} italic style={{ position: "absolute", left: 1000, top: 280, width: 820 }} />
    </Camera>
  );
};

// S4 meet Voice Memory (cream inversion): you ask, Bolna handles the speech.
const Meet: React.FC<{ t: number }> = ({ t }) => {
  const logo = spring({ frame: Math.round(t * FPS), fps: FPS, config: { damping: 13 } });
  const bars = new Array(34).fill(0).map((_, i) => 10 + Math.abs(Math.sin(i * 0.7 + t * 9)) * 70 * k(t, [1.7, 2.2], [0, 1]) * (0.5 + 0.5 * Math.sin(i * 0.31 + t * 3)));
  return (
    <Camera t={t} keys={[{ t: 0, z: 1.15 }, { t: 1.4, z: 1 }, { t: 4.8, z: 1.04, x: -20 }]}>
      <AbsoluteFill style={{ background: C.cream }} />
      <div style={{ position: "absolute", left: 0, right: 0, top: 210, textAlign: "center", transform: `scale(${0.8 + 0.2 * logo})`, opacity: logo }}>
        <div style={{ fontFamily: SERIF, fontSize: 168, letterSpacing: "-0.035em", color: C.creamInk, lineHeight: 1 }}>Voice Memory</div>
        <div style={{ height: 10, width: k(t, [0.5, 1.2], [0, 560], out), background: C.mark, margin: "18px auto 0", borderRadius: 6 }} />
      </div>
      <div style={{ position: "absolute", left: 0, right: 0, top: 560, display: "flex", justifyContent: "center", alignItems: "center", gap: 60 }}>
        <div style={{ opacity: k(t, [1.3, 1.8], [0, 1]), fontFamily: SERIF, fontSize: 64, color: C.creamInk }}>You ask.</div>
        <div style={{ display: "flex", gap: 6, alignItems: "center", height: 110 }}>
          {bars.map((h, i) => (
            <span key={i} style={{ width: 8, height: h, borderRadius: 4, background: C.creamInk, opacity: 0.85 }} />
          ))}
        </div>
        <div style={{ opacity: k(t, [2.3, 2.8], [0, 1]), fontFamily: SERIF, fontSize: 64, color: C.creamInk }}>
          <span style={{ background: C.creamInk, color: C.cream, padding: "2px 18px", borderRadius: 12, fontFamily: SANS, fontWeight: 600, fontSize: 52 }}>Bolna</span> handles the speech.
        </div>
      </div>
      <Badge t={t} dark text="ILLUSTRATION OF THE CALL FLOW" />
    </Camera>
  );
};

// S5 the engine: find the passage, check its status, return what the record supports.
const Engine: React.FC<{ t: number }> = ({ t }) => {
  const checks: [string, string, string, number][] = [
    ["Patient", "SYN-0001 on every cited row", C.teal, 3.0],
    ["Collection", "12 Oct · same sample", C.teal, 3.6],
    ["Report status", "AMENDED replaces PRELIMINARY", C.teal, 4.2],
    ["Units", "ng/mL = ng/mL", C.teal, 4.8],
  ];
  const fy = ((263.4 - 4) / 400) * 100;
  const ans = k(t, [6.2, 6.9], [0, 1], out);
  // memory graph path
  const N = [
    { x: 160, y: 120, l: "SYN-0001", c: C.mark, r: 22 },
    { x: 380, y: 60, l: "Ferritin", c: C.violet, r: 12 },
    { x: 560, y: 160, l: "5 · prelim", c: C.coral, r: 16 },
    { x: 610, y: 20, l: "50 · amended", c: C.teal, r: 18 },
    { x: 300, y: 250, l: "0.5 · Sep", c: C.teal, r: 14 },
  ];
  const E: [number, number, string][] = [[0, 1, "#3a4060"], [1, 2, "#3a4060"], [1, 3, "#3a4060"], [1, 4, "#3a4060"], [3, 2, C.mark], [4, 3, C.teal]];
  const g = k(t, [1.2, 2.2], [0, 1]);
  return (
    <Camera t={t} keys={[{ t: 0, z: 0.94, ry: 6, x: 40 }, { t: 3, z: 1.0, ry: 0 }, { t: 6, z: 1.04, ry: -4, x: -40 }, { t: 8.8, z: 1.1, ry: -6, x: -80 }]}>
      <AbsoluteFill style={{ background: `radial-gradient(1100px 700px at 40% 30%, #121a33 0%, ${C.bg} 60%)` }} />
      <Label style={{ position: "absolute", left: 120, top: 80 }} color={C.mark}>
        The evidence engine
      </Label>
      <Rise t={t} at={0.1} text="Find the passage. Check its status. Say only what it supports." size={56} style={{ position: "absolute", left: 120, top: 120, width: 1600 }} />
      {/* page with located row */}
      <div style={{ position: "absolute", left: 120, top: 300, width: 700, transform: "rotateY(8deg)" }}>
        <div style={{ position: "relative" }}>
          <Shot src="ui/a-2026-10-amended.png" w={700} radius={12} />
          <div style={{ position: "absolute", left: "8.6%", width: "54%", top: `${fy}%`, height: "3.4%", background: C.mark + "88", outline: `3px solid ${C.mark}`, borderRadius: 4, transform: `scaleX(${k(t, [0.9, 1.6], [0, 1], out)})`, transformOrigin: "left", mixBlendMode: "multiply" }} />
        </div>
        <div style={{ fontFamily: SANS, color: C.ink3, fontSize: 18, marginTop: 12 }}>a-2026-10-amended.pdf · page 1 · the original passage</div>
      </div>
      {/* checks */}
      <div style={{ position: "absolute", left: 900, top: 300, width: 860, display: "grid", gap: 14 }}>
        {checks.map(([a, b, col, at], i) => {
          const p = k(t, [at, at + 0.4], [0, 1], out);
          return (
            <div key={i} style={{ display: "flex", alignItems: "center", gap: 18, padding: "16px 22px", borderRadius: 18, background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)", opacity: p, transform: `translateX(${(1 - p) * 40}px)` }}>
              <span style={{ width: 34, height: 34, borderRadius: 17, background: col, display: "grid", placeItems: "center", color: "#07130f", fontWeight: 700, fontFamily: SANS, fontSize: 20 }}>✓</span>
              <span style={{ fontFamily: SANS, fontWeight: 600, color: C.ink, fontSize: 26, width: 210 }}>{a}</span>
              <span style={{ fontFamily: SANS, color: C.ink2, fontSize: 24 }}>{b}</span>
            </div>
          );
        })}
        <div style={{ marginTop: 10, padding: "20px 26px", borderRadius: 22, background: C.teal + "1c", border: `1.5px solid ${C.teal}88`, opacity: ans, transform: `translateY(${(1 - ans) * 20}px)` }}>
          <div style={{ fontFamily: SANS, fontSize: 17, letterSpacing: "0.12em", color: C.teal, fontWeight: 600 }}>SENT BACK TO BOLNA TO SPEAK</div>
          <div style={{ fontFamily: SERIF, fontSize: 36, color: C.ink, marginTop: 6, lineHeight: 1.25 }}>“Your ferritin is 50 ng/mL. The 12 October result was corrected from 5 to 50, and I'm using the corrected value.”</div>
        </div>
      </div>
      {/* memory graph strip */}
      <svg width="760" height="300" viewBox="0 0 760 300" style={{ position: "absolute", left: 1080, top: 760, opacity: g * k(t, [6.0, 6.6], [1, 0.0]) }}>
        {E.map(([a, b, col], i) => {
          const p = k(t, [1.4 + i * 0.25, 1.9 + i * 0.25], [0, 1]);
          const special = col !== "#3a4060";
          return <line key={i} x1={N[a].x} y1={N[a].y} x2={N[a].x + (N[b].x - N[a].x) * p} y2={N[a].y + (N[b].y - N[a].y) * p} stroke={col} strokeWidth={special ? 3 : 1.5} strokeDasharray={special ? "8 7" : undefined} strokeDashoffset={-t * 30} />;
        })}
        {N.map((n, i) => (
          <g key={i} opacity={k(t, [1.2 + i * 0.15, 1.6 + i * 0.15], [0, 1])}>
            <circle cx={n.x} cy={n.y} r={n.r} fill={n.c + "33"} stroke={n.c} strokeWidth={3} />
            <text x={n.x} y={n.y + n.r + 22} textAnchor="middle" fill={C.ink} fontFamily="Plex" fontSize={16} fontWeight={600}>
              {n.l}
            </text>
          </g>
        ))}
        <text x={470} y={120} fill={C.mark} fontFamily="Plex" fontSize={15} fontWeight={600} opacity={k(t, [2.8, 3.2], [0, 1])}>
          corrects
        </text>
      </svg>
      <Label style={{ position: "absolute", left: 1080, top: 720, opacity: g * k(t, [6.0, 6.6], [1, 0]) }} color={C.ink3}>
        Memory graph · the edge that decides it
      </Label>
      <Badge t={t} text="ILLUSTRATION · REAL ENGINE OUTPUT" />
    </Camera>
  );
};

// Real app screenshot with a guided camera move.
const UI: React.FC<{ t: number; src: string; w: number; h: number; keys: Key[]; badge?: string; overlay?: React.ReactNode }> = ({ t, src, w, h, keys, badge = "LIVE APP · FICTIONAL RECORDS", overlay }) => (
  <>
    <Camera t={t} keys={keys} persp={2400}>
      <AbsoluteFill style={{ background: `radial-gradient(1200px 700px at 50% 40%, #1b2136 0%, ${C.bg} 70%)` }} />
      <div style={{ position: "absolute", left: 960 - w / 2, top: 540 - h / 2, width: w }}>
        <Shot src={src} w={w} radius={26} />
      </div>
    </Camera>
    {overlay}
    <Badge t={t} text={badge} />
  </>
);

// S8 beyond healthcare
const Beyond: React.FC<{ t: number }> = ({ t }) => {
  const cards: [string, string, string][] = [
    ["Lab reports", "amended · preliminary · units · patients", C.teal],
    ["Contracts", "proposed · superseded · signed", C.mark],
    ["Meetings", "discussed · decided · still open", C.violet],
  ];
  return (
    <Camera t={t} keys={[{ t: 0, z: 1.05, rx: 10 }, { t: 2.8, z: 0.98, rx: 0 }]}>
      <AbsoluteFill style={{ background: C.bg }} />
      <Rise t={t} at={0.05} text="It goes beyond healthcare." size={84} style={{ position: "absolute", left: 120, top: 150, width: 1600 }} />
      <div style={{ position: "absolute", left: 120, top: 420, display: "flex", gap: 30 }}>
        {cards.map(([a, b, col], i) => {
          const p = k(t, [0.5 + i * 0.25, 1.0 + i * 0.25], [0, 1], out);
          return (
            <div key={i} style={{ width: 530, padding: "34px 34px", borderRadius: 28, background: "rgba(255,255,255,0.04)", border: `1.5px solid ${col}55`, opacity: p, transform: `translateY(${(1 - p) * 60}px) rotateX(${(1 - p) * 30}deg)` }}>
              <div style={{ width: 52, height: 6, borderRadius: 3, background: col }} />
              <div style={{ fontFamily: SERIF, fontSize: 58, color: C.ink, marginTop: 20 }}>{a}</div>
              <div style={{ fontFamily: SANS, fontSize: 24, color: C.ink2, marginTop: 8 }}>{b}</div>
            </div>
          );
        })}
      </div>
    </Camera>
  );
};

// S9 the deal: $48,000 -> $42,000 proposed; discussed isn't decided.
const Deal: React.FC<{ t: number }> = ({ t }) => {
  const strike = k(t, [1.0, 1.5], [0, 1], out);
  const p42 = k(t, [2.2, 2.9], [0, 1], out);
  const meet = k(t, [6.2, 6.9], [0, 1], out);
  return (
    <Camera t={t} keys={[{ t: 0, z: 1.02, x: 40 }, { t: 4.5, z: 1, x: 0 }, { t: 6.4, z: 0.96, y: -30 }, { t: 9.6, z: 1.02, y: -40 }]}>
      <AbsoluteFill style={{ background: `radial-gradient(1000px 600px at 70% 30%, #23200f 0%, ${C.bg} 60%)` }} />
      <Label style={{ position: "absolute", left: 120, top: 80 }} color={C.mark}>
        Northstar deal · fictional records
      </Label>
      <div style={{ position: "absolute", left: 120, top: 150, display: "flex", alignItems: "baseline", gap: 50, opacity: 1 - meet * 0.75, transform: `scale(${1 - meet * 0.25})`, transformOrigin: "left top" }}>
        <div style={{ position: "relative", fontFamily: SERIF, fontSize: 170, color: C.coral, letterSpacing: "-0.03em", opacity: k(t, [0, 0.4], [0, 1]) }}>
          $48,000
          <div style={{ position: "absolute", left: -8, right: -8, top: "54%", height: 10, background: C.red, borderRadius: 5, transform: `scaleX(${strike})`, transformOrigin: "left" }} />
          <div style={{ fontFamily: DISPLAY, fontSize: 24, letterSpacing: "0.02em", color: C.ink2, marginTop: 4 }}>Proposal v1 · offer · superseded</div>
        </div>
        <div style={{ opacity: p42, transform: `translateX(${(1 - p42) * 60}px)` }}>
          <Odometer t={t} at={2.2} from="$48,000" to="$42,000" size={170} color={C.ink} />
          <div style={{ display: "flex", gap: 14, marginTop: 14 }}>
            <Tag text="Proposed" color={C.mark} t={t} at={3.0} />
            <Tag text="Finance approval: not recorded" color={C.red} t={t} at={4.6} />
          </div>
        </div>
      </div>
      <div style={{ position: "absolute", left: 120, top: 500, width: 1680, opacity: meet, transform: `translateY(${(1 - meet) * 40}px)` }}>
        <div style={{ fontFamily: SANS, fontSize: 22, letterSpacing: "0.12em", color: C.ink3 }}>STEERING COMMITTEE NOTES · PAYMENT SPLIT</div>
        <div style={{ display: "flex", gap: 30, marginTop: 18 }}>
          <div style={{ flex: 1, padding: "26px 30px", borderRadius: 24, background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.1)" }}>
            <div style={{ fontFamily: SERIF, fontSize: 96, color: C.ink }}>40/60</div>
            <Tag text="Proposed in the revision" color={C.mark} t={t} at={6.8} />
          </div>
          <div style={{ flex: 1, padding: "26px 30px", borderRadius: 24, background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.1)" }}>
            <div style={{ fontFamily: SERIF, fontSize: 96, color: C.ink }}>50/50</div>
            <Tag text="Discussed at steering" color={C.violet} t={t} at={7.2} />
          </div>
          <div style={{ flex: 1.1, padding: "26px 30px", borderRadius: 24, background: C.coral + "18", border: `1.5px solid ${C.coral}77`, opacity: k(t, [7.6, 8.1], [0, 1], out) }}>
            <div style={{ fontFamily: SERIF, fontSize: 70, color: C.coral, fontStyle: "italic", lineHeight: 1.05 }}>Discussed isn't decided.</div>
            <div style={{ fontFamily: SANS, fontSize: 24, color: C.ink2, marginTop: 12 }}>Answer: still open, not approved.</div>
          </div>
        </div>
      </div>
    </Camera>
  );
};

// S11 close: the memory graph, then the line.
const Close: React.FC<{ t: number }> = ({ t }) => (
  <>
    <Camera t={t} keys={[{ t: 0, z: 1.22, x: -120, y: 40, ry: -6 }, { t: 4.5, z: 1.05, x: 0, y: 0, ry: 0 }, { t: 8.2, z: 1.0, x: 30, ry: 3 }]}>
      <AbsoluteFill style={{ background: "#0a0c14" }} />
      <Img src={staticFile("ui/graph-story-3.png")} style={{ position: "absolute", left: 0, top: 0, width: 1920, height: 1200, objectFit: "cover", opacity: k(t, [0, 0.6], [0, 0.95]) }} />
    </Camera>
    <AbsoluteFill style={{ background: "linear-gradient(90deg, rgba(7,8,13,0.92) 0%, rgba(7,8,13,0.55) 45%, rgba(7,8,13,0) 70%)" }} />
    <div style={{ position: "absolute", left: 120, top: 240, width: 900 }}>
      <Label color={C.mark}>Memory graph · live page</Label>
      <Rise t={t} at={0.3} text="It doesn't just find an answer." size={78} style={{ marginTop: 24 }} />
      <Rise t={t} at={3.2} text="It checks whether the record allows it." size={78} italic color={C.mark} style={{ marginTop: 24 }} />
    </div>
    <Badge t={t} text="LIVE APP · MEMORY GRAPH" />
  </>
);

// S12 outro: impact with sources, then the call to action.
const Outro: React.FC<{ t: number }> = ({ t }) => {
  const stats: [string, string, string][] = [
    ["68.6%", "of US adults with online records read test results before a clinician explains them", "JAMA Network Open · Aug 2026"],
    ["1 in 3", "of them don't fully understand what they read", "Same study · HINTS 2024, n = 4,982"],
    ["40M+", "health questions a day go to ChatGPT; ECRI ranks chatbot misuse the #1 health-tech hazard of 2026", "ECRI Top 10 Hazards · Jan 2026"],
  ];
  const cta = k(t, [4.6, 5.3], [0, 1], out);
  return (
    <Camera t={t} keys={[{ t: 0, z: 1.04 }, { t: 9, z: 1 }]}>
      <AbsoluteFill style={{ background: C.cream }} />
      <div style={{ position: "absolute", left: 120, top: 110, opacity: 1 - cta, transform: `translateY(${-cta * 40}px)` }}>
        <Label color="#6b6553">Why it matters</Label>
        <div style={{ display: "flex", gap: 30, marginTop: 30 }}>
          {stats.map(([n, txt, src], i) => {
            const p = k(t, [0.2 + i * 0.35, 0.8 + i * 0.35], [0, 1], out);
            return (
              <div key={i} style={{ width: 540, padding: "34px 34px", borderRadius: 28, background: "#fffdf6", border: "1px solid #e2dfd1", opacity: p, transform: `translateY(${(1 - p) * 50}px)`, boxShadow: "0 30px 60px -40px rgba(22,28,45,0.5)" }}>
                <div style={{ fontFamily: SERIF, fontSize: 120, color: C.coral, letterSpacing: "-0.03em", lineHeight: 1 }}>{n}</div>
                <div style={{ fontFamily: SANS, fontSize: 27, color: C.creamInk, marginTop: 18, lineHeight: 1.35 }}>{txt}</div>
                <div style={{ fontFamily: SANS, fontSize: 18, color: "#80859a", marginTop: 18, borderTop: "1px solid #e2dfd1", paddingTop: 12 }}>{src}</div>
              </div>
            );
          })}
        </div>
      </div>
      <div style={{ position: "absolute", left: 0, right: 0, top: 250, textAlign: "center", opacity: cta, transform: `translateY(${(1 - cta) * 40}px)` }}>
        <div style={{ fontFamily: SERIF, fontSize: 150, color: C.creamInk, letterSpacing: "-0.035em" }}>Voice Memory</div>
        <div style={{ fontFamily: SERIF, fontStyle: "italic", fontSize: 54, color: "#4c5263", marginTop: 4 }}>Ask out loud. Check the line.</div>
        <div style={{ display: "inline-flex", gap: 18, marginTop: 48, alignItems: "center" }}>
          <span style={{ fontFamily: SANS, fontWeight: 600, fontSize: 34, background: C.mark, color: C.creamInk, padding: "16px 30px", borderRadius: 16, border: `2px solid ${C.creamInk}` }}>voice-memory-beige.vercel.app</span>
          <span style={{ fontFamily: SANS, fontWeight: 500, fontSize: 28, color: C.creamInk, padding: "16px 26px", borderRadius: 16, border: `2px solid ${C.creamInk}` }}>Built on Bolna</span>
        </div>
        <div style={{ fontFamily: SANS, fontSize: 20, color: "#80859a", marginTop: 40 }}>Fictional, synthetic records. A research prototype, not a diagnostic or clinically validated product.</div>
      </div>
    </Camera>
  );
};

// Insert 1: a real Bolna call, from its call log (transcript verbatim).
const CallLog: React.FC<{ t: number }> = ({ t }) => {
  const bars = new Array(28).fill(0).map((_, i) => 8 + Math.abs(Math.sin(i * 0.8 + t * 10)) * 46 * (0.4 + 0.6 * Math.abs(Math.sin(i * 0.37 + t * 2.3))));
  const user = "has the creatine got gone up क्या अपना creatine ज़्यादा हो गया है";
  const agent = "मैं आपके दोनों Creatinine नतीजों की तुलना नहीं कर सकता: 3 सितंबर 2026 वाला mg/dL में है और 12 अक्टूबर 2026 वाला µmol/L में, और मैं यूनिट नहीं बदलता।";
  const typed = (txt: string, a: number, cps: number) => txt.slice(0, Math.max(0, Math.floor((t - a) * cps)));
  const pu = k(t, [0.5, 0.9], [0, 1], out);
  const pa = k(t, [2.9, 3.3], [0, 1], out);
  const chip = k(t, [5.3, 5.7], [0, 1], out);
  return (
    <Camera t={t} keys={[{ t: 0, z: 1.12, y: 30, rx: 6 }, { t: 2.5, z: 1.02, y: 0, rx: 0 }, { t: 7.6, z: 1.06, x: -20 }]}>
      <AbsoluteFill style={{ background: `radial-gradient(1000px 640px at 50% 30%, #13213a 0%, ${C.bg} 65%)` }} />
      <Label style={{ position: "absolute", left: 120, top: 90 }} color={C.teal}>
        Real Bolna call · transcript from the call log
      </Label>
      <div style={{ position: "absolute", left: 120, top: 140, display: "flex", alignItems: "center", gap: 22 }}>
        <div style={{ fontFamily: SERIF, fontSize: 64, color: C.ink }}>Asked in English and Hindi, on a live call</div>
      </div>
      <div style={{ position: "absolute", left: 120, top: 270, width: 1680, display: "flex", alignItems: "center", gap: 26, padding: "18px 26px", borderRadius: 22, background: "#121a2c", border: "1px solid rgba(255,255,255,0.08)" }}>
        <span style={{ width: 16, height: 16, borderRadius: 8, background: C.coral, boxShadow: `0 0 18px ${C.coral}` }} />
        <span style={{ fontFamily: DISPLAY, fontWeight: 600, fontSize: 26, color: C.ink }}>Live · Bolna web call</span>
        <div style={{ display: "flex", gap: 5, alignItems: "center", height: 60 }}>
          {bars.map((h, i) => <span key={i} style={{ width: 6, height: h, borderRadius: 3, background: t < 2.9 ? C.ink2 : C.mark }} />)}
        </div>
        <span style={{ fontFamily: SANS, fontSize: 22, color: C.ink3, marginLeft: "auto" }}>speech → Bolna ASR → Voice Memory → Bolna TTS</span>
      </div>
      <div style={{ position: "absolute", left: 120, top: 420, width: 1100, opacity: pu, transform: `translateY(${(1 - pu) * 20}px)` }}>
        <div style={{ fontFamily: DISPLAY, fontSize: 20, letterSpacing: "0.12em", color: C.ink3, fontWeight: 600 }}>CALLER · AS BOLNA HEARD IT</div>
        <div style={{ marginTop: 10, padding: "20px 26px", borderRadius: 22, background: "rgba(255,255,255,0.06)", fontFamily: SANS, fontSize: 36, color: C.ink, lineHeight: 1.4, minHeight: 70 }}>
          “{typed(user, 0.8, 26)}”
        </div>
      </div>
      <div style={{ position: "absolute", left: 600, top: 610, width: 1200, opacity: pa, transform: `translateY(${(1 - pa) * 20}px)` }}>
        <div style={{ fontFamily: DISPLAY, fontSize: 20, letterSpacing: "0.12em", color: C.teal, fontWeight: 600 }}>VOICE MEMORY · SPOKEN BACK, IN HINDI</div>
        <div style={{ marginTop: 10, padding: "20px 26px", borderRadius: 22, background: C.teal + "1c", border: `1.5px solid ${C.teal}77`, fontFamily: SANS, fontSize: 32, color: C.ink, lineHeight: 1.45, minHeight: 120 }}>
          {typed(agent, 3.1, 58)}
        </div>
        <div style={{ marginTop: 14, display: "flex", gap: 16, alignItems: "center", opacity: chip }}>
          <Tag text="Won't compare: units differ" color={C.red} t={t} at={5.3} />
          <span style={{ fontFamily: SANS, fontSize: 24, color: C.ink2 }}>“I can't compare your two creatinine results: mg/dL vs µmol/L.”</span>
        </div>
      </div>
      <Badge t={t} text="LIVE CALL · 1 NOV 2026, 00:24 IST" />
    </Camera>
  );
};

// Insert 2: typed questions answering in the real page (screen capture, 1.5x).
const TypedClip: React.FC<{ t: number }> = ({ t }) => (
  <>
    <Camera t={t} keys={[{ t: 0, z: 1.0, y: 10 }, { t: 3.2, z: 1.06, x: 60, y: 40 }, { t: 6.4, z: 1.02, x: -40, y: 20 }, { t: 10, z: 1.06, x: 50, y: 30 }]} persp={2400}>
      <AbsoluteFill style={{ background: `radial-gradient(1200px 700px at 50% 40%, #1b2136 0%, ${C.bg} 70%)` }} />
      <div style={{ position: "absolute", left: 160, top: 70, width: 1600, borderRadius: 22, overflow: "hidden", boxShadow: "0 60px 120px -40px rgba(0,0,0,0.8), 0 0 0 1px rgba(255,255,255,0.08)" }}>
        <OffthreadVideo src={staticFile("ui/typed.mp4")} playbackRate={1.5} muted style={{ width: 1600, display: "block" }} />
      </div>
    </Camera>
    <Badge t={t} text="LIVE APP · SCREEN RECORDING · 1.5×" />
  </>
);

// ---------------------------------------------------------------- film
export const Film: React.FC = () => {
  const { width } = useVideoConfig();
  return (
    <AbsoluteFill style={{ background: C.bg, fontFamily: SANS }}>
      <Fonts />
      <div style={{ position: "absolute", inset: 0, transform: `scale(${width / 1920})`, transformOrigin: "top left", width: 1920, height: 1080 }}>
        <Scene a={0} b={v(10.0)}>{(t) => <Hook t={t} />}</Scene>
        <Scene a={v(9.9)} b={v(17.5)}>{(t, d) => <Change t={t} d={d} />}</Scene>
        <Scene a={v(17.45)} b={v(22.8)}>{(t) => <Question t={t} />}</Scene>
        <Scene a={v(22.75)} b={gapStart(0) + 0.15} fade={0.25}>{(t) => <Meet t={t} />}</Scene>
        <Scene a={gapStart(0)} b={gapStart(0) + GAPS[0].len + 0.15} fade={0.3}>{(t) => <CallLog t={t} />}</Scene>
        <Scene a={v(27.5)} b={v(36.75)}>{(t) => <Engine t={t} />}</Scene>
        <Scene a={v(36.7)} b={v(39.8)}>
          {(t) => <UI t={t} src="ui/desk-ferritin.png" w={1500} h={1003} keys={[{ t: 0, z: 0.82, rx: 8, y: 30 }, { t: 1.3, z: 1.35, x: 300, y: 110, rx: 0 }, { t: 3.1, z: 1.55, x: -260, y: 60 }]} />}
        </Scene>
        <Scene a={v(39.75)} b={v(45.95)}>
          {(t) => (
            <UI
              t={t}
              src="ui/desk-creatinine.png"
              w={1500}
              h={1237}
              keys={[{ t: 0, z: 0.75, ry: -10 }, { t: 1.8, z: 1.25, x: 330, y: 130, ry: 0 }, { t: 3.8, z: 1.35, x: -300, y: 0 }, { t: 6.2, z: 1.3, x: -300, y: -260 }]}
              overlay={
                <div style={{ position: "absolute", right: 90, bottom: 190, padding: "22px 30px", borderRadius: 22, background: "rgba(10,12,20,0.88)", border: `1.5px solid ${C.red}88`, opacity: k(useCurrentFrame() / FPS, [2.8, 3.3], [0, 1]) }}>
                  <div style={{ fontFamily: SERIF, fontSize: 64, color: C.ink }}>
                    1.2 mg/dL <span style={{ color: C.red }}>≠</span> 106 µmol/L
                  </div>
                  <div style={{ fontFamily: SANS, fontSize: 24, color: C.red, marginTop: 6 }}>No validated conversion → won't compare</div>
                </div>
              }
            />
          )}
        </Scene>
        <Scene a={v(45.9)} b={v(48.65)}>{(t) => <Beyond t={t} />}</Scene>
        <Scene a={v(48.6)} b={v(58.65)}>{(t) => <Deal t={t} />}</Scene>
        <Scene a={v(58.6)} b={gapStart(1) + 0.15}>
          {(t) => <UI t={t} src="ui/desk-deal42.png" w={1500} h={1214} keys={[{ t: 0, z: 1.35, x: 300, y: 180 }, { t: 1.6, z: 1.35, x: 300, y: 100 }, { t: 3.5, z: 1.4, x: -320, y: 220 }]} />}
        </Scene>
        <Scene a={gapStart(1)} b={gapStart(1) + GAPS[1].len + 0.15} fade={0.3}>{(t) => <TypedClip t={t} />}</Scene>
        <Scene a={v(62.1)} b={v(70.3)}>{(t) => <Close t={t} />}</Scene>
        <Scene a={v(70.2)} b={END} fade={0.4}>{(t) => <Outro t={t} />}</Scene>
      </div>
      <Captions />
      <Grain />
      <Vignette />
    </AbsoluteFill>
  );
};
