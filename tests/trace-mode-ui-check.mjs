// Compare the real engine's dense/hybrid response with the shipped trace label.
// Synthetic demo documents only. Warm embeddings before launching Chrome to
// avoid concurrent model-load and browser startup peaks on small machines.
import { chromium } from "playwright";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const shots =
  process.env.VM_SHOTS_DIR || join(tmpdir(), "voice-memory-trace-mode-shots");
await mkdir(shots, { recursive: true });
const port = 4600 + Math.floor(Math.random() * 200);
const env = { ...process.env };
for (const k of Object.keys(env))
  if (k.startsWith("VM_") || /(_KEY|_TOKEN|_SECRET|PASSWORD)$/.test(k))
    delete env[k];
Object.assign(env, {
  PORT: String(port),
  VM_GEMINI: "off",
  VM_RSS_WATCHDOG: "off",
  VM_COUNTERS_ALLOW_FILE: "on",
  VM_PARSE_IDLE_MS: "1000",
  // Dense stage enabled by default; honest headroom for this box.
  VM_MEMORY_LIMIT_MB: "1536",
});
const devLog = createWriteStream(join(shots, "server.log"));
const dev = spawn(process.execPath, ["server.mjs"], {
  env,
  stdio: ["ignore", "pipe", "pipe"],
});
dev.stdout.pipe(devLog);
dev.stderr.pipe(devLog);
const origin = `http://127.0.0.1:${port}`;
const text =
  "# Lease design\n\n## Ownership\nA lease identifies the worker responsible for a partition.\n\n## Backpressure\nA bounded queue pauses producers while consumers catch up. Checkpoints preserve progress after a restart.\n";
const question = "What pauses producers when consumers cannot keep up?";
let browser;
try {
  for (let i = 0; i < 80; i++) {
    if (
      await fetch(origin)
        .then((r) => r.ok)
        .catch(() => false)
    )
      break;
    await new Promise((r) => setTimeout(r, 200));
    if (i === 79) throw Error("engine server failed to start");
  }
  // Warm the dense stage over plain HTTP.
  {
    const sessResp = await fetch(`${origin}/api/session`);
    const sess = await sessResp.json();
    const cookie = (sessResp.headers.getSetCookie?.() ?? [])
      .map((c) => c.split(";")[0])
      .join("; ");
    const put = await fetch(`${origin}/api/upload`, {
      method: "POST",
      headers: {
        "Content-Type": "application/octet-stream",
        Origin: origin,
        "X-CSRF-Token": sess.csrf,
        Cookie: cookie,
        "X-File-Name": encodeURIComponent("warm.md"),
      },
      body: Buffer.from(text),
    });
    if (!put.ok && put.status !== 202)
      throw Error(`warm-up upload failed: ${put.status}`);
    let mode = "keyword";
    for (let i = 0; i < 36 && mode === "keyword"; i++) {
      await new Promise((r) => setTimeout(r, 5000));
      const q = await fetch(`${origin}/api/query`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: origin,
          "X-CSRF-Token": sess.csrf,
          Cookie: cookie,
        },
        body: JSON.stringify({ question }),
      }).then((r) => r.json());
      mode = q.actualMode ?? "keyword";
    }
    console.log("warm-up actualMode:", mode);
    if (mode === "keyword") throw Error("dense stage never became resident");
  }
  browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox"],
    ...(process.env.CHROME_PATH
      ? { executablePath: process.env.CHROME_PATH }
      : {}),
  });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  page.on("pageerror", (e) => console.log("PAGEERROR:", e.message));
  // Headless Chrome omits the Origin header on this page's same-origin
  // upload XHR, which the server's POST origin check requires
  // (src/server.mjs localOrigin/publicOrigin list). Restore the header the
  // deployed browser sends so the local flow can run; assertion targets are
  // unchanged.
  await page.route("**/api/**", (route) => {
    const headers = route.request().headers();
    if (!headers["origin"]) headers["origin"] = origin;
    route.continue({ headers });
  });
  page.on("response", async (r) => {
    if (r.url().includes("/api/")) {
      const req = r.request();
      console.log(
        "API",
        req.method(),
        r.url().replace(origin, ""),
        r.status(),
        "origin-hdr:",
        req.headers()["origin"],
      );
      if (r.status() >= 400)
        console.log("  body:", (await r.text()).slice(0, 200));
    }
  });
  await page.goto(origin, { waitUntil: "domcontentloaded" });
  // Use the repository's synthetic demo corpus.
  await page.locator("#northstar").click();
  await page.waitForFunction(
    () =>
      document.querySelectorAll('#sources li.doc[data-status="ready"]')
        .length >= 5,
    {},
    { timeout: 60000 },
  );
  const ask = async (q) => {
    const respPromise = page.waitForResponse(
      (r) => r.url().includes("/api/query") && r.request().method() === "POST",
      { timeout: 60000 },
    );
    await page.locator("#question").fill(q);
    await page.locator("#query").click();
    const resp = await respPromise;
    return resp.json();
  };
  // Dense embeddings for the imported corpus fill in the background; retry
  // until the engine reports its dense stage ran.
  const demoQuestion = "Was the $42,000 revision finalized?";
  let body = await ask(demoQuestion);
  for (let i = 0; i < 4 && body.actualMode === "keyword"; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    body = await ask(demoQuestion);
  }
  await page.waitForFunction(
    () => !document.querySelector("#query").disabled,
    null,
    { timeout: 10000 },
  );
  const modeText = (await page.locator("#mode").textContent()) ?? "";
  await page.locator("#trace-panel summary").click();
  await page.screenshot({
    path: join(shots, "trace-panel.png"),
    fullPage: false,
  });
  const result = {
    actualMode: body.actualMode,
    embeddingModel: body.embeddingModel ?? null,
    modeLabel: modeText.trim(),
    screenshot: join(shots, "trace-panel.png"),
  };
  console.log(JSON.stringify(result, null, 2));
  assert.ok(
    ["dense", "hybrid"].includes(body.actualMode),
    "dense stage never ran",
  );
  assert.ok(
    modeText.includes(
      body.actualMode === "hybrid"
        ? "keyword and semantic search"
        : "semantic search",
    ),
    `trace panel label does not match ${body.actualMode} mode`,
  );
  assert.ok(
    modeText.includes("Scores below are keyword-stage candidates only."),
  );
  assert.ok(!/Found by/i.test(modeText));
  console.log("trace-mode-ui-check: PASS");
} finally {
  dev.kill();
  await browser?.close();
}
