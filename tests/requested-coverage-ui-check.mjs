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
    name: "Shipment.txt",
    mimeType: "text/plain",
    buffer: Buffer.from(
      "Order PK-101\nTracking number: TRK-8273\nReceiver: Maya Rao\nShipment weight: 17 kg\nShipment dispatch status: pending carrier collection.",
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
  mkdirSync("/downloads", { recursive: true });
  await ask("Who received order PK-101 and what is its tracking number?");
  const answer = page.locator("#answer");
  assert.equal(
    await answer.locator(".verdict-chip").innerText(),
    "Answer not established",
  );
  assert.match(await answer.innerText(), /coverage of the whole request/);
  assert.match(await answer.innerText(), /Related evidence, not an answer/);
  assert.match(await answer.innerText(), /Maya Rao|TRK-8273/);
  await answer.screenshot({
    path: "/downloads/voice-memory-requested-coverage-mobile.png",
  });
  await ask("What is the tracking number for order PK-101?");
  assert.match(await answer.innerText(), /TRK-8273/);
  assert.doesNotMatch(
    await answer.innerText(),
    /coverage of the whole request/,
  );
  console.log(
    "PASS unresolved whole-request coverage and labelled related evidence; standalone positive retained;320px screenshot. No provider calls.",
  );
} finally {
  await browser?.close();
  dev.kill("SIGTERM");
}
