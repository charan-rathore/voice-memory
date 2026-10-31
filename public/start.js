// Start screen: cards open a corpus, question chips load the Northstar demo
// (if nothing is loaded) and ask. Uses the page's own controls, so every
// path is the same one a person would click.
import { springIn } from "/motion.js";

const $ = (id) => document.getElementById(id);
const ready = () =>
  /Documents ready|Evidence ready|Found in|ready/i.test(
    $("status")?.textContent ?? "",
  ) && document.querySelectorAll("#sources li").length > 0;

async function waitReady(ms = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (ready()) return true;
    await new Promise((r) => setTimeout(r, 120));
  }
  return false;
}

document.querySelectorAll(".start-card").forEach((card, i) => {
  card.style.opacity = "0";
  setTimeout(() => springIn(card, { rise: 14 }), 90 + i * 80);
  card.addEventListener("click", () => {
    const what = card.dataset.start;
    if (what === "upload") $("files")?.click();
    else $(what)?.click();
  });
});

document.querySelectorAll(".q-chip").forEach((chip) =>
  chip.addEventListener("click", async () => {
    if (!document.querySelectorAll("#sources li").length) {
      $("northstar")?.click();
      await waitReady();
    }
    const q = $("question");
    q.value = chip.textContent.trim();
    $("ask").requestSubmit();
  }),
);
