// The memory-graph band in 3D (Three.js + pmndrs/postprocessing bloom +
// three.quarks particles). Same graph the engine answers from (snapshot or
// /api/public/graph/health). Splines do the work, none is drawn:
//   - the camera rides a closed Catmull-Rom orbit (CatmullRomCurve3, sampled
//     by arc length so its speed is even) and leans toward the pointer on a
//     critically damped spring;
//   - a `corrects` edge carries a particle comet from the old value to the
//     corrected one along an arched spline; a `not comparable` edge carries
//     one that stalls halfway and fades, because the values never meet.
// Lazy-loaded by the landing when the band nears the viewport; the 2D
// canvas stays as the fallback (no WebGL, reduced motion, or load failure).
import * as THREE from "three";
import { EffectComposer, RenderPass, EffectPass, BloomEffect } from "postprocessing";
import {
  BatchedRenderer,
  ParticleSystem,
  RenderMode,
  ConstantValue,
  IntervalValue,
  ConstantColor,
  Vector4,
  PointEmitter,
  ColorOverLife,
  Gradient,
  SizeOverLife,
  PiecewiseBezier,
  Bezier,
  Vector3 as QV3,
} from "three.quarks";
import { smoothDamp } from "../motion-math.mjs";
import { animate as loop, onVisible, reducedMotion } from "../motion-loop.mjs";

const COLORS = { patient: 0xf4dc4a, document: 0x8fa3ff, topic: 0xeceae0, value: 0x4fd1bd };
const SUPERSEDED = 0xe8735a;

// Deterministic 3D force layout, computed once before the first frame.
function layout(graph) {
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
  const nodes = graph.nodes.map((n) => ({ ...n, p: new THREE.Vector3(rnd() * 60, rnd() * 40, rnd() * 40), v: new THREE.Vector3() }));
  const by = new Map(nodes.map((n) => [n.id, n]));
  const edges = graph.edges.map((e) => ({ ...e, a: by.get(e.from), b: by.get(e.to) })).filter((e) => e.a && e.b);
  const d = new THREE.Vector3();
  for (let it = 0; it < 420; it++) {
    for (const a of nodes)
      for (const b of nodes) {
        if (a === b) continue;
        d.subVectors(a.p, b.p);
        const l2 = d.lengthSq() + 0.01;
        if (l2 < 4000) a.v.addScaledVector(d, 30 / l2);
      }
    for (const e of edges) {
      d.subVectors(e.b.p, e.a.p);
      const l = d.length() || 1;
      const rest = e.kind === "corrects" ? 30 : e.kind === "not comparable" ? 30 : e.kind === "has report" ? 26 : 18;
      const f = (l - rest) * 0.02;
      d.multiplyScalar(f / l);
      e.a.v.add(d);
      e.b.v.sub(d);
    }
    for (const n of nodes) {
      n.v.addScaledVector(n.p, -0.004);
      n.v.multiplyScalar(0.8);
      n.p.add(n.v);
    }
  }
  return { nodes, edges };
}

function dotTexture() {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const g = c.getContext("2d");
  const r = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  r.addColorStop(0, "rgba(255,255,255,1)");
  r.addColorStop(0.35, "rgba(255,255,255,0.6)");
  r.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = r;
  g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

function label(text, color) {
  const c = document.createElement("canvas");
  const g = c.getContext("2d");
  const font = "500 44px Plex, system-ui, sans-serif";
  g.font = font;
  c.width = Math.ceil(g.measureText(text).width) + 16;
  c.height = 60;
  g.font = font;
  g.fillStyle = color;
  g.fillText(text, 8, 44);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }));
  s.scale.set(c.width / 9, c.height / 9, 1);
  return s;
}

