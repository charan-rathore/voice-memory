import http from "node:http";
import { readFile, readdir } from "node:fs/promises";
import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import {
  importBundle,
  answer,
  draft,
  validateEvidence,
} from "./dist/engine.mjs";
import { createVoiceAdapter } from "./voice-adapter.mjs";
import {
  DENSE_MODEL_ID,
  denseAvailableFor,
  embedQueryReady,
  pauseDenseForIngest,
  resumeDenseAfterIngest,
  warmDense,
} from "./dense.mjs";
import { spokenTurn } from "./spoken.mjs";
import { extractiveSpoken } from "./spoken-extract.mjs";
import {
  clinicalTurn,
  clinicalReportsFor,
  observationEvidence,
} from "./clinical/answer.mjs";
import { extractReport } from "./clinical/observations.mjs";
import { detectLang } from "./clinical/explain.mjs";
import { normalizeSpoken } from "./spoken-normalize.mjs";
import { createAnswerCache } from "./cache.mjs";
import { readdirSync } from "node:fs";
import { NORTHSTAR_DOCS } from "./corpus-northstar.mjs";
import {
  addUpload,
  replaceWithText,
  indexable,
  findEntry,
  removeEntry,
  publicEntry,
  documentView,
  decorateResult,
  libraryOf,
  locatorFor,
  LIMITS,
} from "./library.mjs";
// Static assets: explicit allow-list (no path joining from the URL).
const STATIC = {
  "/": ["./public/index.html", "text/html; charset=utf-8"],
  "/app.js": ["./public/app.js", "text/javascript"],
  "/workspace.js": ["./public/workspace.js", "text/javascript"],
  "/viewer.js": ["./public/viewer.js", "text/javascript"],
  "/notes.js": ["./public/notes.js", "text/javascript"],
  "/motion.js": ["./public/motion.js", "text/javascript"],
  "/style.css": ["./public/style.css", "text/css"],
  "/vendor/pdf.min.mjs": [
    "./node_modules/pdfjs-dist/build/pdf.min.mjs",
    "text/javascript",
  ],
  "/vendor/pdf.worker.min.mjs": [
    "./node_modules/pdfjs-dist/build/pdf.worker.min.mjs",
    "text/javascript",
  ],
  "/fonts/newsreader.woff2": [
    "./node_modules/@fontsource-variable/newsreader/files/newsreader-latin-opsz-normal.woff2",
    "font/woff2",
  ],
  "/fonts/newsreader-italic.woff2": [
    "./node_modules/@fontsource-variable/newsreader/files/newsreader-latin-opsz-italic.woff2",
    "font/woff2",
  ],
  "/fonts/plex-sans-400.woff2": [
    "./node_modules/@fontsource/ibm-plex-sans/files/ibm-plex-sans-latin-400-normal.woff2",
    "font/woff2",
  ],
  "/fonts/plex-sans-500.woff2": [
    "./node_modules/@fontsource/ibm-plex-sans/files/ibm-plex-sans-latin-500-normal.woff2",
    "font/woff2",
  ],
  "/fonts/plex-sans-600.woff2": [
    "./node_modules/@fontsource/ibm-plex-sans/files/ibm-plex-sans-latin-600-normal.woff2",
    "font/woff2",
  ],
  "/fonts/plex-mono-400.woff2": [
    "./node_modules/@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-400-normal.woff2",
    "font/woff2",
  ],
  "/fonts/plex-mono-500.woff2": [
    "./node_modules/@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-500-normal.woff2",
    "font/woff2",
  ],
  "/favicon.svg": ["./public/favicon.svg", "image/svg+xml"],
};
// pdf.js standard font data (for PDFs that use non-embedded base fonts).
for (const f of readdirSync(
  new URL("./node_modules/pdfjs-dist/standard_fonts/", import.meta.url),
))
  if (/^[\w.-]+\.(pfb|ttf)$/.test(f))
    STATIC["/vendor/standard_fonts/" + f] = [
      "./node_modules/pdfjs-dist/standard_fonts/" + f,
      "application/octet-stream",
    ];
