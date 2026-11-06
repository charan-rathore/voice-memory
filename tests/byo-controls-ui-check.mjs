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
  for (const mode of [
    "clear-pending",
    "scope-pending",
    "scope-aba-pending",
    "clear-failed-pending",
    "empty-own",
    "revoke-failure",
    "copy-denied",
    "display-switch",
  ]) {
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    let minted = 0,
      deleted = 0,
      release;
    const held = new Promise((r) => (release = r));
    await page.route("**/api/public/status", async (route) => {
      const response = await route.fetch();
      const data = await response.json();
      data.byoVoice = { enabled: true };
      await route.fulfill({ response, json: data });
    });
    await page.route("**/api/public/llm/key", async (route) => {
      if (route.request().method() === "DELETE") {
        deleted++;
        return route.fulfill({
          status:
            ["revoke-failure", "clear-failed-pending"].includes(mode) &&
            deleted === 1
              ? 503
              : 200,
          json: { revoked: true },
        });
      }
      minted++;
      const scope = route.request().postDataJSON().case;
      if (mode.endsWith("pending")) await held;
      await route.fulfill({
        json: {
          apiKey: "a".repeat(64),
          baseUrl: origin + "/api/public/llm/v1",
          model: "voice-memory",
          scope,
          expiresAt: Date.now() + 60000,
        },
      });
    });
    await page.goto(origin, { waitUntil: "domcontentloaded" });
    await page.locator("#byo summary").click();
    await page.locator("#byo-llm-get").waitFor();
    if (mode === "empty-own")
      await page.locator('.case-tab[data-case="own"]').click();
    await page.locator("#byo-llm-get").click();
    if (mode.endsWith("pending")) {
      await page.waitForFunction(
        () => document.querySelector("#byo-llm-get").disabled,
      );
      while (!minted) await new Promise((r) => setTimeout(r, 10));
      if (mode.startsWith("clear-")) await page.locator("#byo-clear").click();
      else await page.locator('.case-tab[data-case="deal"]').click();
      if (mode === "scope-aba-pending")
        await page.locator('.case-tab[data-case="health"]').click();
      release();
      await page.waitForFunction(
        () => !document.querySelector("#byo-llm-get").disabled,
      );
      assert.equal(
        await page.locator("#byo-llm").isVisible(),
        false,
        mode + ": stale key stays hidden",
      );
      assert.equal(
        await page.locator('[data-k="key"]').textContent(),
        "",
        mode + ": no residual token",
      );
      await page.waitForTimeout(100);
      assert.equal(deleted, 1, mode + ": orphan revoked");
      if (mode === "clear-failed-pending") {
        assert.match(
          await page.locator("#byo-feedback").textContent(),
          /pending|retry/i,
        );
        await page.locator("#byo-clear").click();
        await page.waitForTimeout(150);
        assert.equal(deleted, 2, "late orphan revocation failure is retryable");
      }
    } else if (mode === "empty-own") {
      await page.waitForFunction(
        () => !document.querySelector("#byo-llm-get").disabled,
      );
      assert.equal(minted, 0, "empty upload view must not mint demo key");
    } else {
      await page.locator("#byo-llm").waitFor({ state: "visible" });
      assert.match(
        await page.locator('[data-k="scope"]').textContent(),
        /Lab report demo/,
      );
      if (mode === "display-switch") {
        await page.locator('.case-tab[data-case="deal"]').click();
        assert.equal(await page.locator("#byo-llm").isVisible(), false);
        assert.equal(await page.locator('[data-k="key"]').textContent(), "");
      } else if (mode === "revoke-failure") {
        await page.locator("#byo-clear").click();
        await page.waitForTimeout(150);
        assert.match(
          await page.locator("#byo-feedback").textContent(),
          /pending|retry|could not/i,
        );
        await page.locator("#byo-clear").click();
        await page.waitForTimeout(150);
        assert.equal(deleted, 2, "failed revocation remains retryable");
      } else {
        await page.evaluate(() =>
          Object.defineProperty(navigator, "clipboard", {
            configurable: true,
            value: {
              writeText: async () => {
                throw Error("clipboard denied");
              },
            },
          }),
        );
        await page.locator("[data-copy]").first().click();
        await page.waitForTimeout(100);
        assert.match(
          await page.locator("#byo-feedback").textContent(),
          /manually|select|copy/i,
        );
        assert.deepEqual(errors, []);
      }
    }
    results.push({ mode, pass: true });
    await page.close();
  }
  console.log(JSON.stringify(results));
} finally {
  await browser.close();
  dev.kill();
}
