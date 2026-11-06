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
    name: "design-notes.md",
    mimeType: "text/markdown",
    buffer: Buffer.from(
      "# Event processing\n\n## Backpressure\nA bounded queue pauses producers while consumers catch up. Checkpoints preserve progress after a restart. Each worker holds a lease for its partition.\n",
    ),
  });
  await page
    .locator("#upl-list li")
    .filter({ hasText: "Ready" })
    .first()
    .waitFor({ timeout: 45000 });
  await page
    .locator("#ov-body .skeleton")
    .first()
    .waitFor({ state: "detached" });
  const body = await page.locator("#ov-body").innerText();
  console.log("generic document overview:", body);
  assert.doesNotMatch(body, /Upload a lab report/i);
  assert.match(body, /document|passage|ready/i);
  await page.locator('#ov-body a[href="graph.html?case=own"]').waitFor();
  console.log(
    "PASS non-clinical uploaded documents have a useful overview and graph entry",
  );
} finally {
  await browser.close();
  dev.kill();
}
