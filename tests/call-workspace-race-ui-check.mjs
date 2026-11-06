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
  for (const staleStatus of [404, 200]) {
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
        }
        on() {}
        async start() {
          window.__callStarts++;
          await this.opts.getSession();
        }
        stop() {}
      };
    });
    await page.route("**/api/public/status", async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      body.voice = { configured: true, ready: true };
      await route.fulfill({ response, json: body });
    });
    await page.route("**/api/public/voice/session", (route) =>
      route.fulfill({ json: { vm_ticket: "t".repeat(32) } }),
    );
    await page.goto(origin, { waitUntil: "domcontentloaded" });
    await page.locator('.case-tab[data-case="own"]').click();
    const file = (name) => ({
      name,
      mimeType: "text/markdown",
      buffer: Buffer.from(
        "A bounded queue pauses producers while consumers catch up. Checkpoints preserve progress after a restart. Each worker owns a partition lease.",
      ),
    });
    await page.locator("#files").setInputFiles(file("original.md"));
    await page
      .locator("#upl-list li")
      .filter({ hasText: "Ready" })
      .first()
      .waitFor({ timeout: 45000 });
    await page.locator("#call-btn").waitFor();
    const old = await page.evaluate(() => sessionStorage.getItem("vm_ws"));
    let first = true,
      release,
      observed;
    const gate = new Promise((r) => (release = r));
    const checked = new Promise((r) => (observed = r));
    await page.route("**/api/public/workspace/" + old, async (route) => {
      if (first) {
        first = false;
        observed();
        await gate;
        await route.fulfill({
          status: staleStatus,
          contentType: "application/json",
          body:
            staleStatus === 404
              ? '{"error":"expired"}'
              : '{"ready":true,"documents":[]}',
        });
      } else
        await route.fulfill({
          status: 404,
          contentType: "application/json",
          body: '{"error":"expired"}',
        });
    });
    await page.locator("#call-btn").click();
    await checked;
    await page.locator("#files").setInputFiles(file("replacement.md"));
    await page
      .locator("#upl-list li")
      .filter({ hasText: "replacement.md" })
      .filter({ hasText: "Ready" })
      .waitFor({ timeout: 45000 });
    const current = await page.evaluate(() => sessionStorage.getItem("vm_ws"));
    assert.notEqual(current, old);
    assert.ok(current);
    release();
    await page.waitForTimeout(300);
    assert.equal(
      await page.evaluate(() => sessionStorage.getItem("vm_ws")),
      current,
      "late call check cannot clear the replacement workspace",
    );
    assert.equal(
      await page.evaluate(() => window.__micCalls),
      0,
      "changed workspace is rechecked before microphone/mint",
    );
    assert.equal(await page.evaluate(() => window.__callStarts), 0);
    await page.locator("#q").fill("What does the bounded queue do?");
    await page.locator(".ask-go").click();
    await page.locator("#answer .a-lead").waitFor();
    assert.ok((await page.locator("[data-cite]").count()) > 0);
    console.log(
      "PASS stale call check " +
        staleStatus +
        " preserves replacement documents and starts no call",
    );
    await page.close();
  }
} finally {
  await browser.close();
  dev.kill();
}
