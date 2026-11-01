// One requestAnimationFrame loop for the whole page. It runs only while
// something is animating and the tab is visible, and hands every subscriber
// a dt in seconds (clamped, so a backgrounded tab doesn't teleport anything).
// A subscriber returns `true` to keep running, anything else to stop.
const subs = new Set();
let raf = 0,
  last = 0;

function frame(now) {
  const dt = last ? Math.min(0.05, (now - last) / 1000) : 1 / 60;
  last = now;
  for (const fn of [...subs]) if (fn(dt, now) !== true) subs.delete(fn);
  raf = subs.size && !document.hidden ? requestAnimationFrame(frame) : 0;
  if (!raf) last = 0;
}
export function animate(fn) {
  subs.add(fn);
  if (!raf && !document.hidden) raf = requestAnimationFrame(frame);
  return () => subs.delete(fn);
}
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && subs.size && !raf) {
    last = 0;
    raf = requestAnimationFrame(frame);
  }
});
export const reducedMotion = () =>
  matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Calls `fn(visible)` when `el` enters or leaves the viewport. */
export function onVisible(el, fn, margin = "120px") {
  const io = new IntersectionObserver(([e]) => fn(e.isIntersecting), {
    rootMargin: margin,
  });
  io.observe(el);
  return () => io.disconnect();
}

/** A tween as a subscriber: fn(easedProgress) for `ms`, then done(). */
export function tween(ms, ease, fn, done) {
  let t = 0;
  return animate((dt) => {
    t += (dt * 1000) / ms;
    fn(ease(Math.min(1, t)));
    if (t >= 1) {
      done?.();
      return false;
    }
    return true;
  });
}
