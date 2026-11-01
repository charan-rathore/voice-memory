// Screenshots of the landing page as deployed (site/ + local engine), for
// design review and as a smoke test. Fails on any console error, if the
// hero's 5 never lands in the amended value, or if the 3D memory graph
// doesn't mount when its band scrolls into view.
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
  args: [
    "--no-sandbox",
    "--use-gl=angle",
    "--use-angle=swiftshader",
    "--enable-unsafe-swiftshader",
  ],
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
      (m) =>
        m.type() === "error" &&
        !/Failed to load resource/.test(m.text()) &&
        errors.push(`${name}: ${m.text()}`),
    );
    page.on("pageerror", (e) => errors.push(`${name}: ${e.message}`));
    await page.goto("http://127.0.0.1:4500/");
    await page.waitForTimeout(1700);
    await page.screenshot({ path: `${out}/${name}-hero-flight.png` });
    await page.waitForTimeout(2300);
    await page.screenshot({ path: `${out}/${name}-hero.png` });
    const landed = await page.evaluate(() => {
      const d5 = document.querySelector(".hc-d5");
      return (
        !document.querySelector(".hc-ghost") &&
        getComputedStyle(d5).opacity === "1"
      );
    });
    if (!landed) errors.push(`${name}: the 5 never landed in the amended value`);
    await page.locator(".pipe").scrollIntoViewIfNeeded();
    await page.waitForTimeout(1600);
    await page.screenshot({ path: `${out}/${name}-pipeline.png` });
    await page.locator(".graph-band").scrollIntoViewIfNeeded();
    await page.waitForTimeout(3500);
    if (!(await page.locator(".graph-3d").count()))
      errors.push(`${name}: 3D memory graph did not mount`);
    await page
      .locator(".graph-band")
      .screenshot({ path: `${out}/${name}-graph.png` });
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
