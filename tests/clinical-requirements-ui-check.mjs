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
  await page.locator('.case-tab[data-case="health"]').click();
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
  await ask("What are SYN-0001's ferritin and sodium results?");
  const answer = page.locator("#answer");
  assert.equal(
    await answer.locator(".verdict-chip").innerText(),
    "Partial answer",
  );
  assert.match(await answer.innerText(), /50 ng\/mL/);
  assert.match(await answer.innerText(), /sodium: I could not establish/);
  await answer.screenshot({
    path: "/downloads/voice-memory-clinical-requirements-partial-mobile.png",
  });
  await ask("What are SYN-0001's ferritin and TSH results?");
  assert.equal(
    await answer.locator(".verdict-chip").innerText(),
    "Requested test results",
  );
  assert.match(await answer.innerText(), /50 ng\/mL/);
  assert.match(await answer.innerText(), /0\.30 mIU\/L/);
  await answer.screenshot({
    path: "/downloads/voice-memory-clinical-requirements-complete-mobile.png",
  });
  console.log(
    "PASS explicit single-ID multi-test coverage; positive Ferritin/TSH, missing Sodium partial;320px screenshots. No providers.",
  );
} finally {
  await browser?.close();
  dev.kill("SIGTERM");
}
