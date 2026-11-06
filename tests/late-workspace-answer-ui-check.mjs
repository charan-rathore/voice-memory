import { chromium } from "playwright";
import assert from "node:assert/strict";
import { writeFile, mkdir, readFile } from "node:fs/promises";
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
  if (process.env.VM_BASELINE_SITE) {
    const baseline = await readFile(process.env.VM_BASELINE_SITE, "utf8");
    await page.route("**/site.js", (r) =>
      r.fulfill({ contentType: "text/javascript", body: baseline }),
    );
  }
  await page.goto(origin, { waitUntil: "domcontentloaded" });
  await page.locator('.case-tab[data-case="own"]').click();
  const file = (name, marker) => ({
    name,
    mimeType: "text/markdown",
    buffer: Buffer.from(
      "Telescope observation log. The observation marker is " +
        marker +
        ". Calibration uses dark frames and a stable mount. The cooled camera improves long-exposure imaging.",
    ),
  });
  await page
    .locator("#files")
    .setInputFiles(file("old-notes.md", "ORION-CEDAR"));
  await page
    .locator("#upl-list li")
    .filter({ hasText: "Ready" })
    .first()
    .waitFor({ timeout: 45000 });
  const old = await page.evaluate(() => sessionStorage.getItem("vm_ws"));
  let release;
  const gate = new Promise((r) => (release = r));
  let fetched;
  const gotAnswer = new Promise((r) => (fetched = r));
  await page.route("**/api/public/ask", async (route) => {
    const response = await route.fetch();
    fetched();
    await gate;
    await route.fulfill({ response });
  });
  const responseReady = page.waitForResponse(
    (r) => new URL(r.url()).pathname === "/api/public/ask",
  );
  await page.locator("#q").fill("What is the observation marker?");
  await page.locator(".ask-go").click();
  await gotAnswer;
  await page.route("**/api/public/workspace/" + old, (r) =>
    r.fulfill({
      status: 404,
      contentType: "application/json",
      body: '{"error":"expired"}',
    }),
  );
  await page
    .locator("#files")
    .setInputFiles(file("new-notes.md", "SELENE-BIRCH"));
  await page
    .locator("#upl-list li")
    .filter({ hasText: "new-notes.md" })
    .filter({ hasText: "Ready" })
    .waitFor({ timeout: 45000 });
  release();
  await (await responseReady).finished();
  await page.evaluate(
    () =>
      new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
  );
  const text = await page.locator("#answer").innerText();
  console.log("answer after workspace replacement:", text);
  assert.doesNotMatch(text, /ORION-CEDAR/);
  await page.unroute("**/api/public/ask");
  await page.locator("#q").fill("What is the observation marker?");
  await page.locator(".ask-go").click();
  await page
    .locator("#answer .a-lead")
    .filter({ hasText: "SELENE-BIRCH" })
    .waitFor();
  console.log(
    "PASS old workspace answer is dropped and replacement workspace remains answerable",
  );
} finally {
  await browser.close();
  dev.kill();
}
