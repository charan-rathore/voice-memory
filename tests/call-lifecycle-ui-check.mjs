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
  const modes = process.env.VM_LIFECYCLE_MODE
    ? [process.env.VM_LIFECYCLE_MODE]
    : ["old-event", "old-poll", "old-success", "old-timer", "pending-session"];
  for (const mode of modes) {
    const page = await browser.newPage();
    await page.addInitScript(() => {
      window.__instances = [];
      window.__expiry = new Map();
      let timerId = 900000;
      const set = window.setTimeout.bind(window),
        clear = window.clearTimeout.bind(window);
      window.setTimeout = (fn, delay, ...args) => {
        if (delay === 20000) {
          const id = ++timerId;
          window.__expiry.set(id, () => fn(...args));
          return id;
        }
        return set(fn, delay, ...args);
      };
      window.clearTimeout = (id) => {
        if (!window.__expiry.delete(id)) clear(id);
      };
      window.__runExpiry = () => {
        const callbacks = [...window.__expiry.values()];
        window.__expiry.clear();
        callbacks.forEach((fn) => fn());
      };
      Object.defineProperty(navigator, "mediaDevices", {
        configurable: true,
        value: {
          getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }),
          enumerateDevices: async () => [],
        },
      });
      window.BolnaWebCall = class {
        constructor(opts) {
          this.opts = opts;
          this.h = {};
          this.stops = 0;
          window.__instances.push(this);
        }
        on(k, fn) {
          this.h[k] = fn;
        }
        async start() {
          await this.opts.getSession();
          this.h["call-start"]?.();
        }
        stop() {
          this.stops++;
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
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    let releaseMint, mintSeen;
    const mintGate = new Promise((r) => (releaseMint = r)),
      firstMint = new Promise((r) => (mintSeen = r));
    const scopes = [];
    await page.route("**/api/public/voice/session", async (route) => {
      const mint = ++mints;
      if (mode === "pending-session" && mint === 1) {
        mintSeen();
        await mintGate;
      }
      return route.fulfill({ json: { vm_ticket: String(mint).repeat(32) } });
    });
    await page.route("**/api/public/voice/scope", (route) => {
      const body = JSON.parse(route.request().postData());
      scopes.push(body);
      return route.fulfill({ json: { case: body.case } });
    });
    let releaseOld, oldSeen;
    const oldGate = new Promise((r) => (releaseOld = r)),
      oldRequested = new Promise((r) => (oldSeen = r));
    await page.route("**/api/public/voice/turns?*", async (route) => {
      if (
        ["old-poll", "old-success"].includes(mode) &&
        new URL(route.request().url()).searchParams.get("ticket") ===
          "1".repeat(32)
      ) {
        oldSeen();
        await oldGate;
        if (mode === "old-poll")
          await route.fulfill({ status: 403, json: { error: "ended" } });
        else
          await route.fulfill({
            json: {
              turns: [
                {
                  at: 1,
                  case: "health",
                  question: "OLD-CALL-A-TRANSCRIPT",
                  lead: {
                    text: "OLD-CALL-A-ANSWER",
                    verdict: "LATEST",
                    field: "SYN-0001 Ferritin",
                    citations: [],
                  },
                },
              ],
            },
          });
      } else await route.fulfill({ json: { turns: [] } });
    });
    await page.goto(origin, { waitUntil: "domcontentloaded" });
    await page.locator("#call-btn").waitFor();
    await page.locator("#call-btn").click();
    if (mode === "pending-session") await firstMint;
    else
      await page
        .locator("#call-label")
        .filter({ hasText: "Hang up" })
        .waitFor();
    if (["old-poll", "old-success"].includes(mode)) await oldRequested;
    await page.locator("#call-btn").click();
    await page
      .locator("#call-label")
      .filter({ hasText: "Call Voice Memory" })
      .waitFor();
    await page.locator("#call-btn").click();
    await page.locator("#call-label").filter({ hasText: "Hang up" }).waitFor();
    assert.equal(mints, 2);
    if (mode === "old-event")
      await page.evaluate(() =>
        window.__instances[0].h["call-end"]({ reason: "late" }),
      );
    if (["old-poll", "old-success"].includes(mode)) releaseOld();
    if (mode === "pending-session") releaseMint();
    if (mode === "old-timer") await page.evaluate(() => window.__runExpiry());
    await page.waitForTimeout(200);
    assert.equal(
      await page.locator("#call-label").textContent(),
      "Hang up",
      mode + " cannot end the replacement call",
    );
    assert.equal(await page.evaluate(() => window.__instances[1].stops), 0);
    assert.doesNotMatch(
      await page.locator("#answer").innerText(),
      /OLD-CALL-A/,
    );
    assert.deepEqual(errors, []);
    await page.locator('.case-tab[data-case="deal"]').click();
    await page.waitForTimeout(150);
    assert.equal(
      scopes.at(-1)?.ticket,
      "2".repeat(32),
      mode + " preserves the new ticket and scope synchronization",
    );
    console.log(
      "PASS " + mode + " cannot alter the replacement call or its ticket",
    );
    await page.close();
  }
} finally {
  await browser.close();
  dev.kill();
}
