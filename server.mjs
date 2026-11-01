import http from "node:http";
import { readFile, readdir } from "node:fs/promises";
import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import { paraphraseLookup } from "./paraphrase.mjs";
import {
  repairDealTerms,
  stripPreamble,
  isHindi,
  langOfText,
  isDealQuestion,
  glossHindi,
  toHindi,
} from "./conversation.mjs";
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
  denseCacheSuffix,
  denseStatus,
  embedQueryReady,
  pauseDenseForIngest,
  resumeDenseAfterIngest,
  warmDense,
} from "./dense.mjs";
import { spokenTurn } from "./spoken.mjs";
import { extractiveSpoken } from "./spoken-extract.mjs";
import {
  clinicalTurn,
  clinicalOverview,
  clinicalReportsFor,
  observationEvidence,
} from "./clinical/answer.mjs";
import { extractReport } from "./clinical/observations.mjs";
import { detectLang } from "./clinical/explain.mjs";
import { normalizeSpoken } from "./spoken-normalize.mjs";
import { createMemory, recordTurn, liveEpisodes } from "./memory/memory.mjs";
import { buildGraph } from "./memory/graph.mjs";
import { createStore, snapshotOf, restoreInto } from "./memory/store.mjs";
import { createAnswerCache } from "./cache.mjs";
import { readdirSync } from "node:fs";
import { NORTHSTAR_DOCS } from "./corpus-northstar.mjs";
import { createPublicApi, publicAnswer } from "./public-api.mjs";
import { createRssWatchdog } from "./rss-watchdog.mjs";
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
  globalBytes,
  parseCacheStats,
} from "./library.mjs";
// Static assets: explicit allow-list (no path joining from the URL).
const STATIC = {
  "/": ["./public/index.html", "text/html; charset=utf-8"],
  "/app.js": ["./public/app.js", "text/javascript"],
  "/workspace.js": ["./public/workspace.js", "text/javascript"],
  "/viewer.js": ["./public/viewer.js", "text/javascript"],
  "/notes.js": ["./public/notes.js", "text/javascript"],
  "/motion.js": ["./public/motion.js", "text/javascript"],
  "/voicelab.js": ["./public/voicelab.js", "text/javascript"],
  "/graph.js": ["./public/graph.js", "text/javascript"],
  "/start.js": ["./public/start.js", "text/javascript"],
  "/voicelab-score.mjs": ["./public/voicelab-score.mjs", "text/javascript"],
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
      const c =
        clinicalTurn(question, bundle.clinical) ??
        clinicalOverview(question, bundle.clinical);
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
const LANDING_URL =
  process.env.VM_LANDING_URL || "https://voice-memory-beige.vercel.app/";
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
  // The dense shed-guard (dense.mjs) is the primary memory protection: on a
  // host with a readable cgroup limit it bounds RSS by shedding dense and
  // refusing reloads (measured 221 MiB stable across upload cycles at a 512
  // MiB limit). The RSS watchdog is an opt-in restart backstop only; its
  // admission control caused false 503s in measured runs, so it is off
  // unless explicitly enabled with VM_RSS_WATCHDOG=on.
  watchdog = createRssWatchdog({
    disabled: process.env.VM_RSS_WATCHDOG !== "on",
  }),
} = {}) {
  // Deployment configuration (all optional; unset = local-only behavior):
  // VM_PUBLIC_HOST / VM_PUBLIC_ORIGIN: the one public hostname/origin the UI
  // may be reached at. VM_OWNER_KEY: owner bootstrap secret (vault-held) that
  // creates a UI session; without it the public host serves nothing.
  // VM_VOICE_CAPABILITY: fixed bearer capability for the Bolna endpoint.
  const publicHost = process.env.VM_PUBLIC_HOST || null;
  // Encrypted at-rest persistence of the OWNER's workspace (memory/store.mjs).
  // Off unless VM_DATA_DIR is set; VM_DATA_DIR without VM_STORE_KEY throws.
  const store = createStore({
    dir: process.env.VM_DATA_DIR || null,
    keyHex: process.env.VM_STORE_KEY || null,
  });
  const persistTimers = new WeakMap();
  const schedulePersist = (s) => {
    if (!store || !s?.persistNs) return;
    clearTimeout(persistTimers.get(s));
    persistTimers.set(
      s,
      setTimeout(() => {
        try {
          const snap = snapshotOf(s);
          // An empty workspace leaves nothing on disk.
          if (!snap.library.length && !(snap.memory?.episodes ?? []).length)
            store.remove(s.persistNs);
          else store.save(s.persistNs, snap);
        } catch (e) {
          // Never log content: the error class only.
          console.error("persist failed:", e?.code ?? e?.name ?? "error");
        }
      }, 250),
    );
  };
  const restoreOwner = (s) => {
    if (!store || s.persistNs) return;
    s.persistNs = "owner";
    try {
      if (restoreInto(s, store.load("owner")) && s.library.length)
        rebuildIndex(s);
    } catch (e) {
      console.error("restore failed:", e?.code ?? e?.name ?? "error");
    }
  };
  const publicOrigin = process.env.VM_PUBLIC_ORIGIN || null;
  // VM_OWNER_SIGNIN=off removes the hosted owner workspace entirely: the
  // public host then serves only the landing API, the Bolna routes and a
  // redirect to the landing page (the buildathon deployment runs this way).
  const ownerKey =
    process.env.VM_OWNER_SIGNIN === "off"
      ? null
      : process.env.VM_OWNER_KEY || null;
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
  // Voice turns land in the episodic memory of the session that owns the
  // token, and only while that session still holds the same documents.
  const voiceCase = {
    sid: "case:voice",
    memory: createMemory(),
    internal: true,
  };
  // Verified turns of public calls (every fictional case answers on the
  // fixed credential), read back only by the caller holding the ticket.
  const publicTurns = [];
  voice.setOnTurn?.((token, t) => {
    const feedCase =
      token === fixedCap
        ? voiceCase.bundle && t.scope === voiceCase.bundle.scope
          ? voiceCase
          : [...workspaces.values()].find((w) => w.s.bundle?.scope === t.scope)
              ?.s
        : null;
    if (feedCase) {
      const lead = t.lead
        ? {
            text: t.lead.spoken,
            verdict: t.lead.verdict,
            field: t.lead.field ?? null,
            citations: decorateResult(
              { evidence: t.lead.citations ?? [], question: t.question },
              feedCase,
            ).evidence,
          }
        : null;
      publicTurns.push({ at: Date.now(), question: t.question, lead });
      if (publicTurns.length > 20) publicTurns.shift();
    }
    for (const ss of sessions.values())
      if (ss.voiceToken === token && ss.bundle?.scope === t.scope) {
        recordTurn(ss.memory, { ...t, channel: "voice" });
        schedulePersist(ss);
      }
  });
  const origin = `http://127.0.0.1:${port}`;
  function session(
    req,
    res,
    { create = true, secure = false, fresh = false } = {},
  ) {
    let id = fresh
      ? null
      : (req.headers.cookie || "")
          .split("; ")
          .find((c) => c.startsWith("vm="))
          ?.slice(3);
    if ((!id || !sessions.has(id)) && !create) return null;
    if (!id || !sessions.has(id)) {
      id = randomBytes(32).toString("hex");
      sessions.set(id, {
        sid: id,
        at: Date.now(),
        memory: createMemory(),
        csrf: randomBytes(32).toString("hex"),
      });
      res.setHeader(
        "Set-Cookie",
        `vm=${id}; HttpOnly; SameSite=Strict; Path=/${secure ? "; Secure" : ""}`,
      );
    }
    // Local single-user app (no public host configured): this machine's
    // workspace is the owner's. On a public host only /owner-signin restores.
    if (store && !publicHost && !sessions.get(id).persistNs)
      restoreOwner(sessions.get(id));
    if (sessions.size > 50) {
      const oldest = sessions.keys().next().value;
      if (oldest !== id) {
        releaseVoice(sessions.get(oldest));
        const lib = sessions.get(oldest).library;
        if (lib) lib.length = 0;
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
    schedulePersist(s);
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
  // One deterministic answer path for the workspace, the public landing API
  // and (via the same leadFor) the voice call: engine answer, located
  // citations, and the short lead sentence a call would speak.
  async function resolveAnswer(s, question, ctx) {
    const bundle = s.bundle;
    // Retrieval mode is part of the key: a keyword or partial-warm
    // answer cached while the embedder was cold or warming must not
    // outlive that state (see denseCacheSuffix in dense.mjs).
    const key = answerCache.key(
      bundle.scope + denseCacheSuffix(bundle),
      question,
      ctx,
      detectLang(question),
    );
    return answerCache.resolve(key, async () => {
      // Phrased any way: drop a leading greeting, repair the deal's names,
      // and ask a Hindi deal question in the English the engine reads (lab
      // questions are understood in Hindi directly). The answer is rendered
      // back in Hindi below.
      const original = question;
      question = repairDealTerms(stripPreamble(question)) || question;
      const hindi = isHindi(langOfText(original));
      const gloss =
        hindi && (isDealQuestion(question) || !bundle.clinical?.length)
          ? glossHindi(question)
          : null;
      if (gloss) question = gloss;
      const queryVector = await embedQueryReady(question);
      const raw = answer(question, bundle, {
        queryVector,
        model: DENSE_MODEL_ID,
        available: denseAvailableFor(bundle),
      });
      const shown = decorateResult(raw, s);
      // Typed follow-ups ("so finance rejected it?") inherit the previous
      // question's field, exactly as the voice grant does.
      shown.lead = leadFor(question, raw, bundle, ctx || null);
      // Reworded beyond keyword reach: one verbatim sentence with its
      // citation, only when the calibrated paraphrase gate is unambiguous.
      if (!shown.lead || shown.lead.verdict === "UNKNOWN") {
        const p = await paraphraseLookup(question, bundle).catch(() => null);
        if (p)
          shown.lead = {
            text: p.spoken,
            verdict: "QUOTED",
            field: null,
            citations: [p.citation],
          };
      }
      if (gloss && shown.lead?.text) shown.lead.text = toHindi(shown.lead.text);
      if (shown.lead)
        shown.lead.citations = decorateResult(
          { evidence: shown.lead.citations, question },
          s,
        ).evidence;
      return { raw, shown };
    });
  }
  // Built-in fictional cases for the public landing page. Each is an
  // internal, read-only session (never reachable by cookie): the synthetic
  // lab reports are parsed by the same ingest worker as uploads, so their
  // citations point at real PDF pages. "voice" holds every fictional record
  // and is what the fixed Bolna credential answers from.
  const CASE_FILES = {
    health: [
      "a-2026-09.pdf",
      "a-2026-10-prelim.pdf",
      "a-2026-10-amended.pdf",
      "c-2026-10.pdf",
    ],
  };
  const caseSessions = {};
  const bundleFor = (target, docsIn) => {
    const bundle = importBundle(
      docsIn.map((e) => ({ title: e.title, text: e.doc.text })),
    );
    target.sourceToEntry = new Map(
      bundle.sources.map((src, i) => [src.id, docsIn[i]]),
    );
    target.library = docsIn;
    bundle.locateEvidence = locatorFor(target.sourceToEntry);
    bundle.clinical = clinicalReportsFor(bundle, docsIn, extractReport);
    target.bundle = bundle;
    return target;
  };
  const stableDocId = (sid, filename) => {
    const h = createHash("sha256")
      .update(`vm-demo:${sid}:${filename}`)
      .digest("hex");
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
  };
  async function loadCase(target, files, docs = null) {
    if (docs) replaceWithText(target, docs);
    for (const f of files ?? []) {
      const bytes = await readFile(
        new URL("./clinical/fixtures/files/" + f, import.meta.url),
      );
      addUpload(target, bytes, f, () => {});
    }
    for (let i = 0; i < 1200; i++) {
      const lib = libraryOf(target);
      if (
        lib.every((e) => ["ready", "needs_review", "failed"].includes(e.status))
      )
        break;
      await new Promise((r) => setTimeout(r, 100));
    }
    for (const e of libraryOf(target)) {
      if (e.status === "needs_review") e.included = true;
      // Demo documents get ids derived from the case and file name, so they
      // are the same on every boot. Answers and case lists can then be cached
      // at the CDN across free-tier restarts without pointing at documents
      // that no longer exist. Visitor uploads keep random, unguessable ids.
      e.id = stableDocId(target.sid, e.filename);
    }
    return bundleFor(target, indexable(target));
  }
  // Loaded on first use (tests that never touch /api/public pay nothing);
  // the production entry point calls it at boot with bindVoice = true.
  let casesReady = null;
  const loadPublicCases = ({ bindVoice = false } = {}) => {
    casesReady ??= (async () => {
      const mk = (id) => ({
        sid: "case:" + id,
        memory: createMemory(),
        internal: true,
      });
      try {
        caseSessions.deal = await loadCase(mk("deal"), [], NORTHSTAR_DOCS);
        caseSessions.health = await loadCase(mk("health"), CASE_FILES.health);
        bundleFor(voiceCase, [
          ...caseSessions.deal.library,
          ...caseSessions.health.library,
        ]);
      } catch (e) {
        console.error("case load failed:", e?.code ?? e?.message ?? "error");
      }
    })();
    if (bindVoice)
      casesReady.then(() => {
        // The fixed Bolna credential answers every fictional case.
        if (!fixedCap || !voiceCase.bundle) return;
        if (voice.retarget(fixedCap, voiceCase.bundle)) return;
        try {
          voice.bind(voiceCase.bundle, fixedCap);
        } catch (e) {
          console.warn("public voice not bound:", e.message);
        }
      });
    return casesReady;
  };
  // Bolna web-call session mint. SDK v3.0.1 expects the FreeSWITCH session
  // shape ({run_id, wss_url, sip_username, ...}); the older /web-call/session
  // route is only a fallback for accounts that do not have it.
  async function mintBolna(userData) {
    if (!bolnaKey || !bolnaAgent) {
      const e = Error("Bolna web call is not configured on this server.");
      e.status = 503;
      throw e;
    }
    let last = null;
    for (const route of ["/web-call/freeswitch-session", "/web-call/session"]) {
      const r = await fetch("https://api.bolna.ai" + route, {
        method: "POST",
        headers: {
          authorization: "Bearer " + bolnaKey,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          agent_id: bolnaAgent,
          ...(userData && typeof userData === "object"
            ? { user_data: userData }
            : {}),
        }),
        signal: AbortSignal.timeout(10000),
      });
      if (r.status === 404 || r.status === 405) {
        last = r.status;
        continue;
      }
      if (r.status === 429) {
        const e = Error("All voice lines are busy. Try again shortly.");
        e.status = 429;
        throw e;
      }
      if (!r.ok) {
        console.warn("bolna mint failed:", route, r.status);
        const e = Error("Bolna session request failed.");
        e.status = 502;
        throw e;
      }
      return r.json();
    }
    console.warn("bolna mint: no session route", last);
    const e = Error("Bolna session request failed.");
    e.status = 502;
    throw e;
  }
  // Visitor workspaces: anyone can upload their own documents from the
  // landing page into a private, short-lived workspace named by an
  // unguessable id. Same ingest worker (PDF / DOCX / scans with OCR / text),
  // same index (BM25 + guarded dense embeddings), same evidence gate and
  // clinical layer as everything else. Memory-bounded: few files, few
  // workspaces, idle ones evicted.
  const WS_MAX = Number(process.env.VM_WS_MAX || 12);
  const WS_FILES = Number(process.env.VM_WS_FILES || 5);
  const WS_IDLE_MS = Number(process.env.VM_WS_IDLE_MIN || 30) * 60000;
  const workspaces = new Map(); // id -> { s, at }
  const dropWorkspace = (id) => {
    const w = workspaces.get(id);
    if (!w) return;
    libraryOf(w.s).length = 0; // frees the global document budget
    w.s.bundle = null;
    workspaces.delete(id);
  };
  const sweepWorkspaces = () => {
    for (const [id, w] of workspaces)
      if (Date.now() - w.at > WS_IDLE_MS) dropWorkspace(id);
    while (workspaces.size >= WS_MAX)
      dropWorkspace(workspaces.keys().next().value);
  };
  const rebuildWorkspace = (ws) => {
    const docsIn = indexable(ws);
    for (const e of libraryOf(ws))
      if (e.status === "needs_review") e.included = true;
    if (!docsIn.length) {
      ws.bundle = null;
      return;
    }
    const docsNow = indexable(ws);
    const bundle = importBundle(
      docsNow.map((e) => ({ title: e.title, text: e.doc.text })),
    );
    ws.sourceToEntry = new Map(
      bundle.sources.map((src, i) => [src.id, docsNow[i]]),
    );
    bundle.locateEvidence = locatorFor(ws.sourceToEntry);
    bundle.clinical = clinicalReportsFor(bundle, docsNow, extractReport);
    ws.bundle = bundle; // the library keeps every entry, indexed or not
    warmDense(bundle.rows);
  };
  const workspaceApi = {
    create() {
      sweepWorkspaces();
      const id = "w_" + randomBytes(16).toString("hex");
      const ws = { sid: "ws:" + id, memory: createMemory(), internal: true };
      workspaces.set(id, { s: ws, at: Date.now() });
      return { id, maxFiles: WS_FILES, idleMinutes: WS_IDLE_MS / 60000 };
    },
    get(id) {
      const w = workspaces.get(id);
      if (!w) return null;
      w.at = Date.now();
      return w.s;
    },
    async upload(id, bytes, filename) {
      const ws = this.get(id);
      if (!ws) {
        const e = Error("This workspace has expired. Start a new one.");
        e.status = 404;
        throw e;
      }
      if (
        libraryOf(ws).filter((e) => e.status !== "failed").length >= WS_FILES
      ) {
        const e = Error(`Up to ${WS_FILES} files per workspace.`);
        e.status = 409;
        throw e;
      }
      await pauseDenseForIngest();
      const entry = addUpload(ws, bytes, filename, (x) => rebuildWorkspace(x));
      const t0 = Date.now();
      const iv = setInterval(() => {
        if (
          ["ready", "needs_review", "failed"].includes(entry.status) ||
          Date.now() - t0 > 120000
        ) {
          clearInterval(iv);
          if (entry.status === "needs_review") rebuildWorkspace(ws);
          resumeDenseAfterIngest(ws.bundle?.rows ?? null);
        }
      }, 400);
      iv.unref?.();
      return publicEntry(entry);
    },
    status(id) {
      const ws = this.get(id);
      if (!ws) return null;
      return {
        ready: !!ws.bundle,
        documents: libraryOf(ws).map((e) => ({
          ...publicEntry(e),
          title: e.title,
          pages: e.doc?.pages?.length ?? null,
        })),
      };
    },
  };
  // Calls that carry a workspace id (Bolna substitutes {vm_ws} into the
  // agent prompt) answer from that visitor's documents.
  voice.setBundleResolver?.((messages) => {
    for (const m of messages ?? []) {
      const text =
        typeof m?.content === "string"
          ? m.content
          : JSON.stringify(m?.content ?? "");
      const id = /vm_ws=(w_[0-9a-f]{32})/.exec(text)?.[1];
      if (id) return workspaces.get(id)?.s?.bundle ?? null;
    }
    return null;
  });
  const publicApi = createPublicApi({
    cases: caseSessions,
    workspaces: workspaceApi,
    resolve: async (cs, question, ctx) => {
      const q = normalizeSpoken(question) || question;
      const { json } = await resolveAnswer(cs, q, ctx);
      return { ...JSON.parse(json).shown, question };
    },
    mintVoice: mintBolna,
    voiceTurns: (since) =>
      publicTurns
        .filter((t) => t.at >= since)
        .map((t) => ({
          ...t,
          lead: t.lead && publicAnswer({ lead: t.lead }).lead,
        })),
    voiceState: () => ({
      configured: !!(bolnaKey && bolnaAgent),
      ready:
        !!voiceCase.bundle &&
        (!fixedCap || voice.isBound(fixedCap) || !!voiceHardExpiresAtMs()),
    }),
  });
  const server = http.createServer(async (req, res) => {
    watchdog.beginRequest();
    res.once("close", () => watchdog.endRequest());
    // Memory admission control: expensive routes are refused with 503 +
    // Retry-After BEFORE the process nears the host's hard RSS kill line,
    // so pressure never silently kills a request we chose to accept.
    // Thresholds are measured (see rss-watchdog.mjs), not picked round.
    const EXPENSIVE = new Set([
      "/api/upload",
      "/api/import",
      "/api/query",
      "/api/voice/start",
      "/v1/chat/completions",
    ]);
    if (req.method === "POST" && EXPENSIVE.has(req.url) && !watchdog.admit()) {
      res.writeHead(503, { "Retry-After": "5" });
      res.end(
        JSON.stringify({
          error:
            "Server is under memory pressure; expensive requests are paused. Retry in a few seconds.",
        }),
      );
      return;
    }
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
          // Memory only: no documents, questions or identities.
          documents: {
            retainedBytes: globalBytes(),
            parseCache: { ...parseCacheStats },
          },
          memory: denseStatus().memory,
          dense: {
            ready: denseStatus().ready,
            disabled: denseStatus().disabled,
          },
        }),
      );
      return;
    }
    // Public landing API: key-free, read-only, rate-limited (public-api.mjs).
    if (req.url.startsWith("/api/public/")) {
      loadPublicCases();
      res.setHeader("Content-Type", "application/json");
      if (await publicApi(req, res)) return;
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
        if (!ownerKey) {
          res.writeHead(302, { Location: LANDING_URL });
          res.end();
          return;
        }
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
        // fresh: a visitor holding a demo session must get a NEW owner
        // session, not the demo session upgraded; the demo flag and the
        // synthetic corpus never attach to an owner session.
        s = session(req, res, { create: true, secure: true, fresh: true });
        delete s.demo;
        restoreOwner(s);
        res.writeHead(302, { Location: "/" });
        res.end();
        return;
      }
      // Bolna server-to-server routes authenticate by the bearer capability
      // inside the adapter; they carry no browser session and must not be
      // gated by one (localhost tests never exercised this branch).
      s = isBolnaRoute ? null : session(req, res, { create: false });
      if (!isBolnaRoute && !s) {
        // No owner session: the hosted product is the public landing page
        // and its key-free API (/api/public/*). Without an owner key the
        // workspace does not exist on the public host at all.
        if (req.method === "GET" && STATIC[req.url]) {
          res.writeHead(302, {
            Location: ownerKey ? "/owner-signin" : LANDING_URL,
          });
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
            // Memory pressure state, reported not hidden: the owner can see
            // when admission control is close to refusing expensive work.
            memory: watchdog.state(),
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
      // Memory and knowledge graph (owner session, read-only GETs). The graph
      // is rebuilt from evidence + episodes on each request: it cannot drift
      // from the documents, and it grows with every answered question.
      if (req.method === "GET" && req.url.startsWith("/api/graph")) {
        const focus =
          new URL(req.url, origin).searchParams.get("focus") || "overview";
        if (!/^[\w:./%-]{1,200}$/.test(focus)) {
          res.statusCode = 400;
          res.end(JSON.stringify({ error: "Bad focus" }));
          return;
        }
        const g = buildGraph(s.bundle, s.memory, focus);
        // Map evidence spans and documents to library ids so a click opens
        // the original in the viewer (same as a citation).
        const docId = (sid) => s.sourceToEntry?.get(sid)?.id ?? null;
        for (const n of g.nodes) {
          if (n.kind === "document") n.documentId = docId(n.id.slice(4));
          if (n.evidence) n.evidence.documentId = docId(n.evidence.sourceId);
        }
        for (const e of g.edges)
          if (e.evidence) e.evidence.documentId = docId(e.evidence.sourceId);
        res.end(JSON.stringify(g));
        return;
      }
      if (req.method === "GET" && req.url === "/api/memory") {
        res.end(
          JSON.stringify({
            working: s.memory.working,
            episodes: liveEpisodes(s.memory, s.bundle).slice(-50),
            total: s.memory.episodes.length,
          }),
        );
        return;
      }
      // Voice lab feed: the transcript Bolna actually delivered for each
      // turn plus server receipt / first-byte wall-clock times and the
      // server's current time (for browser clock alignment). Same owner
      // session gate as /api/voice/last; read-only.
      if (req.method === "GET" && req.url === "/api/voice/turns") {
        const token = s.voiceToken ?? (demoBundle ? fixedCap : null);
        res.end(
          JSON.stringify({
            serverNow: Date.now(),
            turns: token ? voice.turnLog(token) : [],
          }),
        );
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
        const { json, cache } = await resolveAnswer(s, data.question, ctx);
        if (s.bundle !== bundle)
          throw Error("Documents changed while answering; ask again.");
        const cached = JSON.parse(json);
        s.result = cached.raw;
        out = cached.shown;
        if (out.lead) s.lastField = out.lead.field ?? s.lastField ?? null;
        out.cache = cache;
        // Episodic memory: interaction only, exact spans, never authority.
        out.episode = recordTurn(s.memory, {
          question: data.question,
          lead: out.lead,
          result: out,
          channel: data.channel === "note" ? "note" : "typed",
          scope: bundle.scope,
        }).id;
        schedulePersist(s);
      } else if (req.url === "/api/memory/forget") {
        s.memory = createMemory();
        schedulePersist(s);
        out = { ok: true };
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
        out = await mintBolna(data?.user_data);
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
        s.memory = createMemory();
        if (store && s.persistNs) {
          clearTimeout(persistTimers.get(s));
          store.remove(s.persistNs);
        }
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
  server.loadPublicCases = loadPublicCases;
  return server;
}
export const server = createLocalServer();
if (process.argv[1] === new URL(import.meta.url).pathname) {
  // Slow-client protection: a request must send its headers within 15 s and
  // finish within 90 s (uploads included). Keep-alive outlives the proxy's
  // idle timeout so the proxy never reuses a socket we already closed.
  server.headersTimeout = 15_000;
  server.requestTimeout = 90_000;
  server.keepAliveTimeout = 65_000;
  server.listen(
    Number(process.env.PORT || 4317),
    process.env.VM_BIND_HOST || "127.0.0.1",
    () => {
      console.log("Voice-memory server ready");
      server.loadPublicCases({ bindVoice: true });
    },
  );
  // Render sends SIGTERM before replacing the instance on a deploy: stop
  // accepting connections, let in-flight answers finish, then exit. A hard
  // deadline keeps a stuck request from holding the old instance forever.
  let stopping = false;
  const stop = (sig) => {
    if (stopping) return;
    stopping = true;
    console.log(`${sig}: draining`);
    server.close(() => process.exit(0));
    server.closeIdleConnections?.();
    setTimeout(() => process.exit(0), 10_000).unref();
  };
  process.on("SIGTERM", () => stop("SIGTERM"));
  process.on("SIGINT", () => stop("SIGINT"));
}
