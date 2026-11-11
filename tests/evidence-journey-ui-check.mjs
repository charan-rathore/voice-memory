// Browser check for the reading view (site/reading.js) at 320, 390, 768 and
// 1280 px: page tiles are real buttons with usable touch targets, Enter on
// a tile opens that document in the source viewer, the illustrative index
// lookup is labelled as an example, and no time budget is promised.
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PDFDocument, StandardFonts } from "pdf-lib";

const shots =
  process.env.VM_SHOTS_DIR || join(tmpdir(), "voice-memory-journey-shots");
mkdirSync(shots, { recursive: true });
const fail = (m) => {
  throw Error(m);
};
async function twoPagePdf() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const lines of [
    [
      "Service Agreement",
      "The monthly fee is Rs 12,000.",
      "Payment is due on the 5th.",
    ],
    [
      "Schedule B",
      "The notice period is 30 days.",
      "Signed copies are kept by the client.",
    ],
  ]) {
    const p = doc.addPage([595, 400]);
    lines.forEach((t, i) =>
      p.drawText(t, { x: 56, y: 340 - i * 24, size: 11, font }),
    );
  }
  return {
    name: "two-page-agreement.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from(await doc.save()),
  };
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const dev = spawn("node", ["scripts/site-dev.mjs"], { stdio: "ignore" });
let browser;
try {
  for (let i = 0; i < 50; i++) {
    if (
      await fetch("http://127.0.0.1:4500/")
        .then((r) => r.ok)
        .catch(() => false)
    )
      break;
    await wait(200);
    if (i === 49) fail("site-dev never came up");
  }
  browser = await chromium.launch({
    headless: true,
    ...(process.env.CHROME_PATH
      ? { executablePath: process.env.CHROME_PATH }
      : {}),
    args: ["--no-sandbox"],
  });
  const file = await twoPagePdf();
  for (const width of [320, 390, 768, 1280]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    await page.goto("http://127.0.0.1:4500/");
    await page.locator('.case-tab[data-case="own"]').click();
    await page.locator("#files").setInputFiles(file);
    await page
      .locator("#upl-list li", { hasText: "Ready" })
      .first()
      .waitFor({ timeout: 60000 });
    const tiles = page.locator(".rd-pages .rd-pg");
    await tiles.first().waitFor({ timeout: 20000 });
    if ((await tiles.count()) < 2) fail(`${width}: expected a tile per page`);
    // never hidden from assistive technology
    if (await page.locator(".rd-pages[aria-hidden]").count())
      fail(`${width}: page strip is hidden from assistive tech`);
    const box = await tiles.nth(1).boundingBox();
    if (!box || box.width < 44 || box.height < 44)
      fail(`${width}: touch target too small ${JSON.stringify(box)}`);
    const reading = await page.locator(".rd").innerText();
    if (/2:00 budget|2-minute budget/.test(reading))
      fail(`${width}: budget promised`);
    if (/Looking up “/.test(reading) && !/not your search/.test(reading))
      fail(`${width}: an index example is not labelled as an example`);

    // Read the server-owned upload log/digest. The UI must display these
    // facts, not frame numbers or fabricated "completed" milestones.
    const observed = await page.evaluate(async () => {
      const workspace = sessionStorage.getItem("vm_ws");
      const response = await fetch("/api/public/workspace/" + workspace);
      return { workspace, status: await response.json() };
    });
    const uploaded = observed.status.documents.find(
      (d) => d.filename === file.name,
    );
    if (!uploaded)
      fail(width + ": uploaded document missing from workspace status");
    for (const id of [
      "received",
      "pages",
      "records",
      "facts",
      "indexed",
      "ready",
    ]) {
      const details = page.locator(
        '.rd-stage[data-stage="' + id + '"] details',
      );
      await details.waitFor({ timeout: 10000 });
      if (!(await details.evaluate((el) => el.open)))
        await details.locator("summary").click();
    }
    const received = await page
      .locator('.rd-stage[data-stage="received"]')
      .innerText();
    if (
      !received.includes(uploaded.filename) ||
      !received.includes(Number(uploaded.bytes).toLocaleString("en-US")) ||
      !received.includes(uploaded.kind)
    )
      fail(
        width + ": receipt details do not match server-owned upload metadata",
      );
    const pages = await page
      .locator('.rd-stage[data-stage="pages"]')
      .innerText();
    if (!pages.includes(String(uploaded.pages) + " pages"))
      fail(width + ": the real page count did not reach the page disclosure");
    const records = await page
      .locator('.rd-stage[data-stage="records"]')
      .innerText();
    if (
      !records.includes(
        String(uploaded.digest?.records?.length ?? 0) + " records",
      )
    )
      fail(width + ": record boundaries do not match the actual digest");
    const facts = uploaded.digest?.inspectedFacts ?? [];
    const factView = await page
      .locator('.rd-stage[data-stage="facts"]')
      .innerText();
    if (!factView.includes(String(facts.length) + " cited rows"))
      fail(width + ": extracted-fact count differs from the digest");
    for (const fact of facts) {
      if (!fact.citation?.quote || !fact.citation?.location?.focus)
        fail(width + ": a displayed fact lacks an exact canonical citation");
      if (!factView.includes(fact.label))
        fail(width + ": a digest fact was omitted from the disclosure");
    }
    const indexed = await page
      .locator('.rd-stage[data-stage="indexed"]')
      .innerText();
    if (
      uploaded.digest?.index &&
      !indexed.includes(String(uploaded.digest.index.passages) + " passages")
    )
      fail(width + ": indexed passage count differs from the digest");
    if (/confidence score|retrieval score/i.test(indexed))
      fail(width + ": index metrics were presented as answer confidence");
    const readyAction = page.locator(
      '.rd-stage[data-stage="ready"] [data-ready], .rd-stage[data-stage="ready"] .rd-ready-button',
    );
    if (uploaded.answerable) {
      await readyAction.click();
      if (!(await page.evaluate(() => document.activeElement?.id === "q")))
        fail(width + ": Ready must focus the real question input");
    }

    await page.screenshot({
      path: join(shots, `journey-${width}-reading.png`),
      fullPage: false,
    });
    // keyboard: focus page 2 and press Enter
    await tiles.nth(1).focus();
    await page.keyboard.press("Enter");
    if ((await tiles.nth(1).getAttribute("aria-pressed")) !== "true")
      fail(`${width}: selected tile not marked pressed`);
    await page
      .locator("#viewer-body .rd-doc.focus", { hasText: "two-page-agreement" })
      .first()
      .waitFor({ timeout: 10000 });
    await page.screenshot({
      path: join(shots, `journey-${width}-viewer.png`),
      fullPage: false,
    });

    // Verify that the *real* typed response, not the highest-ranked passage,
    // determines the query activity and its canonical admitted citations.
    const submit = async (q) => {
      const done = page.waitForResponse(
        (r) =>
          r.url().includes("/api/public/ask") &&
          r.request().method() === "POST",
        { timeout: 45000 },
      );
      await page.locator("#q").fill(q);
      await page.locator("#askbar").evaluate((f) => f.requestSubmit());
      const response = await done;
      if (!response.ok()) fail(width + ": ask failed: " + response.status());
      const body = await response.json();
      if (!body.final) fail(width + ": canonical final missing on live answer");
      await page.locator(".rd-query:not([hidden])").waitFor({ timeout: 15000 });
      const verdict = await page.locator(".rd-query-verdict").innerText();
      const supported = typeof body.final.admittedText === "string";
      if (
        !verdict.includes(
          supported ? body.final.admittedText : "No supported answer",
        )
      )
        fail(width + ": query display diverges from final.admittedText");
      const admitted = body.final.citations ?? [];
      const citedButtons = page.locator("#answer .cites .cite");
      if ((await citedButtons.count()) !== admitted.length)
        fail(width + ": the answer promoted a non-admitted retrieval passage");
      // innerText normalizes PDF line breaks; textContent preserves the exact
      // canonical citation quote bytes used to construct the DOM nodes.
      const queryText = await page.locator(".rd-query").textContent();
      for (const cite of admitted)
        if (!queryText.includes(cite.quote))
          fail(
            width + ": a canonical citation is missing from the query journey",
          );
      if (
        (body.final.relatedEvidence ?? []).length &&
        !queryText.includes("Related evidence — not an answer")
      )
        fail(width + ": related evidence was not separated from admissions");
      return body.final;
    };

    const first = await submit("What is the notice period?");
    if (first.citations?.length) {
      const cite = first.citations[0];
      await page.locator("#answer .cite").first().click();
      await page.locator("#viewer-body .rd-doc.focus").waitFor();
      const originalText = await page.locator("#viewer-body").innerText();
      const hasPdfBox =
        (await page.locator("#viewer-body .rd-canvas .box").count()) > 0;
      const hasTextMark = (await page.locator("#viewer-body mark").count()) > 0;
      if (!hasPdfBox && !hasTextMark && !originalText.includes(cite.quote))
        fail(width + ": citation did not open its original source");
      if ((width === 390 || width === 1280) &&
          typeof first.admittedText === "string")
        await page.locator("#desk").screenshot({
          path: join(shots, "journey-" + width + "-admitted-after.png"),
        });
    }
    const unknown = await submit("What is the private admin password?");
    if (unknown.admittedText !== null)
      fail(width + ": unsupported question was admitted as a confident answer");
    const label = await page.locator("#answer .verdict-chip").innerText();
    if (!/no supported answer|needs clarification/i.test(label))
      fail(width + ": unsupported question has a confident visual status");
    if (width === 390 || width === 1280) {
      await page.locator("#desk").screenshot({
        path: join(shots, "journey-" + width + "-unsupported-after.png"),
      });
    }

    // Synthetic UI stress inputs are NOT evidence-engine accuracy tests.
    // They exercise state rendering with 101 pages, a long name, failed OCR,
    // and zero pages without using private files or fabricating a real upload.
    await page.evaluate((entry) => {
      const workspace = sessionStorage.getItem("vm_ws");
      const doc = structuredClone(entry);
      doc.id = "synthetic-browser-ocr";
      doc.filename = "very-long-" + "x".repeat(225) + ".pdf";
      doc.title = entry.title;
      doc.pages = 101;
      doc.answerable = false;
      doc.progress = {
        ...doc.progress,
        age: 2000,
        log: [],
        pages: Array.from({ length: 101 }, (_, i) => ({
          n: i + 1,
          state: i === 1 ? "ocr-done" : "text",
          chars: i === 1 ? 0 : 15,
          uncertain: i === 1 ? 2 : 0,
        })),
      };
      window.__journeyNav = null;
      document.addEventListener(
        "vm:open-page",
        (ev) => {
          window.__journeyNavPage = ev.detail?.page;
        },
        { once: true },
      );
      window.VMReading.render(document.getElementById("upl-flow"), [doc], {
        workspace,
        generation: entry.bundleGeneration,
        openSource: async (title, citations) => {
          window.__journeyNav = { title, citations };
        },
      });
    }, uploaded);
    const pageStage = page.locator('.rd-stage[data-stage="pages"] details');
    if (!(await pageStage.evaluate((el) => el.open)))
      await pageStage.locator("summary").click();
    const warning = page.locator(
      '.rd-stage[data-stage="pages"] .rd-data-row.warn',
    );
    await warning
      .first()
      .getByRole("button", { name: "Open page to review" })
      .click();
    const jump = await page.evaluate(() => window.__journeyNav);
    if (
      !jump ||
      jump.title !== uploaded.title ||
      (await page.evaluate(() => window.__journeyNavPage)) !== 2
    )
      fail(
        width + ": OCR warning did not open the correct synthetic page source",
      );
    while ((await page.locator(".rd-pages [data-expand-pages]").count()) > 0) {
      await page.locator(".rd-pages [data-expand-pages]").click();
    }
    if ((await page.locator(".rd-pages .rd-pg").count()) !== 101)
      fail(width + ": 101 pages are not reachable by explicit expansion");
    const longName = await page
      .locator('.rd-stage[data-stage="received"]')
      .innerText();
    if (!longName.includes("x".repeat(225)))
      fail(width + ": a long filename was lost rather than wrapped");

    await page.evaluate((entry) => {
      const doc = structuredClone(entry);
      doc.id = "synthetic-browser-zero-pages";
      doc.pages = 0;
      doc.digest = null;
      doc.status = "failed";
      doc.answerable = false;
      doc.progress = { log: [], pages: [], age: 0 };
      window.VMReading.render(document.getElementById("upl-flow"), [doc], {
        workspace: sessionStorage.getItem("vm_ws"),
      });
    }, uploaded);
    const zeroPages = await page
      .locator('.rd-stage[data-stage="pages"]')
      .innerText();
    if (!/0 pages/.test(zeroPages) || !/Zero readable pages/.test(zeroPages))
      fail(width + ": zero-page state was not truthful");

    await page.close();
  }
  console.log(
    "evidence-journey-ui-check OK: six real-data disclosures, original-page navigation, canonical query/citation rendering, safe unsupported answers, 101/0 pages and OCR review at 320/390/768/1280. Shots:",
    shots,
  );
} finally {
  await browser?.close();
  dev.kill();
}
