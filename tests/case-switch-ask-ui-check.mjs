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
  for (const outcome of ["success", "failure"]) {
    const page = await browser.newPage();
    if (process.env.VM_BASELINE_SITE) {
      const baseline = await readFile(process.env.VM_BASELINE_SITE, "utf8");
      await page.route("**/site.js", (r) =>
        r.fulfill({ contentType: "text/javascript", body: baseline }),
      );
    }
    await page.route("**/api/public/status", async (r) => {
      const response = await r.fetch();
      const body = await response.json();
      body.cases = { health: true, deal: true, ...body.cases };
      await r.fulfill({ response, json: body });
    });
    let release, seen;
    const gate = new Promise((r) => (release = r)),
      started = new Promise((r) => (seen = r));
    let asks = 0;
    await page.route("**/api/public/answer?*", async (r) => {
      const n = ++asks;
      if (n === 1) {
        seen();
        await gate;
        if (outcome === "failure")
          return r.fulfill({ status: 503, json: { error: "OLD-CASE-ERROR" } });
      }
      return r.fulfill({
        json: {
          lead: {
            text: n === 1 ? "OLD-CASE-ANSWER" : "NEW-CASE-ANSWER",
            verdict: "LATEST",
            citations: [],
          },
        },
      });
    });
    await page.goto(origin, { waitUntil: "domcontentloaded" });
    await page
      .waitForFunction(
        () =>
          document.querySelector("#engine-note")?.textContent?.includes("Live"),
        null,
        { timeout: 10000 },
      )
      .catch(() => {});
    await page.locator("#q").fill("Which fact changed?");
    await page.locator(".ask-go").click();
    await started;
    await page.locator('.case-tab[data-case="deal"]').click();
    assert.equal(
      await page.locator(".ask-go").isEnabled(),
      true,
      "case switch releases the old submit lock",
    );
    await page.locator("#q").fill("What is the current agreement?");
    await page.locator(".ask-go").click();
    await page
      .locator("#answer")
      .filter({ hasText: "NEW-CASE-ANSWER" })
      .waitFor();
    release();
    await page.waitForTimeout(150);
    assert.doesNotMatch(await page.locator("#answer").innerText(), /OLD-CASE/);
    assert.equal(await page.locator(".ask-go").isEnabled(), true);
    console.log(
      "PASS case switch during " +
        outcome +
        " allows next ask and rejects stale result",
    );
    await page.close();
  }
} finally {
  await browser.close();
  dev.kill();
}
