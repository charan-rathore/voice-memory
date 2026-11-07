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
  let releaseCases;
  const gate = new Promise((r) => (releaseCases = r));
  let sawCases;
  const requested = new Promise((r) => (sawCases = r));
  await page.route("**/api/public/cases", async (route) => {
    sawCases();
    await gate;
    await route.continue();
  });
  await page.goto(origin, { waitUntil: "domcontentloaded" });
  await page.locator('.case-tab[data-case="own"]').click();
  await page.locator("#files").setInputFiles({
    name: "queue.md",
    mimeType: "text/markdown",
    buffer: Buffer.from(
      "A bounded queue pauses producers while consumers catch up. Checkpoints preserve progress after a restart. The queue retains event order.",
    ),
  });
  await page
    .locator("#upl-list li")
    .filter({ hasText: "Ready" })
    .first()
    .waitFor({ timeout: 45000 });
  let requestTimer;
  try {
    await Promise.race([
      requested,
      new Promise((_, reject) => {
        requestTimer = setTimeout(
          () => reject(Error("cases request not observed")),
          20000,
        );
      }),
    ]);
  } finally {
    clearTimeout(requestTimer);
  }
  let releaseSource;
  const sourceGate = new Promise((r) => (releaseSource = r));
  let sawSource;
  const sourceRequested = new Promise((r) => (sawSource = r));
  await page.route("**/api/public/doc/w_*/*", async (route) => {
    const response = await route.fetch();
    sawSource();
    await sourceGate;
    await route.fulfill({ response });
  });
  await page.locator("#files-btn").click();
  // One indexed document now opens its reader directly; multiple documents
  // still expose the file grid. Keep the source/error assertions below.
  if (await page.locator("#viewer-body .file-card").count())
    await page.locator("#viewer-body .file-card").first().click();
  await sourceRequested;
  releaseCases();
  await page
    .locator("#engine-note")
    .filter({ hasText: "Live engine connected" })
    .waitFor();
  releaseSource();
  await page
    .locator("#viewer-body .vw-text")
    .filter({ hasText: "bounded queue" })
    .waitFor({ timeout: 5000 })
    .catch(async (error) => {
      console.log(
        "source pane after delayed connection:",
        await page.locator("#viewer-body").innerText(),
      );
      throw error;
    });
  await page.locator("#q").fill("What does the bounded queue do?");
  await page.locator(".ask-go").click();
  await page.waitForFunction(
    () => !!document.querySelector("#answer .a-lead,#answer .a-err"),
  );
  const answer = await page.locator("#answer").innerText();
  assert.equal(await page.locator("#answer .a-err").count(), 0, answer);
  assert.ok((await page.locator("[data-cite]").count()) > 0);
  console.log(
    "PASS delayed demo connection preserves uploaded document readiness and citations",
  );
} finally {
  await browser.close();
  dev.kill();
}
