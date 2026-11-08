// Real local upload/browser flow, provider-free bounded schema fixtures.
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { chromium } from "playwright";
const shots =
  process.env.VM_SHOTS_DIR || join(tmpdir(), "voice-memory-exact-field-shots");
mkdirSync(shots, { recursive: true });
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
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.goto("http://127.0.0.1:4500/");
  await page.locator('.case-tab[data-case="own"]').click();
  const upload = async (name, text) => {
    await page.locator("#files").setInputFiles({
      name,
      mimeType: "text/plain",
      buffer: Buffer.from(text),
    });
    await page.waitForFunction(() => {
      const items = [...document.querySelectorAll("#upl-list li")];
      return items.length > 0 && items.every((x) => /Ready/.test(x.innerText));
    });
  };
  const ask = async () => {
    await page
      .locator("#q")
      .fill("What are the handling window and approval status?");
    await page.locator(".ask-go").click();
    await page.waitForFunction(
      () => !document.querySelector(".ask-go").disabled,
    );
    await page.locator("#answer").evaluate(async (el) => {
      await Promise.all(
        el
          .getAnimations({ subtree: true })
          .map((a) => a.finished.catch(() => {})),
      );
    });
    assert.equal(
      await page
        .locator("#answer")
        .evaluate((el) => el.scrollWidth <= el.clientWidth),
      true,
    );
  };
  await upload(
    "schema.txt",
    "Draft policy; applicability conditions remain unresolved.\n| Field | Value |\n|---|---|\n| Handling window | 19 working days |\n| Approval status | Proposed, not approved |",
  );
  await ask();
  assert.match(await page.locator("#answer").innerText(), /19 working days/);
  assert.match(
    await page.locator("#answer").innerText(),
    /Proposed, not approved/,
  );
  await page
    .locator("#answer")
    .screenshot({ path: join(shots, "exact-fields-positive-mobile.png") });
  await upload(
    "conflict.txt",
    "| Field | Value |\n| Handling window | 7 days |",
  );
  await ask();
  assert.match(
    await page.locator("#answer").innerText(),
    /conflicting table values/,
  );
  assert.match(
    await page.locator("#answer").innerText(),
    /Proposed, not approved/,
  );
  assert.equal(
    await page.locator("#answer .verdict-chip").innerText(),
    "Partial answer",
  );
  assert.equal(
    await page
      .locator("#answer .verdict-chip")
      .evaluate((el) => el.classList.contains("v-warn")),
    true,
  );
  await page
    .locator("#answer")
    .screenshot({ path: join(shots, "exact-fields-partial-mobile.png") });
  console.log(
    `PASS bounded exact fields, complete and partial with source conflict; screenshots ${shots}. No provider calls.`,
  );
} finally {
  await browser?.close();
  dev.kill("SIGTERM");
}
