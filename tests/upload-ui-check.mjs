import { chromium } from "playwright";
import assert from "node:assert/strict";
import { writeFile, mkdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
const shots =
  process.env.VM_SHOTS_DIR || join(tmpdir(), "voice-memory-upload-audit");
await mkdir(shots, { recursive: true });
const port = 4600 + Math.floor(Math.random() * 200);
const env = { ...process.env };
for (const k of Object.keys(env))
  if (k.startsWith("VM_") || /(_KEY|_TOKEN|_SECRET|PASSWORD)$/.test(k))
    delete env[k];
Object.assign(env, {
  SITE_PORT: String(port),
  VM_DENSE: "off",
  VM_GEMINI: "off",
  VM_RSS_WATCHDOG: "off",
  VM_COUNTERS_ALLOW_FILE: "on",
});
const dev = spawn(process.execPath, ["scripts/site-dev.mjs"], {
  env,
  stdio: "ignore",
});

const browser = await chromium
  .launch({
    headless: true,
    ...(process.env.CHROME_PATH
      ? { executablePath: process.env.CHROME_PATH }
      : {}),
  })
  .catch((error) => {
    dev.kill();
    throw error;
  });
const results = [];
const origin = `http://127.0.0.1:${port}`;
for (let i = 0; i < 80; i++) {
  if (
    await fetch(origin)
      .then((r) => r.ok)
      .catch(() => false)
  )
    break;
  await new Promise((r) => setTimeout(r, 200));
  if (i === 79) {
    dev.kill();
    await browser.close();
    throw Error("local site failed to start");
  }
}
const text =
  "# Processing design\n\n## Ownership\nA lease identifies the worker responsible for a partition.\n\n## Backpressure\nA bounded queue pauses producers while consumers catch up. Checkpoints preserve progress after a restart.\n";
const file = (name) => ({
  name,
  mimeType: "text/markdown",
  buffer: Buffer.from(text),
});
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(origin, { waitUntil: "domcontentloaded" });
  await page.locator('.case-tab[data-case="own"]').click();
  let creates = 0;
  await page.route("**/api/public/workspace", async (route) => {
    if (route.request().method() === "POST") {
      creates++;
      await new Promise((r) => setTimeout(r, 400));
    }
    await route.continue();
  });
  await page.locator("#files").setInputFiles(file("first.md"));
  await page.locator("#files").setInputFiles(file("second.md"));
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll("#upl-list .upl-st")].filter(
        (e) => e.textContent === "Ready",
      ).length === 2,
    {},
    { timeout: 45000 },
  );
  assert.equal(creates, 1);
  assert.equal(await page.locator("#viewer-body .file-card").count(), 2);
  results.push({
    check:
      "concurrent drops share workspace; Documents pane updates without reload",
    pass: true,
  });
  const ws = await page.evaluate(() => sessionStorage.getItem("vm_ws"));
  let fail = true;
  await page.route("**/api/public/workspace/" + ws, async (route) => {
    if (fail) {
      fail = false;
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: '{"error":"temporary"}',
      });
    } else await route.continue();
  });
  await page.locator("#files").setInputFiles(file("third.md"));
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll("#upl-list .upl-st")].filter(
        (e) => e.textContent === "Ready",
      ).length === 3,
    {},
    { timeout: 45000 },
  );
  assert.equal(await page.evaluate(() => sessionStorage.getItem("vm_ws")), ws);
  assert.equal(creates, 1);
  results.push({
    check:
      "temporary workspace validation failure preserves all uploads and recovers",
    pass: true,
  });
  await page
    .locator("#q")
    .fill("What happens to producers when consumers cannot keep up?");
  await page.locator(".ask-go").click();
  await page.locator("#answer .a-lead").waitFor({ timeout: 30000 });
  results.push({
    check: "own document paraphrase answer",
    answer: await page.locator("#answer .a-lead").textContent(),
    citations: await page.locator("[data-cite]").count(),
  });
  if (await page.locator("[data-cite]").count()) {
    await page.locator("[data-cite]").first().click();
    await page.locator("#viewer-body mark").first().waitFor({ timeout: 10000 });
    results.push({ check: "citation opens highlighted source", pass: true });
  }
  await page.locator("#q").fill("What does the bounded queue do?");
  await page.locator(".ask-go").click();
  await page.locator("#answer .a-lead").waitFor();
  assert.ok((await page.locator("[data-cite]").count()) > 0);
  await page.locator("[data-cite]").first().click();
  await page.locator("#viewer-body mark").first().waitFor();
  results.push({
    check: "literal own-document question opens exact highlighted citation",
    pass: true,
  });
  await page.unroute("**/api/public/workspace/" + ws);
  let pollFailures = 0;
  await page.route(
    "**/api/public/workspace/" + ws + "/upload",
    async (route) => {
      const response = await route.fetch();
      pollFailures = 3;
      await route.fulfill({ response });
    },
  );
  await page.route("**/api/public/workspace/" + ws, async (route) => {
    if (pollFailures > 0) {
      pollFailures--;
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: '{"error":"temporary"}',
      });
    } else await route.continue();
  });
  await page.locator("#files").setInputFiles(file("fourth.md"));
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll("#upl-list .upl-st")].filter(
        (e) => e.textContent === "Ready",
      ).length === 4,
    {},
    { timeout: 45000 },
  );
  assert.equal(await page.evaluate(() => sessionStorage.getItem("vm_ws")), ws);
  results.push({
    check: "three failed polling responses recover without losing workspace",
    pass: true,
  });
  await page.goto(origin + "/graph?case=own");
  await page
    .locator("#accessible-nodes button")
    .first()
    .waitFor({ state: "attached" });
  assert.ok((await page.locator("#accessible-nodes button").count()) >= 9);
  await page.locator("#node-list summary").click();
  await page.locator("#find").fill("Backpressure");
  assert.ok((await page.locator("#accessible-nodes button").count()) > 0);
  await page.locator("#accessible-nodes button").first().click();
  assert.equal(await page.locator("#panel").isVisible(), true);
  await page.keyboard.press("Escape");
  assert.equal(await page.locator("#panel").isVisible(), false);
  await page.locator("#find").fill("");
  await page.locator("#zin").click();
  await page.locator("#zout").click();
  await page.locator("#fit").click();
  results.push({
    check: "graph node list, search, node detail, Escape, zoom and fit",
    pass: true,
  });
  await page.route("**/api/public/graph/" + ws, (r) =>
    r.fulfill({ status: 503, body: "{}" }),
  );
  await page.locator('.seg [data-case="deal"]').click();
  await page.locator('.seg [data-case="' + ws + '"]').click();
  await page
    .locator("#graph-status")
    .filter({ hasText: "unavailable" })
    .waitFor();
  assert.equal(await page.locator("#accessible-nodes button").count(), 0);
  results.push({
    check: "failed own graph shows error and clears unrelated case nodes",
    pass: true,
  });
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    await page.goto(origin);
    await page.locator('.case-tab[data-case="own"]').waitFor();
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
      false,
    );
    await page.screenshot({
      path: join(shots, "final-mobile-" + width + ".png"),
      fullPage: true,
    });
  }
  results.push({
    check: "320px and390px home layout no horizontal overflow",
    pass: true,
  });
  assert.deepEqual(errors, []);
  results.push({ check: "uncaught browser errors", errors });
  await writeFile(
    join(shots, "browser-regression-results.json"),
    JSON.stringify(results, null, 2),
  );
  console.log(JSON.stringify(results, null, 2));
} finally {
  await browser.close();
  dev.kill();
}
