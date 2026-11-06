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
  await page.addInitScript(() => {
    window.__micCalls = 0;
    window.__callStarts = 0;
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: async () => {
          window.__micCalls++;
          return { getTracks: () => [{ stop() {} }] };
        },
        enumerateDevices: async () => [],
      },
    });
    window.BolnaWebCall = class {
      constructor(opts) {
        this.opts = opts;
        this.h = {};
      }
      on(k, fn) {
        this.h[k] = fn;
      }
      async start() {
        window.__callStarts++;
        await this.opts.getSession();
        this.h["call-start"]?.();
      }
      stop() {
        this.h["call-end"]?.({ reason: "hangup" });
      }
    };
  });
  await page.route("**/api/public/status", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    body.voice = { configured: true, ready: true };
    await route.fulfill({ response, json: body });
  });
  let mints = 0;
  await page.route("**/api/public/voice/session", (route) => {
    mints++;
    return route.fulfill({
      json: { vm_ticket: String(mints).padStart(32, "t") },
    });
  });
  await page.route("**/api/public/voice/turns?*", (r) =>
    r.fulfill({ json: { turns: [] } }),
  );
  await page.goto(origin, { waitUntil: "domcontentloaded" });
  await page.locator('.case-tab[data-case="own"]').click();
  await page.locator("#files").setInputFiles({
    name: "queue.md",
    mimeType: "text/markdown",
    buffer: Buffer.from(
      "A bounded queue pauses producers while consumers catch up. Checkpoints preserve progress after a restart. Each worker owns a partition lease.",
    ),
  });
  await page
    .locator("#upl-list li")
    .filter({ hasText: "Ready" })
    .first()
    .waitFor({ timeout: 45000 });
  await page.locator("#call-btn").waitFor();
  const ws = await page.evaluate(() => sessionStorage.getItem("vm_ws"));
  let release, observed;
  const gate = new Promise((r) => (release = r));
  const checked = new Promise((r) => (observed = r));
  let checks = 0;
  await page.route("**/api/public/workspace/" + ws, async (route) => {
    checks++;
    observed();
    await gate;
    await route.fulfill({ json: { ready: true, documents: [] } });
  });
  await page.locator("#call-btn").click();
  await checked;
  await page.locator("#call-btn").click();
  release();
  await page.locator("#call-label").filter({ hasText: "Hang up" }).waitFor();
  await page.waitForTimeout(200);
  console.log(
    JSON.stringify({
      checks,
      mints,
      microphones: await page.evaluate(() => window.__micCalls),
      starts: await page.evaluate(() => window.__callStarts),
    }),
  );
  assert.equal(checks, 1);
  assert.equal(mints, 1);
  assert.equal(await page.evaluate(() => window.__micCalls), 1);
  assert.equal(await page.evaluate(() => window.__callStarts), 1);
  await page.locator("#call-btn").click();
  console.log(
    "PASS repeated clicks share one preflight, microphone request and call session",
  );
} finally {
  await browser.close();
  dev.kill();
}
