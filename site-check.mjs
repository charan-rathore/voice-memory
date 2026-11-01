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
// Synthetic catering agreement as a real PDF, generated deterministically
// with the repo's declared pdf-lib: each visual line is drawn separately with
// paragraph-like spacing, so the text layer wraps the deadline sentence
// exactly like the user-reported PDF case (and the engine regression fixture).
// No fixture file on disk, nothing private.
import { PDFDocument, StandardFonts } from "pdf-lib";

const FIXTURE_LINES = [
  "This agreement is made between Riverglass Studios (the Client) and Harbor & Fig",
  "Catering Co. (the Caterer), effective 3 January 2027.",
  "1. Services. The Caterer will provide full event catering for the Client's",
  "annual showcase on 17 April 2027 at the Meadowbrook Hall, Pune.",
  "2. Menu deadline. Final menu selections and headcount must be confirmed in",
  "writing no later than 27 March 2027. Changes after that date incur a",
  "replanning fee of Rs 18,000.",
  "3. Payment. A deposit of Rs 42,500 is due on signing. The balance is due",
  "within 15 days of the event.",
  "4. Cancellation. Either party may cancel with at least 60 days written",
  "notice. Cancellations inside 60 days forfeit the deposit.",
  "5. Allergens. The Caterer will label all dishes containing nuts, dairy and",
  "gluten, and will provide a nut-free preparation line on request.",
];

async function buildFixture() {
  const doc = await PDFDocument.create();
  const page = doc.addPage([595, 400]);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const body = await doc.embedFont(StandardFonts.Helvetica);
  let y = 360;
  page.drawText("Harbor & Fig Catering Services Agreement", {
    x: 56,
    y,
    size: 13,
    font: bold,
  });
  y -= 26;
  for (const line of FIXTURE_LINES) {
    page.drawText(line, { x: 56, y, size: 10, font: body });
    y -= 22; // generous leading so extraction keeps visual lines as blocks
  }
  return {
    name: "harbor-fig-catering.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from(await doc.save()),
  };
}

const FIXTURE = await buildFixture();

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
  await page.locator("#files").setInputFiles(FIXTURE);
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
  await page2.locator("#files").setInputFiles(FIXTURE);
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
  await page3.locator("#files").setInputFiles(FIXTURE);
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
  // Path D: voice gate off (the harness never configures voice) - no call
  // entry point may be visible, and invoking the call path must never ask
  // for the microphone. Regression for the static call buttons that used to
  // render while the server refused to mint.
  const page4 = await browser.newPage({
    viewport: { width: 1280, height: 1000 },
  });
  await page4.addInitScript(() => {
    window.__micCalls = 0;
    const md = navigator.mediaDevices;
    if (md?.getUserMedia) {
      const orig = md.getUserMedia.bind(md);
      md.getUserMedia = (...a) => {
        window.__micCalls++;
        return orig(...a);
      };
    }
  });
  await page4.goto("http://127.0.0.1:4500/");
  await page4.locator('.case-tab[data-case="health"]').waitFor();
  // Let connect() resolve status; voice stays off in the harness.
  await page4.waitForTimeout(3000);
  const callElsVisible = await page4.evaluate(() =>
    [...document.querySelectorAll("[data-start-call], [data-call-link], .callbar")]
      .filter((el) => getComputedStyle(el).display !== "none")
      .map((el) => el.className || el.id || el.tagName),
  );
  if (callElsVisible.length)
    fail(`call entry points visible while voice is gated off: ${callElsVisible.join(", ")}`);
  await page4.evaluate(() => {
    document.querySelector("[data-start-call]")?.click();
  });
  await page4.waitForTimeout(1500);
  const micCalls = await page4.evaluate(() => window.__micCalls);
  if (micCalls !== 0)
    fail(`getUserMedia invoked while voice is gated off (${micCalls}x)`);
  console.log(
    "site-check OK: own-case selection, deadline+fee answer, focused highlight, cold-boot ask, voice-gated call buttons",
  );
} finally {
  await browser?.close();
  dev.kill();
}
