// Browser check for the bring-your-own-document landing flow.
// Drives the deployed landing (site/ + live engine through the same proxy
// shape as vercel.json) and proves, for a fresh synthetic upload:
//   1. after upload the visitor's documents become the active case, even if
//      the upload did not go through the tab (drag/direct path);
//   2. the answer names the actual supporting passage (deadline AND fee),
//      not the start of a document-spanning citation quote;
//   3. the source viewer marks only the focused line, not the whole page.
import { chromium } from "playwright";
import { spawn } from "node:child_process";

const fail = (m) => {
  throw Error(m);
};
const dev = spawn("node", ["scripts/site-dev.mjs"], { stdio: "ignore" });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let browser;
try {
  for (let i = 0; i < 50; i++) {
    const ok = await fetch("http://127.0.0.1:4500/")
      .then((r) => r.ok)
      .catch(() => false);
    if (ok) break;
    await wait(200);
    if (i === 49) fail("site-dev never came up");
  }
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.CHROME_PATH || "/usr/bin/google-chrome",
    args: ["--no-sandbox"],
  });
  const page = await browser.newPage({
    viewport: { width: 1280, height: 1000 },
  });
  await page.goto("http://127.0.0.1:4500/");
  await page.locator('.case-tab[data-case="health"]').waitFor();

  // Path A: upload through the "Your documents" tab, then ask.
  await page.locator('.case-tab[data-case="own"]').click();
  await page.locator("#files").setInputFiles("/tmp/harbor-fig-catering.pdf");
  await page
    .locator("#upl-list li", { hasText: "Ready" })
    .first()
    .waitFor({ timeout: 60000 });
  await page
    .locator("#q")
    .fill(
      "What is the menu deadline and what fee applies if it changes after that?",
    );
  await page.locator(".ask-go").click();
  const lead = page.locator("#answer .a-lead");
  await lead.waitFor({ timeout: 60000 });
  const leadText = await lead.innerText();
  if (!leadText.includes("27 March 2027"))
    fail(`answer missing the deadline: ${leadText.slice(0, 200)}`);
  if (!leadText.includes("18,000"))
    fail(`answer missing the fee: ${leadText.slice(0, 200)}`);
  // The viewer must mark only the focused line(s), not the whole document.
  await page.locator("#viewer-body mark").first().waitFor({ timeout: 30000 });
  const marks = await page.locator("#viewer-body mark").allInnerTexts();
  if (marks.length > 2) fail(`whole-document highlight: ${marks.length} marks`);
  if (!marks.some((m) => m.includes("27 March 2027")))
    fail(
      `focused highlight is not the deadline line: ${marks.join(" | ").slice(0, 200)}`,
    );
  await page.screenshot({ path: "/tmp/site-check-answer.png" });

  // Path B: fresh page, upload without touching the tab (drag/direct path);
  // the active case must switch to the visitor's documents on its own.
  const page2 = await browser.newPage({
    viewport: { width: 390, height: 844 },
  });
  await page2.goto("http://127.0.0.1:4500/");
  await page2.locator('.case-tab[data-case="health"]').waitFor();
  await page2.locator("#files").setInputFiles("/tmp/harbor-fig-catering.pdf");
  await page2
    .locator("#upl-list li", { hasText: "Ready" })
    .first()
    .waitFor({ timeout: 60000 });
  await page2
    .locator("#suggest .chip", {
      hasText: "What does this document say about the deadline?",
    })
    .first()
    .waitFor({ timeout: 15000 })
    .catch(() =>
      fail("upload did not switch the active case to the visitor's documents"),
    );
  if (
    (await page2
      .locator('.case-tab[data-case="own"]')
      .getAttribute("aria-selected")) !== "true"
  )
    fail("own tab not selected after direct upload");
  await page2.screenshot({ path: "/tmp/site-check-mobile.png" });

  // Path C: the demo cases never report ready (forced via route) - a visitor
  // ask about an uploaded document must still answer. This was the second
  // half of the reported cold-boot failure: asks hard-gated on state.live.
  const page3 = await browser.newPage({
    viewport: { width: 1280, height: 1000 },
  });
  await page3.route("**/api/public/status", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        cases: { health: false, deal: false },
        voice: { configured: false, ready: false },
      }),
    }),
  );
  await page3.goto("http://127.0.0.1:4500/");
  await page3.locator('.case-tab[data-case="health"]').waitFor();
  await page3.locator("#files").setInputFiles("/tmp/harbor-fig-catering.pdf");
  await page3
    .locator("#upl-list li", { hasText: "Ready" })
    .first()
    .waitFor({ timeout: 60000 });
  await page3
    .locator("#q")
    .fill(
      "What is the menu deadline and what fee applies if it changes after that?",
    );
  await page3.locator(".ask-go").click();
  const lead3 = page3.locator("#answer .a-lead");
  await lead3.waitFor({ timeout: 60000 });
  const lead3Text = await lead3.innerText();
  if (!lead3Text.includes("27 March 2027") || !lead3Text.includes("18,000"))
    fail(`cold-boot own ask did not answer: ${lead3Text.slice(0, 200)}`);
  console.log(
    "site-check OK: own-case selection, deadline+fee answer, focused highlight, cold-boot ask",
  );
} finally {
  await browser?.close();
  dev.kill();
}
