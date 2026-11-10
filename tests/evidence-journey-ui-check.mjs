// Browser check for the reading view (site/reading.js) at 320, 390, 768 and
// 1280 px: page tiles are real buttons with usable touch targets, Enter on
// a tile opens that document in the source viewer, the illustrative index
// lookup is labelled as an example, and no time budget is promised.
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PDFDocument, StandardFonts } from "pdf-lib";

const shots =
  process.env.VM_SHOTS_DIR || join(tmpdir(), "voice-memory-journey-shots");
mkdirSync(shots, { recursive: true });
const fail = (m) => {
  throw Error(m);
};
async function twoPagePdf() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const lines of [
    [
      "Service Agreement",
      "The monthly fee is Rs 12,000.",
      "Payment is due on the 5th.",
    ],
    [
      "Schedule B",
      "The notice period is 30 days.",
      "Signed copies are kept by the client.",
    ],
  ]) {
    const p = doc.addPage([595, 400]);
    lines.forEach((t, i) =>
      p.drawText(t, { x: 56, y: 340 - i * 24, size: 11, font }),
    );
  }
  return {
    name: "two-page-agreement.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from(await doc.save()),
  };
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const dev = spawn("node", ["scripts/site-dev.mjs"], { stdio: "ignore" });
let browser;
try {
  for (let i = 0; i < 50; i++) {
    if (
      await fetch("http://127.0.0.1:4500/")
        .then((r) => r.ok)
        .catch(() => false)
    )
      break;
    await wait(200);
    if (i === 49) fail("site-dev never came up");
  }
  browser = await chromium.launch({
    headless: true,
    ...(process.env.CHROME_PATH
      ? { executablePath: process.env.CHROME_PATH }
      : {}),
    args: ["--no-sandbox"],
  });
  const file = await twoPagePdf();
  for (const width of [320, 390, 768, 1280]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    await page.goto("http://127.0.0.1:4500/");
    await page.locator('.case-tab[data-case="own"]').click();
    await page.locator("#files").setInputFiles(file);
    await page
      .locator("#upl-list li", { hasText: "Ready" })
      .first()
      .waitFor({ timeout: 60000 });
    const tiles = page.locator(".rd-pages .rd-pg");
    await tiles.first().waitFor({ timeout: 20000 });
    if ((await tiles.count()) < 2) fail(`${width}: expected a tile per page`);
    // never hidden from assistive technology
    if (await page.locator(".rd-pages[aria-hidden]").count())
      fail(`${width}: page strip is hidden from assistive tech`);
    const box = await tiles.nth(1).boundingBox();
    if (!box || box.width < 44 || box.height < 44)
      fail(`${width}: touch target too small ${JSON.stringify(box)}`);
    const reading = await page.locator(".rd").innerText();
    if (/2:00 budget|2-minute budget/.test(reading))
      fail(`${width}: budget promised`);
    if (/Looking up “/.test(reading) && !/not your search/.test(reading))
      fail(`${width}: an index example is not labelled as an example`);
    await page.screenshot({
      path: join(shots, `journey-${width}-reading.png`),
      fullPage: false,
    });
    // keyboard: focus page 2 and press Enter
    await tiles.nth(1).focus();
    await page.keyboard.press("Enter");
    if ((await tiles.nth(1).getAttribute("aria-pressed")) !== "true")
      fail(`${width}: selected tile not marked pressed`);
    await page
      .locator("#viewer-body .rd-doc.focus", { hasText: "two-page-agreement" })
      .first()
      .waitFor({ timeout: 10000 });
    await page.screenshot({
      path: join(shots, `journey-${width}-viewer.png`),
      fullPage: false,
    });
    await page.close();
  }
  console.log(
    "evidence-journey-ui-check OK: tiles are buttons at 320/390/768/1280, Enter opens the document, no budget, example labelled. Shots:",
    shots,
  );
} finally {
  await browser?.close();
  dev.kill();
}
