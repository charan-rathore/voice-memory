import { chromium } from "playwright";
import assert from "node:assert/strict";
import { writeFile, mkdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
const shotsDir =
  process.env.VM_SHOTS_DIR || join(tmpdir(), "voice-memory-shots");
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
  for (const pending of [false, true]) {
    const page = await browser.newPage();
    await page.addInitScript((pending) => {
      const set = window.setTimeout.bind(window);
      window.__expire = null;
      window.__started = false;
      window.setTimeout = (fn, ms, ...args) =>
        ms === 90000
          ? ((window.__expire = () => fn(...args)), 900001)
          : set(fn, ms, ...args);
      window.__stops = 0;
      window.__tracksStopped = 0;
      Object.defineProperty(navigator, "mediaDevices", {
        configurable: true,
        value: {
          getUserMedia: async () => ({
            getTracks: () => [
              {
                stop() {
                  window.__tracksStopped++;
                },
              },
            ],
          }),
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
          await this.opts.getSession();
          window.__started = true;
          if (pending) return new Promise(() => {});
          this.h["call-start"]?.();
        }
        stop() {
          window.__stops++;
          this.h["call-end"]?.({ reason: "hangup" });
        }
      };
    }, pending);
    let ready = true,
      status = 0,
      mints = 0;
    await page.route("**/api/public/status", async (route) => {
      const r = await route.fetch();
      const b = await r.json();
      b.voice = { configured: true, ready };
      status++;
      await route.fulfill({ response: r, json: b });
    });
    await page.route("**/api/public/voice/session", (r) => {
      mints++;
      return r.fulfill({ json: { vm_ticket: "t".repeat(32) } });
    });
    await page.route("**/api/public/voice/turns?*", (r) =>
      r.fulfill({ json: { turns: [] } }),
    );
    await page.goto(origin, { waitUntil: "domcontentloaded" });
    await page.locator("#call-btn").click();
    await page.waitForFunction(() => window.__started);
    if (!pending)
      await page.locator("#call-label", { hasText: "Hang up" }).waitFor();
    ready = false;
    const before = status;
    await page.evaluate(() =>
      document.dispatchEvent(new Event("visibilitychange")),
    );
    await page.waitForFunction(() => !document.hidden);
    for (let i = 0; status === before && i < 50; i++)
      await page.waitForTimeout(20);
    assert.ok(status > before, "tab return status probe occurred");
    await page.waitForTimeout(100);
    assert.ok(
      await page.locator("#call-btn").isVisible(),
      "active call hangup must remain visible when ready becomes false",
    );
    if (!pending)
      assert.match(await page.locator("#call-label").innerText(), /Hang up/);
    await page.locator(".callbar").screenshot({
      path: pending
        ? join(shotsDir, "vm-active-pending-preserved.png")
        : join(shotsDir, "vm-active-hangup-preserved.png"),
    });
    if (pending) await page.evaluate(() => window.__expire());
    else await page.locator("#call-btn").click();
    await page.waitForFunction(() => window.__stops === 1);
    await page.locator("#call-btn").waitFor({ state: "hidden" });
    assert.equal(await page.locator(".voice-off").isVisible(), true);
    assert.equal(mints, 1);
    assert.equal(await page.evaluate(() => window.__stops), 1);
    assert.equal(
      await page.evaluate(() => window.__tracksStopped),
      1,
      "preflight mic track released",
    );
    console.log(
      pending
        ? "PASS ready=false pending SDK timeout stops owned stub, clears gate, releases preflight track"
        : "PASS active call retains reachable Hang up after ready=false; click stops stub once and disabled gate hides new-call UI; one intercepted session, no provider calls",
    );
    await page.close();
  }
} finally {
  await browser.close();
  dev.kill();
}