// A comet that rides `curve` by arc length (getPointAt is distance-uniform).
function comet(batch, scene, curve, rgb, tex, { stall = false } = {}) {
  const ps = new ParticleSystem({
    duration: 1,
    looping: true,
    startLife: new IntervalValue(0.5, 0.9),
    startSpeed: new ConstantValue(0),
    startSize: new IntervalValue(1.6, 2.6),
    startColor: new ConstantColor(new Vector4(...rgb, 1)),
    worldSpace: true,
    maxParticle: 400,
    emissionOverTime: new ConstantValue(120),
    shape: new PointEmitter(),
    material: new THREE.MeshBasicMaterial({ map: tex, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }),
    renderMode: RenderMode.BillBoard,
  });
  ps.addBehavior(
    new ColorOverLife(
      new Gradient(
        [
          [new QV3(...rgb), 0],
          [new QV3(rgb[0], rgb[1] * 0.6, rgb[2] * 0.4), 1],
        ],
        [
          [1, 0],
          [0, 1],
        ],
      ),
    ),
  );
  ps.addBehavior(new SizeOverLife(new PiecewiseBezier([[new Bezier(1, 0.85, 0.4, 0), 0]])));
  batch.addSystem(ps);
  scene.add(ps.emitter);
  let u = 0,
    pause = 0;
  return (dt) => {
    if (pause > 0) {
      pause -= dt;
      ps.emissionOverTime = new ConstantValue(0);
      return;
    }
    ps.emissionOverTime = new ConstantValue(120);
    u += dt / 1.8;
    const end = stall ? 0.5 : 1; // not comparable: the values never meet
    if (u >= end) {
      u = 0;
      pause = stall ? 1.6 : 0.9;
    }
    ps.emitter.position.copy(curve.getPointAt(Math.min(u, end)));
  };
}

