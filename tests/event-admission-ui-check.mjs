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
    buffer: Buffer.from(
      "Arjun paid $1,500 to Nimbus.\nPriya approved the commercial scope.\nKamal did not sign the delivery plan.",
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
  await ask("Did Arjun pay $1,500 to Nimbus?");
  assert.equal(
    await page.locator("#answer .verdict-chip").innerText(),
    "Recorded source assertion",
  );
  assert.match(
    await page.locator("#answer").innerText(),
    /Arjun paid \$1,500 to Nimbus/,
  );
  await page
    .locator("#answer")
    .screenshot({ path: "/downloads/voice-memory-event-positive-mobile.png" });
  await ask(
    "Did Arjun pay $1,500 to Nimbus and did Priya sign the commercial scope?",
  );
  assert.equal(
    await page.locator("#answer .verdict-chip").innerText(),
    "Partial answer",
  );
  assert.match(await page.locator("#answer").innerText(), /Did Priya sign/);
  assert.match(
    await page.locator("#answer").innerText(),
    /could not establish/,
  );
  await page
    .locator("#answer")
    .screenshot({ path: "/downloads/voice-memory-event-partial-mobile.png" });
  await ask("Did Priya sign the commercial scope?");
  assert.equal(
    await page.locator("#answer .verdict-chip").innerText(),
    "Answer not established",
  );
  assert.equal(await page.locator("#answer .cites .cite").count(), 0);
  await page.locator("#answer").screenshot({
    path: "/downloads/voice-memory-event-unsupported-mobile.png",
  });
  await ask("Who approved the commercial scope?");
  assert.equal(
    await page.locator("#answer .verdict-chip").innerText(),
    "Recorded source assertion",
  );
  assert.match(
    await page.locator("#answer").innerText(),
    /The source names Priya/,
  );
  await page
    .locator("#answer")
    .screenshot({ path: "/downloads/voice-memory-event-actor-mobile.png" });
  await ask("Who signed the commercial scope?");
  assert.equal(
    await page.locator("#answer .verdict-chip").innerText(),
    "Answer not established",
  );
  await page.locator("#answer").screenshot({
    path: "/downloads/voice-memory-event-actor-unresolved-mobile.png",
  });
  await ask("How much did Arjun pay to Nimbus?");
  assert.match(
    await page.locator("#answer").innerText(),
    /The source records \$1,500/,
  );
  await page
    .locator("#answer")
    .screenshot({ path: "/downloads/voice-memory-event-amount-mobile.png" });
  await ask(
    "How much did Arjun pay to Nimbus and how much did Arjun owe to Nimbus?",
  );
  assert.equal(
    await page.locator("#answer .verdict-chip").innerText(),
    "Partial answer",
  );
  assert.match(
    await page.locator("#answer").innerText(),
    /How much did Arjun owe/,
  );
  await page.locator("#answer").screenshot({
    path: "/downloads/voice-memory-event-amount-partial-mobile.png",
  });
  await ask("How much did Arjun pay to Nimbus and when and who approved it?");
  assert.equal(
    await page.locator("#answer .verdict-chip").innerText(),
    "Partial answer",
  );
  assert.match(
    await page.locator("#answer").innerText(),
    /when and who approved it/,
  );
  await page
    .locator("#answer")
    .screenshot({ path: "/downloads/voice-memory-event-remainder-mobile.png" });
  await ask(
    "How much did Arjun pay to Nimbus or how much did Nimbus pay to Arjun?",
  );
  assert.equal(
    await page.locator("#answer .verdict-chip").innerText(),
    "Answer not established",
  );
  assert.equal(await page.locator("#answer .cites .cite").count(), 0);
  await ask("How much did Arjun pay to Nimbus yesterday?");
  assert.equal(
    await page.locator("#answer .verdict-chip").innerText(),
    "Answer not established",
  );
  assert.equal(await page.locator("#answer .cites .cite").count(), 0);
  assert.match(await page.locator("#answer").innerText(), /yesterday/);
  await page
    .locator("#answer")
    .screenshot({ path: "/downloads/voice-memory-event-qualifier-mobile.png" });
  await page.locator("#files").setInputFiles({
    name: "Purchase.txt",
    mimeType: "text/plain",
    buffer: Buffer.from(
      "# PURCHASE ORDER PO-55120\n\nAPPROVED / SIGNED\nApproved by: Priya Nair, Head of Procurement Approval date: 03 Nov 2026",
    ),
  });
  await page.locator("#upl-list li", { hasText: "Ready" }).nth(1).waitFor();
  await ask("Who approved the purchase order?");
  assert.equal(
    await page.locator("#answer .verdict-chip").innerText(),
    "Recorded fields",
  );
  assert.match(
    await page.locator("#answer").innerText(),
    /not confirmation that the event occurred/,
  );
  await page
    .locator("#answer")
    .screenshot({ path: "/downloads/voice-memory-recorded-role-mobile.png" });
  await ask("Who signed the purchase order?");
  assert.equal(
    await page.locator("#answer .verdict-chip").innerText(),
    "Answer not established",
  );
  console.log(
    "PASS event source assertion, unsupported signature, complete compound partial outcome;320px screenshots captured. No provider calls.",
  );
} finally {
  await browser?.close();
  dev.kill("SIGTERM");
}
