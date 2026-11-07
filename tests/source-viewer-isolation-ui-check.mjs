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
  await page.locator("#files").setInputFiles({
    name: "01_Northstar_Proposal_v1.md",
    mimeType: "text/markdown",
    buffer: Buffer.from(
      "Personal telescope notes. The private observation marker is ORION-CEDAR. A cooled camera improves long-exposure imaging. Calibration uses dark frames and a stable mount. No commercial agreement is described.",
    ),
  });
  await page
    .locator("#upl-list li")
    .filter({ hasText: "Ready" })
    .first()
    .waitFor({ timeout: 45000 });
  await page.route("**/api/public/doc/w_*/*", (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: '{"error":"temporary"}',
    }),
  );
  await page.locator("#files-btn").click();
  // One indexed document now opens its reader directly; multiple documents
  // still expose the file grid. Keep the source/error assertions below.
  if (await page.locator("#viewer-body .file-card").count())
    await page.locator("#viewer-body .file-card").first().click();
  await page.waitForFunction(
    () =>
      !!document.querySelector(
        "#viewer-body .vw-text,#viewer-body .viewer-note",
      ),
  );
  const text = await page.locator("#viewer-body").innerText();
  console.log("source read during outage:", text.slice(0, 800));
  assert.doesNotMatch(text, /48,000|three regions|Northstar Pilot Proposal/);
  assert.match(text, /load this document|unavailable|try again/i);
  console.log(
    "PASS unavailable own document never uses a same-title demo snapshot",
  );
} finally {
  await browser.close();
  dev.kill();
}
