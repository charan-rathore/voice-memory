import { chromium } from "playwright";
import assert from "node:assert/strict";
import { writeFile, mkdir, readFile } from "node:fs/promises";
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

try {
  const page = await browser.newPage({
    viewport: { width: 1280, height: 900 },
  });
  if (process.env.VM_BASELINE_SITE) {
    const baseline = await readFile(process.env.VM_BASELINE_SITE, "utf8");
    await page.route("**/site.js", (r) =>
      r.fulfill({ contentType: "text/javascript", body: baseline }),
    );
  }
  await page.goto(origin, { waitUntil: "domcontentloaded" });
  await page.locator('.case-tab[data-case="own"]').click();
  const upload = async (name, text, count) => {
    await page.locator("#files").setInputFiles({
      name,
      mimeType: "text/markdown",
      buffer: Buffer.from(text),
    });
    await page.waitForFunction(
      (n) =>
        [...document.querySelectorAll("#upl-list li")].filter((x) =>
          x.textContent.includes("Ready"),
        ).length === n,
      count,
      { timeout: 45000 },
    );
  };
  const ask = async () => {
    await page.locator("#q").fill("Who owns the security review?");
    await page.locator(".ask-go").click();
    await page.locator("#answer .corpus-version").waitFor();
    await page.waitForFunction(
      () => !document.querySelector(".ask-go").disabled,
    );
  };
  // Every new corpus-version element must stay AA-readable on the light
  // answer/viewer surfaces (regression: first version used dark-theme ink).
  const contrastOf = (sel, root) =>
    page.evaluate(
      ([selector, rootSel]) => {
        const el = document.querySelector(selector);
        if (!el) return null;
        const lum = (rgb) => {
          const [r, g, b] = rgb
            .match(/[\d.]+/g)
            .slice(0, 3)
            .map(Number)
            .map((v) => {
              const c = v / 255;
              return c <= 0.03928
                ? c / 12.92
                : Math.pow((c + 0.055) / 1.055, 2.4);
            });
          return 0.2126 * r + 0.7152 * g + 0.0722 * b;
        };
        let surf = el.parentElement;
        let bg = getComputedStyle(surf).backgroundColor;
        const alpha = (c) => {
          const m = c.match(/rgba\((?:[^,]+,){3}\s*([\d.]+)\s*\)/);
          return m ? Number(m[1]) : c === "transparent" ? 0 : 1;
        };
        while (surf && surf !== document.documentElement && alpha(bg) < 0.99) {
          surf = surf.parentElement;
          bg = getComputedStyle(surf).backgroundColor;
        }
        const L1 = lum(getComputedStyle(el).color);
        const L2 = lum(bg);
        return [
          (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05),
          getComputedStyle(el).color,
          bg,
          getComputedStyle(el).opacity,
        ];
      },
      [sel, root],
    );
  const assertReadable = async (sel, root) => {
    const [ratio, fg, bg, opacity] = (await contrastOf(sel, root)) ?? [];
    assert.ok(
      ratio && ratio >= 4.5,
      `${sel} contrast ${ratio} < 4.5:1 (color ${fg} on ${bg}, opacity ${opacity})`,
    );
  };
  await upload(
    "review.md",
    "Maya owns the security review. Pilot launch is proposed for Tuesday and remains subject to final sign-off.",
    1,
  );
  await ask();
  const first = await page
    .locator("#answer .corpus-version")
    .getAttribute("data-corpus-version");
  assert.match(first, /^[0-9a-f]{64}$/);
  assert.doesNotMatch(
    await page.locator("#answer .corpus-version").innerText(),
    /updated since/,
  );
  // One genuinely added indexed document, not a mocked version response.
  await upload(
    "budget.md",
    "Nina owns the budget review. The budget must be reviewed before the pilot launches. Budget sign-off is pending.",
    2,
  );
  await ask();
  const second = await page
    .locator("#answer .corpus-version")
    .getAttribute("data-corpus-version");
  assert.notEqual(first, second);
  assert.match(
    await page.locator("#answer .corpus-version").innerText(),
    /updated since the previous answer/,
  );
  await assertReadable("#answer .corpus-notice", "#answer");
  await assertReadable("#answer .corpus-version > p:nth-child(2)", "#answer");
  await assertReadable("#answer .corpus-details summary", "#answer");
  // B2 regression: a stale cached GET /answer replaying the pre-update
  // version after the updated answer was shown must NOT be described as
  // "updated documents", and must not roll the committed version back -
  // the next live answer must not re-announce the same change.
  const wsKey = await page.evaluate(() => sessionStorage.getItem("vm_ws"));
  await page.evaluate(
    async ([staleVersion, key]) => {
      const { renderCorpusNotice } = await import("./source-reader.mjs");
      const host = document.createElement("div");
      host.id = "stale-answer";
      host.innerHTML = '<p class="a-q"></p>';
      document.body.appendChild(host);
      renderCorpusNotice(host, { corpus: { version: staleVersion } }, key);
    },
    [first, wsKey],
  );
  assert.doesNotMatch(
    await page.locator("#stale-answer .corpus-notice").innerText(),
    /updated since/,
  );
  await ask();
  assert.doesNotMatch(
    await page.locator("#answer .corpus-version").innerText(),
    /updated since/,
  );

  // B2 on the real request path: a stale cached GET /answer replaying a
  // previously displayed version through the actual demo-case ask flow must
  // render neutral, and the cache-busting ?v= key must never roll back to
  // the stale version (regression: corpusVer was set from any response).
  await page.locator('.case-tab[data-case="health"]').click();
  const answerUrls = [];
  const answerVersions = [];
  let forcedVersion = null;
  let forcedChanged = false;
  await page.route("**/api/public/answer*", async (route) => {
    answerUrls.push(route.request().url());
    const response = await route.fetch();
    const body = await response.json();
    if (forcedVersion)
      body.corpus = {
        version: forcedVersion,
        changedSinceLastAnswer: forcedChanged,
      };
    answerVersions.push(body.corpus?.version ?? null);
    await route.fulfill({ response, json: body });
  });
  const askDemo = async () => {
    await page.locator("#q").fill("What is SYN-0001's ferritin result?");
    await page.locator(".ask-go").click();
    await page.locator("#answer .corpus-version").waitFor();
    await page.waitForFunction(
      () => !document.querySelector(".ask-go").disabled,
    );
  };
  await askDemo(); // A: the real current version, committed
  const realA = answerVersions[0];
  assert.match(realA, /^[0-9a-f]{64}$/);
  forcedVersion = "b".repeat(64);
  await askDemo(); // B: a genuinely new version announces the update
  assert.match(
    await page.locator("#answer .corpus-version").innerText(),
    /updated since the previous answer/,
  );
  forcedVersion = realA; // a stale cached A arrives after B was displayed
  await askDemo();
  assert.doesNotMatch(
    await page.locator("#answer .corpus-version").innerText(),
    /updated since/,
  );
  forcedVersion = null; // the edge later serves the same stale A uncached
  await askDemo();
  assert.doesNotMatch(
    await page.locator("#answer .corpus-version").innerText(),
    /updated since/,
  );
  // The cache-buster tracks the committed version: no v on the first ask,
  // v=A once A was committed, v=B after B - and still v=B after the stale
  // replay, never rolled back to the stale A.
  const vParam = (u) => new URL(u).searchParams.get("v");
  assert.equal(vParam(answerUrls[0]), null);
  assert.equal(vParam(answerUrls[1]), realA);
  assert.equal(vParam(answerUrls[2]), "b".repeat(64));
  assert.equal(vParam(answerUrls[3]), "b".repeat(64));
  // A genuinely flagged revert (the server explicitly reports the change)
  // must be announced AND committed, and the cache key must advance back to
  // A: replay-by-hash must not suppress an explicitly flagged real change.
  forcedChanged = true;
  forcedVersion = realA;
  await askDemo();
  assert.match(
    await page.locator("#answer .corpus-version").innerText(),
    /updated since the previous answer/,
  );
  forcedChanged = false;
  forcedVersion = null;
  await askDemo(); // uncached A again; already committed, so neutral
  assert.doesNotMatch(
    await page.locator("#answer .corpus-version").innerText(),
    /updated since/,
  );
  assert.equal(vParam(answerUrls[4]), "b".repeat(64));
  assert.equal(vParam(answerUrls[5]), realA);
  await page.unroute("**/api/public/answer*");
  await page.locator('.case-tab[data-case="own"]').click();
  await ask(); // restore the own-case answer (with cites) for the flow below
  await page
    .locator("#answer")
    .screenshot({ path: join(shots, "midcall-version-desktop-detail.png") });
  await page.screenshot({
    path: join(shots, "midcall-version-desktop.png"),
    fullPage: true,
  });
  // The matching current original should still open normally.
  await page.locator("#answer [data-cite]").first().click();
  await page.waitForFunction(() =>
    document.querySelector("#viewer-body")?.textContent.includes("Maya owns"),
  );
  assert.doesNotMatch(
    await page.locator("#viewer-meta").innerText(),
    /Historical citation/,
  );
  // Simulate the source becoming unavailable after this answer. Keep the
  // old quote, but do not navigate by title to a same-title replacement.
  const ws = await page.evaluate(() => sessionStorage.getItem("vm_ws"));
  await page.route("**/api/public/workspace/" + ws, async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    body.corpus = { ...body.corpus, sources: [] };
    await route.fulfill({ response, json: body });
  });
  await page.locator("#answer [data-cite]").first().click();
  await page
    .locator("#viewer-meta")
    .filter({ hasText: "Historical citation" })
    .waitFor();
  assert.match(
    await page.locator("#viewer-body").innerText(),
    /Original source unavailable or not verified/,
  );
  assert.match(await page.locator("#viewer-body").innerText(), /Maya owns/);
  assert.equal(await page.locator("#viewer-body .rd-doc").count(), 0);
  await assertReadable("#viewer-body .corpus-notice", "#viewer-body");
  await assertReadable("#viewer-body .corpus-quote", "#viewer-body");
  await page.locator("#viewer-body").screenshot({
    path: join(shots, "midcall-historical-citation-desktop-detail.png"),
  });
  await page.screenshot({
    path: join(shots, "midcall-historical-citation-desktop.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page
    .locator("#answer")
    .screenshot({ path: join(shots, "midcall-version-mobile-detail.png") });
  await page.screenshot({
    path: join(shots, "midcall-version-mobile.png"),
    fullPage: true,
  });
  console.log(
    "PASS real upload transition updates the answer version; simulated unavailable original preserves the historical quote without opening a same-title replacement.",
  );
} finally {
  await browser.close();
  dev.kill();
}
