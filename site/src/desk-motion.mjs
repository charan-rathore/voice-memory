// The live desk as an app window: a segmented case control whose indicator
// slides on a real spring, suggestions that lift into the command bar, a
// question placeholder that types itself in English and Hindi, answers that
// resolve with their verdict, a marker sound when the cited line is
// highlighted, and a chime when a call connects. Motion answers the
// visitor's actions; sound is optional.
import { animate as motionAnimate } from "motion";
import { sfx, mountToggle } from "./sound.mjs";
import { reducedMotion, onVisible } from "../motion-loop.mjs";

const $ = (s, el = document) => el.querySelector(s);
const still = reducedMotion();

// Typed placeholder, cycling through real questions the engine answers,
// in both languages, so a visitor sees they can ask in Hindi too.
const EXAMPLES = [
  "What is SYN-0001's ferritin result?",
  "क्या creatinine सितंबर से बढ़ा है?",
  "Was the $42,000 revision finalized?",
  "फीस कितनी है?",
  "Did they agree on the payment split?",
  "mera ferritin kitna hai?",
];
function typewriter() {
  const q = $("#q");
  if (!q || still) return;
  let i = 0,
    timer = null,
    alive = true;
  const typeOne = (s, k = 0) => {
    if (!alive) return;
    if (document.activeElement === q || q.value) {
      timer = setTimeout(() => typeOne(s, k), 800);
      return;
    }
    q.placeholder = s.slice(0, k) + (k < s.length ? "▍" : "");
    if (k < s.length) timer = setTimeout(() => typeOne(s, k + 1), 38 + Math.random() * 40);
    else timer = setTimeout(() => typeOne(EXAMPLES[(i = (i + 1) % EXAMPLES.length)], 0), 2200);
  };
  onVisible(q, (vis) => {
    alive = vis;
    clearTimeout(timer);
    if (vis) typeOne(EXAMPLES[i], 0);
  });
}

// A sticky note peels off and lands in the ask bar before the question is asked.
function noteFlights() {
  document.addEventListener(
    "click",
    (e) => {
      const chip = e.target.closest?.(".chip[data-q]");
      if (!chip) return;
      sfx.pop();
      if (still) return;
      const r = chip.getBoundingClientRect();
      const t = $("#askbar").getBoundingClientRect();
      const ghost = chip.cloneNode(true);
      ghost.classList.add("chip-ghost");
      Object.assign(ghost.style, { left: r.left + "px", top: r.top + "px", width: r.width + "px" });
      document.body.appendChild(ghost);
      motionAnimate(
        ghost,
        { x: t.left + 16 - r.left, y: t.top + 10 - r.top, scale: [1, 0.9], opacity: [1, 0] },
        { type: "spring", stiffness: 170, damping: 22 },
      ).then(() => ghost.remove());
    },
    true,
  );
}

// Segmented control: one indicator that springs to the selected tab
// (the easing is the damped spring set as --spring by figures.mjs).
function tabs() {
  const box = $(".cases");
  if (!box) return;
  const ind = document.createElement("span");
  ind.className = "case-ind";
  ind.setAttribute("aria-hidden", "true");
  box.prepend(ind);
  const place = () => {
    const on = $('.case-tab[aria-selected="true"]', box);
    if (!on) return;
    ind.style.width = on.offsetWidth + "px";
    ind.style.height = on.offsetHeight + "px";
    ind.style.transform = `translate(${on.offsetLeft}px, ${on.offsetTop}px)`;
  };
  place();
  new MutationObserver(place).observe(box, { attributes: true, subtree: true, attributeFilter: ["aria-selected"] });
  new ResizeObserver(place).observe(box);
  box.addEventListener("click", (e) => {
    if (e.target.closest(".case-tab")) sfx.tick();
  });
}

// Answers resolve in place, then the verdict chip springs in.
function answers() {
  const box = $("#answer");
  if (!box) return;
  document.addEventListener("vm:answer", () => {
    box.classList.remove("printing");
    void box.offsetWidth; // restart the CSS animation
    box.classList.add("printing");
    sfx.swipe();
    setTimeout(() => {
      if ($(".verdict-chip", box)) sfx.confirm();
    }, 260);
  });
  document.addEventListener("vm:source", (e) => {
    if (e.detail?.cited) setTimeout(() => sfx.marker(), 320);
  });
  document.addEventListener("vm:call", (e) => (e.detail === "start" ? sfx.chime() : sfx.hang()));
}

function dropZone() {
  const drop = $("#drop");
  if (!drop) return;
  for (const ev of ["dragenter", "dragover"]) drop.addEventListener(ev, () => drop.classList.add("over"));
  for (const ev of ["dragleave", "drop"]) drop.addEventListener(ev, () => drop.classList.remove("over"));
  drop.addEventListener("drop", () => sfx.pop());
  $("#files")?.addEventListener("change", () => sfx.pop());
}

// Every button press ticks (once the visitor has opted into sound).
function ticks() {
  document.addEventListener("click", (e) => {
    if (e.target.closest?.(".catch, .ask-go, .tool, .doc-rail button, .cite")) sfx.tick();
  });
}

export function mountDesk() {
  mountToggle();
  typewriter();
  noteFlights();
  tabs();
  answers();
  dropZone();
  ticks();
}
