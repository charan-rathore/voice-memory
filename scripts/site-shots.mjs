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
    // The 5 must land and its flying ghost must be gone: waited for (up to
    // 8 s) rather than raced against a fixed delay, since a cold engine boot
    // on the same machine can push the first story back by a few hundred ms.
    const landed = await page
      .waitForFunction(
        () => {
          const d5 = document.querySelector(".hc-d5");
          return (
            !document.querySelector(".hc-ghost") &&
            getComputedStyle(d5).opacity === "1"
          );
        },
        null,
        { timeout: 8000 },
      )
      .then(() => true)
      .catch(() => false);
    if (!landed)
      errors.push(`${name}: the 5 never landed in the amended value`);
    await page.locator(".pipe").scrollIntoViewIfNeeded();
    await page.waitForTimeout(1600);
    await page.screenshot({ path: `${out}/${name}-pipeline.png` });
    // Report charts: clicking a range row opens that test as a scene on
    // the stage (right column on desktop, under the report on phones);
    // a brace on the number line opens its group of results.
    const row = page.locator('.rr-row[data-sel="test:hemoglobin"]').first();
    if (await row.count()) {
      await row.scrollIntoViewIfNeeded();
      await row.click();
      await page.waitForTimeout(900);
      const dd = await page.evaluate(() => {
        const sc = document.querySelector(".stage .st-scene:not(.leaving)");
        return {
          key: sc?.dataset.key ?? "",
          line: !!sc?.querySelector(".m-nl"),
          readings: sc?.querySelectorAll(".m-pt").length ?? 0,
          selected: document.querySelectorAll(
            '.vz-report [data-sel="test:hemoglobin"].sel',
          ).length,
        };
      });
      if (
        dd.key !== "test:hemoglobin" ||
        !dd.line ||
        dd.readings < 2 ||
        dd.selected < 1
      )
        errors.push(`${name}: report scene did not open ${JSON.stringify(dd)}`);
      const brace = page.locator(".m-brace").first();
      if (await brace.count()) {
        await brace.dispatchEvent("click");
        await page.waitForTimeout(700);
        const n = await page.evaluate(
          () =>
            document.querySelectorAll(".stage .st-scene:not(.leaving) .m-bar")
              .length,
        );
        if (n < 1) errors.push(`${name}: brace opened no results`);
      } else errors.push(`${name}: no braces on the result field`);
      await page
        .locator(".vz-report")
        .first()
        .screenshot({ path: `${out}/${name}-report.png` });
      if (await page.locator(".stage").count())
        await page
          .locator(".stage")
          .first()
          .screenshot({ path: `${out}/${name}-stage.png` });
    } else errors.push(`${name}: no hemoglobin row on the report`);
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
