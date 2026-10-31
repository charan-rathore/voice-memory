// Knowledge map: a view of /api/graph, which is rebuilt from the documents and
// the answered questions on every request. Click a node to go one level deeper
// (topic -> values -> the exact sentences -> the original page); click a line
// to read the sentence that creates it.
//
// Motion, from first principles (motion.js):
//  - layout: deterministic layers (questions, topics, values, evidence,
//    documents), barycenter-ordered to reduce crossings, stacked by card size;
//  - display: each drawn position follows its target position by
//    exponential decay (half-life 70 ms) - frame-rate independent smoothing;
//  - camera: the viewBox eases to fit the nodes with the same decay;
//  - drill-down: nodes that persist glide to their new place, new ones are
//    born at the node you clicked; edges are C1 cubic Béziers.
// Reduced motion: final positions, drawn once.
import {
  expDecay,
  decayFromHalfLife,
  bezier,
  loop,
  prefersReducedMotion,
} from "/motion.js";
import { openSource } from "/viewer.js";

const $ = (id) => document.getElementById(id);
const NS = "http://www.w3.org/2000/svg";
const svgEl = (tag, attrs = {}, parent) => {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  parent?.append(e);
  return e;
};

const DRILL = new Set(["topic", "value", "document", "question"]);
const LAMBDA = decayFromHalfLife(0.09);
const CAM_LAMBDA = decayFromHalfLife(0.12);

let state = {
  focus: "overview",
  data: null,
  sim: new Map(),
  drawn: new Map(),
  cam: null,
  origin: null,
  selected: null,
};
let driver = null;

function wrap(t, max) {
  if (t.length <= max) return [t];
  const words = t.split(" ");
  const a = [];
  while (words.length && (a.join(" ") + " " + words[0]).trim().length <= max)
    a.push(words.shift());
  let b = words.join(" ");
  if (b.length > max) b = b.slice(0, max - 1).trimEnd() + "…";
  return [a.join(" "), b];
}

const short = (s, n) => (s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s);

function label(n) {
  if (n.kind === "evidence") return short(n.label, 110);
  if (n.kind === "question") return short(n.label, 40);
  if (n.kind === "document") return short(n.label, 30);
  return short(n.label, 34);
}

// ------------------------------------------------------------------ layout
// Layered layout (text-heavy nodes need structure, not a particle cloud):
// columns by kind, order inside a column by the barycenter of neighbours
// (two sweeps, fewer crossings), stacked by real card size so nothing
// overlaps. Narrow screens stack the layers top-to-bottom instead.
const ORDER = ["question", "topic", "value", "evidence", "document"];

function layout(nodes, edges, sizes, narrow) {
  const layers = ORDER.map((k) => nodes.filter((n) => n.kind === k)).filter(
    (l) => l.length,
  );
  const nbr = new Map(nodes.map((n) => [n.id, []]));
  for (const e of edges) {
    nbr.get(e.from)?.push(e.to);
    nbr.get(e.to)?.push(e.from);
  }
  const pos = new Map();
  const place = () =>
    layers.forEach((l) => l.forEach((n, i) => pos.set(n.id, i)));
  place();
  for (let sweep = 0; sweep < 4; sweep++) {
    const seq = sweep % 2 ? [...layers].reverse() : layers;
    for (const l of seq) {
      const bc = (n) => {
        const ns = nbr
          .get(n.id)
          .filter((m) => pos.has(m) && !l.some((x) => x.id === m));
        return ns.length
          ? ns.reduce((a, m) => a + pos.get(m), 0) / ns.length
          : pos.get(n.id);
      };
      l.sort((a, b) => bc(a) - bc(b) || (b.weight ?? 0) - (a.weight ?? 0));
      l.forEach((n, i) => pos.set(n.id, i));
    }
  }
  const out = new Map();
  const GAP = narrow ? 10 : 14;
  if (!narrow) {
    let x = 0;
    for (const l of layers) {
      const colW = Math.max(...l.map((n) => sizes.get(n.id).w));
      const total = l.reduce((a, n) => a + sizes.get(n.id).h + GAP, -GAP);
      let y = -total / 2;
      for (const n of l) {
        const h = sizes.get(n.id).h;
        out.set(n.id, { x: x + colW / 2, y: y + h / 2 });
        y += h + GAP;
      }
      x += colW + 90;
    }
  } else {
    let y = 0;
    for (const l of layers) {
      const total = l.reduce((a, n) => a + sizes.get(n.id).h + GAP, -GAP);
      let yy = y;
      for (const n of l) {
        const h = sizes.get(n.id).h;
        out.set(n.id, { x: 0, y: yy + h / 2 });
        yy += h + GAP;
      }
      y += total + 46;
    }
  }
  return out;
}

