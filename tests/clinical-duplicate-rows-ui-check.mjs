// Local assertion-only fixture. No actual provider, secret or paid voice.
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import assert from "node:assert/strict";
import { chromium } from "playwright";
const shotsDir =
  process.env.VM_SHOTS_DIR || join(tmpdir(), "voice-memory-shots");
const dev = spawn("node", ["scripts/site-dev.mjs"], {
  stdio: "ignore",
  env: {
    ...process.env,
    VM_GEMINI: "off",
    VM_DOCUMENT_REASONING: "off",
    VM_DENSE: "off",
    VM_PARSE_IDLE_MS: "1000",
  },
});
let browser;
try {
  for (let i = 0; i < 100; i++) {
    if (
      await fetch("http://127.0.0.1:4500/")
        .then((r) => r.ok)
        .catch(() => false)
    )
      break;
    await new Promise((r) => setTimeout(r, 100));
  }
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.CHROME_PATH || "/usr/bin/google-chrome",
    args: ["--no-sandbox"],
  });
  const page = await browser.newPage({
    viewport: { width: 320, height: 1000 },
  });
  await page.goto("http://127.0.0.1:4500/");
  await page.locator('.case-tab[data-case="own"]').click();
  await page.locator("#files").setInputFiles({
    name: "Duplicate.txt",
    mimeType: "text/plain",
    buffer: Buffer.from(
      "Patient: Asha Sinha, ID AX-113\nCollected: 10 October 2026\nReport status: FINAL\nTest Name    Results    Units    Reference range\nTSH    1.10    mIU/L    0.4 - 4.0\nTSH    9.90    mIU/L    0.4 - 4.0\n",
    ),
  });
  await page.locator("#upl-list li", { hasText: "Ready" }).first().waitFor();
  const ask = async (q) => {
    await page.locator("#q").fill(q);
    await page.locator(".ask-go").click();
    await page.waitForFunction(
      () => !document.querySelector(".ask-go").disabled,
    );
    await page
      .locator("#answer")
      .evaluate(async (el) =>
        Promise.all(
          el
            .getAnimations({ subtree: true })
            .map((a) => a.finished.catch(() => {})),
        ),
      );
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= 320),
      true,
    );
  };
  mkdirSync(shotsDir, { recursive: true });
  await ask("What is AX-113's TSH result?");
  const text = await page.locator("#answer").innerText();
  assert.match(text, /conflict/i);
  assert.doesNotMatch(text, /corrected from|result is 9.90/);
  await page.locator("#answer").screenshot({
    path: join(shotsDir, "voice-memory-clinical-duplicate-rows-mobile.png"),
  });
  console.log(
    "PASS same-unit duplicate values refuse first-row selection;320px. No providers.",
  );
} finally {
  await browser?.close();
  dev.kill("SIGTERM");
}
