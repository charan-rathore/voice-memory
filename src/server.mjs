import http from "node:http";
import path from "node:path";
import { createCallCounters } from "./public-call-counters.mjs";
import { selectCallCounters } from "./public-call-counters-upstash.mjs";
import { readFile, readdir } from "node:fs/promises";
import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import { promotedAnswer, warmUnits, closestLine } from "./paraphrase.mjs";
import {
  repairDealTerms,
  stripPreamble,
  isHindi,
  langOfText,
  isDealQuestion,
  glossHindi,
  toHindi,
  socialTurn,
  splitMixed,
  domainOf,
} from "./conversation.mjs";
import {
  importBundle,
  answer,
  draft,
  validateEvidence,
} from "../dist/engine.mjs";
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
import { intentLead, semanticRescue } from "./semantic/route.mjs";
import { semanticConsentFor } from "./semantic/scope.mjs";
import { createGemini } from "./semantic/gemini.mjs";
import { visualFor, caseVisual } from "./visual-summary.mjs";
import { extractiveSpoken } from "./spoken-extract.mjs";
import {
  clinicalAnswer,
  clinicalReportsFor,
  observationEvidence,
  findTest,
  subjectsFor,
  DATE_ASK_RE,
} from "../clinical/answer.mjs";
import { extractReport } from "../clinical/observations.mjs";
import { sectionAnswer, fieldAnswer } from "./doc-sections.mjs";
import {
  attachRecords,
  bundleFactAnswer,
  recordIntent,
} from "./record-facts.mjs";
import { cite as citeSpan } from "./spoken-routes.mjs";
import { detectLang, aliasesFor, nameOf } from "../clinical/explain.mjs";
import {
  labVocabulary,
  repairTestNames,
  selfRepair,
} from "./spoken-repair.mjs";
import { normalizeSpoken } from "./spoken-normalize.mjs";
import {
  normalizeVernacular,
  adviceKind,
  declineLead,
  toHinglish,
  noAnswerLead,
} from "./vernacular.mjs";
import { createMemory, recordTurn, liveEpisodes } from "../memory/memory.mjs";
import { buildGraph } from "../memory/graph.mjs";
import { createStore, snapshotOf, restoreInto } from "../memory/store.mjs";
import { createAnswerCache } from "./cache.mjs";
import { readdirSync } from "node:fs";
import { NORTHSTAR_DOCS } from "../examples/corpus-northstar.mjs";
import { createPublicApi, publicAnswer, clientAddress } from "./public-api.mjs";
import { createSarvamTts } from "./sarvam-tts.mjs";
import {
  createElevenTts,
  createVoiceOut,
  createSarvamStt,
  createElevenStt,
  createVoiceIn,
  createFakeTts,
} from "./voice-providers.mjs";
import { openerFor } from "./companion.mjs";
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
  "/": ["../public/index.html", "text/html; charset=utf-8"],
  "/app.js": ["../public/app.js", "text/javascript"],
  "/workspace.js": ["../public/workspace.js", "text/javascript"],
  "/viewer.js": ["../public/viewer.js", "text/javascript"],
  "/notes.js": ["../public/notes.js", "text/javascript"],
  "/motion.js": ["../public/motion.js", "text/javascript"],
  "/voicelab.js": ["../public/voicelab.js", "text/javascript"],
  "/graph.js": ["../public/graph.js", "text/javascript"],
  "/start.js": ["../public/start.js", "text/javascript"],
  "/voicelab-score.mjs": ["../public/voicelab-score.mjs", "text/javascript"],
  "/style.css": ["../public/style.css", "text/css"],
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
  "/favicon.svg": ["../public/favicon.svg", "image/svg+xml"],
};
// pdf.js standard font data (for PDFs that use non-embedded base fonts).
for (const f of readdirSync(
  new URL("../node_modules/pdfjs-dist/standard_fonts/", import.meta.url),
))
  if (/^[\w.-]+\.(pfb|ttf)$/.test(f))
    STATIC["/vendor/standard_fonts/" + f] = [
      "../node_modules/pdfjs-dist/standard_fonts/" + f,
      "application/octet-stream",
    ];
// The short answer shown first on screen is the SAME deterministic sentence
// the voice call would speak (claim renderer, else one verbatim quote), so
// screen and voice never tell different stories. Null when the spoken layer
// abstains or disagrees; the full engine text is always returned too.
// A typed follow-up about the lab result just shown ("what was it before
// the correction?") names no test of its own. The page sends back the
// previous lead's field (patient and test, see labField), and the question
// is read with it, exactly as the voice path reads a follow-up joined to the
// caller's previous utterance. Bounded: one field, only for a question with
// no test of its own that reads as a follow-up.
const LAB_FOLLOWUP_RE =
  /\b(it|its|that|this|those|them|before|previous|earlier|again|same|then|correct\w*|amend\w*|original\w*|prelim\w*|units?|range|normal|high|low|why|mean\w*)\b|पहले|वो|यह|इसका|उसका|इसे/i;
