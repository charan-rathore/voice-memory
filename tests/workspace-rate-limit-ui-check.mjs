import { chromium } from "playwright";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
const port = 4793;
const shots = process.env.VM_SHOTS_PREFIX || "/tmp/workspace-rate-limit";
const dev = spawn(process.execPath, ["scripts/site-dev.mjs"], {
  stdio: "ignore",
  env: {
    ...process.env,
    SITE_PORT: String(port),
    VM_DENSE: "off",
    VM_GEMINI: "off",
    VM_RSS_WATCHDOG: "off",
  },
});
let browser;
try {
  for (let i = 0; i < 80; i++) {
    if (
      await fetch(`http://127.0.0.1:${port}`)
        .then((r) => r.ok)
        .catch(() => false)
    )
      break;
    await new Promise((r) => setTimeout(r, 100));
  }
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.CHROME_PATH,
    args: ["--no-sandbox"],
  });
  const page = await browser.newPage({
    viewport: { width: 1280, height: 1000 },
  });
  let attempts = 0;
  await page.route("**/api/public/workspace", (r) => {
    attempts++;
    return r.fulfill({
      status: 429,
      headers: { "retry-after": "3600" },
      contentType: "application/json",
      body: JSON.stringify({
        error: "Too many new workspaces. Try again later.",
      }),
    });
  });
  await page.goto(`http://127.0.0.1:${port}`);
  await page.locator('.case-tab[data-case="own"]').click();
  await page.locator("#files").setInputFiles({
    name: "synthetic-retry.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("Synthetic invoice. Amount 42."),
  });
  await page.locator("#upl-list .upl-st.bad").waitFor({ timeout: 30000 });
  await page.locator("#upl-flow .rd").waitFor();
  await page.locator("#upl-flow").scrollIntoViewIfNeeded();
  await page.screenshot({ path: shots + "-desktop.png" });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator("#upl-flow").scrollIntoViewIfNeeded();
  await page.screenshot({ path: shots + "-phone.png" });
  const upload = await page.locator("#upl-list").innerText();
  const reading = await page.locator("#upl-flow").innerText();
  console.log(JSON.stringify({ attempts, upload, reading }));
  assert.match(upload, /Too many new workspaces/);
  assert.doesNotMatch(upload, /waking up/);
  assert.equal(attempts, 1, "429 must not be retried automatically");
  assert.equal(
    await page.locator('[data-step="answer"]').getAttribute("data-state"),
    "bad",
  );
  assert.match(reading, /Not ready to ask/);
  assert.match(reading, /Not received/);
  assert.equal(
    await page.locator('[data-step="received"]').getAttribute("data-state"),
    "bad",
  );
  assert.doesNotMatch(reading, /Answers are live|inside the 2-minute budget/);
  console.log("workspace429 UI PASS");
} finally {
  await browser?.close();
  dev.kill();
}
