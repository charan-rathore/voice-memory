// Actual browser + local server, with a fake document model. No external
import { tmpdir } from "node:os";
// provider, secret, paid speech or network inference is used.
import { createServer } from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import { extname, join } from "node:path";
import assert from "node:assert/strict";
import { chromium } from "playwright";
const shotsDir =
  process.env.VM_SHOTS_DIR || join(tmpdir(), "voice-memory-shots");
const names = [
  "VM_DOCUMENT_REASONING",
  "VM_GEMINI",
  "VM_COUNTERS_ALLOW_FILE",
  "VM_SEMANTIC_AUDIENCE",
  "VM_DENSE",
  "VM_PARSE_IDLE_MS",
];
const saved = Object.fromEntries(names.map((n) => [n, process.env[n]]));
Object.assign(process.env, {
  VM_DOCUMENT_REASONING: "on",
  VM_COUNTERS_ALLOW_FILE: "on",
  VM_DENSE: "off",
  VM_PARSE_IDLE_MS: "1000",
});
delete process.env.VM_SEMANTIC_AUDIENCE;
delete process.env.VM_GEMINI;
let calls = 0;
let fixtureDecomposition = true;
let partialFixture = false;
let rejectedAudit = false;
const gemini = {
  model: "fake/local-only",
  enabled: () => true,
  searchEnabled: () => false,
  status: () => ({ provider: "openrouter" }),
  interpret: async () => null,
  planClaims: async () => null,
  documentRead: async (requestPlan, documents) => {
    calls++;
    assert.match(documents[0].text, /retention window is 17 days/);
    return {
      question: requestPlan.originalQuestion,
      questionPlanKey: requestPlan.key,
      scopeKey: requestPlan.scopeKey,
      requirements: [
        {
          ...requestPlan.requirements[0],
          status: "answered",
          claims: [
            {
              statement: "The retention window is 17 days.",
              evidence: [
                { document: 0, quote: "The retention window is 17 days." },
              ],
            },
          ],
        },
        ...(partialFixture
          ? [{ ...requestPlan.requirements[1], status: "clarify", claims: [] }]
          : []),
      ],
    };
  },
  documentAudit: async (requestPlan, plan, statements) => {
    calls++;
    return {
      question: requestPlan.originalQuestion,
      questionPlanKey: requestPlan.key,
      scopeKey: requestPlan.scopeKey,
      complete: !rejectedAudit,
      relevant: true,
      supported: true,
      items: statements.map((_, index) => ({
        index,
        requirementId: statements[index].requirementId,
        accept: true,
      })),
    };
  },
};
const { createLocalServer } = await import("../src/server.mjs");
// This injected single-requirement fixture tests consent UI only. It is not
// a qualified arbitrary-document decomposition implementation.
const engine = createLocalServer({
  port: 0,
  gemini,
  resolveDocumentDecomposition: (q) =>
    partialFixture
      ? {
          provenance: "explicit-partial-consent-fixture",
          segments: [
            { kind: "requirement", start: 0, end: q.indexOf(", and ") },
            {
              kind: "glue",
              start: q.indexOf(", and "),
              end: q.indexOf(", and ") + 6,
            },
            {
              kind: "requirement",
              start: q.indexOf(", and ") + 6,
              end: q.length,
            },
          ],
        }
      : fixtureDecomposition
        ? {
            provenance: "explicit-consent-ui-fixture",
            segments: [{ kind: "requirement", start: 0, end: q.length }],
          }
        : null,
});
await new Promise((r) => engine.listen(0, "127.0.0.1", r));
await engine.loadPublicCases();
const apiPort = engine.address().port;
const types = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
};
const site = createServer(async (req, res) => {
  if (req.url.startsWith("/api/public/")) {
    const http = await import("node:http");
    const proxy = http.request(
      {
        host: "127.0.0.1",
        port: apiPort,
        path: req.url,
        method: req.method,
        headers: req.headers,
      },
      (r) => {
        res.writeHead(r.statusCode, r.headers);
        r.pipe(res);
      },
    );
    req.pipe(proxy);
    return;
  }
  let path = new URL(req.url, "http://local").pathname;
  if (path === "/") path = "/index.html";
  try {
    const b = await readFile(new URL("../site" + path, import.meta.url));
    res.writeHead(200, {
      "content-type": types[extname(path)] ?? "application/octet-stream",
    });
    res.end(b);
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((r) => site.listen(0, "127.0.0.1", r));
const origin = `http://127.0.0.1:${site.address().port}`;
let browser;
try {
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.CHROME_PATH || "/usr/bin/google-chrome",
    args: ["--no-sandbox"],
  });
  const page = await browser.newPage({
    viewport: { width: 320, height: 1000 },
  });
  const requests = [];
  page.on("request", (r) => {
    if (r.url().endsWith("/api/public/ask"))
      requests.push(JSON.parse(r.postData()));
  });
  await page.goto(origin);
  await page.locator('.case-tab[data-case="own"]').click();
  const input = page.locator("#document-ai-consent");
  await input.waitFor({ state: "visible" });
  assert.equal(await input.isChecked(), false);
  assert.equal(await input.isDisabled(), true);
  await page.locator("#files").setInputFiles({
    name: "retention.txt",
    mimeType: "text/plain",
    buffer: Buffer.from(
      "Pilot policy. The retention window is 17 days. Approval remains pending.",
    ),
  });
  await page.waitForFunction(
    () => !document.querySelector("#document-ai-consent").disabled,
  );
  async function ask(q) {
    await page.locator("#q").fill(q);
    await page.locator("#askbar").evaluate((f) => f.requestSubmit());
    await page.waitForFunction(
      () => !document.querySelector(".ask-go").disabled,
    );
  }
  await ask("What is the retention window?");
  assert.equal(requests.at(-1).semantic, false);
  assert.equal(calls, 0);
  await input.check();
  await ask("How long is the retention window?");
  assert.equal(requests.at(-1).semantic, true);
  assert.equal(calls, 2);
  assert.match(await page.locator("#answer").innerText(), /17 days/);
  assert.match(
    await page.locator("#answer").innerText(),
    /Voice is not enabled for this answer/,
  );
  assert.equal(await page.locator("#answer [data-listen]").count(), 0);
  assert.equal(requests.at(-1).documentConsent.model, "fake/local-only");
  const priorRequest = requests.at(-1);
  const afterAllowed = calls;
  for (const documentConsent of [
    undefined,
    { ...requests.at(-1).documentConsent, model: "changed-model" },
    { ...requests.at(-1).documentConsent, provider: "changed-provider" },
  ]) {
    const invalid = await fetch(origin + "/api/public/ask", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...requests.at(-1),
        question: "Does this request have current cloud permission?",
        documentConsent,
      }),
    });
    assert.equal(invalid.status, 409);
    assert.equal(calls, afterAllowed);
  }

  assert.match(
    await page.locator("#document-consent").innerText(),
    /complete text/,
  );
  assert.match(
    await page.locator("#document-consent").innerText(),
    /OpenRouter/,
  );
  await page.locator("#document-consent").scrollIntoViewIfNeeded();
  await mkdir(shotsDir, { recursive: true });
  await page.screenshot({
    path: join(shotsDir, "voice-memory-document-consent-mobile.png"),
    fullPage: false,
  });
  await page.locator("#document-consent").screenshot({
    path: join(shotsDir, "voice-memory-document-consent-mobile-card.png"),
  });
  const box = await page.locator("#document-consent").boundingBox();
  assert.ok(box.x >= 0 && box.x + box.width <= 321);
  // Exercise the production opaque behavior after the consent-only fixture.
  fixtureDecomposition = false;
  await ask("Was the retention policy approved, and who authorized it?");
  assert.equal(
    calls,
    2,
    "unqualified decomposition must not disclose documents",
  );
  assert.match(
    await page.locator("#answer").innerText(),
    /interpretation remains unresolved/,
  );
  assert.doesNotMatch(
    await page.locator("#answer").innerText(),
    /Not in these documents|checked every page|Cloud answer/,
  );
  await page.locator("#answer").evaluate(async (el) => {
    await Promise.all(
      el
        .getAnimations({ subtree: true })
        .map((a) => a.finished.catch(() => {})),
    );
  });
  await page.locator("#answer").screenshot({
    path: join(shotsDir, "voice-memory-opaque-question-mobile.png"),
  });
  await input.uncheck();
  await ask("Which retention window is in the policy?");
  assert.equal(requests.at(-1).semantic, false);
  assert.equal(calls, 2);
  await input.check();
  await page.locator("#files").setInputFiles({
    name: "new.txt",
    mimeType: "text/plain",
    buffer: Buffer.from(
      "Second policy. Security approval is not yet recorded. This is a separate source document.",
    ),
  });
  assert.equal(await input.isChecked(), false);
  await page.waitForFunction(
    () => !document.querySelector("#document-ai-consent").disabled,
  );
  assert.equal(await input.isChecked(), false);
  const beforeStale = calls;
  const stale = await fetch(origin + "/api/public/ask", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      ...priorRequest,
      question: "Another question after the document set changed",
    }),
  });
  assert.equal(stale.status, 409);
  assert.equal(calls, beforeStale);
  await page.reload();
  await page.locator('.case-tab[data-case="own"]').click();
  await input.waitFor({ state: "visible" });
  assert.equal(await input.isChecked(), false);
  process.env.VM_DOCUMENT_REASONING = "off";
  await page.evaluate(() =>
    document.dispatchEvent(new Event("visibilitychange")),
  );
  await page.waitForFunction(
    () => document.querySelector("#document-consent").hidden,
  );
  assert.equal(
    (await fetch(origin + "/api/public/status").then((r) => r.json())).semantic
      .documentReader.enabled,
    false,
  );
  process.env.VM_DOCUMENT_REASONING = "on";
  process.env.VM_SEMANTIC_AUDIENCE = "demo";
  assert.equal(
    (await fetch(origin + "/api/public/status").then((r) => r.json())).semantic
      .documentReader.enabled,
    false,
  );
  delete process.env.VM_SEMANTIC_AUDIENCE;
  await page.evaluate(() =>
    document.dispatchEvent(new Event("visibilitychange")),
  );
  await input.waitFor({ state: "visible" });
  partialFixture = true;
  await input.check();
  await ask("What is the retention window, and who approved it?");
  const answer = page.locator("#answer");
  assert.match(await answer.innerText(), /17 days/);
  assert.match(await answer.innerText(), /could not establish/);
  const badge = answer.locator(".verdict-chip");
  assert.equal(await badge.innerText(), "Partial answer");
  assert.ok((await badge.getAttribute("class")).includes("v-warn"));
  assert.equal(await answer.locator("[data-listen]").count(), 0);
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth <= 320),
    true,
  );
  await answer.evaluate(async (el) => {
    await Promise.all(
      el
        .getAnimations({ subtree: true })
        .map((a) => a.finished.catch(() => {})),
    );
  });
  await answer.screenshot({
    path: join(shotsDir, "voice-memory-partial-document-mobile.png"),
  });
  rejectedAudit = true;
  await ask("What is the retention window, and was the policy approved?");
  assert.match(await answer.innerText(), /could not establish/);
  assert.match(
    await answer.innerText(),
    /Cloud reading could not verify this answer/,
  );
  assert.doesNotMatch(
    await answer.innerText(),
    /Computed from these documents|Cloud answer · inspect the sources/,
  );
  assert.equal(await answer.locator("[data-listen]").count(), 0);
  await answer.evaluate(async (el) => {
    await Promise.all(
      el
        .getAnimations({ subtree: true })
        .map((a) => a.finished.catch(() => {})),
    );
  });
  await answer.screenshot({
    path: join(shotsDir, "voice-memory-rejected-cloud-footer-mobile.png"),
  });
  console.log(
    "PASS rejected cloud audit is not labeled computed or source-verified; mobile screenshot captured.",
  );
  console.log(
    "PASS mixed document outcomes remain partial with known fact and unresolved requirement; mobile screenshot captured.",
  );
  console.log(
    "PASS default-off/explicit-on/off/new-document/reload consent, actual fake-provider calls, mobile width. No real provider requests.",
  );
} finally {
  await browser?.close();
  site.closeAllConnections();
  await new Promise((r) => site.close(r));
  engine.closeAllConnections();
  await new Promise((r) => engine.close(r));
  for (const n of names)
    if (saved[n] === undefined) delete process.env[n];
    else process.env[n] = saved[n];
}
