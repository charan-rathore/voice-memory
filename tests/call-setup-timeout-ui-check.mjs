import { chromium } from "playwright";
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
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
  for (const mode of process.env.VM_SETUP_MODE
    ? [process.env.VM_SETUP_MODE]
    : [
        "pending-mic",
        "pending-enumeration",
        "pending-sdk",
        "resolved-no-event",
      ]) {
    const page = await browser.newPage();
    await page.addInitScript((mode) => {
      window.__instances = [];
      window.__stops = 0;
      window.__deadline = new Map();
      let id = 800000;
      const set = window.setTimeout.bind(window),
        clear = window.clearTimeout.bind(window);
      window.setTimeout = (fn, delay, ...args) => {
        if (delay === 90000) {
          const k = ++id;
          window.__deadline.set(k, () => fn(...args));
          return k;
        }
        return set(fn, delay, ...args);
      };
      window.clearTimeout = (k) => {
        if (!window.__deadline.delete(k)) clear(k);
      };
      window.__expire = () => {
        const fs = [...window.__deadline.values()];
        window.__deadline.clear();
        fs.forEach((f) => f());
      };
      window.__late = null;
      let first = true;
      Object.defineProperty(navigator, "mediaDevices", {
        configurable: true,
        value: {
          getUserMedia: async () => {
            const stream = {
              getTracks: () => [
                {
                  stop() {
                    window.__stops++;
                  },
                },
              ],
            };
            if (mode === "pending-mic" && first) {
              first = false;
              return new Promise((r) => (window.__late = () => r(stream)));
            }
            return stream;
          },
          enumerateDevices: async () => {
            if (mode === "pending-enumeration" && first) {
              first = false;
              return new Promise((r) => (window.__late = () => r([])));
            }
            return [];
          },
        },
      });
      window.BolnaWebCall = class {
        constructor(opts) {
          this.opts = opts;
          this.h = {};
          this.stops = 0;
          window.__instances.push(this);
        }
        on(k, f) {
          this.h[k] = f;
        }
        async start() {
          await this.opts.getSession();
          if (mode === "pending-sdk" && first) {
            first = false;
            await new Promise((r) => (window.__late = () => r()));
          }
          if (mode === "resolved-no-event" && first) {
            first = false;
            window.__late = () => this.h["call-start"]?.();
            return;
          }
          this.h["call-start"]?.();
        }
        stop() {
          this.stops++;
          this.h["call-end"]?.({ reason: "hangup" });
        }
      };
    }, mode);
    await page.route("**/api/public/status", async (r) => {
      const response = await r.fetch();
      const body = await response.json();
      body.voice = { configured: true, ready: true };
      await r.fulfill({ response, json: body });
    });
    let mints = 0;
    await page.route("**/api/public/voice/session", (r) =>
      r.fulfill({ json: { vm_ticket: String(++mints).repeat(32) } }),
    );
    await page.route("**/api/public/voice/turns?*", (r) =>
      r.fulfill({ json: { turns: [] } }),
    );
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    if (process.env.VM_BASELINE_SITE) {
      const baseline = await readFile(process.env.VM_BASELINE_SITE, "utf8");
      await page.route("**/site.js", (r) =>
        r.fulfill({ contentType: "text/javascript", body: baseline }),
      );
    }
    await page.goto(origin, { waitUntil: "domcontentloaded" });
    await page.locator("#call-btn").waitFor();
    await page.locator("#call-btn").click();
    await page.waitForFunction(() => typeof window.__late === "function");
    await page.evaluate(() => window.__expire());
    await page.waitForTimeout(50);
    assert.match(
      await page.locator("#call-state").innerText(),
      /timed out/i,
      mode + " must recover",
    );
    assert.equal(
      await page.locator("#call-label").textContent(),
      "Call Voice Memory",
    );
    if (mode === "pending-mic") {
      await page.locator("#call-state").scrollIntoViewIfNeeded();
      await page.screenshot({
        path: join(shots, "call-timeout-recovered.png"),
      });
    }
    await page.locator("#call-btn").click();
    await page.locator("#call-label").filter({ hasText: "Hang up" }).waitFor();
    const before = mints;
    await page.evaluate(() => window.__expire());
    assert.equal(
      await page.locator("#call-label").textContent(),
      "Hang up",
      "live call cancels setup deadline",
    );
    await page.evaluate(() => window.__late());
    await page.waitForTimeout(100);
    assert.equal(mints, before, "late preflight must not mint another call");
    assert.equal(
      await page.locator("#call-label").textContent(),
      "Hang up",
      "late result cannot alter replacement call",
    );
    assert.deepEqual(errors, []);
    if (mode === "pending-mic") {
      await page.locator("#call-state").scrollIntoViewIfNeeded();
      await page.screenshot({
        path: join(shots, "call-timeout-retry-live.png"),
      });
    }
    await page.locator("#call-btn").click();
    console.log(
      "PASS " + mode + " expires, retries, and ignores late settlement",
    );
    await page.close();
  }
} finally {
  await browser.close();
  dev.kill();
}
