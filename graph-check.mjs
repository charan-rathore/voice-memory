// Browser check for the knowledge map: renders, drills down, grows, opens the
// original. Screenshots go to /tmp/vm-shots for visual review.
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import { createLocalServer } from "./server.mjs";
const PORT = 4400 + Math.floor(Math.random() * 300);
const app = createLocalServer({ port: PORT });
await new Promise((r) => app.listen(PORT, "127.0.0.1", r));
mkdirSync("/tmp/vm-shots", { recursive: true });
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.CHROME_PATH || "/usr/bin/google-chrome",
  args: ["--no-sandbox"],
});
const fail = (m) => {
  throw Error(m);
};
try {
  for (const [w, h, name] of [
    [1280, 1000, "desktop"],
    [390, 844, "phone"],
  ]) {
    const page = await browser.newPage({ viewport: { width: w, height: h } });
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(`http://127.0.0.1:${PORT}/`);
    await page.locator("#northstar").evaluate((b) => b.click());
    await page.getByText("Documents ready. Ask a question above.").waitFor();
    await page
      .getByLabel("Ask across your documents")
      .fill("What fee did we finally agree on?");
    await page.getByRole("button", { name: "Find the evidence" }).click();
    await page.locator("#verdict").filter({ hasText: /\S/ }).waitFor();
    await page.locator("#map summary").click();
    await page.locator(".mn-topic").first().waitFor();
    await page.waitForTimeout(1200);
    await page
      .locator("#map")
      .screenshot({ path: `/tmp/vm-shots/map-overview-${name}.png` });
    const q1 = await page.locator(".mn-question").count();
    if (q1 < 1) fail("no question node after an answer");
    await page.locator(".mn-topic", { hasText: "Fee" }).first().click();
    await page.locator(".mn-value").first().waitFor();
    await page.waitForTimeout(1200);
    await page
      .locator("#map")
      .screenshot({ path: `/tmp/vm-shots/map-topic-${name}.png` });
    const labels = await page.locator(".mn-value text").allTextContents();
    if (
      !labels.some((t) => t.includes("42,000")) ||
      !labels.some((t) => t.includes("48,000"))
    )
      fail("fee values missing: " + labels);
    if ((await page.locator(".mn-value.st-superseded").count()) < 1)
      fail("superseded value not marked");
    await page.locator(".mn-value", { hasText: "42,000" }).first().click();
    await page.locator(".mn-evidence").first().waitFor();
    await page.waitForTimeout(1200);
    await page
      .locator("#map")
      .screenshot({ path: `/tmp/vm-shots/map-value-${name}.png` });
    if (
      (await page.locator("#map-crumbs").textContent()).split("›").length !== 3
    )
      fail("crumbs not 3 levels");
    await page.locator(".mn-evidence").first().click();
    await page.locator("#viewer:not([hidden])").waitFor({ timeout: 5000 });
    // Grows: a second question adds a question node on the overview.
    await page
      .locator("#viewer-close")
      .click()
      .catch(() => {});
    await page
      .getByLabel("Ask across your documents")
      .fill("What's still open?");
    await page.getByRole("button", { name: "Find the evidence" }).click();
    await page.waitForTimeout(600);
    await page
      .locator("#map-crumbs button", { hasText: "All records" })
      .click();
    await page.waitForTimeout(1200);
    const q2 = await page.locator(".mn-question").count();
    if (q2 <= q1) fail(`graph did not grow (${q1} -> ${q2})`);
    if (
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      )
    )
      fail(`${name}: horizontal scroll`);
    if (errors.length) fail("page errors: " + errors.join("; "));
    await page.close();
  }
  console.log("graph check: pass (desktop + phone)");
} finally {
  await browser.close();
  app.close();
}
