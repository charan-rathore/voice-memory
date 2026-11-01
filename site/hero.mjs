// Hero: the engine's real answer, with each claim tied by a thread to the
// line on the original page it rests on. Answers and citations come from
// snapshot.js (a saved run of the engine, kept equal to the live engine by
// evaluation/site-snapshot.test.mjs); anchor boxes come from the citation's
// own page coordinates, so nothing here is drawn by hand.
import {
  arcTable,
  pointAtDistance,
  tether,
  pathD,
  bezier,
  anchorTokens,
  easeOutCubic,
  easeInOutCubic,
  smoothDamp,
} from "./motion-math.mjs";
import { animate, tween, reducedMotion } from "./motion-loop.mjs";

const PAGE_W = 595,
  PAGE_H = 400; // PDF points; the page images are rendered at 2.8x
const DOCS = {
  "a-2026-10-amended.pdf": { img: "pages/a-2026-10-amended.png", label: "Amended report, 15 October", status: "current" },
  "a-2026-10-prelim.pdf": { img: "pages/a-2026-10-prelim.png", label: "Preliminary report, 13 October, since corrected", status: "superseded" },
  "a-2026-09.pdf": { img: "pages/a-2026-09.png", label: "September report", status: "current" },
  "c-2026-10.pdf": { img: "pages/c-2026-10.png", label: "SYN-0003's report, 21 October", status: "current" },
};
// The patient line sits at the same place on every synthetic report
// (clinical/fixtures/build.mjs draws it at a fixed position).
const PATIENT_LINE = [56, 66, 292, 80];
const HERO = [
  { key: "health|What is SYN-0001's ferritin result?", label: "Ferritin was corrected" },
  { key: "health|Has creatinine gone up since September?", label: "Creatinine changed units" },
  {
    key: "health|What is the TSH?",
    label: "TSH belongs to two people",
    patients: [
      ["SYN-0001", "a-2026-10-amended.pdf"],
      ["SYN-0003", "c-2026-10.pdf"],
    ],
  },
];
const VERDICT = {
  LATEST: ["ok", "Corrected value used"],
  NOT_COMPARABLE: ["no", "Won't compare"],
  AMBIGUOUS_PATIENT: ["ask", "Asks which patient"],
};

const snap = window.VM_SNAPSHOT;
const hero = document.getElementById("top");
const $ = (s) => hero.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const NS = "http://www.w3.org/2000/svg";
const svgEl = (tag, attrs = {}, parent) => {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  parent?.appendChild(e);
  return e;
};

let current = null; // { links: [{tok, mark, kind}], verdict }
let stopAll = [];

function build(q) {
  const lead = snap?.answers?.[q.key]?.lead;
  if (!lead) return null;
  const text = lead.text.replace(/μ/g, "µ");
  // anchors: claim words -> (doc, bbox)
  let anchors;
  if (q.patients) {
    anchors = q.patients
      .map(([id, doc]) => {
        const i = text.indexOf(id);
        return i < 0 ? null : { start: i, end: i + id.length, doc, bbox: PATIENT_LINE, kind: "ask" };
      })
      .filter(Boolean);
  } else {
    anchors = anchorTokens(text, lead.citations).map((a) => {
      const c = lead.citations[a.cite];
      const r = c.location?.focus?.regions?.[0];
      return {
        ...a,
        doc: c.title,
        bbox: r?.bbox,
        kind: DOCS[c.title]?.status === "superseded" ? "old" : "ok",
      };
    });
  }
  anchors = anchors.filter((a) => a.bbox && DOCS[a.doc]);
  return { lead, text, anchors };
}

function renderAnswer({ text, anchors }, animateIn) {
  const sorted = [...anchors].map((a, i) => ({ ...a, i })).sort((a, b) => a.start - b.start);
  const parts = [];
  let at = 0,
    w = 0;
  const words = (s) =>
    s
      .split(/(\s+)/)
      .map((x) => (/^\s+$/.test(x) || !x ? x : `<span class="w" style="--d:${w++ * 15}ms">${esc(x)}</span>`))
      .join("");
  for (const a of sorted) {
    parts.push(words(text.slice(at, a.start)));
    parts.push(`<span class="w tok tok-${a.kind}" data-link="${a.i}" style="--d:${w++ * 15}ms">${esc(text.slice(a.start, a.end))}</span>`);
    at = a.end;
  }
  parts.push(words(text.slice(at)));
  const el = $("#hero-answer");
  el.classList.toggle("enter", animateIn);
  el.innerHTML = parts.join("");
  return w * 15;
}

