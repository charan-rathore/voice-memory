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
      }
      on(k, fn) {
        this.h[k] = fn;
      }
      async start() {
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
  await page.route("**/api/public/voice/session", (r) =>
    r.fulfill({ json: { vm_ticket: "1".repeat(32) } }),
  );
  await page.route("**/api/public/voice/turns?*", (r) =>
    r.fulfill({ json: { turns: [] } }),
  );
  let releaseOld, oldSeen;
  const gate = new Promise((r) => (releaseOld = r)),
    scopeRequested = new Promise((r) => (oldSeen = r));
  let first = true;
  const scopes = [];
  await page.route("**/api/public/voice/scope", async (route) => {
    const body = JSON.parse(route.request().postData());
    scopes.push(body);
    if (first) {
      first = false;
      oldSeen();
      await gate;
      await route.fulfill({ status: 404, json: { error: "expired" } });
    } else await route.fulfill({ json: { case: body.case } });
  });
  await page.goto(origin, { waitUntil: "domcontentloaded" });
  await page.locator('.case-tab[data-case="own"]').click();
  const upload = async (name) => {
    await page.locator("#files").setInputFiles({
      name,
      mimeType: "text/markdown",
      buffer: Buffer.from(
        "A bounded queue pauses producers while consumers catch up. Checkpoints preserve progress after a restart. Each worker owns a partition lease.",
      ),
    });
    await page
      .locator("#upl-list li")
      .filter({ hasText: name })
      .filter({ hasText: "Ready" })
      .waitFor({ timeout: 45000 });
    return page.evaluate(() => sessionStorage.getItem("vm_ws"));
  };
  const a = await upload("first.md");
  await page.locator("#call-btn").waitFor();
  await page.locator("#call-btn").click();
  await page.locator("#call-label").filter({ hasText: "Hang up" }).waitFor();
  await page.route("**/api/public/workspace/" + a, (r) =>
    r.fulfill({ status: 404, json: { error: "expired" } }),
  );
  const b = await upload("second.md");
  await scopeRequested;
  await page.route("**/api/public/workspace/" + b, (r) =>
    r.fulfill({ status: 404, json: { error: "expired" } }),
  );
  const c = await upload("third.md");
  assert.notEqual(c, b);
  assert.equal(scopes.at(-1)?.case, c);
  releaseOld();
  await page.waitForTimeout(250);
  assert.equal(
    await page.evaluate(() => sessionStorage.getItem("vm_ws")),
    c,
    "old failed scope response cannot erase the newer workspace",
  );
  assert.equal(await page.locator("#call-label").textContent(), "Hang up");
  await page.locator("#q").fill("What does the bounded queue do?");
  await page.locator(".ask-go").click();
  await page.locator("#answer .a-lead").waitFor();
  assert.ok((await page.locator("[data-cite]").count()) > 0);
  console.log(
    "PASS late rejected scope update preserves the newest uploaded workspace and active call",
  );
} finally {
  await browser.close();
  dev.kill();
}
