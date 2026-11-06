import { chromium } from "playwright";
import assert from "node:assert/strict";
import { writeFile, mkdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
const shots =
  process.env.VM_SHOTS_DIR || join(tmpdir(), "voice-memory-upload-audit");
await mkdir(shots, { recursive: true });
const port = 4600 + Math.floor(Math.random() * 200);
const env = { ...process.env };
for (const k of Object.keys(env))
  if (k.startsWith("VM_") || /(_KEY|_TOKEN|_SECRET|PASSWORD)$/.test(k))
    delete env[k];
Object.assign(env, {
  SITE_PORT: String(port),
  VM_DENSE: "off",
  VM_GEMINI: "off",
  VM_RSS_WATCHDOG: "off",
  VM_COUNTERS_ALLOW_FILE: "on",
});
const dev = spawn(process.execPath, ["scripts/site-dev.mjs"], {
  env,
  stdio: "ignore",
});

const browser = await chromium
  .launch({
    headless: true,
    ...(process.env.CHROME_PATH
      ? { executablePath: process.env.CHROME_PATH }
      : {}),
  })
  .catch((error) => {
    dev.kill();
    throw error;
  });
const results = [];
const origin = `http://127.0.0.1:${port}`;
for (let i = 0; i < 80; i++) {
  if (
    await fetch(origin)
      .then((r) => r.ok)
      .catch(() => false)
  )
    break;
  await new Promise((r) => setTimeout(r, 200));
  if (i === 79) {
    dev.kill();
    throw Error("local site failed to start");
  }
}

try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(origin, { waitUntil: "networkidle" });
  for (const plug of ["mcp", "bolna", "rest"]) {
    await page.locator('.tm-tabs [data-plug="' + plug + '"]').click();
    assert.equal(
      await page.locator('.tm-code[data-plug="' + plug + '"]').isVisible(),
      true,
    );
  }
  results.push({ check: "all three integration snippet tabs", pass: true });
  const sound = page.locator("[data-sound]");
  const before = await sound.getAttribute("aria-pressed");
  await sound.click();
  assert.notEqual(await sound.getAttribute("aria-pressed"), before);
  await sound.click();
  results.push({ check: "sound toggle updates state", pass: true });
  for (const scene of ["fix", "units", "deal"]) {
    const b = page.locator('.hc-tab[data-scene="' + scene + '"]');
    await b.click();
    assert.equal(await b.getAttribute("aria-selected"), "true");
  }
  results.push({ check: "hero correction/units/approval scenes", pass: true });
  for (const id of ["health", "deal"]) {
    await page.locator('.case-tab[data-case="' + id + '"]').click();
    await page.locator("#files-btn").click();
    await page.locator("#viewer-body .file-card").first().waitFor();
    const count = await page.locator("#viewer-body .file-card").count();
    for (let i = 0; i < count; i++) {
      await page.locator("#files-btn").click();
      try {
        await page
          .locator("#viewer-body .file-card")
          .nth(i)
          .click({ timeout: 5000 });
      } catch (error) {
        console.log(
          JSON.stringify(
            await page.evaluate(() =>
              [
                ...document.querySelectorAll(
                  ".stage,#viewer-body,.file-card,.desk-right",
                ),
              ].map((e) => ({
                cls: e.className,
                rect: e.getBoundingClientRect().toJSON(),
                position: getComputedStyle(e).position,
                flex: getComputedStyle(e).flex,
                height: getComputedStyle(e).height,
                grid: getComputedStyle(e).gridTemplateRows,
              })),
            ),
            null,
            2,
          ),
        );
        await page.screenshot({
          path: join(shots, "blocked-document-card.png"),
        });
        throw error;
      }
      await page.waitForFunction(
        () =>
          !!document.querySelector(
            "#viewer-body .page, #viewer-body .vw-text, #viewer-body .rd-doc",
          ),
      );
    }
    results.push({ check: id + " document-card buttons", count, pass: true });
  }
  for (const lang of ["en", "hi", "hinglish"]) {
    const b = page.locator('button[data-lang="' + lang + '"]');
    if (!(await b.count())) {
      results.push({ check: "language " + lang, available: false });
      continue;
    }
    await b.click();
    await page
      .locator('button[data-lang="' + lang + '"][aria-pressed="true"]')
      .waitFor();
  }
  results.push({ check: "available language selectors", pass: true });
  const media = await page
    .locator("video source,video track")
    .evaluateAll((es) => es.map((e) => e.getAttribute("src")));
  for (const path of media) {
    const r = await page.request.get(origin + "/" + path);
    assert.equal(r.status(), 200, path);
  }
  results.push({
    check: "film and caption assets reachable (playback untested)",
    pass: true,
  });
  assert.deepEqual(errors, []);
  results.push({ check: "uncaught errors", errors });
  await writeFile(
    join(shots, "control-matrix-results.json"),
    JSON.stringify(results, null, 2),
  );
  console.log(JSON.stringify(results, null, 2));
} finally {
  await browser.close();
  dev.kill();
}
