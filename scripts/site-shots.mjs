// Screenshots of the landing page as deployed (site/ + local engine), for
// design review and as a smoke test: fails on any console error or a hero
// that drew no tethers.
//   node scripts/site-shots.mjs [outDir]
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { chromium } from "playwright";

const out = process.argv[2] || ".shots";
mkdirSync(out, { recursive: true });
const dev = spawn(process.execPath, ["scripts/site-dev.mjs"], {
  stdio: ["ignore", "pipe", "inherit"],
});
await new Promise((r) => {
  dev.stdout.on("data", (d) => String(d).includes("4500") && r());
  setTimeout(r, 4000);
});
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.CHROME_PATH || "/usr/bin/google-chrome",
  args: ["--no-sandbox"],
});
const errors = [];
try {
  for (const [name, vp] of [
    ["desktop", { width: 1440, height: 900 }],
    ["phone", { width: 390, height: 844 }],
  ]) {
    const page = await browser.newPage({ viewport: vp, deviceScaleFactor: 1 });
    page.on(
      "console",
      (m) => m.type() === "error" && errors.push(`${name}: ${m.text()}`),
    );
    page.on("pageerror", (e) => errors.push(`${name}: ${e.message}`));
    await page.goto("http://127.0.0.1:4500/", { waitUntil: "networkidle" });
    await page.waitForTimeout(3500);
    const tethers = await page.locator("#tethers .tether").count();
    if (!tethers) errors.push(`${name}: hero drew no tethers`);
    await page.screenshot({ path: `${out}/${name}-hero.png` });
    for (const [i, label] of ["creatinine", "tsh"].entries()) {
      await page.locator(`[data-hq="${i + 1}"]`).click();
      await page.evaluate(() => scrollTo(0, 0));
      await page.waitForTimeout(3200);
      await page.screenshot({ path: `${out}/${name}-hero-${label}.png` });
    }
    await page.screenshot({ path: `${out}/${name}-full.png`, fullPage: true });
    await page.close();
  }
} finally {
  await browser.close();
  dev.kill();
}
if (errors.length) {
  console.error(errors.join("\n"));
  process.exit(1);
}
console.log("ok", out);
