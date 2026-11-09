// Local assertion-only fixture. No actual provider, secret or paid voice.
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import assert from "node:assert/strict";
import { chromium } from "playwright";
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
    name: "Assertions.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("Debt ledger\nArjun owes $1,500.\nNimbus owes $5,000."),
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
  mkdirSync("/downloads", { recursive: true });
  await ask("How much does Arjun owe?");
  assert.equal(
    await page.locator("#answer .verdict-chip").innerText(),
    "quoted",
  );
  assert.match(await page.locator("#answer").innerText(), /Arjun owes \$1,500/);
  await ask("How much does Arjun not owe?");
  assert.equal(
    await page.locator("#answer .verdict-chip").innerText(),
    "Answer not established",
  );
  assert.match(
    await page.locator("#answer").innerText(),
    /related evidence, not an answer/,
  );
  await page
    .locator("#answer")
    .screenshot({ path: "/downloads/voice-memory-debt-polarity-mobile.png" });
  console.log(
    "PASS exact debt positives retained, negative amount refuses with related evidence;320px. No providers.",
  );
} finally {
  await browser?.close();
  dev.kill("SIGTERM");
}