export function mount(fallback, graph) {
  if (!graph || !fallback) return false;
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: false, alpha: true, powerPreference: "low-power", stencil: false, depth: true });
    renderer.setClearColor(0x000000, 0);
  } catch {
    return false;
  }
  const cv = renderer.domElement;
  cv.className = fallback.className + " graph-3d";
  cv.setAttribute("aria-label", fallback.getAttribute("aria-label") ?? "Memory graph");
  fallback.after(cv);
  fallback.dataset.engine = "3d";
  fallback.style.display = "none";

  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(0x12172a, 0.006);
  const camera = new THREE.PerspectiveCamera(42, 640 / 420, 1, 1000);
  const { nodes, edges } = layout(graph);

  const center = new THREE.Vector3();
  nodes.forEach((n) => center.add(n.p));
  center.divideScalar(nodes.length);
  const geo = new THREE.SphereGeometry(1, 16, 12);
  const labelled = new Set();
  for (const n of nodes) {
    const r = n.kind === "patient" ? 3.2 : n.kind === "document" ? 2.4 : n.kind === "topic" ? 1.4 : 1.8;
    const col = n.status === "superseded" ? SUPERSEDED : (COLORS[n.kind] ?? 0xcccccc);
    const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: col }));
    m.scale.setScalar(r);
    m.position.copy(n.p);
    scene.add(m);
    const key = n.kind === "patient" || /^(5|50) ng|^1\.2 mg|^106 /.test(n.label) ? n.label : null;
    if (key && !labelled.has(key)) {
      labelled.add(key);
      const s = label(n.label, n.status === "superseded" ? "#ff9b84" : "#eceae0");
      s.position.copy(n.p).add(new THREE.Vector3(0, r + 3.5, 0));
      scene.add(s);
    }
  }
  const plain = edges.filter((e) => e.kind !== "corrects" && e.kind !== "not comparable");
  const pos = new Float32Array(plain.length * 6);
  plain.forEach((e, i) => {
    pos.set([e.a.p.x, e.a.p.y, e.a.p.z, e.b.p.x, e.b.p.y, e.b.p.z], i * 6);
  });
  const lg = new THREE.BufferGeometry();
  lg.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  scene.add(new THREE.LineSegments(lg, new THREE.LineBasicMaterial({ color: 0xa0aac8, transparent: true, opacity: 0.22 })));

  // splines the comets ride: arched between the two values, bowed away
  // from the centre so they read as a separate relation, not an edge
  const tex = dotTexture();
  const batch = new BatchedRenderer();
  scene.add(batch);
  const comets = [];
  for (const e of edges.filter((x) => x.kind === "corrects" || x.kind === "not comparable")) {
    const mid = e.a.p.clone().add(e.b.p).multiplyScalar(0.5);
    const out = mid.clone().sub(center).normalize().multiplyScalar(10).add(new THREE.Vector3(0, 9, 0));
    const curve = new THREE.CatmullRomCurve3([e.a.p.clone(), mid.clone().add(out.clone().multiplyScalar(0.6)), mid.clone().add(out), e.b.p.clone()], false, "centripetal");
    const rgb = e.kind === "corrects" ? [1, 0.86, 0.29] : [0.91, 0.45, 0.35];
    comets.push(comet(batch, scene, curve, rgb, tex, { stall: e.kind === "not comparable" }));
  }

  // camera rail: a closed Catmull-Rom loop around the graph
  let span = 0;
  nodes.forEach((n) => (span = Math.max(span, n.p.distanceTo(center))));
  const R = span * 2.1 + 20;
  const rail = new THREE.CatmullRomCurve3(
    [0, 1, 2, 3, 4, 5].map((i) => {
      const a = (i / 6) * Math.PI * 2;
      return new THREE.Vector3(Math.cos(a) * R, Math.sin(a * 2) * R * 0.18 + R * 0.12, Math.sin(a) * R * 0.85).add(center);
    }),
    true,
    "centripetal",
  );

  const composer = new EffectComposer(renderer, { frameBufferType: THREE.HalfFloatType });
  composer.addPass(new RenderPass(scene, camera));
  composer.addPass(new EffectPass(camera, new BloomEffect({ intensity: 1.6, luminanceThreshold: 0.15, luminanceSmoothing: 0.4, mipmapBlur: true, radius: 0.7 })));

  const resize = () => {
    const w = cv.clientWidth || 640;
    const h = Math.round(w * (420 / 640));
    renderer.setPixelRatio(Math.min(1.75, devicePixelRatio || 1));
    renderer.setSize(w, h, false);
    composer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };
  cv.style.width = "100%";
  cv.style.aspectRatio = "640 / 420";
  new ResizeObserver(resize).observe(cv);
  resize();

  const lean = { x: { x: 0, v: 0 }, y: { x: 0, v: 0 }, tx: 0, ty: 0 };
  cv.addEventListener("pointermove", (e) => {
    const r = cv.getBoundingClientRect();
    lean.tx = ((e.clientX - r.left) / r.width - 0.5) * 2;
    lean.ty = ((e.clientY - r.top) / r.height - 0.5) * 2;
  });
  cv.addEventListener("pointerleave", () => (lean.tx = lean.ty = 0));

  let u = 0.08;
  const look = center.clone();
  const frame = (dt) => {
    u = (u + dt / 70) % 1; // one loop every 70 s, even speed (arc length)
    smoothDamp(lean.x, lean.tx, 0.5, dt);
    smoothDamp(lean.y, lean.ty, 0.5, dt);
    camera.position.copy(rail.getPointAt(u));
    camera.position.y += lean.y.x * R * 0.12;
    look.copy(center).add(new THREE.Vector3(lean.x.x * span * 0.25, 0, 0));
    camera.lookAt(look);
    comets.forEach((c) => c(dt));
    batch.update(dt);
    composer.render(dt);
  };
  if (reducedMotion()) {
    frame(0);
    return true;
  }
  let stop = null;
  onVisible(cv, (vis) => {
    if (vis && !stop) stop = loop((dt) => (frame(dt), true));
    else if (!vis && stop) (stop(), (stop = null));
  });
  return true;
}
