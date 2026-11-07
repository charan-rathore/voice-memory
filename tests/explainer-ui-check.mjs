// Browser check for the test explainer (one lab test for someone who has
// never read a lab report). Each assertion failed before this change:
//   - tapping the Ferritin dot opened Hemoglobin (a neighbouring label and
//     the decorative range band took the tap);
//   - a unit label was uppercased, so "µmol/L" read "MMOL/L";
//   - TSH "<0.05 -> 0.30" said "Not compared" on screen while the spoken
//     answer said "higher" (the direction is certain, the size is not);
//   - on a phone the number line was cut off before the printed range.
// Run alone (node tests/explainer-ui-check.mjs) or from
// scripts/site-shots.mjs, which passes its own browser.
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

const BASE = "http://127.0.0.1:4500";

async function openTest(page, key) {
  await page.goto(BASE + "/#try");
  await page.waitForSelector(`[data-sel="test:${key}"]`, { timeout: 15000 });
  const dot = page.locator(`.m-dot[data-sel="test:${key}"] .m-c`).first();
  await dot.scrollIntoViewIfNeeded();
  await dot.click();
  await page.waitForSelector(".ex-h .st-title", { timeout: 10000 });
  await page.waitForTimeout(400);
  return (await page.locator(".ex-h .st-title .m-tw").first().innerText())
    .trim();
}

export async function checkExplainer(browser) {
  const errors = [];
  const say = (ok, m) => ok || errors.push(m);
  for (const [name, viewport] of [
    ["desktop", { width: 1440, height: 900 }],
    ["phone", { width: 390, height: 844 }],
  ]) {
    const page = await browser.newPage({ viewport });
    page.on("pageerror", (e) => errors.push(`${name}: ${e.message}`));
    try {
      // a dot opens its own test
      const ferritin = await openTest(page, "ferritin");
      say(ferritin === "Ferritin", `${name}: ferritin dot opened ${ferritin}`);
      const text = await page.locator(".st-scene").first().innerText();
      for (const want of [
        /What is it\?/i,
        /Why is it measured\?/i,
        /What your report says/i,
        /Where it sits/i,
        /What changed/i,
        /What this can.t tell you/i,
        /Not yet reviewed by a clinician/,
        /fix to the paper, not a change in your body/,
      ])
        say(want.test(text), `${name}: ferritin explainer lacks ${want}`);
      const src = await page
        .locator(".ex-src a")
        .first()
        .getAttribute("href");
      say(/^https:\/\/medlineplus\.gov\//.test(src ?? ""), `${name}: source`);

      // units are shown exactly as printed
      await openTest(page, "creatinine");
      const units = await page.locator(".ex-chart .m-unit").allInnerTexts();
      say(units.includes("µmol/L"), `${name}: units read ${units}`);
      say(!units.some((u) => /MMOL/.test(u)), `${name}: µ shown as M`);
      const crea = await page.locator(".st-scene").first().innerText();
      say(/Not compared/.test(crea), `${name}: creatinine compared`);
      // a claimed direction, not "whether it went up or down"
      say(!/(Higher|Lower) than on/.test(crea), `${name}: direction`);

      // a bound: direction yes, size no; screen agrees with the voice
      await openTest(page, "tsh");
      const tsh = await page.locator(".st-scene").first().innerText();
      say(/Higher than on 3 Sep/.test(tsh), `${name}: TSH direction missing`);
      say(!/Not compared/.test(tsh), `${name}: TSH says not compared`);
      say(!/[+-]0\.25/.test(tsh), `${name}: a bound was subtracted from`);

      // the whole printed range is on screen: nothing scrolls sideways
      const fit = await page.evaluate(() => {
        const svg = document.querySelector(".ex-chart .m-nl");
        const band = svg?.querySelector(".m-band")?.getBoundingClientRect();
        const box = svg?.getBoundingClientRect();
        return band && box
          ? band.right <= box.right + 1 && box.right <= innerWidth + 1
          : false;
      });
      say(fit, `${name}: printed range not fully visible`);
    } catch (e) {
      errors.push(`${name}: ${e.message}`);
    } finally {
      await page.close();
    }
  }
  return errors;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const dev = spawn(process.execPath, ["scripts/site-dev.mjs"], {
    stdio: "ignore",
  });
  let browser;
  let errors = [];
  try {
    for (let i = 0; i < 60; i++) {
      const up = await fetch(BASE + "/")
        .then((r) => r.ok)
        .catch(() => false);
      if (up) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    browser = await chromium.launch({
      headless: true,
      executablePath: process.env.CHROME_PATH || undefined,
      args: ["--no-sandbox"],
    });
    errors = await checkExplainer(browser);
  } finally {
    await browser?.close();
    dev.kill();
  }
  if (errors.length) {
    console.error(errors.join("\n"));
    process.exit(1);
  }
  console.log("explainer ok");
}