function renderSheets({ anchors }, animateIn) {
  const box = $("#hero-pages");
  const docs = [...new Set(anchors.map((a) => a.doc))];
  box.innerHTML = docs
    .map((d, i) => {
      const D = DOCS[d];
      const marks = anchors
        .map((a, j) => ({ a, j }))
        .filter(({ a }) => a.doc === d)
        .map(({ a, j }) => {
          const [x0, y0, x1, y1] = a.bbox;
          const s = `left:${((x0 - 4) / PAGE_W) * 100}%;top:${((y0 - 3) / PAGE_H) * 100}%;width:${((x1 - x0 + 8) / PAGE_W) * 100}%;height:${((y1 - y0 + 6) / PAGE_H) * 100}%`;
          return `<span class="mark mark-${a.kind}" data-link="${j}" style="${s}"></span>`;
        })
        .join("");
      return `<figure class="sheet sheet-${D.status}" data-doc="${esc(d)}" style="--n:${i}">
        <div class="sheet-page"><img src="${D.img}" width="1666" height="1120" alt="${esc(D.label)}" decoding="async" />${marks}</div>
        <figcaption>${esc(D.label)}</figcaption></figure>`;
    })
    .join("");
  const sheets = [...box.querySelectorAll(".sheet")];
  if (!animateIn) return Promise.resolve();
  // Each copy drops onto the desk with a critically damped spring: fast,
  // no wobble, and the same feel at 60 Hz or 144 Hz.
  return Promise.all(
    sheets.map(
      (el, i) =>
        new Promise((res) => {
          const s = { x: 1, v: 0 };
          let wait = i * 0.09;
          el.style.opacity = "0";
          stopAll.push(
            animate((dt) => {
              if ((wait -= dt) > 0) return true;
              smoothDamp(s, 0, 0.32, dt);
              el.style.opacity = String(1 - s.x);
              el.style.transform = `translate3d(0, ${s.x * 28}px, 0) rotate(${s.x * (i % 2 ? -2 : 2)}deg)`;
              if (s.x < 0.002) {
                el.style.transform = el.style.opacity = "";
                res();
                return false;
              }
              return true;
            }),
          );
        }),
    ),
  );
}

// ------------------------------------------------------------ tethers
const svg = document.getElementById("tethers");
function layoutLinks() {
  const hr = hero.getBoundingClientRect();
  const links = [];
  hero.querySelectorAll("#hero-answer .tok").forEach((tok) => {
    const j = tok.dataset.link;
    const mark = hero.querySelector(`.mark[data-link="${j}"]`);
    if (!mark) return;
    const rs = tok.getClientRects();
    const r0 = rs[rs.length - 1] ?? tok.getBoundingClientRect();
    const m = mark.getBoundingClientRect();
    const p0 = [r0.left + r0.width / 2 - hr.left, r0.bottom + 3 - hr.top];
    const p1 = [m.left - hr.left - 2, m.top + m.height / 2 - hr.top];
    // Leave the underline downward; arrive at the line from the left, or from
    // above when the page sits under the text (narrow screens).
    // Narrow screens put the page under the text: arrive from above instead.
    const below = p1[1] > p0[1] + 40 && m.left - hr.left < r0.right - hr.left + 40;
    const end = below ? [m.left - hr.left + 14, m.top - hr.top - 2] : p1;
    const out = [Math.sign(end[0] - p0[0]) || 1, 1.1];
    const pts = tether(p0, end, out, below ? [0, 1] : [1, 0]);
    links.push({ j, tok, mark, kind: tok.classList.contains("tok-old") ? "old" : tok.classList.contains("tok-ask") ? "ask" : "ok", pts, table: arcTable(...pts, 64) });
  });
  return links;
}

function drawLinks(links, { progress = 1, verdict } = {}) {
  svg.innerHTML = "";
  const defs = svgEl("defs", {}, svg);
  const out = links.map((L, i) => {
    const d = pathD(L.pts);
    const len = L.table.total;
    // Reveal by arc length through a mask, so dashed (superseded) threads
    // draw exactly like solid ones.
    const mask = svgEl("mask", { id: `tm${i}`, maskUnits: "userSpaceOnUse" }, defs);
    const mp = svgEl("path", { d, fill: "none", stroke: "#fff", "stroke-width": 8, "stroke-dasharray": `${len} ${len}`, "stroke-dashoffset": len * (1 - progress) }, mask);
    const g = svgEl("g", { class: `tether t-${L.kind}`, "data-link": L.j, mask: `url(#tm${i})` }, svg);
    svgEl("path", { d, class: "thread" }, g);
    svgEl("circle", { cx: L.pts[0][0], cy: L.pts[0][1], r: 3.5, class: "knot" }, g);
    svgEl("circle", { cx: L.pts[3][0], cy: L.pts[3][1], r: 3.5, class: "knot" }, g);
    return { ...L, mp, len, g };
  });
  if (verdict === "NOT_COMPARABLE" && links.length >= 2) {
    // The two values are tied to the answer, never to each other: a broken
    // red bracket between the rows, with ≠ where they would have met.
    const a = links[0].mark.getBoundingClientRect(),
      b = links[1].mark.getBoundingClientRect(),
      hr = hero.getBoundingClientRect();
    const pa = [a.right - hr.left + 6, a.top + a.height / 2 - hr.top],
      pb = [b.right - hr.left + 6, b.top + b.height / 2 - hr.top];
    const bow = Math.min(90, Math.abs(pb[1] - pa[1]) * 0.35 + 30);
    const pts = [pa, [pa[0] + bow, pa[1]], [pb[0] + bow, pb[1]], pb];
    const mid = bezier(...pts, 0.5);
    const g = svgEl("g", { class: "nocompare" }, svg);
    svgEl("path", { d: pathD(pts), class: "thread" }, g);
    svgEl("circle", { cx: mid[0], cy: mid[1], r: 13, class: "ne-bg" }, g);
    const t = svgEl("text", { x: mid[0], y: mid[1] + 6, "text-anchor": "middle", class: "ne" }, g);
    t.textContent = "≠";
    out.nocompare = g;
  }
  return out;
}

