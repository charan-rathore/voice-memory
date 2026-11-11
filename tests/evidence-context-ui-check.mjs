import { chromium } from "playwright";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
const port = 4879;
const env = {
  ...process.env,
  SITE_PORT: String(port),
  VM_DENSE: "off",
  VM_GEMINI: "off",
  VM_RSS_WATCHDOG: "off",
  VM_COUNTERS_ALLOW_FILE: "on",
};
const dev = spawn(process.execPath, ["scripts/site-dev.mjs"], {
  env,
  stdio: "ignore",
});
let browser;
try {
  for (let i = 0; i < 100; i++) {
    if (
      await fetch(`http://127.0.0.1:${port}`)
        .then((r) => r.ok)
        .catch(() => false)
    )
      break;
    await new Promise((r) => setTimeout(r, 200));
  }
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.CHROME_PATH || "/usr/bin/google-chrome",
    args: ["--no-sandbox"],
  });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1100 },
  });
  let wsId;
  page.on("response", async (r) => {
    if (
      r.url().endsWith("/api/public/workspace") &&
      r.request().method() === "POST"
    )
      wsId = (await r.json()).id;
  });
  await page.goto(`http://127.0.0.1:${port}`);
  await page.locator('.case-tab[data-case="own"]').click();
  await page
    .locator("#files")
    .setInputFiles("clinical/fixtures/files/packet-synthetic.pdf");
  await page
    .locator("#upl-list li")
    .filter({ hasText: "Ready" })
    .first()
    .waitFor({ timeout: 45000 });

  for (let i = 0; i < 400; i++) {
    if (wsId) {
      const st = await (
        await fetch(`http://127.0.0.1:${port}/api/public/workspace/${wsId}`)
      ).json();
      if (
        st.documents?.every((d) => ["ready", "needs_review"].includes(d.status))
      )
        break;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  await page.locator("#q").fill("What is my ferritin?");
  await page.locator("#askbar").evaluate((f) => f.requestSubmit());
  await page.waitForFunction(() =>
    document
      .querySelector("#answer")
      ?.innerText.includes("Whose results should I look at?"),
  );
  await page.locator("#answer .cite-context").first().waitFor();
  const answer = await page.locator("#answer").innerText();
  assert.match(answer, /Context only - not evidence for this answer/);
  assert.match(answer, /TV-P2001/);
  assert.match(answer, /TV-P2002/);
  const blocks = await page.locator("#answer .cite-context").count();
  assert.ok(blocks >= 2);
  // The patient chooser is operable and readable on the dark report surface:
  // unselected tabs must keep AA contrast (selection is the pill, not dimming).
  const ratio = await page.evaluate(() => {
    const tab = document.querySelector("#answer .rp-subj");
    const surf = tab?.closest(".vz-report, .stage");
    if (!tab || !surf) return null;
    const lum = (rgb) => {
      const [r, g, b] = rgb.match(/[\d.]+/g).slice(0, 3).map(Number).map((v) => {
        const c = v / 255;
        return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
      });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const L1 = lum(getComputedStyle(tab).color);
    const L2 = lum(getComputedStyle(surf).backgroundColor);
    return (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
  });
  assert.ok(ratio && ratio >= 4.5, `unselected patient tab contrast ${ratio} < 4.5:1`);
  assert.equal(
    await page.locator("#answer .rp-who [aria-selected=true]").count(),
    0,
  );
  assert.equal(
    await page.locator("#answer .rp-detail, #answer .rp-timeline").count(),
    0,
  );
  await mkdir("/downloads", { recursive: true });
  await page
    .locator("#answer")
    .screenshot({ path: "/downloads/r6-evidence-context-desktop.png" });
  await page.setViewportSize({ width: 390, height: 844 });
  await page
    .locator("#answer")
    .screenshot({ path: "/downloads/r6-evidence-context-mobile.png" });

  await page.setViewportSize({ width: 1440, height: 1100 });
  await page
    .locator("#answer .rp-subj")
    .filter({ hasText: "TV-P2002" })
    .click();
  await page.locator("#q").fill("What is my ferritin?");
  const request2 = page.waitForResponse((r) =>
    r.url().includes("/api/public/ask"),
  );
  await page.locator("#askbar").evaluate((f) => f.requestSubmit());
  const result2 = await (await request2).json();
  assert.match(result2.final.text, /90 ng\/mL/);
  assert.ok(result2.final.citations.some((c) => c.quote.includes("90")));
  assert.ok(!result2.final.citations.some((c) => c.quote.includes("40")));
  assert.ok(
    result2.final.citations.every(
      (c) => c.record?.patientId === "TV-P2002" && c.contextOnly === false,
    ),
  );
  await page.waitForFunction(() =>
    document.querySelector("#answer .a-lead")?.innerText.includes("90"),
  );
  await page.waitForFunction(
    () =>
      document.querySelectorAll("#answer .cite").length > 0 &&
      document.querySelector("#answer .vz-focus"),
  );
  await page
    .locator("#answer .cite-owner")
    .filter({ hasText: "TV-P2002" })
    .first()
    .waitFor();
  assert.doesNotMatch(
    await page.locator("#answer .cite").first().innerText(),
    /Context only/,
  );
  await page.waitForTimeout(1800); // presentation animation, not readiness
  assert.match(await page.locator("#answer .vz").innerText(), /90/);
  assert.doesNotMatch(await page.locator("#answer .vz").innerText(), /40 ng/);
  await page
    .locator("#answer")
    .screenshot({ path: "/downloads/r6-evidence-selected-desktop.png" });
  await page.setViewportSize({ width: 390, height: 844 });
  await page
    .locator("#answer")
    .screenshot({ path: "/downloads/r6-evidence-selected-mobile.png" });
  // A production-extracted 60-character ID, selected by an actual tab click.
  const lp = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await lp.goto(`http://127.0.0.1:${port}`);
  await lp.locator('.case-tab[data-case="own"]').click();
  const longId = "A" + "1".repeat(59),
    otherId = "B" + "2".repeat(59);
  await lp.locator("#files").setInputFiles(
    [longId, otherId].map((id, i) => ({
      name: `long${i}.txt`,
      mimeType: "text/plain",
      buffer: Buffer.from(
        `Patient: Same Person, ID ${id}\nDOB: 12 Jan 1980 Sex: Female\nCollected: 10 October 2026\n\nTest Name    Result    Units    Reference range\nTSH    ${i ? "1.2" : "7.8"}    mIU/L    0.4 - 4.0\n`,
      ),
    })),
  );
  await lp
    .locator("#upl-list li")
    .filter({ hasText: "Ready" })
    .nth(1)
    .waitFor({ timeout: 45000 });
  await lp.locator("#ov-body .rp-subj").filter({ hasText: longId }).click();
  await lp.locator("#q").fill("What is my TSH?");
  const longRes = lp.waitForResponse((r) =>
    r.url().endsWith("/api/public/ask"),
  );
  await lp.locator("#askbar").evaluate((f) => f.requestSubmit());
  const response = await longRes,
    body = await response.json();
  assert.equal(response.request().postDataJSON().patient, longId);
  assert.match(body.final.text, /7\.8/);
  assert.ok(body.final.citations.every((c) => c.record?.patientId === longId));
  await lp.locator("#answer .cite-owner").filter({ hasText: longId }).waitFor();
  await lp.waitForTimeout(1800); // wait for the answer reveal, not data readiness
  assert.equal(
    await lp.locator("#answer").evaluate((e) => e.scrollWidth <= e.clientWidth),
    true,
    "long ID wraps within answer",
  );
  await lp
    .locator("#answer")
    .screenshot({ path: "/downloads/r6-long-id-mobile.png" });
  console.log(
    "PASS actual long patient ID survives upload, tab selection, separate API field, answer and source",
  );
  console.log(
    "PASS initial overview is not a selection; deliberate second-patient tab scopes the next answer and cited row",
  );
  console.log(
    "PASS real packet ambiguity retains both record identities and context-only labels; screenshots captured",
  );
} finally {
  if (browser) await browser.close();
  dev.kill();
  await new Promise((r) => dev.once("exit", r));
}
