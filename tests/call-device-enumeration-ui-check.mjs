// Device-enumeration fallback: when the mic is GRANTED but enumerateDevices
// rejects, the call must still start with default audio instead of reporting
// "Microphone blocked". A true getUserMedia denial must keep that message,
// and a fallback call must not show a mic label picked by an earlier call.
// The mock SDK follows the real bundled contract: start() emits "error" then
// rejects on failure, fires "call-start" on success.
import { chromium } from "playwright";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
const port = 4900 + Math.floor(Math.random() * 200);
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
const browser = await chromium.launch({
  headless: true,
  ...(process.env.CHROME_PATH
    ? { executablePath: process.env.CHROME_PATH }
    : {}),
});
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
    throw Error("site failed to start");
  }
}
const BLOCKED = "Microphone blocked";
const outcome = (page) =>
  page.waitForFunction(
    (blocked) => {
      const label = document.querySelector("#call-label")?.textContent ?? "";
      const state = document.querySelector("#call-state")?.textContent ?? "";
      return (
        label === "Hang up" ||
        label === "Call Voice Memory" ||
        state.includes(blocked) ||
        state.includes("Couldn't")
      );
    },
    BLOCKED,
    { timeout: 15000 },
  );
const rows = [];
try {
  for (const mode of [
    "enumerate-fails",
    "true-denial",
    "prior-label-fallback",
  ]) {
    const page = await browser.newPage();
    await page.addInitScript((m) => {
      window.__mode = m;
      window.__enumFails = m === "enumerate-fails";
      window.__instances = [];
      window.__preflightStops = 0;
      Object.defineProperty(navigator, "mediaDevices", {
        configurable: true,
        value: {
          getUserMedia: async () => {
            if (window.__mode === "true-denial")
              throw new DOMException("Permission denied", "NotAllowedError");
            return {
              getTracks: () => [
                {
                  stop() {
                    window.__preflightStops++;
                  },
                },
              ],
            };
          },
          enumerateDevices: async () => {
            if (window.__enumFails) throw new Error("enumeration unavailable");
            return [
              {
                kind: "audioinput",
                deviceId: "default",
                label: "Built-in Microphone",
              },
            ];
          },
        },
      });
      window.BolnaWebCall = class {
        constructor(opts) {
          this.opts = opts;
          this.h = {};
          this.stops = 0;
          window.__instances.push(this);
        }
        on(k, fn) {
          this.h[k] = fn;
        }
        async start() {
          const session = await this.opts.getSession();
          if (typeof session?.wss_url !== "string") {
            const e = new Error("Invalid URL");
            this.h["error"]?.({ code: "connect_failed", message: e.message });
            throw e;
          }
          this.h["call-start"]?.();
        }
        stop() {
          this.stops++;
          this.h["call-end"]?.({ reason: "hangup" });
        }
      };
    }, mode);
    await page.route("**/api/public/status", async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      body.voice = { configured: true, ready: true };
      await route.fulfill({ response, json: body });
    });
    let mints = 0;
    await page.route("**/api/public/voice/session", (route) => {
      mints++;
      return route.fulfill({
        json: {
          vm_ticket: "t".repeat(32),
          wss_url: "wss://example.invalid/call",
        },
      });
    });
    await page.route("**/api/public/voice/scope", (route) =>
      route.fulfill({ json: { case: "health" } }),
    );
    await page.route("**/api/public/voice/turns?*", (route) =>
      route.fulfill({ json: { turns: [] } }),
    );
    await page.goto(origin, { waitUntil: "domcontentloaded" });
    await page.locator("#call-btn").waitFor();
    if (mode === "prior-label-fallback") {
      // Call 1: enumeration works, a labeled mic is picked and shown.
      await page.locator("#call-btn").click();
      await outcome(page);
      const liveText = (await page.locator("#call-state").textContent()) ?? "";
      const first = await page.evaluate(() => ({
        hasAudio: "audio" in window.__instances[0].opts,
        stops: window.__instances[0].stops,
        preflight: window.__preflightStops,
      }));
      // Hang up, then call again with enumeration now failing.
      await page.locator("#call-btn").click();
      await page.waitForFunction(
        () =>
          document.querySelector("#call-label")?.textContent ===
          "Call Voice Memory",
        { timeout: 15000 },
      );
      await page.evaluate(() => {
        window.__enumFails = true;
      });
      await page.locator("#call-btn").click();
      await outcome(page);
      const stateText = (
        (await page.locator("#call-state").textContent()) ?? ""
      ).trim();
      const second = await page.evaluate(() => ({
        hasAudio: "audio" in (window.__instances[1]?.opts ?? {}),
        preflight: window.__preflightStops,
      }));
      rows.push({
        mode,
        mints,
        liveText: liveText.trim(),
        stateText,
        first,
        second,
      });
    } else {
      await page.locator("#call-btn").click();
      await outcome(page);
      const label = (await page.locator("#call-label").textContent())?.trim();
      const stateText = (
        (await page.locator("#call-state").textContent()) ?? ""
      ).trim();
      const inst = await page.evaluate(() =>
        window.__instances.map((i) => ({
          hasAudio: "audio" in i.opts,
          stops: i.stops,
        })),
      );
      const preflight = await page.evaluate(() => window.__preflightStops);
      rows.push({ mode, mints, label, stateText, inst, preflight });
    }
    await page.close();
  }
} finally {
  dev.kill();
  await browser.close();
}
for (const r of rows) console.log(JSON.stringify(r));

const en = rows.find((r) => r.mode === "enumerate-fails");
const dn = rows.find((r) => r.mode === "true-denial");
const pl = rows.find((r) => r.mode === "prior-label-fallback");
assert.ok(en && dn && pl, "all scenarios ran");

// Granted mic + failed enumeration: the call must proceed on default audio.
assert.equal(en.mints, 1, "enumerate-fails should still mint the call");
assert.equal(en.inst.length, 1, "SDK constructed once");
assert.equal(
  en.inst[0].hasAudio,
  false,
  "no device override: SDK default audio",
);
assert.equal(en.label, "Hang up", "call reaches Live");
assert.equal(en.preflight, 1, "preflight track stopped once");
assert.ok(!en.stateText.includes(BLOCKED), "no false blocked message");

// True denial keeps the accurate message and never mints.
assert.equal(dn.mints, 0, "true denial must not mint");
assert.equal(dn.inst.length, 0, "true denial must not construct the SDK");
assert.ok(dn.stateText.includes(BLOCKED), "true denial message preserved");

// Prior label must not leak into a fallback call.
assert.equal(pl.first.hasAudio, true, "first call picked the labeled mic");
assert.ok(
  pl.liveText.includes("Built-in Microphone"),
  "first call shows its mic",
);
assert.equal(pl.first.preflight, 1, "first preflight stopped");
assert.equal(pl.mints, 2, "both calls minted");
assert.equal(pl.second.hasAudio, false, "fallback call uses default audio");
assert.equal(pl.second.preflight, 2, "second preflight stopped");
assert.ok(
  !pl.stateText.includes("Built-in Microphone"),
  "fallback call shows no stale mic label",
);
assert.ok(!pl.stateText.includes(BLOCKED), "fallback call not misreported");
console.log(
  "PASS enumeration fallback uses default audio, true denial stays accurate, no stale mic label",
);