// ----------------------------------------------------------------- drawing
function edgePath(a, b, narrow) {
  // Cubic Bézier with tangents along the layer direction: C1-continuous
  // where it meets each card, so lines leave and arrive straight.
  const k = 0.5;
  const c1 = narrow
    ? [a.x + 40, a.y + (b.y - a.y) * k]
    : [a.x + (b.x - a.x) * k, a.y];
  const c2 = narrow
    ? [b.x + 40, b.y - (b.y - a.y) * k]
    : [b.x - (b.x - a.x) * k, b.y];
  return {
    d: `M${a.x.toFixed(1)},${a.y.toFixed(1)} C${c1[0].toFixed(1)},${c1[1].toFixed(1)} ${c2[0].toFixed(1)},${c2[1].toFixed(1)} ${b.x.toFixed(1)},${b.y.toFixed(1)}`,
    mid: bezier([a.x, a.y], c1, c2, [b.x, b.y], 0.5),
  };
}

function build(data) {
  const svg = $("map-svg");
  svg.replaceChildren();
  const gEdges = svgEl("g", { class: "map-edges" }, svg);
  const gNodes = svgEl("g", { class: "map-nodes" }, svg);
  const els = { edges: new Map(), nodes: new Map() };
  for (const e of data.edges) {
    const g = svgEl(
      "g",
      { class: `me me-${cls(e.kind)}`, "data-id": e.id },
      gEdges,
    );
    const path = svgEl(
      "path",
      { class: "me-line", "stroke-width": String(0.8 + e.weight * 0.5) },
      g,
    );
    const hit = svgEl(
      "path",
      {
        class: "me-hit",
        tabindex: e.evidence ? "0" : "-1",
        role: e.evidence ? "button" : "presentation",
        "aria-label": `${e.kind}${e.evidence ? ": " + e.evidence.quote : ""}`,
      },
      g,
    );
    const text = svgEl("text", { class: "me-label" }, g);
    text.textContent = e.kind;
    const pick = () => select(e);
    hit.addEventListener("click", pick);
    hit.addEventListener(
      "keydown",
      (ev) =>
        (ev.key === "Enter" || ev.key === " ") && (ev.preventDefault(), pick()),
    );
    els.edges.set(e.id, { e, path, hit, text, g });
  }
  for (const n of data.nodes) {
    const g = svgEl(
      "g",
      {
        class: `mn mn-${n.kind} st-${cls(n.status ?? "")}${n.id === data.focus ? " is-focus" : ""}`,
        tabindex: "0",
        role: "button",
        "aria-label": `${n.kind}: ${n.label}${n.status ? ", " + n.status : ""}`,
      },
      gNodes,
    );
    const rect = svgEl("rect", { rx: n.kind === "topic" ? "999" : "5" }, g);
    const text = svgEl(
      "text",
      { "text-anchor": "middle", "dominant-baseline": "central" },
      g,
    );
    // Evidence sentences wrap to two lines; everything else is one line.
    const lines = wrap(
      label(n),
      n.kind === "evidence" ? (state.narrow ? 40 : 52) : 99,
    );
    if (lines.length === 1) text.textContent = lines[0];
    else
      lines.forEach((ln, i) => {
        const t = svgEl(
          "tspan",
          { x: "0", dy: i ? "1.25em" : "-0.62em" },
          text,
        );
        t.textContent = ln;
      });
    if (n.weight > 0 && n.kind !== "question") {
      const dot = svgEl(
        "text",
        {
          class: "mn-use",
          "text-anchor": "start",
          "dominant-baseline": "central",
        },
        g,
      );
      dot.textContent = `· ${n.weight}`;
    }
    const act = () => activate(n);
    g.addEventListener("click", act);
    g.addEventListener(
      "keydown",
      (ev) =>
        (ev.key === "Enter" || ev.key === " ") && (ev.preventDefault(), act()),
    );
    els.nodes.set(n.id, { n, g, rect, text });
  }
  // Size each node's card to its text.
  for (const v of els.nodes.values()) {
    const bb = v.text.getBBox?.();
    const w = Math.min(bb?.width || v.n.label.length * 6, 380) + 20;
    const hgt = Math.max(24, (bb?.height || 14) + 12);
    v.w = w;
    v.h = hgt;
    v.rect.setAttribute("x", String(-w / 2));
    v.rect.setAttribute("y", String(-hgt / 2));
    v.rect.setAttribute("width", String(w));
    v.rect.setAttribute("height", String(hgt));
    const use = v.g.querySelector(".mn-use");
    if (use) use.setAttribute("x", String(w / 2 + 4));
  }
  return els;
}