// "SYN-0003" alone, said back after "whose TSH?", answers that question.
const BARE_ID_RE =
  /^\s*(?:(?:and|for|of|the|patient)\s+)*[A-Za-z]{2,5}[- ]?\d{3,6}(?:'s)?\s*[?.!]?\s*$/i;
function withLabContext(question, reports, prevField) {
  if (
    !prevField ||
    DATE_ASK_RE.test(question) ||
    (!LAB_FOLLOWUP_RE.test(question) && !BARE_ID_RE.test(question))
  )
    return question;
  if (findTest(question, reports) || !findTest(prevField, reports))
    return question;
  const test = prevField.replace(/^[A-Z]{2,5}-\d{3,6}\s+/, "");
  // the question names its own patient only if it says an id; subjectsFor
  // lists every patient when none is named, so it cannot tell
  const ownSubject = /\b[A-Za-z]{2,5}[- ]?\d{3,6}\b/.test(question);
  return `${question} ${ownSubject ? test : prevField}`;
}
const labField = (c) => {
  const o = c?.used?.[0];
  // a clarification ("whose TSH?") keeps the test it asked about
  if (!o)
    return typeof c?.test === "string" &&
      /^[A-Za-z0-9][A-Za-z0-9 .:-]{0,59}$/.test(c.test)
      ? c.test
      : null;
  const pid = o.report?.meta?.patient?.id;
  // an answer about one dated report keeps that date ("convert it" then
  // means the September value, not the latest)
  const day =
    c.used.length === 1 &&
    c.verdict === "VALUE" &&
    /^\d{4}-\d{2}-\d{2}$/.test(o.report?.meta?.collected ?? "")
      ? " " + o.report.meta.collected
      : "";
  const f = `${/^[A-Z]{2,5}-\d{3,6}$/.test(pid ?? "") ? pid + " " : ""}${nameOf(o)}${day}`;
  return /^[A-Za-z0-9][A-Za-z0-9 .:-]{0,59}$/.test(f) ? f : null;
};
function leadFor(question, result, bundle, prevField) {
  try {
    // Lab results across reports first (synthetic-data research prototype):
    // typed observations, comparability checks, no clinical judgement.
    if (bundle.clinical?.length) {
      question = withLabContext(question, bundle.clinical, prevField);
      // What kind of answer would answer this? A "why" gets a reason, a
      // "what is X" a definition, an absent measurement an honest "not here".
      const il = intentLead(question, bundle, (ev) =>
        validateEvidence(ev, bundle),
      );
      if (il) return il;
      const c = clinicalAnswer(question, bundle.clinical);
      if (c)
        return {
          text: c.spoken,
          verdict: c.verdict,
          field: labField(c),
          used: c.used,
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
      t = extractiveSpoken(
        question,
        result,
        bundle,
        bundle.locateEvidence,
        result?.queryTransform?.expanded ?? undefined,
      );
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
    // The engine's exact-citation rule (a quote appearing more than once in
    // its source is never a pinpoint citation) applies to the spoken path
    // too: mark repeated quotes broad so renderers say so honestly.
    const marked = citations.map((c) => {
      if (c.broadCitation || !c.quote) return c;
      const src = bundle.sources.find((x) => x.id === c.sourceId);
      if (!src) return c;
      return src.text.indexOf(c.quote) !== src.text.lastIndexOf(c.quote)
        ? { ...c, broadCitation: true }
        : c;
    });
    return {
      text: t.spoken,
      verdict: t.verdict,
      field: t.field ?? null,
      citations: marked,
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
// Source-grounded mint-failure classification: Bolna creates a web-call
// session only on a 2xx from its mint routes. A 429 or other 4xx is a
// definitive refusal BEFORE creation (pre-session: refundable). A 5xx or a
// network/timeout failure is AMBIGUOUS - the session may exist - so it must
// stay charged until reconciled; never auto-refunded.
// Read-only vendor execution reader for reconciliation. GETs ONLY - never
// mints, never stops, never writes. Maps the documented Bolna read
// contract (GET /executions/{id}; GET /v2/agent/{agent_id}/executions)
// onto the reconcile module's result kinds. Injected in tests; the real
// thing is only wired when reconciliation actually runs post-activation.
export function createBolnaExecutionReader({ vendorFetchImpl, apiKey }) {
  return async (op, args) => {
    try {
      if (op === "get") {
        const r = await vendorFetchImpl(
          `https://api.bolna.ai/executions/${encodeURIComponent(args.executionId)}`,
          {
            headers: { authorization: "Bearer " + apiKey },
            signal: AbortSignal.timeout(10000),
          },
        );
        if (r.status === 404) return { kind: "not-found" };
        if (!r.ok) return { kind: "error", status: r.status };
        const body = await r.json();
        if (body && body.id) return { kind: "found", execution: body };
        // A 200 with no execution (e.g. {message}) is UNKNOWN, not
        // "not found" - labels stay truthful; reconcile treats both
        // conservatively (stays charged) regardless.
        return { kind: "unknown" };
      }
      if (op === "list") {
        const q = new URLSearchParams({
          page_size: "50",
          page_number: "1",
          provider: "web-call",
          from: args.from,
          to: args.to,
        });
        const r = await vendorFetchImpl(
          `https://api.bolna.ai/v2/agent/${encodeURIComponent(args.agentId)}/executions?${q}`,
          {
            headers: { authorization: "Bearer " + apiKey },
            signal: AbortSignal.timeout(10000),
          },
        );
        if (!r.ok) return { kind: "error", status: r.status };
        const body = await r.json();
        return { kind: "ok", executions: body?.data ?? [] };
      }
      return { kind: "error" };
    } catch {
      return { kind: "error" };
    }
  };
}

export function classifyBolnaMintFailure(status) {
  return status === 429 || (status >= 400 && status < 500)
    ? "preSession"
    : "ambiguous";
}

const BROAD_DEAL =
  /\b(chang\w*|happen\w*|summary|summari[sz]e|status|update|overview|badl\w*|kya\s+hua)\b|बदल|क्या\s+हुआ/i;
// Social turns a typed visitor gets a reply to (the rest go to the engine).
const TYPED_SOCIAL = new Set([
  "HELP",
  "UPLOAD",
  "WHO",
  "THANKS",
  "BYE",
  "GREET",
]);
// Replies written to be spoken, set for reading.
const typedText = (s) =>
  String(s)
    .replace(/S Y N zero zero zero one/g, "SYN-0001")
    .replace(/forty two thousand dollar/gi, "$42,000")
    .replace(/thirty idle minutes/g, "30 idle minutes")
    .replace(/up to five/g, "up to 5")
    .replace(
      /voice memory beige dot vercel dot app/g,
      "voice-memory-beige.vercel.app",
    );
// A strong subject: a test name or patient ID, or a deal term. Generic words
// ("report", "result") never move a question to another case.
const STRONG_LAB =
  /\b(ferritin|creatin\w*|tsh|thyroid|h(a)?emoglobin|hba1c|urea|syn-?\d{4})\b|फेरिटिन|क्रिएटिनिन|थायरॉइड|हीमोग्लोबिन|यूरिया/i;
const STRONG_DEAL =
  /\b(northstar|meridian|kapoor|engagement\s+fee|fees?|proposal|revision|contract|agreement|payment\s+split|deadline|steering|pilot)\b|फ़ीस|फीस|अनुबंध|कॉन्ट्रैक्ट|भुगतान|डेडलाइन/i;
function strongDomain(text) {
  const t = repairDealTerms(String(text ?? ""));
  const lab = STRONG_LAB.test(t),
    deal = STRONG_DEAL.test(t);
  return lab && !deal ? "lab" : deal && !lab ? "deal" : null;
}

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
  // Vendor transport, injectable so tests never reach the real Bolna API.
  vendorFetch = fetch,
  // Semantic layer, injectable so tests can count provider calls without a
  // network. Default builds from the host's encrypted environment.
  gemini = createGemini(),
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
  // Bounded semantic layer: off (deterministic only) unless a provider key is
  // set in the host's encrypted environment; VM_GEMINI=off is the kill switch.
  // Injectable (see createLocalServer options) so tests never spend.
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
  // Live public calls on the fixed credential, by the per-call handle the
  // mint put in vm_ws: which case or workspace each call answers from right
  // now. The page owns its call's scope (POST /api/public/voice/scope);
  // Bolna's request can only name a handle, never pick another scope.
  const voiceCalls = new Map(); // call -> {scope, at}
  const VOICE_CALL_MS = 20 * 60000;
  const voiceCallsApi = {
    open(call, scope) {
      const t = Date.now();
      for (const [c, v] of voiceCalls)
        if (t - v.at > VOICE_CALL_MS) voiceCalls.delete(c);
      voiceCalls.set(call, { scope, at: t, gen: 0 });
    },
    // `gen` is the page's own switch counter. Scope updates can arrive out of
    // order (A -> B -> A sent quickly, B delivered last); an update older
    // than the one already applied is ignored, so the server ends on what
    // the page shows. Returns the scope in force, or false.
    setScope(call, scope, gen = null) {
      const v = voiceCalls.get(call);
      if (!v) return false;
      if (Number.isSafeInteger(gen) && gen <= v.gen) return v.scope;
      if (scope.startsWith("w_") && !liveWorkspace(scope)) return false;
      v.scope = scope;
      if (Number.isSafeInteger(gen)) v.gen = gen;
      return v.scope;
    },
  };
  const liveWorkspace = (id) => {
    const w = workspaces.get(id);
    if (w && Date.now() - w.at > WS_IDLE_MS) {
      dropWorkspace(id);
      return null;
    }
    if (w) w.at = Date.now(); // a voice question is activity too
    return w ?? null;
  };
  voice.setOnTurn?.((token, t) => {
    const feedCase =
      (token === fixedCap
        ? t.caseId === "health" || t.caseId === "deal"
          ? caseSessions[t.caseId]
          : voiceCase.bundle && t.scope === voiceCase.bundle.scope
            ? voiceCase
            : [...workspaces.values()].find(
                (w) => w.s.bundle?.scope === t.scope,
              )?.s
        : null) ??
      // A turn with nothing to cite (workspace expired, scope unreadable,
      // page switched mid-answer) still reaches its own call's screen, so
      // the page shows the words the caller heard.
      (token === fixedCap && t.call && !t.lead?.citations?.length
        ? voiceCase
        : null);
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
      if (lead && t.lead.action) lead.action = t.lead.action;
      // Tied to its call and its case: a ticket reads only its own call's
      // turns, and the page is told which case answered, never left to
      // guess it from citation file names.
      publicTurns.push({
        at: Date.now(),
        question: t.question,
        lead,
        call: t.call ?? null,
        case: t.caseId ?? "demo",
      });
      if (publicTurns.length > 200) publicTurns.shift();
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
      attachRecords(bundle, docs);
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
  // No answer, an abstention, or a "quote" that is only a heading line.
  const weakLead = (l) => {
    if (!l || l.verdict === "UNKNOWN") return true;
    if (l.verdict !== "QUOTED") return false;
    return (
      junkQuote(l) ||
      String(l.text)
        .split(/(?<=[.!?])\s/)[0]
        .trim()
        .split(/\s+/).length < 6
    );
  };
  // A heading ("IMPRESSION.") or a form header ("PATIENT: ... DOB: ...") is
  // a place in the document, not an answer: better to say nothing.
  const junkQuote = (l) => {
    if (l?.verdict !== "QUOTED") return false;
    const first = String(l.text)
      .split(/(?<=[.!?])\s/)[0]
      .trim();
    return (
      !/[a-z]/.test(first.replace(/[A-Z][a-z]*\b/, "")) ||
      (first.match(/\b[A-Z][A-Za-z #./]{1,20}:/g) ?? []).length >= 2
    );
  };
  async function resolveAnswer(s, question, ctx, opts = {}) {
    const bundle = s.bundle;
    // May this document set's passages go to the model? Fictional demo
    // cases: yes. A visitor's own documents: only with their consent, and
    // only outside VM_SEMANTIC_AUDIENCE=demo trial scope (see scope.mjs).
    const consent = semanticConsentFor(s.sid, opts.consent);
    const mode = gemini.enabled() ? (consent ? ":g1" : ":g0") : ":d";
    // Retrieval mode is part of the key: a keyword or partial-warm
    // answer cached while the embedder was cold or warming must not
    // outlive that state (see denseCacheSuffix in dense.mjs).
    const key = answerCache.key(
      bundle.scope + denseCacheSuffix(bundle) + mode,
      question,
      ctx,
      detectLang(question),
    );
    return answerCache.resolve(key, async () => {
      const original = question;
      const lang = langOfText(original);
      // Treatment, diagnosis or a decision that is the visitor's to make:
      // say no clearly, in their language, before any retrieval can turn a
      // nearby value into something that sounds like advice.
      const advice = adviceKind(original);
      if (advice)
        return {
          raw: null,
          shown: {
            lead: declineLead(advice, lang, original),
            semantic: { intent: "ADVICE", lang, steps: ["decline_advice"] },
            evidence: [],
          },
        };
      const { raw, shown } = await deterministicAnswer(s, question, ctx);
      // Understand first, verify after: intent-specific rescue (grounded
      // background, composed summaries, model interpretation, verified
      // model claims) and the final "does this answer the question" audit.
      const validate = (ev) => validateEvidence(ev, bundle);
      const sem = await semanticRescue({
        question: original,
        bundle,
        lead: shown.lead,
        raw,
        ctx,
        validate,
        gemini,
        consent,
        ip: opts.ip,
        rerun: async (q) =>
          (await deterministicAnswer(s, q, ctx)).shown.lead ?? null,
      }).catch(() => ({
        lead: shown.lead,
        trace: { steps: ["semantic_error"] },
      }));
      if (sem.lead !== shown.lead && sem.lead?.citations?.length)
        sem.lead.citations = decorateResult(
          { evidence: sem.lead.citations, question: original },
          s,
        ).evidence;
      shown.lead = sem.lead;
      shown.semantic = sem.trace;
      // A Hindi or Hinglish visitor with nothing supported hears that in
      // their own language, not a silent English fallback.
      if (!shown.lead && lang !== "en" && !(shown.evidence ?? []).length)
        shown.lead = noAnswerLead(lang);
      // The picture of the answer: ranges, series, corrections, units,
      // drawn from the same typed rows the sentence came from.
      shown.visual = visualFor(original, bundle, shown.lead);
      if (shown.lead) delete shown.lead.used;
      return { raw, shown };
    });
  }
  // The deterministic chain (claim graph, clinical answers, sections, form
  // fields, hybrid sentence search), unchanged in behaviour; the semantic
  // router above decides what to do with its result.
  async function deterministicAnswer(s, question, ctx) {
    const bundle = s.bundle;
    {
      // Phrased any way: drop a leading greeting, repair the deal's names,
      // and ask a Hindi deal question in the English the engine reads (lab
      // questions are understood in Hindi directly). The answer is rendered
      // back in Hindi below.
      const original = question;
      question =
        repairDealTerms(stripPreamble(selfRepair(question))) || question;
      // Recogniser and keyboard damage to a test this case actually reports
      // ("ferrite in" -> Ferritin) is repaired against the case's own lab
      // vocabulary; anything the reports don't hold stays untouched, and the
      // repair is disclosed on the lead as "understood as".
      let repairedLab = false;
      if (bundle.clinical?.length) {
        const vocab = labVocabulary(bundle.clinical, aliasesFor);
        const fixed = repairTestNames(question, vocab);
        if (fixed && fixed !== question) {
          question = fixed;
          repairedLab = true;
        }
      }
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
      if (repairedLab && shown.lead) shown.lead.interpretedAs = question;
      // Reworded beyond keyword reach: one verbatim sentence with its
      // citation, only when the calibrated paraphrase gate is unambiguous.
      // A section-shaped question ("what does this report suggest?", "why
      // was the scan done?") is answered with that headed section, verbatim.
      let sectioned = false;
      // A fact stated in a record's table, from the most authoritative
      // record that states it (signed / final / posted over estimate /
      // draft / preliminary), with superseded provisional values named.
      if (
        weakLead(shown.lead) ||
        shown.lead?.verdict === "QUOTED" ||
        recordIntent(question)
      ) {
        const fa = bundleFactAnswer(question, bundle, citeSpan);
        if (fa) {
          sectioned = true;
          shown.lead = {
            text: fa.spoken,
            verdict: "QUOTED",
            field: null,
            citations: fa.citations,
            record: {
              title: fa.record.title,
              pages: fa.record.pages,
              status: fa.record.status,
              authority: fa.record.authority,
            },
          };
        }
      }
      if (
        !sectioned &&
        (weakLead(shown.lead) || shown.lead?.verdict === "QUOTED")
      ) {
        const sec = sectionAnswer(question, bundle);
        if (sec) {
          sectioned = true;
          shown.lead = {
            text: sec.spoken,
            verdict: "QUOTED",
            field: null,
            citations: sec.citations,
          };
        }
      }
      if (
        !sectioned &&
        (weakLead(shown.lead) || shown.lead?.verdict === "QUOTED")
      ) {
        const f = fieldAnswer(question, bundle);
        if (f) {
          sectioned = true;
          shown.lead = {
            text: f.spoken,
            verdict: "QUOTED",
            field: null,
            citations: f.citations,
          };
        }
      }
      // On a visitor's own documents the hybrid sentence search (meaning +
      // words, lay terms expanded) outranks the keyword-only extract.
      const ownDocs = String(s.sid ?? "").startsWith("ws:");
      if (
        !sectioned &&
        (weakLead(shown.lead) || (ownDocs && shown.lead?.verdict === "QUOTED"))
      ) {
        const p = await promotedAnswer(question, bundle).catch(() => null);
        if (p)
          shown.lead = {
            text: p.spoken,
            verdict: "QUOTED",
            field: null,
            citations: [p.citation],
          };
      }
      // Still abstaining: offer the closest line as a pointer, labelled
      // "not an answer", never as the reply (paraphrase.mjs closestLine).
      if (!sectioned && weakLead(shown.lead)) {
        const c = await closestLine(question, bundle).catch(() => null);
        if (c)
          shown.closest = {
            ...c,
            citation: {
              ...c.citation,
              documentId: s.sourceToEntry?.get(c.citation.sourceId)?.id ?? null,
            },
          };
      }
      if (!sectioned && junkQuote(shown.lead)) shown.lead = null;
      // The deal's fixed English templates are rendered in the visitor's
      // language: Devanagari for Hindi, romanised for Hinglish. Record text
      // and values stay verbatim (see toHindi / toHinglish).
      const answerLang = langOfText(original);
      if (
        shown.lead?.text &&
        answerLang !== "en" &&
        !/[ऀ-ॿ]/.test(shown.lead.text) &&
        (gloss || isDealQuestion(question) || !bundle.clinical?.length) &&
        detectLang(shown.lead.text) === "en"
      )
        shown.lead.text =
          answerLang === "hi"
            ? toHindi(shown.lead.text)
            : toHinglish(shown.lead.text);
      if (shown.lead)
        shown.lead.citations = decorateResult(
          { evidence: shown.lead.citations, question },
          s,
        ).evidence;
      return { raw, shown };
    }
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
    attachRecords(bundle, docsIn);
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
        new URL("../clinical/fixtures/files/" + f, import.meta.url),
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
  // Shared call counters (visitor + owner): rate smoothing for issuance.
  // NOT a money ceiling - the JSON file can reset on redeploy; see
  // public-call-counters.mjs for exactly what is and is not guaranteed.
  // Durable-by-default: without a configured durable store the selector
  // throws and voice mints fail closed (503) - production safety must not
  // depend on remembering an opt-in env var. The non-durable file backend
  // requires the explicit VM_COUNTERS_ALLOW_FILE=on opt-in (local dev/test
  // only; single writer; NOT multi-instance safe; NOT a money ceiling).
  let callCounters;
  try {
    callCounters =
      selectCallCounters() ??
      createCallCounters({
        file:
          process.env.VM_PUBLIC_COUNTER_FILE ||
          path.join(
            process.env.VM_DATA_DIR || process.cwd(),
            "public-call-counters.json",
          ),
      });
  } catch (e) {
    console.warn("public voice counters fail closed:", e.message);
    callCounters = null;
  }
  // Boot-time reachability proof for the durable store. Note the store
  // fails closed on every admission anyway (any store error -> 503, no
  // mint); this surfaces the misconfiguration at boot instead of at the
  // first call.
  if (typeof callCounters?.verify === "function")
    Promise.resolve()
      .then(() => callCounters.verify())
      .catch((e) =>
        console.warn(
          "durable call-counter store UNREACHABLE at boot; admissions fail closed:",
          e.message,
        ),
      );
  // Best-effort vendor stop behind the server ticket cutoff and the landing
  // client's own hangup. Bolna documents POST /call/{execution_id}/stop for
  // queued/scheduled calls; whether it ends an in-progress web call is
  // unverified, so this never stands in for the ticket cutoff.
  // Best-effort stop ATTEMPT. Never returns confirmation: no /stop status
  // code proves an in-progress web call ended - Bolna documents the route
  // for queued/scheduled calls only, and a 404 can mean an unsupported
  // route or an id shape the vendor does not recognize, not a dead call.
  // Until the vendor owns documented terminal-state semantics (or a status
  // read we have verified), callers treat every outcome as UNKNOWN and keep
  // their own cleanup (ticket cutoff + landing hangup) to the end.
  async function stopBolna(session) {
    if (!bolnaKey || !session || typeof session !== "object") return false;
    const id =
      session.execution_id ?? session.call_id ?? session.run_id ?? null;
    if (!id) return false;
    try {
      const r = await vendorFetch(
        `https://api.bolna.ai/call/${encodeURIComponent(id)}/stop`,
        {
          method: "POST",
          headers: { authorization: "Bearer " + bolnaKey },
          signal: AbortSignal.timeout(5000),
        },
      );
      if (!r.ok) console.warn("bolna stop returned", r.status);
    } catch (e) {
      console.warn("bolna stop failed:", e.message);
    }
    return false; // attempt only - terminal state never claimed
  }
  // Bolna web-call session mint. SDK v3.0.1 expects the FreeSWITCH session
  // shape ({run_id, wss_url, sip_username, ...}); the older /web-call/session
  // route is only a fallback for accounts that do not have it.
  async function mintBolna(userData, creds = null) {
    const key = creds?.key ?? bolnaKey;
    const agentId = creds?.agent ?? bolnaAgent;
    if (!key || !agentId) {
      const e = Error("Bolna web call is not configured on this server.");
      e.status = 503;
      throw e;
    }
    let last = null;
    for (const route of ["/web-call/freeswitch-session", "/web-call/session"]) {
      const r = await vendorFetch("https://api.bolna.ai" + route, {
        method: "POST",
        headers: {
          authorization: "Bearer " + key,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          agent_id: agentId,
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
        // Definitive pre-session failure: the vendor created nothing.
        const e = Error("All voice lines are busy. Try again shortly.");
        e.status = 429;
        e.preSession = true;
        throw e;
      }
      if (classifyBolnaMintFailure(r.status) === "preSession") {
        // Definitive pre-session failure: the vendor rejected the mint
        // before creating anything (4xx). Safe to hand the allowance back.
        console.warn("bolna mint rejected:", route, r.status);
        const e = Error("Bolna session request failed.");
        e.status = 502;
        e.preSession = true;
        throw e;
      }
      if (!r.ok) {
        // 5xx: AMBIGUOUS - the vendor may have created the session and then
        // failed the response. NOT marked preSession: the reservation stays
        // charged until reconciled against the vendor's call list.
        console.warn("bolna mint outcome ambiguous:", route, r.status);
        const e = Error("Bolna session request failed.");
        e.status = 502;
        throw e;
      }
      return r.json();
    }
    console.warn("bolna mint: no session route", last);
    const e = Error("Bolna session request failed.");
    e.status = 502;
    // Both documented routes answered 404/405: no session was created.
    e.preSession = true;
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
    // Drop voice bundle references at the same time, not on the next key sweep.
    for (const [token, key] of byoKeys) if (key.scope === id) byoRevoke(token);
  };
  const sweepWorkspaces = () => {
    for (const [id, w] of workspaces)
      if (Date.now() - w.at > WS_IDLE_MS) dropWorkspace(id);
    while (workspaces.size >= WS_MAX)
      dropWorkspace(workspaces.keys().next().value);
  };
  const workspaceSweepTimer = setInterval(() => {
    for (const [id, w] of workspaces)
      if (Date.now() - w.at > WS_IDLE_MS) dropWorkspace(id);
  }, 1000);
  workspaceSweepTimer.unref?.();
  const rebuildWorkspace = (ws) => {
    // Visitor uploads held for OCR review are included (the review notes
    // still travel with every answer). Mark them BEFORE reading the
    // indexable set: reading it first left a review-only workspace with no
    // bundle, answering "still loading" forever.
    for (const e of libraryOf(ws))
      if (e.status === "needs_review") e.included = true;
    const docsNow = indexable(ws);
    if (!docsNow.length) {
      ws.bundle = null;
      return;
    }
    const bundle = importBundle(
      docsNow.map((e) => ({ title: e.title, text: e.doc.text })),
    );
    ws.sourceToEntry = new Map(
      bundle.sources.map((src, i) => [src.id, docsNow[i]]),
    );
    bundle.locateEvidence = locatorFor(ws.sourceToEntry);
    bundle.clinical = clinicalReportsFor(bundle, docsNow, extractReport);
    attachRecords(bundle, docsNow);
    ws.bundle = bundle; // the library keeps every entry, indexed or not
    warmDense(bundle.rows);
    warmUnits(bundle);
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
      if (Date.now() - w.at > WS_IDLE_MS) {
        dropWorkspace(id);
        return null;
      }
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
  // Only the agent's own system prompt names the scope. A caller who says
  // "vm_ws=w_..." out loud (or a transcript that contains it) is asking a
  // question, not choosing whose documents to read.
  voice.setBundleResolver?.((messages) => {
    for (const m of messages ?? []) {
      if (m?.role !== "system") continue;
      const text =
        typeof m?.content === "string"
          ? m.content
          : JSON.stringify(m?.content ?? "");
      // The agent prompt reads "vm_ws={vm_ws}." Bolna substitutes the value
      // minted for a browser call; a phone call (no value) leaves the
      // placeholder or nothing, and answers from the demo records as before.
      // A value that is present but unreadable is refused, never widened to
      // every record.
      const raw = /vm_ws=(\S*)/.exec(text)?.[1];
      if (raw === undefined) continue;
      const value = raw.replace(/[.,;:)\]'"]+$/, "");
      if (!value || /^\{\s*vm_ws\s*\}$/.test(value)) continue;
      const hit =
        /^(w_[0-9a-f]{32}|health|deal|demo)(?:\.(c[0-9a-f]{24}))?$/.exec(value);
      if (!hit) return { malformed: true, call: null, caseId: null };
      const call = hit[2] ?? null;
      // A live public call's scope is what its page has open now.
      const scope = (call && voiceCalls.get(call)?.scope) || hit[1];
      if (scope.startsWith("w_")) {
        const w = liveWorkspace(scope);
        // Never fall back to the fictional records for someone who was
        // asking about their own documents.
        if (!w?.s?.bundle) return { expired: true, call, caseId: scope };
        return { bundle: w.s.bundle, call, caseId: scope };
      }
      if (scope === "health" || scope === "deal") {
        const b = caseSessions[scope]?.bundle;
        return b ? { bundle: b, call, caseId: scope } : null;
      }
      return { bundle: null, call, caseId: "demo" };
    }
    return null;
  });
  // ------------------------------------------------------------ bring your own voice
  // A visitor's own voice platform (Bolna, Vapi, Retell, ElevenLabs Agents)
  // pays for speech; this engine still writes every reply. A key issued here
  // is a capability on a SEPARATE adapter, bound to one public case or the
  // visitor's own workspace, so it answers exactly what /api/public/ask
  // answers, in the OpenAI chat format a "custom LLM" setting expects. It
  // can never reach the operator's fixed Bolna capability or another
  // workspace. Every key dies 24 hours after issue, or with its workspace.
  // Visitor Bolna keys are used for one mint and never kept.
  const BYO_HARD_MS = 24 * 3600 * 1000;
  const byoVoice = createVoiceAdapter({
    ttlMs: 30 * 60 * 1000,
    hardTtlMs: BYO_HARD_MS,
  });
  const byoEnabled = process.env.VM_BYO_VOICE === "on";
  const byoKeys = new Map(); // token -> { at, scope, bundle }
  const byoHits = new Map(); // `${kind}|${ip}` -> { n, start }
  const byoAllow = (kind, ip, max, windowMs = 3600000) => {
    const k = `${kind}|${ip}`;
    const t = Date.now();
    const r = byoHits.get(k) ?? { n: 0, start: t };
    if (t - r.start > windowMs) Object.assign(r, { n: 0, start: t });
    r.n++;
    byoHits.set(k, r);
    if (byoHits.size > 20000) byoHits.delete(byoHits.keys().next().value);
    return r.n <= max;
  };
  const byoBundle = (scope) => {
    if (scope === "demo" || scope === "health" || scope === "deal")
      return (
        (scope === "demo" ? voiceCase.bundle : caseSessions[scope]?.bundle) ??
        null
      );
    if (/^w_[0-9a-f]{32}$/.test(String(scope))) {
      const w = workspaces.get(scope);
      if (w && Date.now() - w.at > WS_IDLE_MS) dropWorkspace(scope);
      return workspaces.get(scope)?.s?.bundle ?? null;
    }
    return null;
  };
  // A key is live while it is under 24 hours old and its scope still
  // exists. A workspace key follows the workspace: new uploads are answered
  // from, and once the workspace is deleted the key dies with it, so no
  // document outlives the visitor's 30-minute promise through a voice key.
  const byoLive = (token) => {
    const k = byoKeys.get(token);
    if (!k) return false;
    const current =
      Date.now() - k.at <= BYO_HARD_MS ? byoBundle(k.scope) : null;
    if (!current) {
      byoKeys.delete(token);
      byoVoice.retire(token);
      return false;
    }
    if (current !== k.bundle) {
      byoVoice.retarget(token, current);
      k.bundle = current;
    }
    return true;
  };
  // Ceilings across all visitors, so many addresses cannot add up to an
  // unbounded load on the engine: keys issued per hour, turns per day.
  const BYO_KEYS_HOUR = Number(process.env.VM_BYO_KEYS_PER_HOUR || 300);
  const BYO_TURNS_DAY = Number(process.env.VM_BYO_TURNS_PER_DAY || 20000);
  const byoRevoke = (token) => {
    if (!byoKeys.has(token)) return false;
    byoKeys.delete(token);
    byoVoice.retire(token);
    return true;
  };
  const byoSweep = () => {
    for (const t of [...byoKeys.keys()]) byoLive(t);
  };
  // drop keys (and their bundle references) for deleted workspaces promptly
  setInterval(byoSweep, 60000).unref?.();
  // Public narration voice (Sarvam Bulbul). Null without VM_SARVAM_API_KEY:
  // the narrate-audio route then fails closed with 503, never a fallback.
  const sarvamTts = createSarvamTts();
  // Voice out: Sarvam Bulbul first (Hindi, Hinglish and Indian English in
  // one pass), ElevenLabs next (word timestamps), in VM_TTS_ORDER. Voice in:
  // Sarvam Saaras / ElevenLabs Scribe, then Gemini. Each is null without its
  // key, and every public voice route fails closed without any.
  const voiceOut = createVoiceOut({
    sarvam: sarvamTts,
    eleven: createElevenTts() ?? createFakeTts(),
  });
  const voiceIn = createVoiceIn({
    sarvam: createSarvamStt(),
    eleven: createElevenStt(),
    fallback: gemini,
  });
  const publicApi = createPublicApi({
    cases: caseSessions,
    workspaces: workspaceApi,
    resolve: async (cs, question, ctx, opts = {}) => {
      const lang = langOfText(question);
      // About the page, not the records ("how can you help", "how do I use
      // my own reports", "thanks"): a fixed reply, and a page action.
      const social = socialTurn(repairDealTerms(question), { lang });
      if (social && TYPED_SOCIAL.has(social.intent))
        return {
          question,
          lead: {
            text: typedText(social.spoken),
            verdict: social.intent === "UPLOAD" ? "HOW_TO" : "HELP",
            field: null,
            citations: [],
            action: social.action ?? null,
          },
          semantic: { intent: social.intent, lang, steps: ["social"] },
          evidence: [],
        };
      const answerOne = async (session, text) => {
        const q =
          normalizeSpoken(normalizeVernacular(text)) ||
          normalizeSpoken(text) ||
          text;
        const { json } = await resolveAnswer(session, q, ctx, opts);
        const shown = JSON.parse(json).shown;
        // "What changed in the Northstar deal?": the fee change and what is
        // still open, from the engine's own cited answers, never a guess.
        if (
          session === caseSessions.deal &&
          (!shown.lead || shown.lead.verdict === "UNKNOWN") &&
          BROAD_DEAL.test(text)
        ) {
          const subs = [];
          for (const sq of [
            "What happened to the fee?",
            "What's still open?",
          ]) {
            const r = JSON.parse(
              (await resolveAnswer(session, sq, ctx, opts)).json,
            ).shown.lead;
            if (r?.text && r.verdict !== "UNKNOWN") subs.push(r);
          }
          if (subs.length) {
            const render = (x) =>
              lang === "hi"
                ? toHindi(x)
                : lang === "hinglish"
                  ? toHinglish(x)
                  : x;
            shown.lead = {
              ...subs[0],
              text: subs.map((x) => render(x.text)).join(" "),
              citations: subs.flatMap((x) => x.citations ?? []),
            };
            shown.semantic = { ...(shown.semantic ?? {}), lang };
          }
        }
        if (shown.lead)
          shown.lead.opener = openerFor(
            shown.lead,
            shown.semantic?.lang ?? "en",
          );
        return shown;
      };
      // The two demo cases hold different records. A question (or half of
      // one) about the other case is answered from that case and handed to
      // the page, which offers it or switches there.
      const caseId =
        cs === caseSessions.health
          ? "health"
          : cs === caseSessions.deal
            ? "deal"
            : null;
      const caseDomain = { health: "lab", deal: "deal" }[caseId] ?? null;
      const otherOf = (d) => (d === "lab" ? "health" : "deal");
      if (caseDomain) {
        const parts = splitMixed(normalizeVernacular(question)).map((p) => ({
          text: p,
          domain: strongDomain(p),
        }));
        const away = parts.filter((p) => p.domain && p.domain !== caseDomain);
        const home = parts.filter((p) => !away.includes(p));
        if (away.length) {
          const also = [];
          for (const p of away) {
            const other = caseSessions[otherOf(p.domain)];
            if (!other?.bundle) continue;
            const shownOther = await answerOne(other, p.text);
            if (shownOther.lead)
              also.push({
                case: otherOf(p.domain),
                question: p.text,
                lead: shownOther.lead,
              });
          }
          if (!home.length && also.length === 1)
            // entirely about the other case: the page switches and asks there
            return {
              question,
              lead: {
                text: typedText(
                  {
                    hi: `यह ${also[0].case === "deal" ? "Northstar डील" : "लैब रिपोर्ट"} के बारे में है, तो मैं वहाँ ले चलती हूँ।`,
                    hinglish: `Yeh ${also[0].case === "deal" ? "Northstar deal" : "lab reports"} ke baare mein hai, main wahan le chalti hoon.`,
                  }[lang] ??
                    `That's about the ${also[0].case === "deal" ? "Northstar deal" : "lab reports"}, so I'm taking you there.`,
                ),
                verdict: "SWITCH",
                field: null,
                citations: [],
                action: {
                  type: "switch",
                  case: also[0].case,
                  question: also[0].question,
                },
              },
              semantic: { intent: "SWITCH", lang, steps: ["other_case"] },
              evidence: [],
            };
          const shown = home.length
            ? await answerOne(cs, home.map((p) => p.text).join(" and "))
            : { lead: null, evidence: [] };
          return { ...shown, question, also };
        }
      }
      return { ...(await answerOne(cs, question)), question };
    },
    visual: (cs, lang) => caseVisual(cs.bundle, lang),
    gemini,
    sarvam: sarvamTts,
    voice: voiceOut,
    voiceIn,
    mintVoice: mintBolna,
    stopVoice: stopBolna,
    counters: callCounters,
    voiceCalls: voiceCallsApi,
    voiceTurns: (since, call) =>
      publicTurns
        .filter((t) => t.at >= since && !!call && t.call === call)
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
          // Which code is answering (set by Render on every deploy), so a
          // preview page and this backend can be checked for a version match.
          commit:
            process.env.RENDER_GIT_COMMIT ?? process.env.VM_COMMIT ?? null,
          cache: { entries: answerCache.size, ...answerCache.stats },
          semantic: gemini.status(),
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
    // Bring your own voice: issue a scoped custom-LLM key, serve it, and
    // start a web call on the visitor's own Bolna account.
    const byoPath = req.url.split("?")[0];
    if (
      byoPath.startsWith("/api/public/llm/") ||
      byoPath === "/api/public/voice/byo/session"
    ) {
      if (!byoEnabled) {
        res.writeHead(503, {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        });
        res.end(
          JSON.stringify({ error: "Bring-your-own voice is not enabled." }),
        );
        return;
      }
      const ip = clientAddress(req);
      const reply = (code, obj) => {
        res.writeHead(code, {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        });
        res.end(JSON.stringify(obj));
      };
      if (req.method === "OPTIONS") {
        res.writeHead(204, { Allow: "GET, POST, DELETE" });
        res.end();
        return;
      }
      if (byoPath === "/api/public/llm/key" && req.method === "POST") {
        if (!byoAllow("key", ip, 10))
          return reply(429, {
            error: "Too many keys from here. Try again in an hour.",
          });
        if (!byoAllow("key", "*", BYO_KEYS_HOUR))
          return reply(429, {
            error: "Too many keys issued this hour. Try again later.",
          });
        loadPublicCases();
        await casesReady?.catch?.(() => {});
        const data = await body(req).catch(() => ({}));
        const scope = String(data?.case ?? "demo");
        const bundle = byoBundle(scope);
        if (!bundle)
          return reply(scope.startsWith("w_") ? 404 : 400, {
            error: scope.startsWith("w_")
              ? "That workspace has no documents yet, or it has expired."
              : "Pick health, deal or a workspace id.",
          });
        byoSweep();
        if (byoKeys.size >= 2000) {
          const [oldest] = byoKeys.keys();
          byoRevoke(oldest);
        }
        const token = byoVoice.bind(bundle, randomBytes(32).toString("hex"));
        byoKeys.set(token, { at: Date.now(), scope, bundle });
        const site =
          process.env.VM_PUBLIC_SITE_ORIGIN ||
          (req.headers["x-forwarded-host"]
            ? `https://${String(req.headers["x-forwarded-host"]).split(",")[0].trim()}`
            : `http://${req.headers.host}`);
        return reply(200, {
          baseUrl: `${site}/api/public/llm/v1`,
          apiKey: token,
          model: "voice-memory",
          scope,
          expiresAt: new Date(Date.now() + BYO_HARD_MS).toISOString(),
        });
      }
      // Revoke: the key itself is the only credential needed to kill it.
      if (byoPath === "/api/public/llm/key" && req.method === "DELETE") {
        const bearer = String(req.headers.authorization ?? "").replace(
          /^Bearer /,
          "",
        );
        return byoRevoke(bearer)
          ? reply(200, { revoked: true })
          : reply(401, { error: "Invalid or expired key." });
      }
      if (
        byoPath === "/api/public/llm/v1/models" ||
        byoPath === "/api/public/llm/v1/chat/completions"
      ) {
        const bearer = String(req.headers.authorization ?? "").replace(
          /^Bearer /,
          "",
        );
        if (!byoLive(bearer))
          return reply(401, {
            error: "Invalid or expired key. Get a new one on the page.",
          });
        if (
          req.method === "POST" &&
          !byoAllow("turn", bearer, 600, 24 * 3600000)
        )
          return reply(429, { error: "This key has reached today's turns." });
        if (
          req.method === "POST" &&
          !byoAllow("turn", "*", BYO_TURNS_DAY, 24 * 3600000)
        )
          return reply(429, {
            error: "Today's turns are used up. Try tomorrow.",
          });
        const response = await byoVoice.handle(
          new Request(origin + byoPath.replace("/api/public/llm", ""), {
            method: req.method,
            headers: { authorization: "Bearer " + bearer },
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
          "Cache-Control": "no-store",
        });
        if (response.body) {
          const reader = response.body.getReader();
          try {
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              res.write(value);
            }
          } finally {
            await reader.cancel().catch(() => {});
          }
        }
        res.end();
        return;
      }
      if (
        byoPath === "/api/public/voice/byo/session" &&
        req.method === "POST"
      ) {
        // The visitor's key arrives in a header, is used for this one mint,
        // and is never stored or logged. Their account pays for the call.
        const key = String(req.headers["x-bolna-key"] ?? "").trim();
        const data = await body(req).catch(() => ({}));
        const agent = String(data?.agent_id ?? "").trim();
        if (!key || key.length > 200 || /\s/.test(key))
          return reply(400, { error: "Paste your Bolna API key." });
        if (!/^[0-9a-f-]{8,64}$/i.test(agent))
          return reply(400, { error: "Paste your Bolna agent id." });
        if (!byoAllow("call", ip, 20))
          return reply(429, {
            error: "Too many calls from here. Try again in an hour.",
          });
        try {
          const ws = String(data?.user_data?.vm_ws ?? "demo");
          const session = await mintBolna(
            {
              page: "landing-byo",
              vm_ws: /^w_[0-9a-f]{32}$/.test(ws) ? ws : "demo",
            },
            { key, agent },
          );
          return reply(200, session);
        } catch (e) {
          return reply(e.status === 429 ? 429 : 502, {
            error:
              e.status === 503
                ? "Bolna web call is not configured."
                : "Bolna did not start the call. Check the key and agent id, and that the agent has web calls enabled.",
          });
        }
      }
      return reply(404, { error: "Not found." });
    }
    // Remote MCP (Streamable HTTP): the same tools as mcp/server.mjs, served
    // by calling this engine's own public API over loopback, so every limit
    // and refusal of the public API applies unchanged.
    if (req.url.split("?")[0] === "/api/public/mcp") {
      const { mcpHttp } = await import("../mcp/server.mjs");
      const port = server.address()?.port;
      const site =
        process.env.VM_PUBLIC_SITE_ORIGIN ||
        "https://voice-memory-beige.vercel.app";
      await mcpHttp(req, res, {
        base: `http://127.0.0.1:${port}/api/public`,
        clientIp: clientAddress(req),
        allowedOrigins: [site],
      });
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
        if (!/^[\w:./%@-]{1,200}$/.test(focus)) {
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
        const dir = new URL("../examples/corpus-md/", import.meta.url);
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
                /^[A-Za-z0-9][A-Za-z0-9 .:-]{0,59}$/.test(data.context)
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
        // Owner calls are unlimited in COUNT and are not capped by the
        // visitor abuse budget; they are still COUNTED (shared lifetime
        // count, the observability point an eventual authorized spend
        // brake binds) and follow the same reservation lifecycle: refund
        // only on definitive pre-session failure, stay charged on
        // ambiguous outcomes, settle on success. Owner-call duration
        // enforcement relies on the vendor-side hard duration cap, which
        // is an activation gate, not yet verified.
        if (!callCounters) {
          const e = Error(
            "Voice calls are unavailable: no durable call-counter store is configured.",
          );
          e.status = 503;
          throw e;
        }
        const adm = await callCounters.admitOwner();
        if (!adm.ok) {
          const e = Error(
            "Voice calls are temporarily unavailable (outcome journal full).",
          );
          e.status = 503;
          throw e;
        }
        try {
          out = await mintBolna({
            ...(data?.user_data && typeof data.user_data === "object"
              ? data.user_data
              : {}),
            vm_res: adm.reservation, // reconcile correlation tag
          });
        } catch (e) {
          if (e.preSession) {
            await callCounters.refundReservation(adm.reservation);
          } else {
            console.warn(
              "owner mint outcome ambiguous; reservation retained for reconcile:",
              e.message,
            );
            await callCounters.recordAmbiguous?.({
              reservation: adm.reservation,
              sessionId: null,
              errorClass: e.status ? `http-${e.status}` : "network",
            });
          }
          throw e;
        }
        try {
          await callCounters.settleReservation(adm.reservation);
        } catch (e) {
          // Accounting failed with a possibly-live owner call: the
          // reservation stays charged, stop is attempted, and the outcome
          // is logged for reconcile. No ended claim on an attempt.
          await callCounters
            .recordAmbiguous?.({
              reservation: adm.reservation,
              sessionId:
                out?.execution_id ?? out?.call_id ?? out?.run_id ?? null,
              errorClass: "settle-failed",
              settleFailed: true,
            })
            .catch((re) =>
              console.warn("owner ambiguous-record write failed:", re.message),
            );
          const stopped = await stopBolna(out);
          console.warn(
            stopped
              ? "owner reservation settle failed; vendor confirms the call is gone; retained:"
              : "owner reservation settle failed; stop attempted but NOT confirmed terminal; retained for reconcile:",
            e.message,
          );
          const err = Error(
            stopped
              ? "Call accounting failed. The call is confirmed ended."
              : "Call accounting failed. The call may still be live; it was NOT confirmed ended.",
          );
          err.status = 503;
          throw err;
        }
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
  server.once("close", () => clearInterval(workspaceSweepTimer));
  return server;
}
export const server = createLocalServer();
export function startServer() {
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

if (process.argv[1] === new URL(import.meta.url).pathname) startServer();
