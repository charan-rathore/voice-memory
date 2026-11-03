// Browser check: what is on screen and what voice answers from stay one
// conversation. Drives the real landing page and the real engine (through
// the same proxy shape as vercel.json). Only the Bolna call transport is
// stubbed, so this proves the page's side of the contract, not a spoken call:
//   1. a typed lab follow-up ("what was it before the correction?") is read
//      with the previous answer's field and cites the preliminary and
//      amended rows, with the cited row boxed on the page (desktop + phone);
//   2. a slow typed answer that arrives after a case switch is dropped;
//   3. a call starts on the case that is open, a tab switch moves the call,
//      and a turn answered for a case the page has left is not drawn.
//   CHROME_PATH=/path/to/chrome node tests/voice-sync-check.mjs [shots dir]
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";

const SHOTS = process.argv[2] || "/tmp/voice-sync-shots";
mkdirSync(SHOTS, { recursive: true });
const BASE = "http://127.0.0.1:4500";
const fail = (m) => {
  throw Error(m);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const dev = spawn("node", ["scripts/site-dev.mjs"], { stdio: "ignore" });
let browser;
const results = [];
const pass = (name) => (results.push(name), console.log("ok - " + name));

// A stand-in for window.BolnaWebCall: same events, no audio, no network.
const BOLNA_STUB = () => {
  window.BolnaWebCall = class {
    constructor(opts) {
      this.opts = opts;
      this.h = {};
    }
    on(ev, fn) {
      this.h[ev] = fn;
    }
    async start() {
      await this.opts.getSession();
      this.h["call-start"]?.();
    }
    stop() {
      this.h["call-end"]?.({ reason: "hangup" });
    }
  };
};

try {
  for (let i = 0; i < 100; i++) {
    const r = await fetch(BASE + "/api/public/status")
      .then((x) => x.json())
      .catch(() => null);
    if (r?.cases?.health && r?.cases?.deal) break;
    await wait(300);
    if (i === 99) fail("engine never became ready");
  }
  browser = await chromium.launch({
    headless: true,
    ...(process.env.CHROME_PATH
      ? { executablePath: process.env.CHROME_PATH }
      : {}),
    args: [
      "--no-sandbox",
      "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream",
    ],
  });

  // ---------------------------------------------------------------- 1
  for (const [label, viewport, scale] of [
    ["desktop", { width: 1280, height: 1000 }, 2],
    ["phone", { width: 390, height: 844 }, 2],
  ]) {
    const page = await browser.newPage({ viewport, deviceScaleFactor: scale });
    await page.goto(BASE + "/");
    await page.locator('.case-tab[data-case="health"]').waitFor();
    const askAndWait = async (q) => {
      await page.locator("#q").fill(q);
      await page.locator(".ask-go").click();
      await page
        .locator("#answer .a-q q", { hasText: q })
        .waitFor({ timeout: 30000 });
      await page.locator("#answer .a-lead").waitFor({ timeout: 30000 });
      // the sentence itself: the lead without its verdict chip
      return page.locator("#answer .a-lead").evaluate((el) =>
        [...el.childNodes]
          .filter((n) => !n.classList?.contains("verdict-chip"))
          .map((n) => n.textContent)
          .join("")
          .trim(),
      );
    };
    const first = await askAndWait("What is SYN-0001's ferritin result?");
    if (!/50 ng\/mL/.test(first)) fail(`${label}: first answer: ${first}`);
    const follow = await askAndWait("What was it before the correction?");
    if (!/^Before the correction/.test(follow))
      fail(`${label}: follow-up not answered: ${follow.slice(0, 160)}`);
    if (!/\b5 ng\/mL/.test(follow) || /0\.5/.test(follow))
      fail(`${label}: wrong pre-correction value: ${follow.slice(0, 160)}`);
    const cites = await page.locator(".cite .cite-q").allInnerTexts();
    if (!cites.some((c) => /(^|[|·])\s*5\s*([|·]|$)/.test(c)))
      fail(`${label}: preliminary row not cited: ${cites.join(" / ")}`);
    if (!cites.some((c) => /(^|[|·])\s*50\s*([|·]|$)/.test(c)))
      fail(`${label}: amended row not cited: ${cites.join(" / ")}`);
    // the cited row is boxed on the rendered page, and it is on screen
    await page
      .locator("#viewer-body .box, #viewer-body mark")
      .first()
      .waitFor({ timeout: 30000 });
    const box = page.locator("#viewer-body .box, #viewer-body mark").first();
    await box.scrollIntoViewIfNeeded();
    const bb = await box.boundingBox();
    if (!bb || bb.width < 20 || bb.height < 4)
      fail(`${label}: highlight box missing or degenerate`);
    await page.screenshot({ path: `${SHOTS}/followup-${label}.png` });
    await box.screenshot({ path: `${SHOTS}/followup-${label}-box.png` });
    await page.close();
  }
  pass("typed follow-up reads the previous field and boxes the cited rows");

  // ---------------------------------------------------------------- 2
  {
    const page = await browser.newPage({
      viewport: { width: 1280, height: 1000 },
    });
    await page.route("**/api/public/answer?*", async (route) => {
      if (/creatinine/i.test(decodeURIComponent(route.request().url())))
        await wait(2500);
      route.continue();
    });
    await page.goto(BASE + "/");
    await page.locator('.case-tab[data-case="health"]').waitFor();
    await page.locator("#q").fill("Has creatinine gone up since September?");
    await page.locator(".ask-go").click();
    await wait(300);
    await page.locator('.case-tab[data-case="deal"]').click();
    await wait(3500);
    const shown = await page.locator("#answer").innerText();
    if (/Creatinine|µmol/.test(shown))
      fail(`stale health answer drawn on the deal tab: ${shown.slice(0, 200)}`);
    pass("a slow answer that arrives after a case switch is dropped");
    await page.close();
  }

  // ---------------------------------------------------------------- 3
  {
    const page = await browser.newPage({
      viewport: { width: 1280, height: 1000 },
    });
    await page.addInitScript(BOLNA_STUB);
    const minted = [];
    const scopes = [];
    let feed = [];
    await page.route("**/api/public/status", async (route) => {
      const r = await route.fetch();
      const j = await r.json();
      j.voice = { configured: true, ready: true };
      route.fulfill({ response: r, json: j });
    });
    await page.route("**/api/public/voice/session", async (route) => {
      minted.push(JSON.parse(route.request().postData() || "{}"));
      route.fulfill({ json: { vm_ticket: "t".repeat(32) } });
    });
    await page.route("**/api/public/voice/scope", async (route) => {
      scopes.push(JSON.parse(route.request().postData() || "{}"));
      route.fulfill({ json: { case: scopes.at(-1).case } });
    });
    await page.route("**/api/public/voice/turns?*", async (route) =>
      route.fulfill({ json: { turns: feed } }),
    );
    // real engine leads for realistic turns
    const leadOf = async (c, q) =>
      (
        await (
          await fetch(
            `${BASE}/api/public/answer?case=${c}&q=${encodeURIComponent(q)}`,
          )
        ).json()
      ).lead;
    const ferritin = await leadOf(
      "health",
      "What is SYN-0001's ferritin result?",
    );
    const fee = await leadOf("deal", "Was the $42,000 revision finalized?");
    await page.goto(BASE + "/");
    await page.locator('.case-tab[data-case="health"]').waitFor();
    await page.locator("#call-btn").click();
    await page
      .locator("#call-label", { hasText: "Hang up" })
      .waitFor({ timeout: 15000 });
    if (minted[0]?.user_data?.vm_ws !== "health")
      fail(`call did not start on the open case: ${JSON.stringify(minted[0])}`);
    feed = [
      {
        at: Date.now(),
        question: "What is SYN-0001's ferritin result?",
        lead: ferritin,
        case: "health",
      },
    ];
    await page
      .locator("#answer .a-q q", { hasText: "ferritin" })
      .waitFor({ timeout: 8000 });
    await page.locator('.case-tab[data-case="deal"]').click();
    await wait(400);
    if (
      scopes.at(-1)?.case !== "deal" ||
      scopes.at(-1)?.ticket !== "t".repeat(32)
    )
      fail(`tab switch did not move the call: ${JSON.stringify(scopes)}`);
    // a late turn for the case the page left must not be drawn here
    feed = [
      ...feed,
      {
        at: Date.now() + 1,
        question: "What was ferritin before the correction?",
        lead: ferritin,
        case: "health",
      },
    ];
    await wait(2800);
    if (
      /before the correction/i.test(await page.locator("#answer").innerText())
    )
      fail("a health turn was drawn on the deal tab");
    feed = [
      ...feed,
      {
        at: Date.now() + 2,
        question: "Was the $42,000 revision finalized?",
        lead: fee,
        case: "deal",
      },
    ];
    await page
      .locator("#answer .a-q q", { hasText: "42,000" })
      .waitFor({ timeout: 8000 });
    await page.screenshot({ path: `${SHOTS}/call-deal-turn.png` });
    pass("a call follows the open case and drops turns for a case it left");
    await page.close();
  }
  console.log(`\n${results.length}/3 checks passed; screenshots in ${SHOTS}`);
} finally {
  await browser?.close();
  dev.kill();
}