function playLinks(drawn, startDelay) {
  const beads = [];
  drawn.forEach((L, i) => {
    let wait = startDelay / 1000 + i * 0.18;
    const bead = svgEl("circle", { r: 4.5, class: `bead t-${L.kind}`, opacity: 0 }, svg);
    beads.push(bead);
    let phase = 0, // 0 waiting, 1 drawing, 2 bead, 3 done
      t = 0;
    stopAll.push(
      animate((dt) => {
        if (phase === 0) {
          if ((wait -= dt) > 0) return true;
          phase = 1;
        }
        t += dt;
        if (phase === 1) {
          const p = easeOutCubic(t / 0.7);
          L.mp.setAttribute("stroke-dashoffset", L.len * (1 - p));
          if (t >= 0.7) ((phase = 2), (t = 0), bead.setAttribute("opacity", 1));
          return true;
        }
        if (phase === 2) {
          // the evidence travels back from the page to the word at constant
          // speed along the curve (arc length, not raw t)
          const s = L.len * (1 - easeInOutCubic(t / 0.65));
          const [x, y] = pointAtDistance(L.table, s);
          bead.setAttribute("cx", x);
          bead.setAttribute("cy", y);
          if (t >= 0.65) {
            bead.remove();
            L.tok.classList.add("lit");
            return false;
          }
          return true;
        }
      }),
    );
  });
  if (drawn.nocompare) {
    drawn.nocompare.style.opacity = 0;
    const t0 = startDelay + (drawn.length - 1) * 180 + 600;
    setTimeout(() => stopAll.push(tween(500, easeOutCubic, (p) => (drawn.nocompare.style.opacity = p))), t0);
  }
}

// ------------------------------------------------------------ orchestration
let active = 0;
async function show(index, { first = false } = {}) {
  const q = HERO[index];
  const data = build(q);
  if (!data) return;
  stopAll.forEach((s) => s());
  stopAll = [];
  active = index;
  const still = reducedMotion();
  hero.querySelectorAll("[data-hq]").forEach((b, i) => b.setAttribute("aria-pressed", String(i === index)));
  $("#hero-q").textContent = q.key.split("|")[1];
  const [vcls, vtxt] = VERDICT[data.lead.verdict] ?? ["ok", "Answered"];
  const v = $("#hero-verdict");
  v.className = `verdict v-${vcls}`;
  v.textContent = vtxt;
  svg.innerHTML = "";
  const wordsMs = renderAnswer(data, !still);
  await Promise.all([renderSheets(data, !still), document.fonts?.ready].filter(Boolean));
  if (index !== active) return;
  const links = layoutLinks();
  current = { links, verdict: data.lead.verdict };
  const drawn = drawLinks(links, { progress: still ? 1 : 0, verdict: data.lead.verdict });
  if (still) return hero.querySelectorAll(".tok").forEach((t) => t.classList.add("lit"));
  playLinks(drawn, first ? Math.min(wordsMs, 1400) : Math.min(wordsMs, 900));
}

function relayout() {
  if (!current) return;
  const links = layoutLinks();
  current.links = links;
  drawLinks(links, { progress: 1, verdict: current.verdict });
}

if (snap && hero && svg) {
  hero.classList.add("live");
  hero.addEventListener("click", (e) => {
    const b = e.target.closest("[data-hq]");
    if (b) show(Number(b.dataset.hq));
  });
  // hovering a claim or its line lights both ends of the thread
  const hot = (e, on) => {
    const t = e.target.closest?.("[data-link]");
    if (!t || !hero.contains(t)) return;
    hero.querySelectorAll(`[data-link="${t.dataset.link}"]`).forEach((x) => x.classList.toggle("hot", on));
  };
  hero.addEventListener("pointerover", (e) => hot(e, true));
  hero.addEventListener("pointerout", (e) => hot(e, false));
  let rq = 0;
  new ResizeObserver(() => {
    cancelAnimationFrame(rq);
    rq = requestAnimationFrame(relayout);
  }).observe(hero);
  show(0, { first: true });
}
