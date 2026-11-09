// Isolated public-fixture review. Never import production server or voice routes.
import http from "node:http";
import { readFileSync } from "node:fs";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { importBundle } from "../dist/engine.mjs";
import { createGemini } from "./semantic/gemini.mjs";
import { understandDocumentQuestion } from "./semantic/question-understanding.mjs";
import { readDocumentQuestion } from "./semantic/document.mjs";

const fixture = JSON.parse(
  readFileSync(
    new URL(
      "../tests/fixtures/document-disagreement/saved-gemini-disagreement.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
const source = readFileSync(
  new URL(
    "../tests/fixtures/document-disagreement/constitution-transcript.txt",
    import.meta.url,
  ),
  "utf8",
);
const sourceHash =
  "4828afac3b1dc6e0a6f694259834ef774f16e926e86cafebdca374d3efaeb80b";
if (createHash("sha256").update(source).digest("hex") !== sourceHash)
  throw Error("Public fixture integrity check failed");
const CAP = 0.0495;
const same = (a, b) => {
  const x = Buffer.from(String(a ?? "")),
    y = Buffer.from(String(b ?? ""));
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
};
const page = `<!doctype html><html><meta name="viewport" content="width=device-width"><title>Limited reader check</title><link rel="stylesheet" href="/review.css"><main><h1>Limited reader check</h1><p>This temporary check uses only the public US Constitution. Question interpretation and two readings are saved responses. Only the final audit can make one new Gemini request. This is not a fresh full-reader test, private upload service or public release.</p><p id="question"></p><button id="run">Run one final audit</button><p id="state" role="status"></p><section id="answer"></section><h2>Source quotes</h2><section id="citations"></section><p><a href="https://www.archives.gov/founding-docs/constitution-transcript">Public source</a></p><script src="/review.js"></script></main></html>`;
const login = `<!doctype html><html><meta name="viewport" content="width=device-width"><title>Reader check sign in</title><main><h1>Reader check sign in</h1><form method="post" action="/review/login"><input type="hidden" name="username" value="review" autocomplete="username"><label>Password <input name="password" type="password" autocomplete="current-password" required maxlength="256"></label><button>Sign in</button></form><p>No uploads, voice or public paid access.</p></main></html>`;
const client = `document.getElementById('run').onclick=async()=>{const b=document.getElementById('run'),s=document.getElementById('state');b.disabled=true;s.textContent='Checking the fixed public document. No other document can be sent.';try{const r=await fetch('/review/run',{method:'POST',headers:{'content-type':'application/json'},body:'{}'}),j=await r.json();s.textContent=j.error||j.status;if(j.answer?.verdict==='PARTIAL_DOCUMENT')s.textContent+=' Partial answer; unresolved parts are stated below.';document.getElementById('question').textContent=j.question||'';document.getElementById('answer').textContent=j.answer?.text||'';document.getElementById('citations').replaceChildren(...(j.answer?.citations||[]).map(c=>{const p=document.createElement('blockquote');p.textContent=c.quote;return p}));}catch{s.textContent='Check unavailable. No automatic retry.'}};`;

export function createLocalServer({
  env = process.env,
  fetchImpl = globalThis.fetch,
  now = () => Date.now(),
} = {}) {
  const session = randomBytes(32).toString("hex");
  const deadline = Date.parse(env.VM_REVIEW_EXPIRES_AT ?? "");
  const startup = now();
  const configured =
    env.IS_PULL_REQUEST === "true" &&
    String(env.VM_REVIEW_PASSWORD ?? "").length >= 20 &&
    Number.isFinite(deadline) &&
    deadline > startup &&
    deadline - startup <= 30 * 60_000;
  let attempts = 0,
    consumed = false,
    result = null,
    pending = null;
  const active = () => configured && now() < deadline;
  const reply = (res, status, body, type = "application/json") => {
    res.writeHead(status, {
      "content-type": type,
      "cache-control": "no-store",
      "x-robots-tag": "noindex, nofollow",
      "x-content-type-options": "nosniff",
      "referrer-policy": "same-origin",
      "content-security-policy":
        "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    });
    res.end(type === "application/json" ? JSON.stringify(body) : body);
  };
  const body = async (req) => {
    let s = "";
    for await (const c of req) {
      s += c;
      if (Buffer.byteLength(s) > 2048) throw Error("Request too large");
    }
    return s;
  };
  const fixed = async () => {
    // No inherited OPENROUTER_API_KEY, voice, speech, upload or search credential.
    if (env.VM_REVIEW_PAID !== "one-final-audit" || !env.VM_REVIEW_API_KEY)
      throw Error("Paid check is not activated");
    if (consumed)
      return (
        result ?? { status: "The single check was already consumed. No retry." }
      );
    consumed = true; // Consume BEFORE any key-health/provider request, including failures.
    const keyResponse = await fetchImpl("https://openrouter.ai/api/v1/key", {
      headers: { Authorization: `Bearer ${env.VM_REVIEW_API_KEY}` },
      signal: AbortSignal.timeout(8000),
    });
    if (!keyResponse.ok) throw Error("Dedicated test key health check failed");
    const key = (await keyResponse.json()).data;
    if (
      !(
        key?.limit > 0 &&
        key.limit <= CAP &&
        key.limit_reset === null &&
        key.limit_remaining >= 0.0476289 &&
        Date.parse(key.expires_at) > now() &&
        Date.parse(key.expires_at) <= startup + 60 * 60_000
      )
    )
      throw Error("Dedicated test key cap or expiry could not be verified");
    let paidRequests = 0;
    const audit = createGemini({
      env: {
        OPENROUTER_API_KEY: env.VM_REVIEW_API_KEY,
        VM_OPENROUTER_MODEL: "google/gemini-3.8-flash",
        VM_OPENROUTER_PROVIDER: "google-ai-studio",
        VM_GEMINI_IN_USD_PER_M: "0.825",
        VM_GEMINI_OUT_USD_PER_M: "4.125",
        VM_GEMINI_DAILY_USD: String(CAP),
        VM_GEMINI_DAILY_CALLS: "1",
        VM_GEMINI_SEARCH: "off",
        VM_DOCUMENT_MS: "65000",
      },
      fetchImpl: async (url, options) => {
        const b = JSON.parse(options.body);
        const bytes = b.messages.reduce(
          (s, m) => s + Buffer.byteLength(m.content),
          0,
        );
        if (
          !active() ||
          ++paidRequests !== 1 ||
          url !== "https://openrouter.ai/api/v1/chat/completions" ||
          bytes > 43232 ||
          b.max_tokens !== 2500 ||
          b.model !== "google/gemini-3.8-flash" ||
          b.tools ||
          b.provider.only?.join() !== "google-ai-studio" ||
          b.provider.allow_fallbacks !== false ||
          b.provider.max_price.prompt !== 0.825 ||
          b.provider.max_price.completion !== 4.125 ||
          b.response_format?.type !== "json_schema" ||
          Buffer.byteLength(JSON.stringify(b.response_format)) > 1000
        )
          throw Error("Fixed public audit request guard rejected request");
        return fetchImpl(url, options);
      },
    });
    const bundle = importBundle(
      [{ title: "Constitution - public source replay", text: source }],
      { scope: "offline-frozen-disagreement" },
    );
    const rebind = (original, p, docs) => {
      const x = structuredClone(original);
      x.questionPlanKey = p.key;
      x.scopeKey = p.scopeKey;
      for (const r of x.requirements)
        for (const c of r.claims ?? [])
          for (const e of c.evidence ?? [])
            e.sourceId = docs[e.document].sourceId;
      return x;
    };
    const model = {
      enabled: () => true,
      questionRequirements: async () => structuredClone(fixture.interpretation),
      documentRead: async (p, d) => rebind(fixture.primary, p, d),
      documentCoverage: async (p, d) => rebind(fixture.blind, p, d),
      documentAudit: (...args) => audit.documentAudit(...args),
    };
    const decomposition = await understandDocumentQuestion({
      question: fixture.question,
      gemini: model,
    });
    const answer = await readDocumentQuestion({
      question: fixture.question,
      bundle,
      gemini: model,
      consent: true,
      decomposition,
    });
    return {
      status: answer
        ? "One final audit completed. Earlier readings were replayed."
        : "Final audit did not verify an answer. No retry.",
      question: fixture.question,
      answer,
      sourceHash,
      limitation: "Saved preliminary responses; only the final audit is new.",
    };
  };
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://review.invalid");
      if (req.method === "GET" && url.pathname === "/healthz")
        return reply(res, 200, {
          service: "isolated-public-review",
          configured,
          active: active(),
          inference: active() && env.VM_REVIEW_PAID === "one-final-audit",
          sourceHash,
        });
      if (!active())
        return reply(res, 503, {
          error: "Review is not configured or has expired. No inference.",
        });
      if (req.method === "POST") {
        const expected = new URL(env.RENDER_EXTERNAL_URL ?? "http://127.0.0.1")
          .origin;
        if (req.headers.origin !== expected)
          return reply(res, 403, { error: "Same-origin request required" });
      }
      if (url.pathname === "/review/login" && req.method === "POST") {
        if (++attempts > 5)
          return reply(res, 429, { error: "Sign-in limit reached" });
        const input = new URLSearchParams(await body(req));
        if (!same(input.get("password"), env.VM_REVIEW_PASSWORD))
          return reply(res, 403, { error: "Sign-in failed" });
        res.setHeader(
          "set-cookie",
          `review=${session}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${Math.floor((deadline - now()) / 1000)}`,
        );
        res.setHeader("location", "/");
        return reply(res, 303, "", "text/plain");
      }
      const auth = (req.headers.cookie ?? "")
        .split("; ")
        .some((c) => same(c, `review=${session}`));
      if (!auth)
        return req.method === "GET" && url.pathname === "/"
          ? reply(res, 200, login, "text/html")
          : reply(res, 401, { error: "Sign in required" });
      if (req.method === "GET" && url.pathname === "/")
        return reply(res, 200, page, "text/html");
      if (req.method === "GET" && url.pathname === "/review.js")
        return reply(res, 200, client, "text/javascript");
      if (req.method === "GET" && url.pathname === "/review.css")
        return reply(
          res,
          200,
          "body{font:18px/1.55 system-ui;background:#141827;color:#eee;margin:0}main{max-width:760px;margin:auto;padding:24px}button,input{font:inherit;padding:10px;max-width:100%}button{background:#f7d54e;color:#141827}blockquote{border-left:3px solid #f7d54e;margin:16px 0;padding:12px;background:#202638}a{color:#f7d54e}#answer{white-space:pre-wrap;font-family:Georgia,serif;font-size:23px}",
          "text/css",
        );
      if (req.method === "POST" && url.pathname === "/review/run") {
        if ((await body(req)).trim() !== "{}")
          return reply(res, 400, {
            error: "Only the fixed public fixture is accepted",
          });
        pending ??= fixed()
          .then((x) => (result = x))
          .catch(
            () =>
              (result = {
                status: "Check unavailable or rejected. No automatic retry.",
              }),
          );
        return reply(res, 200, await pending);
      }
      return reply(res, 404, { error: "Route unavailable in isolated review" });
    } catch {
      return reply(res, 400, { error: "Request rejected" });
    }
  });
  server.headersTimeout = 15000;
  server.requestTimeout = 90000;
  return server;
}
export const server = createLocalServer();
export const startServer = () =>
  server.listen(
    Number(process.env.PORT || 4317),
    process.env.VM_BIND_HOST || "0.0.0.0",
  );
