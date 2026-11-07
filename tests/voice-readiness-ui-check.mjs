// Focused, backend-free browser regression using the real landing JS/CSS.
// Run: node tests/voice-readiness-ui-check.mjs
import { chromium } from "playwright";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const assets = new Map(
  await Promise.all(
    ["index.html", "site.css", "site.js", "snapshot.js"].map(async (name) => [
      "/" + name,
      await readFile(new URL("../site/" + name, import.meta.url), "utf8"),
    ]),
  ),
);
const browser = await chromium.launch({
  headless: true,
  ...(process.env.CHROME_PATH
    ? { executablePath: process.env.CHROME_PATH }
    : {}),
});

try {
  const page = await browser.newPage();
  page.setDefaultTimeout(5000);
  const errors = [];
  const unexpected = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    window.__statusStarted = 0;
    window.__statusSettled = 0;
    window.__paidActions = 0;
    const fetch = window.fetch.bind(window);
    window.fetch = async (...args) => {
      if (args[0] !== "/api/public/status") return fetch(...args);
      window.__statusStarted++;
      try {
        const response = await fetch(...args);
        const text = response.text.bind(response);
        response.text = async () => {
          try {
            return await text();
          } finally {
            window.__statusSettled++;
          }
        };
        return response;
      } catch (error) {
        window.__statusSettled++;
        throw error;
      }
    };
    window.BolnaWebCall = class {
      constructor() {
        window.__paidActions++;
      }
    };
    navigator.mediaDevices.getUserMedia = async () => {
      window.__paidActions++;
      throw Error("Unexpected microphone request");
    };
  });

  let ready = false;
  let failure = null;
  let held = null;
  let statusRequests = 0;
  await page.route("**/*", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === "/api/public/status") {
      statusRequests++;
      assert.equal(request.method(), "GET");
      if (held) {
        held.started.resolve();
        await held.release.promise;
      }
      if (failure === "network") return route.abort("failed");
      if (failure === "http") return route.fulfill({ status: 503 });
      if (failure === "invalid")
        return route.fulfill({ json: { voice: { ready: "unknown" } } });
      return route.fulfill({
        json: {
          cases: { health: true, deal: true },
          voice: { ready },
          byoVoice: { enabled: false },
        },
      });
    }
    if (path === "/api/public/cases")
      return route.fulfill({ json: { cases: [] } });
    if (path.startsWith("/api/public/visual/"))
      return route.fulfill({ json: { visual: null } });
    if (path.startsWith("/api/public/graph/"))
      return route.fulfill({ json: { nodes: [], edges: [] } });
    if (path.startsWith("/api/") || request.method() !== "GET") {
      unexpected.push(request.method() + " " + path);
      return route.abort();
    }
    const asset = path === "/" ? "/index.html" : path;
    const contentType = asset.endsWith(".html")
      ? "text/html"
      : asset.endsWith(".css")
        ? "text/css"
        : "text/javascript";
    // Omit unrelated animation/visual bundles; nothing goes to the network.
    return route.fulfill({ contentType, body: assets.get(asset) ?? "" });
  });

  const visibility = (hidden) =>
    page.evaluate((hidden) => {
      Object.defineProperty(document, "hidden", {
        configurable: true,
        value: hidden,
      });
      document.dispatchEvent(new Event("visibilitychange"));
    }, hidden);
  const settled = (count) =>
    page.waitForFunction((n) => window.__statusSettled === n, count);
  const checkUI = async (on) => {
    assert.equal(
      await page
        .locator("html")
        .evaluate((el) => el.classList.contains("voice-on")),
      on,
    );
    assert.equal(await page.locator(".voice-off").isVisible(), !on);
    for (const control of await page
      .locator("[data-start-call], [data-call-link], .callbar")
      .all())
      assert.equal(await control.isVisible(), on);
  };

  await page.goto("https://demo.test/", { waitUntil: "load" });
  await page
    .locator("#engine-note", { hasText: "Live engine connected" })
    .waitFor();
  await checkUI(false);
  if (process.env.VM_SHOTS_DIR)
    await page.screenshot({
      path: process.env.VM_SHOTS_DIR + "/readiness-off.png",
      fullPage: true,
    });
  assert.equal(statusRequests, 1);

  // Holding the response proves repeated visible events share one probe.
  held = {
    started: Promise.withResolvers(),
    release: Promise.withResolvers(),
  };
  ready = true;
  await visibility(true);
  assert.equal(await page.evaluate(() => window.__statusStarted), 1);
  await visibility(false);
  await page.waitForFunction(() => window.__statusStarted === 2);
  await held.started.promise;
  await visibility(false);
  await visibility(true);
  await visibility(false);
  assert.equal(await page.evaluate(() => window.__statusStarted), 2);
  await checkUI(false);
  held.release.resolve();
  await settled(2);
  held = null;
  await checkUI(true);
  if (process.env.VM_SHOTS_DIR)
    await page.screenshot({
      path: process.env.VM_SHOTS_DIR + "/readiness-on.png",
      fullPage: true,
    });
  console.log(
    "PASS not-ready -> ready: notice hides and all call controls appear",
  );
  console.log(
    "PASS hidden events ignored and concurrent visible probes deduplicated",
  );

  for (const on of [true, false]) {
    if (!on) {
      ready = false;
      const next = statusRequests + 1;
      await visibility(true);
      await visibility(false);
      await settled(next);
      await checkUI(false);
      console.log("PASS ready -> not-ready: controls hide and notice appears");
    }
    for (failure of ["network", "http", "invalid"]) {
      const next = statusRequests + 1;
      await visibility(true);
      await visibility(false);
      await settled(next);
      await checkUI(on);
      console.log(
        `PASS ${failure} status failure preserves ${on ? "ready" : "not-ready"} UI`,
      );
    }
    failure = null;
  }

  // A failed probe must release the guard for the next visible event.
  ready = true;
  const next = statusRequests + 1;
  await visibility(true);
  await visibility(false);
  await settled(next);
  await checkUI(true);
  assert.equal(await page.evaluate(() => window.__statusStarted), 10);
  assert.equal(statusRequests, 10);
  assert.deepEqual(errors, []);
  assert.deepEqual(unexpected, []);
  assert.equal(await page.evaluate(() => window.__paidActions), 0);
  console.log(
    "PASS refresh recovers after failure; exactly one request per eligible event",
  );
  console.log("PASS no call, session, microphone, or other paid action");
} finally {
  await browser.close();
}
