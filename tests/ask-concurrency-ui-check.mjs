// P0 reproduction: rapid and overlapping typed asks on the evidence desk.
//
// Every request the page sends is recorded with a sequence id, the question
// it carried, when it was sent and when it was answered. Responses are gated
// so ordering is deterministic (no sleeps decide the outcome).
//
// Cases:
//   A  Enter during an existing ask must not be silently dropped: the newer
//      question is sent, and only its answer is shown.
//   B  Out-of-order completion: an older slow answer arriving after a newer
//      fast one never replaces it.
//   C  Case switch during a slow ask: the old case's answer never lands.
//   D  Typed text the visitor has not submitted is never wiped by an answer
//      arriving for an earlier question.
//
// Run: node tests/ask-concurrency-ui-check.mjs  (VM_BASELINE_SITE=<old site.js>
// replays the same checks against a previous build for fail-before evidence).
import { chromium } from "playwright";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const shots =
  process.env.VM_SHOTS_DIR || join(tmpdir(), "voice-memory-ask-concurrency");
await mkdir(shots, { recursive: true });
const port = 4800 + Math.floor(Math.random() * 150);
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
const origin = `http://127.0.0.1:${port}`;
for (let i = 0; i < 100; i++) {
  if (
    await fetch(origin)
      .then((r) => r.ok)
      .catch(() => false)
  )
    break;
  await new Promise((r) => setTimeout(r, 200));
  if (i === 99) {
    dev.kill();
    await browser.close();
    throw Error("local site failed to start");
  }
}

const baseline = process.env.VM_BASELINE_SITE
  ? await readFile(process.env.VM_BASELINE_SITE, "utf8")
  : null;
const results = [];

// A page whose /answer requests are each held until released by the test.
async function gatedPage() {
  const page = await browser.newPage({
    viewport: { width: 1280, height: 900 },
  });
  if (baseline)
    await page.route("**/site.js", (r) =>
      r.fulfill({ contentType: "text/javascript", body: baseline }),
    );
  await page.route("**/api/public/status", async (r) => {
    const response = await r.fetch();
    const body = await response.json();
    body.cases = { ...body.cases, health: true, deal: true };
    await r.fulfill({ response, json: body });
  });
  const log = [];
  const gates = [];
  const t0 = Date.now();
  await page.route("**/api/public/answer?*", async (r) => {
    const u = new URL(r.request().url());
    const entry = {
      id: log.length + 1,
      q: u.searchParams.get("q"),
      case: u.searchParams.get("case"),
      sentMs: Date.now() - t0,
      answeredMs: null,
    };
    log.push(entry);
    let release;
    const gate = new Promise((res) => (release = res));
    gates.push({ entry, release });
    await gate;
    entry.answeredMs = Date.now() - t0;
    // A recognisable body per request so the DOM shows which one rendered.
    await r.fulfill({
      json: {
        question: entry.q,
        lead: {
          verdict: "QUOTED",
          text: `ANSWER-FOR[${entry.q}]`,
          citations: [],
        },
      },
    });
  });
  await page.goto(origin, { waitUntil: "domcontentloaded" });
  await page
    .waitForFunction(
      () =>
        document.querySelector("#engine-note")?.textContent?.includes("Live"),
      null,
      { timeout: 15000 },
    )
    .catch(() => {});
  await page.locator('.case-tab[data-case="deal"]').click();
  await page.locator("#askbar").scrollIntoViewIfNeeded();
  const waitFor = async (n) => {
    for (let i = 0; i < 100 && log.length < n; i++)
      await new Promise((r) => setTimeout(r, 50));
    return log.length >= n;
  };
  const release = async (i) => {
    gates[i].release();
    await new Promise((r) => setTimeout(r, 250));
  };
  const answerText = () => page.locator("#answer").innerText();
  return { page, log, waitFor, release, answerText };
}

async function check(name, fn) {
  const started = Date.now();
  try {
    const detail = await fn();
    results.push({ name, ok: true, ms: Date.now() - started, ...detail });
  } catch (e) {
    results.push({
      name,
      ok: false,
      ms: Date.now() - started,
      error: e.message.split("\n")[0],
    });
  }
}