const cls = (s) =>
  String(s)
    .toLowerCase()
    .replace(/[^a-z]+/g, "-");

function draw(els) {
  for (const v of els.nodes.values()) {
    const p = state.drawn.get(v.n.id);
    v.g.setAttribute(
      "transform",
      `translate(${p.x.toFixed(1)},${p.y.toFixed(1)})`,
    );
  }
  for (const v of els.edges.values()) {
    const A = state.drawn.get(v.e.from);
    const B = state.drawn.get(v.e.to);
    const sa = els.nodes.get(v.e.from);
    const sb = els.nodes.get(v.e.to);
    if (!A || !B || !sa || !sb) continue;
    // Attach at card edges, on the sides facing each other.
    const flip = state.narrow ? A.y > B.y : A.x > B.x;
    const [p, q, ps, qs] = flip ? [B, A, sb, sa] : [A, B, sa, sb];
    const a = state.narrow
      ? { x: p.x, y: p.y + ps.h / 2 }
      : { x: p.x + ps.w / 2, y: p.y };
    const b = state.narrow
      ? { x: q.x, y: q.y - qs.h / 2 }
      : { x: q.x - qs.w / 2, y: q.y };
    const { d, mid } = edgePath(a, b, state.narrow);
    v.path.setAttribute("d", d);
    v.hit.setAttribute("d", d);
    v.text.setAttribute("x", mid[0].toFixed(1));
    v.text.setAttribute("y", (mid[1] - 4).toFixed(1));
  }
  const c = state.cam;
  $("map-svg").setAttribute(
    "viewBox",
    `${c.x.toFixed(1)} ${c.y.toFixed(1)} ${c.w.toFixed(1)} ${c.h.toFixed(1)}`,
  );
}

function fitTarget(els, targets) {
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  for (const v of els.nodes.values()) {
    const p = targets.get(v.n.id);
    x0 = Math.min(x0, p.x - v.w / 2);
    x1 = Math.max(x1, p.x + v.w / 2 + 28);
    y0 = Math.min(y0, p.y - v.h / 2);
    y1 = Math.max(y1, p.y + v.h / 2);
  }
  const stage = $("map-stage").getBoundingClientRect();
  const aspect = stage.width / Math.max(1, stage.height);
  let w = x1 - x0 + 40;
  let h = y1 - y0 + 40;
  // Never zoom in past 1:1 (text stays at its CSS size or smaller).
  w = Math.max(w, stage.width);
  h = Math.max(h, stage.height);
  if (w / h > aspect) h = w / aspect;
  else w = h * aspect;
  return { x: (x0 + x1) / 2 - w / 2, y: (y0 + y1) / 2 - h / 2, w, h };
}

