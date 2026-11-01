// ?tune: live controls (Tweakpane) for the landing's motion parameters, so
// spline lift, timing curve and spring stiffness can be judged by eye and
// copied back into landing-motion.mjs.
import { Pane } from "tweakpane";

export function mount(P) {
  const pane = new Pane({ title: "Motion (?tune)", expanded: true });
  const f = pane.addFolder({ title: "Hero flight: 5 into 50" });
  f.addBinding(P, "flightMs", { min: 400, max: 2400, step: 10, label: "duration ms" });
  f.addBinding(P, "lift", { min: 0, max: 160, step: 1, label: "spline lift px" });
  const e = { x1: P.flightEase[0], y1: P.flightEase[1], x2: P.flightEase[2], y2: P.flightEase[3] };
  for (const k of ["x1", "y1", "x2", "y2"])
    f.addBinding(e, k, { min: k[0] === "x" ? 0 : -0.5, max: k[0] === "x" ? 1 : 1.5, step: 0.01, label: "bezier " + k }).on(
      "change",
      () => (P.flightEase = [e.x1, e.y1, e.x2, e.y2]),
    );
  f.addButton({ title: "Replay (reload)" }).on("click", () => location.reload());
  const t = pane.addFolder({ title: "Card tilt spring" });
  t.addBinding(P, "tiltDeg", { min: 0, max: 15, step: 0.5, label: "max degrees" });
  t.addBinding(P, "tiltSmooth", { min: 0.03, max: 0.8, step: 0.01, label: "smooth time s" });
  const p = pane.addFolder({ title: "Pipeline token" });
  p.addBinding(P, "tokenSpeed", { min: 100, max: 1500, step: 10, label: "px per second" });
  pane.addButton({ title: "Copy values" }).on("click", () => navigator.clipboard?.writeText(JSON.stringify(P, null, 2)));
  return pane;
}
