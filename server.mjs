import http from "node:http";
import { readFile, readdir } from "node:fs/promises";
import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import { importBundle, answer, draft } from "./dist/engine.mjs";
import { createVoiceAdapter } from "./voice-adapter.mjs";
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
  const signinFails = new Map();
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
        if (
          req.method === "GET" &&
          ["/", "/app.js", "/style.css"].includes(req.url)
        ) {
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
      if (
        req.method === "GET" &&
        ["/", "/app.js", "/style.css"].includes(req.url)
      ) {
        const file = req.url === "/" ? "index.html" : req.url.slice(1);
        res.setHeader(
          "Content-Type",
          file.endsWith("html")
            ? "text/html"
            : file.endsWith("js")
              ? "text/javascript"
              : "text/css",
        );
        res.end(await readFile(new URL("./public/" + file, import.meta.url)));
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
      const data = await body(req);
      let out;
      if (req.url === "/api/import") {
        const bundle = importBundle(data.documents);
        // If THIS session owns the fixed capability, retarget it atomically:
        // a generic release would leave the 10-minute active-call guard
        // pinning the OLD bundle, so bearer traffic would keep answering
        // from the stale corpus until hard expiry.
        if (fixedCap && s.voiceToken === fixedCap)
          voice.retarget(fixedCap, bundle);
        else releaseVoice(s);
        s.bundle = bundle;
        s.result = null;
        out = {
          sources: s.bundle.sources.map(({ id, title, hash, memory }) => ({
            id,
            title,
            hash,
            blocks: memory.blocks.length,
          })),
        };
      } else if (req.url === "/api/query") {
        if (!s.bundle) throw Error("Add documents first.");
        out = s.result = answer(data.question, s.bundle);
      } else if (req.url === "/api/draft") {
        if (!s.bundle || !s.result) throw Error("Ask a question first.");
        out = draft(s.result, s.bundle);
      } else if (req.url === "/api/bolna-session") {
        // Thin, session-gated proxy for Bolna's web-call session mint
        // (official SDK backend pattern): the Bolna API key never reaches
        // the browser. A remote voice call must be bound to this session's
        // documents first: no imported bundle or no voice grant, no mint.
        if (!s.bundle) {
          const e = Error("Import documents before starting a live call.");
          e.status = 400;
          throw e;
        }
        if (!s.voiceToken) {
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
        if (!s.bundle) throw Error("Add documents first.");
        if (fixedCap) {
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
      } else if (req.url === "/api/voice/last") {
        out = { turn: s.voiceToken ? voice.lastTurn(s.voiceToken) : null };
      } else if (req.url === "/api/reset") {
        retireVoice(s);
        s.bundle = null;
        s.result = null;
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