function run(data) {
  driver?.stop();
  const stage = $("map-stage");
  state.narrow = stage.getBoundingClientRect().width < 560;
  stage.dataset.layout = state.narrow ? "rows" : "columns";
  const els = build(data);
  const sizes = new Map(
    [...els.nodes].map(([id, v]) => [id, { w: v.w, h: v.h }]),
  );
  const targets = layout(data.nodes, data.edges, sizes, state.narrow);
  const born = state.origin ?? null;
  for (const n of data.nodes)
    if (!state.drawn.has(n.id)) {
      const t = targets.get(n.id);
      state.drawn.set(n.id, born ? { ...born } : { x: t.x, y: t.y + 12 });
    }
  for (const id of [...state.drawn.keys()])
    if (!targets.has(id)) state.drawn.delete(id);
  state.sim = targets;
  const goal = fitTarget(els, targets);
  if (prefersReducedMotion() || !state.cam) state.cam = { ...goal };
  if (prefersReducedMotion()) {
    for (const [id, t] of targets) state.drawn.set(id, { ...t });
    draw(els);
    return;
  }
  driver = loop((dt) => {
    let moving = 0;
    for (const [id, t] of targets) {
      const d = state.drawn.get(id);
      d.x = expDecay(d.x, t.x, LAMBDA, dt);
      d.y = expDecay(d.y, t.y, LAMBDA, dt);
      moving += Math.abs(d.x - t.x) + Math.abs(d.y - t.y);
    }
    for (const k of ["x", "y", "w", "h"])
      state.cam[k] = expDecay(state.cam[k], goal[k], CAM_LAMBDA, dt);
    draw(els);
    return moving > 0.3 || Math.abs(state.cam.w - goal.w) > 0.5;
  });
  driver.wake();
}

// ------------------------------------------------------------ interaction
function caption(text, action) {
  const c = $("map-caption");
  c.replaceChildren(text);
  if (action) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "link";
    b.textContent = "Open the original";
    b.onclick = action;
    c.append(" ", b);
  }
}

function openEvidence(ev) {
  if (ev?.documentId) openSource({ documentId: ev.documentId, evidence: ev });
}

function select(e) {
  if (!e.evidence)
    return caption(`${nameOf(e.from)} ${e.kind} ${nameOf(e.to)}.`);
  caption(
    `“${e.evidence.quote.replace(/^\s*\d+\.\s*/, "")}” — ${e.evidence.title.replace(/\.(md|pdf|docx|txt)$/i, "").replace(/[_-]+/g, " ")}`,
    () => openEvidence(e.evidence),
  );
}

const nameOf = (id) => state.data?.nodes.find((n) => n.id === id)?.label ?? id;

function activate(n) {
  if (n.kind === "evidence") {
    caption(`“${n.label}”`, () => openEvidence(n.evidence));
    return openEvidence(n.evidence);
  }
  if (n.kind === "document" && n.id === state.focus && n.documentId)
    return openSource({ documentId: n.documentId });
  if (!DRILL.has(n.kind) || n.id === state.focus) return;
  state.origin = state.drawn.get(n.id) ? { ...state.drawn.get(n.id) } : null;
  load(n.id);
}

function crumbs(list) {
  const nav = $("map-crumbs");
  nav.replaceChildren(
    ...list.flatMap((c, i) => {
      const last = i === list.length - 1;
      const el = document.createElement(last ? "span" : "button");
      el.textContent = c.label;
      if (!last) {
        el.type = "button";
        el.className = "link";
        el.onclick = () => load(c.id);
      } else el.setAttribute("aria-current", "page");
      return i
        ? [
            Object.assign(document.createElement("span"), {
              textContent: " › ",
              className: "map-sep",
            }),
            el,
          ]
        : [el];
    }),
  );
}

function listView(data) {
  // Screen-reader equivalent of the drawing.
  $("map-list").replaceChildren(
    ...data.edges.map((e) =>
      Object.assign(document.createElement("li"), {
        textContent: `${nameOf(e.from)} — ${e.kind} — ${nameOf(e.to)}${e.evidence ? `: “${e.evidence.quote}”` : ""}`,
      }),
    ),
  );
}

async function load(focus = state.focus) {
  try {
    // Card sizes are measured from rendered text: wait for the real fonts.
    await document.fonts?.ready;
    const data = await fetch(`/api/graph?focus=${encodeURIComponent(focus)}`, {
      cache: "no-store",
    }).then((r) => r.json());
    if (!data?.nodes) return;
    state.focus = data.focus;
    state.data = data;
    crumbs(data.crumbs ?? []);
    if (!data.nodes.length) {
      $("map-svg").replaceChildren();
      caption("Ask a question and the map of what it touched appears here.");
      return;
    }
    run(data);
    listView(data);
  } catch {
    caption("The map couldn't load. Your answers are unaffected.");
  }
}

const panel = $("map");
panel?.addEventListener("toggle", () => panel.open && load());
globalThis.addEventListener?.("vm:answered", () => panel?.open && load());
