// Browser check: the two-call Voice Memory demo page (site/calls.html).
// Drives both calls through the real local server and engine, asserts the
// three sections and isolation, and saves screenshots (desktop + mobile).
import { chromium } from "playwright";
import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const shots = process.env.VM_SHOTS_DIR || join(tmpdir(), "voice-memory-calls");
await mkdir(shots, { recursive: true });
const port = 5000 + Math.floor(Math.random() * 150);
const env = { ...process.env };
for (const k of Object.keys(env))
  if (k.startsWith("VM_") || /(_KEY|_TOKEN|_SECRET|PASSWORD)$/.test(k)) delete env[k];
Object.assign(env, {
  SITE_PORT: String(port),
  VM_DENSE: "off",
  VM_GEMINI: "off",
  VM_RSS_WATCHDOG: "off",
  VM_COUNTERS_ALLOW_FILE: "on",
  VM_CALLER_DEMO: "on",
  VM_DATA_DIR: await mkdtemp(join(tmpdir(), "vm-calls-ui-")),
  VM_STORE_KEY: "44".repeat(32),
});
const dev = spawn(process.execPath, ["scripts/site-dev.mjs"], { env, stdio: "ignore" });
const browser = await chromium.launch({
  headless: true,
  ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}),
});
const origin = `http://127.0.0.1:${port}`;
for (let i = 0; i < 100; i++) {
  if (await fetch(origin + "/calls.html").then((r) => r.ok).catch(() => false)) break;
  await new Promise((r) => setTimeout(r, 200));
  if (i === 99) throw Error("local site failed to start");
}
const errors = [];
const timings = [];
try {
  for (const [label, viewport] of [
    ["desktop", { width: 1280, height: 1000 }],
    ["mobile", { width: 390, height: 844 }],
  ]) {
    const ctx = await browser.newContext({ viewport });
    const page = await ctx.newPage();
    page.on("pageerror", (e) => errors.push(`${label}: ${e.message}`));
    page.on("console", (m) => m.type() === "error" && errors.push(`${label}: ${m.text()}`));
    await page.goto(origin + "/calls.html");
    const say = async (text) => {
      const n = await page.locator(".msg.vm:not(.pending)").count();
      const t0 = Date.now();
      await page.fill("#say", text);
      await page.press("#say", "Enter");
      await page.waitForFunction((k) => document.querySelectorAll(".msg.vm:not(.pending)").length > k, n);
      timings.push({ label, text, ms: Date.now() - t0 });
      return page.locator(".msg.vm").last().innerText();
    };

    // Call one
    await page.click('[data-persona="asha"]');
    await page.click("#start");
    await page.locator(".msg.sys", { hasText: "Asha (fictional)" }).waitFor();
    assert.match(await page.locator(".msg.vm").first().innerText(), /don't have anything remembered/);
    await say("Please remember that I prefer Hinglish, and remember this conversation for next time.");
    const a1 = await say("Was the revised fee approved?");
    assert.match(a1, /sabse naya proposal hai, aur yeh abhi manzoor nahi/);
    assert.match(await page.locator("#verified").innerText(), /Proposed, not approved[\s\S]*\$42,000 is the latest proposal/);
    assert.match(await page.locator("#remembered").innerText(), /Language\s+Hinglish/);
    assert.match(await page.locator("#unresolved").innerText(), /not approved/);
    if (label === "desktop") await page.screenshot({ path: join(shots, `call-one-${label}.png`), fullPage: true });
    await page.click("#end");

    // Call two (new call, same verified fictional caller)
    await page.click("#start");
    await page.waitForFunction(() => /Welcome back/.test(document.querySelector(".msg.vm")?.textContent ?? ""));
    const greet = await page.locator(".msg.vm").first().innerText();
    assert.match(greet, /Pichli baar aapne fee ke baare mein poocha tha/);
    assert.match(greet, /manzoor nahi/);
    assert.match(await page.locator("#remembered").innerText(), /Last time[\s\S]*Was the revised fee approved/);
    assert.match(await page.locator("#verified").innerText(), /unchanged since your last call/);
    await page.screenshot({ path: join(shots, `call-two-${label}.png`), fullPage: true });
    await say("Please switch my language to English");
    const a2 = await say("Was the revised fee approved?");
    assert.match(a2, /^Voice Memory\s*\$42,000 is the latest proposal, and it is not approved/i);
    await say("Forget my language preference");
    assert.doesNotMatch(await page.locator("#remembered").innerText(), /Language/);
    await page.click("#end");

    // Ravi sees none of it
    await page.click('[data-persona="ravi"]');
    await page.click("#start");
    await page.locator(".msg.sys", { hasText: "Ravi (fictional)" }).waitFor();
    assert.match(await page.locator(".msg.vm").first().innerText(), /don't have anything remembered/);
    assert.doesNotMatch(await page.locator("#remembered").innerText(), /fee|Hinglish/);
    if (label === "mobile") await page.screenshot({ path: join(shots, `ravi-${label}.png`), fullPage: true });
    await page.click("#end");
    // Clean up Asha for the next viewport run
    await page.click('[data-persona="asha"]');
    await page.click("#start");
    await page.locator(".msg.sys", { hasText: "Asha (fictional)" }).waitFor();
    await say("Forget everything");
    await page.click("#end");
    await ctx.close();
  }
} finally {
  await browser.close();
  dev.kill();
}
assert.deepEqual(errors, []);
console.log("PASS two-call caller memory demo (desktop + mobile)");
console.log(JSON.stringify(timings));
console.log("screenshots:", shots);