try {
  await check(
    "A: Enter during an existing ask sends the newer question",
    async () => {
      const { page, log, waitFor, release, answerText } = await gatedPage();
      await page.fill("#q", "What is the fee?");
      await page.press("#q", "Enter");
      assert.ok(await waitFor(1), "first ask was not sent");
      await page.fill("#q", "Was the revised fee approved?");
      await page.press("#q", "Enter");
      const sent = await waitFor(2);
      const shot = join(shots, `A-${baseline ? "before" : "after"}.png`);
      await page.locator("#try").screenshot({ path: shot });
      assert.ok(
        sent,
        `second Enter was dropped: requests=${JSON.stringify(log.map((l) => l.q))}`,
      );
      await release(1);
      await release(0);
      const dom = await answerText();
      assert.match(dom, /ANSWER-FOR\[Was the revised fee approved\?\]/);
      assert.doesNotMatch(dom, /ANSWER-FOR\[What is the fee\?\]/);
      await page.close();
      return { requests: log, screenshot: shot };
    },
  );

  await check(
    "B: an older slow answer never replaces a newer one",
    async () => {
      const { page, log, waitFor, release, answerText } = await gatedPage();
      await page.fill("#q", "Q-old");
      await page.press("#q", "Enter");
      await waitFor(1);
      await page.fill("#q", "Q-new");
      await page.press("#q", "Enter");
      assert.ok(await waitFor(2), "second question never sent");
      await release(1); // newer answers first
      await release(0); // then the stale one
      const dom = await answerText();
      assert.match(dom, /ANSWER-FOR\[Q-new\]/);
      assert.doesNotMatch(dom, /ANSWER-FOR\[Q-old\]/);
      await page.close();
      return { requests: log };
    },
  );

  await check(
    "C: switching case during a slow ask drops the old answer",
    async () => {
      const { page, log, waitFor, release, answerText } = await gatedPage();
      await page.fill("#q", "Was the revised fee approved?");
      await page.press("#q", "Enter");
      await waitFor(1);
      await page.locator('.case-tab[data-case="health"]').click();
      await release(0);
      const dom = await answerText();
      assert.doesNotMatch(dom, /ANSWER-FOR/);
      await page.close();
      return { requests: log };
    },
  );

  await check(
    "D: an arriving answer never wipes text typed since",
    async () => {
      const { page, waitFor, release } = await gatedPage();
      await page.fill("#q", "What is the fee?");
      await page.press("#q", "Enter");
      await waitFor(1);
      await page.fill("#q", "half-typed follow");
      await release(0);
      assert.equal(await page.inputValue("#q"), "half-typed follow");
      await page.close();
      return {};
    },
  );
  await check(
    "E: pressing Enter twice on one question asks it once",
    async () => {
      const { page, log, waitFor, release, answerText } = await gatedPage();
      await page.fill("#q", "What is the fee?");
      await page.press("#q", "Enter");
      await waitFor(1);
      await page.fill("#q", "What is the fee?");
      await page.press("#q", "Enter");
      await new Promise((r) => setTimeout(r, 400));
      assert.equal(
        log.length,
        1,
        `requests=${JSON.stringify(log.map((l) => l.q))}`,
      );
      await release(0);
      assert.match(await answerText(), /ANSWER-FOR\[What is the fee\?\]/);
      assert.equal(
        await page.locator(".ask-go").getAttribute("aria-busy"),
        null,
      );
      await page.close();
      return { requests: log };
    },
  );
  await check(
    "F: the coverage sentence shows once (block), not also in the answer words",
    async () => {
      const page = await browser.newPage({
        viewport: { width: 1280, height: 900 },
      });
      if (baseline)
        await page.route("**/site.js", (r) =>
          r.fulfill({ contentType: "text/javascript", body: baseline }),
        );
      await page.route("**/api/public/status", async (r) => {
        const response = await r.fetch();
        const body = await response.json();
        body.cases = { ...body.cases, health: true, deal: true };
        await r.fulfill({ response, json: body });
      });
      await page.goto(origin, { waitUntil: "domcontentloaded" });
      await page
        .waitForFunction(
          () =>
            document
              .querySelector("#engine-note")
              ?.textContent?.includes("Live"),
          null,
          { timeout: 15000 },
        )
        .catch(() => {});
      await page.locator('.case-tab[data-case="deal"]').click();
      await page.fill("#q", "Was the revised fee approved?");
      await page.press("#q", "Enter");
      await page.locator("#answer .a-lead").waitFor({ timeout: 15000 });
      const lead = await page.locator("#answer .a-lead").innerText();
      const shot = join(shots, `F-${baseline ? "before" : "after"}.png`);
      await page.locator("#answer").screenshot({ path: shot });
      assert.match(lead, /\$42,000/);
      assert.equal(await page.locator("#answer .cov-unverified").count(), 1);
      assert.doesNotMatch(
        lead,
        /haven't verified/,
        `lead repeats the notice: ${lead}`,
      );
      await page.close();
      return { lead, screenshot: shot };
    },
  );
} finally {
  await browser.close();
  dev.kill();
}

const out = join(
  shots,
  `ask-concurrency-${baseline ? "before" : "after"}.json`,
);
await writeFile(out, JSON.stringify(results, null, 2));
for (const r of results)
  console.log(
    `${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok ? "" : "  -- " + r.error}`,
  );
console.log("evidence:", out);
if (results.some((r) => !r.ok)) process.exit(1);
