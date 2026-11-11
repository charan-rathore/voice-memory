// Comparison screenshots for PR B. Runs the actual site-dev engine and browser;
// the baseline checkout and candidate checkout use this identical capture script.
// Synthetic PDFs and the repository's clearly fictional demo cases only.
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { chromium } from "playwright";
import { PDFDocument, StandardFonts } from "pdf-lib";

const output = resolve(process.argv[2] ?? ".shots/pr-b/after");
const siteRoot = resolve(process.argv[3] ?? ".");
mkdirSync(output, { recursive: true });
const port = 4500;
const url = "http://127.0.0.1:" + port;
const dev = spawn(process.execPath, ["scripts/site-dev.mjs"], {
  cwd: siteRoot,
  env: { ...process.env, SITE_PORT: String(port) },
  stdio: ["ignore", "pipe", "pipe"],
});
let browser;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const fail = (message) => {
  throw Error("PR-B screenshot: " + message);
};

async function pdfFixture() {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const p1 = pdf.addPage([595, 400]);
  const p2 = pdf.addPage([595, 400]);
  [
    "Service Agreement",
    "The monthly fee is Rs 12,000.",
    "Payment is due on the 5th.",
  ].forEach((line, i) =>
    p1.drawText(line, { x: 56, y: 340 - i * 24, size: 11, font }),
  );
  [
    "Schedule B",
    "The notice period is 30 days.",
    "Signed copies are kept by the client.",
  ].forEach((line, i) =>
    p2.drawText(line, { x: 56, y: 340 - i * 24, size: 11, font }),
  );
  return {
    name: "two-page-agreement.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from(await pdf.save()),
  };
}

async function ask(page, question) {
  const pending = page.waitForResponse(
    (response) =>
      (response.url().includes("/api/public/ask") &&
        response.request().method() === "POST") ||
      (response.url().includes("/api/public/answer") &&
        response.request().method() === "GET"),
    { timeout: 45000 },
  );
  await page.locator("#q").fill(question);
  await page.locator(".ask-go").click();
  const response = await pending;
  if (!response.ok()) fail("Ask failed " + response.status() + ": " + question);
  const answer = await response.json();
  if (!answer.final) fail("Missing canonical final after: " + question);
  await page.locator("#answer .a-lead").waitFor({ timeout: 15000 });
  return answer;
}

async function snap(page, width, name) {
  const target = page.locator("#desk");
  await target.waitFor({ timeout: 15000 });
  await target.screenshot({ path: join(output, width + "-" + name + ".png") });
}

try {
  for (let i = 0; i < 80; i++) {
    if (
      await fetch(url + "/")
        .then((r) => r.ok)
        .catch(() => false)
    )
      break;
    if (i === 79) fail("site-dev did not start from " + siteRoot);
    await wait(250);
  }
  browser = await chromium.launch({
    headless: true,
    ...(process.env.CHROME_PATH
      ? { executablePath: process.env.CHROME_PATH }
      : {}),
    args: ["--no-sandbox"],
  });
  const fixture = await pdfFixture();
  for (const width of [1280, 390]) {
    const page = await browser.newPage({
      viewport: { width, height: width === 390 ? 844 : 1000 },
      deviceScaleFactor: 1,
    });
    await page.goto(url + "/");
    await page.locator('.case-tab[data-case="own"]').click();
    await page.locator("#files").setInputFiles(fixture);
    await page.locator("#upl-flow .rd").waitFor({ timeout: 30000 });
    await snap(page, width, "01-upload-processing");
    await page
      .locator("#upl-list li", { hasText: "Ready" })
      .first()
      .waitFor({ timeout: 60000 });
    const details = page.locator('.rd-stage[data-stage="pages"] details');
    if (await details.count()) {
      await details.locator("summary").click();
      await page.locator('.rd-stage[data-stage="records"] summary').click();
    }
    await snap(page, width, "02-ready-evidence-stages");

    const unsupported = await ask(page, "What is the private admin password?");
    if (unsupported.final.admittedText !== null)
      fail("An unsupported document question was admitted on " + width);
    await snap(page, width, "04-unsupported-or-related");

    // Synthetic, clearly fictional medical demo reports: a known correction
    // with a source. This is a screenshot of the actual engine, not an
    // external accuracy test.
    await page.locator('.case-tab[data-case="health"]').click();
    let supported = null;
    for (const question of [
      "What is SYN-0001's latest ferritin?",
      "What was SYN-0001's ferritin in the amended October report?",
      "What did the amended report say about ferritin for SYN-0001?",
    ]) {
      const candidate = await ask(page, question);
      if (
        typeof candidate.final.admittedText === "string" &&
        candidate.final.citations?.length
      ) {
        supported = candidate;
        break;
      }
    }
    if (!supported) fail("No source-admitted demo ferritin answer at " + width);
    await page.locator("#answer .cite").first().click();
    // Citation evidence surfaces as a text mark or a drawn box on the
    // rendered page (both builds), or a focused-document section.
    await page
      .locator(
        "#viewer-body mark, #viewer-body .box, #viewer-body .rd-doc.focus",
      )
      .first()
      .waitFor({ timeout: 15000 });
    await snap(page, width, "03-admitted-answer-and-source");
    await page.close();
  }
  console.log("PR B before/after comparison screenshots captured:", output);
} finally {
  await browser?.close();
  dev.kill();
}
