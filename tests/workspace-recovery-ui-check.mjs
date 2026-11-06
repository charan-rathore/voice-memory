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
    await browser.close();
    throw Error("local site failed to start");
  }
}

try {
  const page = await browser.newPage();
  await page.goto(origin, { waitUntil: "domcontentloaded" });
  await page.locator('.case-tab[data-case="own"]').click();
  const file = (marker) => ({
    name: "notes.md",
    mimeType: "text/markdown",
    buffer: Buffer.from(
      "Personal telescope notes. The current observation marker is " +
        marker +
        ". A cooled camera improves long-exposure imaging. Calibration uses dark frames and a stable mount.",
    ),
  });
  await page.locator("#files").setInputFiles(file("ORION-CEDAR"));
  await page
    .locator("#upl-list li")
    .filter({ hasText: "Ready" })
    .first()
    .waitFor({ timeout: 45000 });
  await page.locator("#files-btn").click();
  await page.locator("#viewer-body .file-card").first().click();
  await page
    .locator("#viewer-body .vw-text")
    .filter({ hasText: "ORION-CEDAR" })
    .waitFor();
  const old = await page.evaluate(() => sessionStorage.getItem("vm_ws"));
  await page.route("**/api/public/workspace/" + old, (route) =>
    route.fulfill({
      status: 404,
      contentType: "application/json",
      body: '{"error":"expired"}',
    }),
  );
  await page.locator("#files").setInputFiles(file("SELENE-BIRCH"));
  await page.waitForFunction(
    (old) => sessionStorage.getItem("vm_ws") !== old,
    old,
  );
  await page
    .waitForFunction(
      () =>
        document.querySelectorAll("#upl-list li").length === 1 &&
        document.querySelector("#upl-list .upl-st")?.textContent === "Ready",
      {},
      { timeout: 15000 },
    )
    .catch(async (error) => {
      console.log(
        "replacement upload list:",
        await page.locator("#upl-list").innerText(),
      );
      throw error;
    });
  await page.locator("#files-btn").click();
  assert.equal(await page.locator("#viewer-body .file-card").count(), 1);
  await page.locator("#viewer-body .file-card").first().click();
  await page
    .locator("#viewer-body .vw-text")
    .filter({ hasText: "SELENE-BIRCH" })
    .waitFor();
  assert.doesNotMatch(
    await page.locator("#viewer-body").innerText(),
    /ORION-CEDAR/,
  );
  const current = await page.evaluate(() => sessionStorage.getItem("vm_ws"));
  await page.route("**/api/public/doc/" + current + "/*", (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: '{"error":"temporary"}',
    }),
  );
  await page.locator("#files-btn").click();
  await page.locator("#viewer-body .file-card").first().click();
  await page.locator("#viewer-body .viewer-note").waitFor();
  const unavailable = await page.locator("#viewer-body").innerText();
  assert.doesNotMatch(unavailable, /ORION-CEDAR|SELENE-BIRCH/);
  console.log(
    "PASS expired workspace replacement retains only current documents and never replays cached source text",
  );
} finally {
  await browser.close();
  dev.kill();
}