// The short answer shown first on screen is the SAME deterministic sentence
// the voice call would speak (claim renderer, else one verbatim quote), so
// screen and voice never tell different stories. Null when the spoken layer
// abstains or disagrees; the full engine text is always returned too.
function leadFor(question, result, bundle, prevField) {
  try {
    // Lab results across reports first (synthetic-data research prototype):
    // typed observations, comparability checks, no clinical judgement.
    if (bundle.clinical?.length) {
      const c = clinicalTurn(question, bundle.clinical);
      if (c)
        return {
          text: c.spoken,
          verdict: c.verdict,
          field: null,
          citations: c.used
            .map((o) => observationEvidence(o, bundle))
            .filter((ev) => {
              try {
                return ev && validateEvidence(ev, bundle);
              } catch {
                return false;
              }
            }),
        };
    }
    let t = spokenTurn(question, bundle, prevField);
    if (!t || t.reason === "no_field")
      t = extractiveSpoken(question, result, bundle, bundle.locateEvidence);
    if (!t || t.verdict === "UNKNOWN") return null;
    // Only claim-graph citations that still validate against the source
    // may back a lead; anything else and the screen keeps the engine text.
    const citations = (t.citations ?? []).filter((c) => {
      if (typeof c.start !== "number") return false;
      try {
        return validateEvidence(c, bundle);
      } catch {
        return false;
      }
    });
    if (!citations.length) return null;
    return {
      text: t.spoken,
      verdict: t.verdict,
      field: t.field ?? null,
      citations,
    };
  } catch {
    return null;
  }
}
const voiceTtlMs = () => Number(process.env.VM_VOICE_TTL_MS || 10 * 60 * 1000);
// Immutable cutoff for the fixed bearer, from server boot: covers the demo
// window without making a leaked credential live forever.
// Absolute hard expiry for the fixed bearer capability: an externally fixed
// timestamp (ISO-8601 or epoch ms), never derived from process start, so a
// restart or redeploy cannot extend the credential's absolute lifetime.
const voiceHardExpiresAtMs = () => {
  const v = process.env.VM_VOICE_HARD_EXPIRES_AT;
  if (!v) return null;
  const ms = /^\d+$/.test(v) ? Number(v) : Date.parse(v);
  return Number.isSafeInteger(ms) && ms > 0 ? ms : null;
};
// Human-readable grant window for runtime guidance; must track the
// configured TTL, never a hardcoded duration.
const lapseText = (ms) => {
  const m = Math.round(ms / 60000);
  return m >= 90 && m % 60 === 0
    ? `about ${m / 60} hours`
    : `about ${m} minutes`;
};
export function createLocalServer({
  voice = createVoiceAdapter({
    ttlMs: voiceTtlMs(),
    hardExpiresAtMs: voiceHardExpiresAtMs(),
  }),
  port = Number(process.env.PORT || 4317),
} = {}) {
  // Deployment configuration (all optional; unset = local-only behavior):
  // VM_PUBLIC_HOST / VM_PUBLIC_ORIGIN: the one public hostname/origin the UI
  // may be reached at. VM_OWNER_KEY: owner bootstrap secret (vault-held) that
  // creates a UI session; without it the public host serves nothing.
  // VM_VOICE_CAPABILITY: fixed bearer capability for the Bolna endpoint.
  const publicHost = process.env.VM_PUBLIC_HOST || null;
  const publicOrigin = process.env.VM_PUBLIC_ORIGIN || null;
  const ownerKey = process.env.VM_OWNER_KEY || null;
  const fixedCap = process.env.VM_VOICE_CAPABILITY || null;
  // VM_DEMO_BUNDLE: explicit fictional-demo mode. Boot-pins the fixed voice
  // capability to the built-in fictional corpus so a fresh process serves
  // voice turns with no owner import. Owner imports NEVER retarget the
  // pinned credential to a non-demo bundle; explicit owner reset retires it
  // (terminal within this process: rotate env + redeploy to revive).
  const demoBundleName = process.env.VM_DEMO_BUNDLE || null;
  // Session cleanup (sweep, eviction, re-import) RELEASES the voice grant but
  // never retires the fixed credential: unattended demos survive, and the next
  // authenticated Bolna request rebinds at admission. A grant with admission
  // activity inside 10 minutes is treated as a live call and left alone.
  const releaseVoice = (s) => {
    if (s.voiceToken) {
      if (fixedCap && s.voiceToken === fixedCap)
        voice.releaseIdle(s.voiceToken, 10 * 60 * 1000);
      else voice.release(s.voiceToken);
    }
    s.voiceToken = null;
  };
  // Explicit owner reset retires the fixed credential. HONEST SCOPE: the
  // tombstone is process-local - an instance restart forgets it, and the
  // same env credential could bind again until its absolute hard expiry.
  // Revoking a LEAKED credential is therefore ONE runbook action: retire
  // here AND immediately rotate VM_VOICE_CAPABILITY + redeploy.
  const retireVoice = (s) => {
    if (s.voiceToken) voice.retire(s.voiceToken);
    s.voiceToken = null;
  };
  let demoBundle = null;
  if (demoBundleName) {
    if (!fixedCap) throw Error("VM_DEMO_BUNDLE requires VM_VOICE_CAPABILITY.");
    if (!voiceHardExpiresAtMs())
      throw Error(
        "VM_DEMO_BUNDLE requires VM_VOICE_HARD_EXPIRES_AT (absolute expiry).",
      );
    if (demoBundleName !== "northstar")
      throw Error("Unknown VM_DEMO_BUNDLE: " + demoBundleName);
    demoBundle = importBundle(NORTHSTAR_DOCS);
    // Dense vectors for the pinned demo corpus: background warmup; queries
    // before completion simply rank by keyword (fail-closed).
    warmDense(demoBundle.rows);
    try {
      voice.bind(demoBundle, fixedCap);
    } catch (e) {
      // An expired (or previously retired) credential must not take the
      // whole server down: voice stays strictly 401 while the owner UI and
      // readiness report the inactive state. Any OTHER boot error is
      // unexpected and still fails closed by crashing.
      if (!/retired|hard expiry/i.test(e.message)) throw e;
      console.warn(
        "VM_DEMO_BUNDLE: fixed voice capability is not live (" +
          e.message +
          "). Voice answers 401 until it is rotated and redeployed.",
      );
    }
  }
  const signinFails = new Map();
  // Process-wide answer cache (keys are scoped per index build; see cache.mjs).
  const answerCache = createAnswerCache({
    max: Number(process.env.VM_CACHE_MAX || 1000),
  });
  const SIGNIN_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Owner sign-in</title><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="font-family:system-ui;max-width:22rem;margin:4rem auto"><h1>Voice Memory</h1><form method="post" action="/owner-signin" enctype="application/x-www-form-urlencoded"><label>Owner key <input type="password" name="key" required autocomplete="current-password" style="width:100%"></label><p><button type="submit">Sign in</button></p></form></body></html>`;
  // Bolna web-call session minting: credentials live in env (vault at deploy
  // time), never in client code, logs or artifacts.
  const bolnaKey = process.env.BOLNA_API_KEY || null;
  const bolnaAgent = process.env.BOLNA_AGENT_ID || null;
  const keyMatches = (a, b) => {
    const ha = createHash("sha256").update(String(a)).digest();
    const hb = createHash("sha256").update(String(b)).digest();
    return timingSafeEqual(ha, hb);
  };
  const sessions = new Map();
  const origin = `http://127.0.0.1:${port}`;
  function session(req, res, { create = true, secure = false } = {}) {
    let id = (req.headers.cookie || "")
      .split("; ")
      .find((c) => c.startsWith("vm="))
      ?.slice(3);
    if ((!id || !sessions.has(id)) && !create) return null;
    if (!id || !sessions.has(id)) {
      id = randomBytes(32).toString("hex");
      sessions.set(id, {
        sid: id,
        at: Date.now(),
        csrf: randomBytes(32).toString("hex"),
      });
      res.setHeader(
        "Set-Cookie",
        `vm=${id}; HttpOnly; SameSite=Strict; Path=/${secure ? "; Secure" : ""}`,
      );
    }
    if (sessions.size > 50) {
      const oldest = sessions.keys().next().value;
      if (oldest !== id) {
        releaseVoice(sessions.get(oldest));
        sessions.delete(oldest);
      }
    }
    return sessions.get(id);
  }
  // Raw upload body with a hard byte cap (checked against Content-Length
  // first, then enforced while streaming).
  async function rawBody(req, limit) {
    const declared = Number(req.headers["content-length"]);
    if (Number.isFinite(declared) && declared > limit) {
      const e = Error(
        `This file is ${(declared / 1048576).toFixed(1)} MB. The limit is ${limit / 1048576} MB per file.`,
      );
      e.status = 413;
      throw e;
    }
    const chunks = [];
    let bytes = 0;
    for await (const part of req) {
      const buffer = Buffer.isBuffer(part) ? part : Buffer.from(part);
      bytes += buffer.length;
      if (bytes > limit) {
        const e = Error(`This file is over the ${limit / 1048576} MB limit.`);
        e.status = 413;
        throw e;
      }
      chunks.push(buffer);
    }
    return Buffer.concat(chunks, bytes);
  }
  // One place that changes what a session's documents ARE. The voice grant
  // must follow: a fixed credential this session owns is retargeted
  // atomically (a removed document must stop answering immediately, not at
  // grant lapse); otherwise the session's grant is released.
  const setSessionBundle = (s, bundle) => {
    if (fixedCap && s.voiceToken === fixedCap && !demoBundle)
      voice.retarget(fixedCap, bundle);
    else releaseVoice(s);
    s.bundle = bundle;
    s.result = null;
    s.lastField = null;
  };
  const rebuildIndex = (s) => {
    const docs = indexable(s);
    const bundle = docs.length
      ? importBundle(docs.map((e) => ({ title: e.title, text: e.doc.text })))
      : null;
    s.sourceToEntry = new Map(
      (bundle?.sources ?? []).map((src, i) => [src.id, docs[i]]),
    );
    if (bundle) {
      bundle.locateEvidence = locatorFor(s.sourceToEntry);
      bundle.clinical = clinicalReportsFor(bundle, docs, extractReport);
    }
    setSessionBundle(s, bundle);
  };
  async function body(req) {
    const chunks = [];
    let bytes = 0;
    for await (const part of req) {
      const buffer = Buffer.isBuffer(part) ? part : Buffer.from(part);
      bytes += buffer.length;
      if (bytes > 700000) throw Error("Upload too large.");
      chunks.push(buffer);
    }
    const text = new TextDecoder("utf-8", { fatal: true }).decode(
      Buffer.concat(chunks, bytes),
    );
    if (
      (req.headers["content-type"] ?? "").includes(
        "application/x-www-form-urlencoded",
      )
    )
      return Object.fromEntries(new URLSearchParams(text));
    return JSON.parse(text);
  }
  const server = http.createServer(async (req, res) => {
    const disconnected = new AbortController();
    const abort = () => {
      if (!res.writableEnded) disconnected.abort();
    };
    req.once("aborted", abort);
    res.once("close", abort);
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self' https://cdn.jsdelivr.net; style-src 'self'; connect-src 'self' https://api.bolna.ai https://*.bolna.ai wss://*.bolna.ai; media-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    );
    // Bolna-callable route: server-to-server, authenticated by the voice
    // bearer capability itself (validated inside the adapter), never by the
    // browser session. All other routes stay local-host + cookie + CSRF.
    // The listener still binds 127.0.0.1; public exposure is a separate,
    // unauthorized deployment decision.
    // Load-balancer health check: no session, no data, constant cost.
    if (req.method === "GET" && req.url === "/healthz") {
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          ok: true,
          cache: { entries: answerCache.size, ...answerCache.stats },
        }),
      );
      return;
    }
    const isBolnaRoute =
      req.url === "/v1/chat/completions" || req.url === "/v1/models";
    // Compare against the actual bound address (supports port 0 in tests).
    const bound = server.address();
    const localOrigin = bound ? `http://127.0.0.1:${bound.port}` : origin;
    const isLocalHost = bound && req.headers.host === `127.0.0.1:${bound.port}`;
    const isPublicHost = publicHost !== null && req.headers.host === publicHost;
    if (!isBolnaRoute && !isLocalHost && !isPublicHost) {
      res.writeHead(403);
      res.end("Local host only");
      return;
    }
    for (const [id, s] of sessions)
      if (Date.now() - s.at > 3600000) {
        releaseVoice(s);
        sessions.delete(id);
      }
    // Owner bootstrap on the public host: a sign-in FORM posts the
    // vault-held key in the request body - never in a URL (browser history,
    // access logs, referrers) - and this server keeps no request log.
    // Failed attempts lock the source address out after 10 tries.
    let s;
    if (isPublicHost && !isLocalHost) {
      const reqUrl = new URL(req.url, publicOrigin ?? origin);
      if (req.method === "GET" && reqUrl.pathname === "/owner-signin") {
        res.setHeader("Content-Type", "text/html");
        res.end(SIGNIN_PAGE);
        return;
      }
      if (req.method === "POST" && reqUrl.pathname === "/owner-signin") {
        const ip = req.socket.remoteAddress ?? "unknown";
        const rec = signinFails.get(ip) ?? { fails: 0, lockedUntil: 0 };
        const data = await body(req).catch(() => null);
        if (
          rec.lockedUntil > Date.now() ||
          !ownerKey ||
          !keyMatches(data?.key ?? "", ownerKey)
        ) {
          rec.fails += 1;
          if (rec.fails >= 10) rec.lockedUntil = Date.now() + 10 * 60 * 1000;
          signinFails.set(ip, rec);
          res.writeHead(403);
          res.end(JSON.stringify({ error: "Owner access required." }));
          return;
        }
        signinFails.delete(ip);
        s = session(req, res, { create: true, secure: true });
        res.writeHead(302, { Location: "/" });
        res.end();
        return;
      }
      // Bolna server-to-server routes authenticate by the bearer capability
      // inside the adapter; they carry no browser session and must not be
      // gated by one (localhost tests never exercised this branch).
      s = isBolnaRoute ? null : session(req, res, { create: false });
      if (!isBolnaRoute && !s) {
        if (req.method === "GET" && STATIC[req.url]) {
          res.writeHead(302, { Location: "/owner-signin" });
          res.end();
          return;
        }
        res.writeHead(403);
        res.end(JSON.stringify({ error: "Owner access required." }));
        return;
      }
    } else {
      s = session(req, res);
    }
    if (s) s.at = Date.now();
    try {
      if (req.method === "GET" && STATIC[req.url]) {
        const [file, type] = STATIC[req.url];
        res.setHeader("Content-Type", type);
        if (type.startsWith("font/") || req.url.startsWith("/vendor/"))
          res.setHeader("Cache-Control", "private, max-age=86400");
        res.end(await readFile(new URL(file, import.meta.url)));
        return;
      }
      res.setHeader("Content-Type", "application/json");
      if (isBolnaRoute) {
        // Auth, body bounds, TTL and revocation all live in the adapter;
        // this route adds no state and trusts no session.
        const response = await voice.handle(
          new Request(origin + req.url, {
            signal: disconnected.signal,
            method: req.method,
            headers: { authorization: req.headers.authorization ?? "" },
            ...(req.method === "POST"
              ? {
                  body: await body(req)
                    .then(JSON.stringify)
                    .catch(() => ""),
                }
              : {}),
          }),
        );
        res.writeHead(response.status, {
          "Content-Type":
            response.headers.get("content-type") ?? "application/json",
        });
        if (response.body) {
          const reader = response.body.getReader();
          try {
            while (!disconnected.signal.aborted) {
              const { done, value } = await reader.read();
              if (done) break;
              if (!res.write(value))
                await new Promise((resolve) => {
                  res.once("drain", resolve);
                  res.once("close", resolve);
                });
            }
          } finally {
            await reader.cancel().catch(() => {});
          }
        }
        if (!res.destroyed) res.end();
        return;
      }
      if (req.method === "GET" && req.url === "/api/session") {
        res.end(JSON.stringify({ csrf: s.csrf }));
        return;
      }
      if (req.method === "GET" && req.url === "/api/bolna-config") {
        res.end(JSON.stringify({ configured: !!(bolnaKey && bolnaAgent) }));
        return;
      }
      // Explicit, session-scoped readiness: what a live demo needs right now
      // (corpus present, voice grant bound, fixed credential within its
      // absolute expiry, Bolna mint configured). Read-only; never binds,
      // imports or revives anything - recovery stays an explicit UI action.
      if (req.method === "GET" && req.url === "/api/readiness") {
        const bound = fixedCap
          ? voice.isBound(fixedCap)
          : !!(s.voiceToken && voice.isBound(s.voiceToken));
        const hardMs = voiceHardExpiresAtMs();
        const hardOk = !fixedCap || (hardMs !== null && hardMs > Date.now());
        const bolnaConfigured = !!(bolnaKey && bolnaAgent);
        // The corpus a call actually answers from: this session's imported
        // documents, or the boot-pinned fictional demo corpus. Naming the
        // pinned corpus explicitly keeps "no import yet" from reading as
        // "voice demo broken" - the pinned corpus IS the demo.
        // The pinned demo credential ALWAYS answers the pinned corpus -
        // owner imports never retarget it, so a typed upload must not
        // relabel what the voice call reads. Typed docs are reported
        // separately as sessionDocuments.
        const pinned = !!demoBundle;
        const corpusKind = pinned ? "pinned-demo" : s.bundle ? "session" : null;
        const corpusDocuments = pinned
          ? demoBundle.sources.length
          : s.bundle
            ? s.bundle.sources.length
            : 0;
        res.end(
          JSON.stringify({
            demo: !!demoBundle,
            corpusLoaded: corpusKind !== null,
            corpusKind,
            documents: corpusDocuments,
            sessionDocuments: s.bundle ? s.bundle.sources.length : 0,
            voice: {
              fixedCapability: !!fixedCap,
              bound,
              ownedByThisSession: fixedCap
                ? s.voiceToken === fixedCap && voice.isBound(fixedCap)
                : bound,
              hardExpiresAt:
                fixedCap && hardMs ? new Date(hardMs).toISOString() : null,
              secondsRemaining:
                fixedCap && hardMs
                  ? Math.max(0, Math.floor((hardMs - Date.now()) / 1000))
                  : null,
              bolnaConfigured,
            },
            ready:
              corpusKind !== null &&
              bound &&
              hardOk &&
              (!fixedCap || bolnaConfigured),
          }),
        );
        return;
      }
      // Owner-session evidence feed, read-only like /api/readiness: a plain
      // browser GET with the session cookie - no Origin or CSRF header, so it
      // must not live behind the mutating-POST gate. Demo mode correlates
      // honestly to the single pinned credential's last turn; no
      // multi-user claim.
      if (req.method === "GET" && req.url === "/api/voice/last") {
        const token = s.voiceToken ?? (demoBundle ? fixedCap : null);
        res.end(JSON.stringify({ turn: token ? voice.lastTurn(token) : null }));
        return;
      }
      // Session document library (read-only GETs, cookie-scoped like
      // /api/voice/last). Originals are served only to their own session.
      const libPath = new URL(req.url, origin).pathname;
      if (req.method === "GET" && libPath === "/api/library") {
        res.end(
          JSON.stringify({
            documents: libraryOf(s).map(publicEntry),
            indexed: s.bundle ? s.bundle.sources.length : 0,
            limits: {
              maxFileBytes: LIMITS.maxFileBytes,
              maxPdfPages: LIMITS.maxPdfPages,
              maxDocuments: 10,
            },
          }),
        );
        return;
      }
      const libMatch = /^\/api\/library\/([0-9a-f-]{36})(\/original)?$/.exec(
        libPath,
      );
      if (req.method === "GET" && libMatch) {
        const e = findEntry(s, libMatch[1]);
        if (!e) {
          res.writeHead(404);
          res.end(JSON.stringify({ error: "Not found." }));
          return;
        }
        if (libMatch[2]) {
          if (!e.original || !e.doc) {
            res.writeHead(404);
            res.end(JSON.stringify({ error: "Original not available." }));
            return;
          }
          // Inert delivery: never executable in this origin.
          res.setHeader("Content-Type", e.doc.mime);
          res.setHeader(
            "Content-Security-Policy",
            "default-src 'none'; sandbox",
          );
          res.setHeader(
            "Content-Disposition",
            "inline; filename*=UTF-8''" + encodeURIComponent(e.filename),
          );
          res.end(e.original);
          return;
        }
        res.end(JSON.stringify({ document: documentView(e) }));
        return;
      }
      // One-click demo fixture: the engineered 7-doc Northstar corpus, plain
      // filenames so claim supersession behaves (title prefixes are
      // extraction-sensitive). Session-gated like every app route.
      if (req.method === "GET" && req.url === "/api/demo-corpus") {
        const dir = new URL("./corpus-md/", import.meta.url);
        const documents = [];
        for (const f of (await readdir(dir))
          .filter((f) => f.endsWith(".md"))
          .sort())
          documents.push({
            title: f,
            text: await readFile(new URL(f, dir), "utf8"),
          });
        res.end(JSON.stringify({ documents }));
        return;
      }
      // The web-call SDK cannot carry our CSRF header, so /api/bolna-session
      // relies on the SameSite=Strict session cookie plus the Origin check
      // above: a cross-site POST reaches this route with neither.
      const sdkPost = req.url === "/api/bolna-session";
      if (
        req.method !== "POST" ||
        ![localOrigin, publicOrigin]
          .filter(Boolean)
          .includes(req.headers.origin) ||
        (!sdkPost && req.headers["x-csrf-token"] !== s.csrf)
      ) {
        res.writeHead(403);
        res.end(JSON.stringify({ error: "Session or origin check failed." }));
        return;
      }
      const postPath = new URL(req.url, origin).pathname;
      const isUpload = postPath === "/api/upload";
      const data = isUpload ? null : await body(req);
      const libPost =
        /^\/api\/library\/([0-9a-f-]{36})\/(include|remove)$/.exec(postPath);
      let out;
      if (isUpload) {
        // Binary upload, one file per request. The filename travels in a
        // header (URI-encoded); it is display-only and never touches disk.
        const filename = decodeURIComponent(
          String(req.headers["x-file-name"] ?? "untitled"),
        ).slice(0, 400);
        const bytes = await rawBody(req, LIMITS.maxFileBytes);
        // Memory guard: OCR must never share the 512MB budget with the
        // resident embedding model; dense pauses until this upload settles.
        await pauseDenseForIngest();
        const entry = addUpload(s, bytes, filename, rebuildIndex);
        const up0 = Date.now();
        const iv = setInterval(() => {
          const settled = ["ready", "needs_review", "failed"].includes(
            entry.status,
          );
          if (settled || Date.now() - up0 > 120000) {
            clearInterval(iv);
            resumeDenseAfterIngest(s.bundle?.rows ?? null);
          }
        }, 500);
        iv.unref?.();
        res.writeHead(202);
        out = { document: publicEntry(entry) };
      } else if (libPost) {
        const e = findEntry(s, libPost[1]);
        if (!e) {
          const err = Error("That document is no longer in this session.");
          err.status = 404;
          throw err;
        }
        if (libPost[2] === "include") {
          if (e.status !== "needs_review")
            throw Error("Only documents waiting for review can be included.");
          e.included = true;
          e.updatedAt = Date.now();
        } else {
          removeEntry(s, e.id);
          e.original = null;
          e.doc = null;
        }
        rebuildIndex(s);
        out = { documents: libraryOf(s).map(publicEntry) };
      } else if (req.url === "/api/import") {
        const bundle = importBundle(data.documents);
        // If THIS session owns the fixed capability, retarget it atomically:
        // a generic release would leave the 10-minute active-call guard
        // pinning the OLD bundle, so bearer traffic would keep answering
        // from the stale corpus until hard expiry.
        replaceWithText(s, data.documents);
        s.sourceToEntry = new Map(
          bundle.sources.map((src, i) => [src.id, libraryOf(s)[i]]),
        );
        bundle.locateEvidence = locatorFor(s.sourceToEntry);
        setSessionBundle(s, bundle);
        // Phase 3 hybrid: fill chunk embeddings in the background so later
        // queries can re-rank densely. Fail-closed: until the model warms,
        // and on any failure, rows stay vectorless and retrieval stays
        // keyword-only.
        warmDense(bundle.rows);
        out = {
          sources: s.bundle.sources.map(({ id, title, hash, memory }) => ({
            id,
            title,
            hash,
            blocks: memory.blocks.length,
          })),
          dense: denseAvailableFor(s.bundle),
        };
      } else if (req.url === "/api/query") {
        if (!s.bundle) throw Error("Add documents first.");
        if (typeof data?.question !== "string")
          throw Error("Ask a question of 1-4,000 characters.");
        // Voice notes arrive as speech text ("forty two thousand"); the same
        // notation-only normalization the voice endpoint applies.
        if (data.question.length <= 4000)
          data.question = normalizeSpoken(data.question) || data.question;
        // Context for follow-ups: an explicit note context from the client
        // (parallel voice notes carry the field they were asked after), else
        // the session's last field.
        // `context: null` = explicitly none (a standalone note); a field name
        // = answer as a follow-up to that field; absent = session's last field.
        const ctx =
          data.context === null
            ? ""
            : typeof data.context === "string" &&
                /^[A-Za-z]{1,40}$/.test(data.context)
              ? data.context
              : (s.lastField ?? "");
        const bundle = s.bundle;
        // Dense availability is part of the key: a keyword-only answer cached
        // while the embedder was warming must not outlive the warm-up.
        const key = answerCache.key(
          bundle.scope + (denseAvailableFor(bundle) ? ":d" : ":k"),
          data.question,
          ctx,
          detectLang(data.question),
        );
        const { json, cache } = await answerCache.resolve(key, async () => {
          const queryVector = await embedQueryReady(data.question);
          const raw = answer(data.question, bundle, {
            queryVector,
            model: DENSE_MODEL_ID,
            available: denseAvailableFor(bundle),
          });
          const shown = decorateResult(raw, s);
          // Typed follow-ups ("so finance rejected it?") inherit the previous
          // question's field, exactly as the voice grant does.
          shown.lead = leadFor(data.question, raw, bundle, ctx || null);
          if (shown.lead)
            shown.lead.citations = decorateResult(
              { evidence: shown.lead.citations, question: data.question },
              s,
            ).evidence;
          return { raw, shown };
        });
        if (s.bundle !== bundle)
          throw Error("Documents changed while answering; ask again.");
        const cached = JSON.parse(json);
        s.result = cached.raw;
        out = cached.shown;
        if (out.lead) s.lastField = out.lead.field ?? s.lastField ?? null;
        out.cache = cache;
      } else if (req.url === "/api/draft") {
        if (!s.bundle || !s.result) throw Error("Ask a question first.");
        out = draft(s.result, s.bundle);
      } else if (req.url === "/api/bolna-session") {
        // Thin, session-gated proxy for Bolna's web-call session mint
        // (official SDK backend pattern): the Bolna API key never reaches
        // the browser. A remote voice call must be bound to this session's
        // documents first: no imported bundle or no voice grant, no mint.
        // Pinned-demo parity: demo mode binds the fixed credential to the
        // pinned corpus at /api/voice/start and keeps no session-local
        // bundle or grant, so the mint follows the adapter's pinned-
        // credential admission: isBound is live only while the grant is
        // unretired, unlapsed, and inside the immutable hard expiry
        // (grant lifetime is capped at the credential's hard expiry).
        // An expired or retired pin never reaches Bolna.
        const demoPinned =
          !!fixedCap && !!demoBundle && voice.isBound(fixedCap);
        if (!demoPinned && !s.bundle) {
          const e = Error("Import documents before starting a live call.");
          e.status = 400;
          throw e;
        }
        if (!demoPinned && !s.voiceToken) {
          const e = Error("Voice grant not started for this session.");
          e.status = 400;
          throw e;
        }
        if (!bolnaKey || !bolnaAgent) {
          const e = Error("Bolna web call is not configured on this server.");
          e.status = 503;
          throw e;
        }
        const mint = await fetch("https://api.bolna.ai/web-call/session", {
          method: "POST",
          headers: {
            authorization: "Bearer " + bolnaKey,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            agent_id: bolnaAgent,
            user_data: data?.user_data,
          }),
          signal: AbortSignal.timeout(10000),
        });
        if (!mint.ok) {
          const e = Error("Bolna session request failed.");
          e.status = 502;
          throw e;
        }
        out = await mint.json();
      } else if (req.url === "/api/voice/start") {
        if (!s.bundle && !demoBundle) throw Error("Add documents first.");
        if (fixedCap && demoBundle) {
          if (!voice.isBound(fixedCap)) {
            try {
              voice.bind(demoBundle, fixedCap);
            } catch (e) {
              if (/retired|hard expiry/i.test(e.message))
                throw Error(
                  "Voice capability was retired or expired. Rotate it by redeploying with a new capability.",
                );
              throw e;
            }
          }
          s.voiceToken = null;
        } else if (fixedCap) {
          if (!voiceHardExpiresAtMs())
            throw Error(
              "Voice capability has no configured absolute expiry (VM_VOICE_HARD_EXPIRES_AT). Set a fixed timestamp and redeploy.",
            );
          if (s.voiceToken === fixedCap && voice.isBound(fixedCap)) {
            // Idempotent: this session already owns the live capability.
          } else if (voice.isBound(fixedCap)) {
            throw Error(
              `Voice capability is live in another session. Wait for its voice grant to lapse (${lapseText(voiceTtlMs())} of voice inactivity), then start voice here again. Do not reset a session to free it: resetting retires this credential for the rest of this deployment.`,
            );
          } else {
            try {
              s.voiceToken = voice.bind(s.bundle, fixedCap);
            } catch (e) {
              if (/retired|hard expiry/i.test(e.message))
                throw Error(
                  "Voice capability was retired or expired. Rotate it by redeploying with a new capability.",
                );
              throw e;
            }
          }
        } else {
          releaseVoice(s);
          s.voiceToken = voice.bind(s.bundle);
        }
        out = {
          ready: true,
          mode: "local-contract",
          demo: !!demoBundle,
          audioConnected: false,
          synthesisConnected: false,
        };
      } else if (req.url === "/api/voice/turn") {
        if (!s.voiceToken)
          throw Error("Start a local voice-contract session first.");
        const response = await voice.handle(
          new Request(origin + "/v1/chat/completions", {
            signal: disconnected.signal,
            method: "POST",
            headers: { authorization: "Bearer " + s.voiceToken },
            body: JSON.stringify(data),
          }),
        );
        res.writeHead(response.status, {
          "Content-Type": response.headers.get("content-type"),
        });
        if (!response.body) {
          res.end();
          return;
        }
        const reader = response.body.getReader();
        try {
          while (!disconnected.signal.aborted) {
            const { done, value } = await reader.read();
            if (done) break;
            if (!res.write(value))
              await new Promise((resolve) => {
                res.once("drain", resolve);
                res.once("close", resolve);
              });
          }
        } finally {
          await reader.cancel().catch(() => {});
        }
        if (!res.destroyed) res.end();
        return;
      } else if (req.url === "/api/reset") {
        if (demoBundle && fixedCap) voice.retire(fixedCap);
        retireVoice(s);
        s.bundle = null;
        s.result = null;
        s.lastField = null;
        libraryOf(s).length = 0;
        s.sourceToEntry = new Map();
        out = { reset: true };
      } else {
        res.writeHead(404);
        out = { error: "Not found." };
      }
      res.end(JSON.stringify(out));
    } catch (err) {
      if (res.destroyed) return;
      if (res.headersSent) {
        res.end();
        return;
      }
      res.writeHead(
        Number.isSafeInteger(err?.status) &&
          err.status >= 400 &&
          err.status < 600
          ? err.status
          : 400,
      );
      res.end(
        JSON.stringify({
          error: err instanceof Error ? err.message : "Request failed.",
        }),
      );
    }
  });
  return server;
}
export const server = createLocalServer();
if (process.argv[1] === new URL(import.meta.url).pathname)
  server.listen(
    Number(process.env.PORT || 4317),
    process.env.VM_BIND_HOST || "127.0.0.1",
    () => console.log("Voice-memory server ready"),
  );
