// "How an answer is decided": one Catmull-Rom spline through the five
// stations, and a question that travels it at a constant speed (arc length).
// At "Check its status" it either continues to a spoken sentence or leaves by
// a refusal exit. The three trips are the hero's three questions, with the
// engine's real verdicts. It moves only while on screen.
import { catmullRom, segsD, arcTable, pointAtDistance, smoothstep } from "./motion-math.mjs";
import { animate, onVisible, reducedMotion } from "./motion-loop.mjs";

const root = document.getElementById("pipe-svg");
if (root) {
  const NS = "http://www.w3.org/2000/svg";
  const el = (tag, a = {}, p = root) => {
    const e = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(a)) e.setAttribute(k, v);
    p.appendChild(e);
    return e;
  };
  const ST = [
    [70, 150],
    [330, 126],
    [590, 168],
    [850, 140],
    [1130, 150],
  ];
  const main = catmullRom(ST);
  const exits = {
    no: [ST[3], [900, 140 - 70], [960, 40], [1040, 34]],
    ask: [ST[3], [900, 140 + 70], [960, 262], [1040, 266]],
  };
  el("path", { d: segsD(main), class: "pipe-line" });
  el("path", { d: segsD([exits.no]), class: "pipe-exit pipe-no" });
  el("path", { d: segsD([exits.ask]), class: "pipe-exit pipe-ask" });
  const dots = ST.map(([x, y]) => el("circle", { cx: x, cy: y, r: 7, class: "pipe-dot" }));
  const label = (x, y, cls, text, anchor = "start") => {
    const t = el("text", { x, y, class: cls, "text-anchor": anchor });
    t.textContent = text;
    return t;
  };
  const ends = {
    ok: label(1130, 196, "pipe-end pipe-end-ok", "Says one sentence", "middle"),
    no: label(1052, 39, "pipe-end pipe-end-no", "Won't compare"),
    ask: label(1052, 271, "pipe-end pipe-end-ask", "Asks which patient"),
  };
  const caption = document.getElementById("pipe-caption");
  const bead = el("circle", { r: 6, class: "bead pipe-bead", opacity: 0 });

  // A trip is a list of Bézier segments; measure each once.
  const trip = (segs) => {
    const tables = segs.map((s) => arcTable(...s, 48));
    return { tables, total: tables.reduce((a, t) => a + t.total, 0) };
  };
  const TRIPS = [
    { route: trip(main), end: "ok", q: "“What is SYN-0001's ferritin result?”", a: "50 ng/mL, the corrected value." },
    { route: trip([...main.slice(0, 3), exits.no]), end: "no", q: "“Has creatinine gone up since September?”", a: "mg/dL and µmol/L: it won't compare them." },
    { route: trip([...main.slice(0, 3), exits.ask]), end: "ask", q: "“What is the TSH?”", a: "Two patients have one. It asks whose." },
  ];
  const at = (route, s) => {
    for (const t of route.tables) {
      if (s <= t.total) return pointAtDistance(t, s);
      s -= t.total;
    }
    const last = route.tables.at(-1);
    return pointAtDistance(last, last.total);
  };

  if (reducedMotion()) {
    root.classList.add("still");
  } else {
    const SPEED = 300; // px of curve per second, the same on every segment
    let k = 0,
      s = 0,
      hold = 0.6,
      stop = null;
    const setTrip = (i) => {
      const T = TRIPS[i];
      caption.innerHTML = `<q>${T.q.slice(1, -1)}</q> <span>${T.a}</span>`;
      Object.entries(ends).forEach(([key, e]) => e.classList.toggle("on", key === T.end));
    };
    setTrip(0);
    const step = (dt) => {
      const T = TRIPS[k];
      if (hold > 0) {
        hold -= dt;
        bead.setAttribute("opacity", 0);
        return true;
      }
      s += SPEED * dt;
      const [x, y] = at(T.route, Math.min(s, T.route.total));
      bead.setAttribute("cx", x);
      bead.setAttribute("cy", y);
      // fade in/out over the first and last 40px of the trip
      bead.setAttribute("opacity", smoothstep(s / 40) * smoothstep((T.route.total - s) / 40 + 0.001));
      dots.forEach((d, i) => d.classList.toggle("lit", Math.hypot(ST[i][0] - x, ST[i][1] - y) < 26));
      if (s >= T.route.total) {
        s = 0;
        hold = 1.4;
        k = (k + 1) % TRIPS.length;
        setTrip(k);
      }
      return true;
    };
    onVisible(root, (vis) => {
      if (vis && !stop) stop = animate(step);
      else if (!vis && stop) (stop(), (stop = null));
    });
  }
}
