import assert from "node:assert/strict";
// Real browser, fixed public fixture and mocked key/audit. No external network.
import { createLocalServer } from "../src/public-review-preview.mjs";
import { chromium } from "playwright";
import { writeFileSync } from "node:fs";
const expires = new Date(Date.now() + 25 * 60000).toISOString();
let external = 0;
const env = {
  IS_PULL_REQUEST: "true",
  VM_REVIEW_PASSWORD: "offline-only-password-not-a-real-credential",
  VM_REVIEW_EXPIRES_AT: expires,
  VM_REVIEW_PAID: "one-final-audit",
  VM_REVIEW_API_KEY: "offline-only-mock-key",
};
const server = createLocalServer({
  env,
  fetchImpl: async (url, opts) => {
    external++;
    if (url.endsWith("/key"))
      return Response.json({
        data: {
          limit: 0.0495,
          limit_reset: null,
          limit_remaining: 0.0495,
          expires_at: expires,
        },
      });
    const b = JSON.parse(opts.body),
      p = JSON.parse(b.messages[0].content);
    const j = {
      question: p.requestPlan.originalQuestion,
      questionPlanKey: p.requestPlan.key,
      scopeKey: p.requestPlan.scopeKey,
      complete: true,
      relevant: true,
      supported: true,
      items: p.statements.map((s, index) => ({
        index,
        requirementId: s.requirementId,
        accept: true,
      })),
      coverageItems: p.independentPlan.requirements.flatMap((r) =>
        r.status === "answered"
          ? r.claims.map((_, claimIndex) => ({
              requirementId: r.id,
              claimIndex,
              accept: true,
            }))
          : [{ requirementId: r.id, claimIndex: null, accept: true }],
      ),
    };
    return Response.json({
      choices: [{ message: { content: JSON.stringify(j) } }],
      usage: { prompt_tokens: 10000, completion_tokens: 500, cost: 0.01 },
    });
  },
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
env.RENDER_EXTERNAL_URL = "http://127.0.0.1:" + server.address().port;
const b = await chromium.launch({
  headless: true,
  executablePath: "/usr/bin/google-chrome",
  args: ["--no-sandbox"],
});
try {
  const p = await b.newPage({ viewport: { width: 390, height: 900 } });
  await p.route("**/*", (r) =>
    r.request().url().startsWith(env.RENDER_EXTERNAL_URL)
      ? r.continue()
      : r.abort(),
  );
  await p.goto(env.RENDER_EXTERNAL_URL);
  await p.screenshot({
    path: "/tmp/vm-preview-offline-login-mobile.png",
    fullPage: true,
  });
  await p.locator("[name=password]").fill(env.VM_REVIEW_PASSWORD);
  await p.getByRole("button", { name: "Sign in" }).click();
  await p.getByRole("button", { name: "Run one final audit" }).waitFor();
  await p.screenshot({
    path: "/tmp/vm-preview-offline-scope-mobile.png",
    fullPage: true,
  });
  await p.getByRole("button", { name: "Run one final audit" }).click();
  await p.waitForFunction(() =>
    document
      .querySelector("#state")
      .textContent.startsWith("One final audit completed"),
  );
  await p.screenshot({
    path: "/tmp/vm-preview-offline-answer-mobile.png",
    fullPage: true,
  });
  writeFileSync(
    "/tmp/vm-preview-offline-report.json",
    JSON.stringify(
      {
        mode: "Offline fixture replay, mocked key metadata and mocked final audit. No real model or key-health claim.",
        externalMockCalls: external,
        text: await p.locator("main").innerText(),
      },
      null,
      2,
    ),
  );
  assert.equal(external, 2, "one mocked key read and one mocked audit");
  assert.match(await p.locator("#answer").innerText(), /two-thirds/);
  assert.match(
    await p.locator("#answer").innerText(),
    /reading checks disagreed/,
  );
  assert.equal(
    await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    true,
  );
  assert.equal(await p.locator("#run").isDisabled(), true);
  console.log(await p.locator("#state").innerText());
} finally {
  await b.close();
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
}
