// Public, key-free API for the landing page. Visitors ask questions about
// built-in fictional cases (synthetic lab reports for SYN-0001, and the
// Northstar deal records); every answer is the same deterministic,
// source-checked output the voice call speaks. Nothing here can upload,
// import, reset, read an owner session or change a record.
//
//   GET  /api/public/status                 readiness of each case + voice
//   GET  /api/public/cases                  cases and their documents
//   POST /api/public/ask                    {case, question, context?}
//   GET  /api/public/doc/:case/:id          parsed document (text, pages, elements)
//   GET  /api/public/doc/:case/:id/original original file bytes (inert)
//   GET  /api/public/graph/:case            evidence graph (documents, values, sentences)
//   POST /api/public/voice/session          mints one Bolna web-call session (capped)
//
// Rate limits are per client address and global; voice minting has its own
// tighter caps because each call spends the operator's Bolna credits.
import { randomBytes } from "node:crypto";
import { documentView } from "./library.mjs";
import { buildGraph } from "./memory/graph.mjs";
import { createMemory } from "./memory/memory.mjs";
import { seriesFor, compare } from "./clinical/observations.mjs";

export const CASES = {
  health: {
    title: "Lab reports · SYN-0001",
    blurb: "Synthetic lab reports with a corrected result and a unit change.",
    suggestions: [
      "What is SYN-0001's ferritin result?",
      "Did ferritin change since the last report?",
      "Has creatinine gone up since September?",
      "What is the TSH for SYN-0003?",
    ],
  },
  deal: {
    title: "Northstar deal · 7 records",
    blurb: "A proposal, a revision, steering notes and an action log.",
    suggestions: [
      "Was the $42,000 revision finalized?",
      "What is the engagement fee?",
      "Did they agree on the payment split?",
      "What's still open?",
    ],
  },
};

const num = (v, d) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : d;
};

/** Sliding-window counter keyed by string. */
function limiter(max, windowMs) {
  const hits = new Map();
  return (key, now = Date.now()) => {
    const r = hits.get(key) ?? { n: 0, start: now };
    if (now - r.start > windowMs) Object.assign(r, { n: 0, start: now });
    r.n++;
    hits.set(key, r);
    if (hits.size > 10000) hits.delete(hits.keys().next().value);
    return r.n <= max;
  };
}

export function clientAddress(req) {
  // Behind Render (and the Vercel rewrite) the client is the first
  // X-Forwarded-For hop. Spoofable, so it only shapes per-visitor limits;
  // the global limits below hold regardless.
  const xff = String(req.headers["x-forwarded-for"] ?? "")
    .split(",")[0]
    .trim();
  return xff || req.socket.remoteAddress || "unknown";
}

/**
 * @param {object} deps
 * @param {Record<string, any>} deps.cases case id -> session-like object ({bundle, sourceToEntry, library})
 * @param {(s:any, question:string, ctx:string) => Promise<any>} deps.resolve deterministic answer for a session
 * @param {() => Promise<object>} deps.mintVoice mints a Bolna session
 * @param {() => object} deps.voiceState {configured, ready}
 */
export function createPublicApi({
  cases,
  resolve,
  mintVoice,
  voiceState,
  voiceTurns = () => [],
}) {
  const tickets = new Map(); // ticket -> mint time (call evidence feed)
  const askLimit = limiter(num(process.env.VM_PUBLIC_ASK_PER_MIN, 40), 60000);
  const globalAsk = limiter(
    num(process.env.VM_PUBLIC_ASK_GLOBAL_PER_MIN, 600),
    60000,
  );
  const voicePerIp = limiter(
    num(process.env.VM_PUBLIC_CALLS_PER_IP_HOUR, 4),
    3600000,
  );
  const voiceDaily = limiter(
    num(process.env.VM_PUBLIC_CALLS_PER_DAY, 80),
    86400000,
  );
  const voiceGapMs = num(process.env.VM_PUBLIC_CALL_GAP_MS, 45000);
  // Visitor call minting is deny-by-default: only VM_PUBLIC_VOICE=on
  // (exact, lowercase) enables it. Unset, empty, or any other value keeps
  // minting closed, so a redeploy that loses the env var cannot silently
  // reopen anonymous shared-credit calls. The typed demo and the owner
  // call path are unaffected either way, and status advertises voice only
  // while calls are enabled, so the landing shows its call buttons only
  // then.
  const publicVoiceOn = process.env.VM_PUBLIC_VOICE === "on";
  let lastMint = 0;

  const send = (res, status, obj, extra = {}) => {
    res.writeHead(status, {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      ...extra,
    });
    res.end(JSON.stringify(obj));
  };
  const caseOf = (id) => (Object.hasOwn(CASES, id) ? cases[id] : null);
  const entryOf = (s, id) =>
    (s?.library ?? []).find((e) => e.id === id && e.doc) ?? null;

  async function readJson(req, limit = 8192) {
    let n = 0;
    const chunks = [];
    for await (const c of req) {
      n += c.length;
      if (n > limit)
        throw Object.assign(Error("Request too large."), { status: 413 });
      chunks.push(c);
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    } catch {
      throw Object.assign(Error("Send JSON."), { status: 400 });
    }
  }

  /** Returns true when the request was handled. */
  return async function handle(req, res) {
    const url = new URL(req.url, "http://x");
    if (!url.pathname.startsWith("/api/public/")) return false;
    const path = url.pathname.slice("/api/public".length);
    const ip = clientAddress(req);
    try {
      if (req.method === "OPTIONS") {
        res.writeHead(204, { Allow: "GET, POST" });
        res.end();
        return true;
      }
      if (req.method === "GET" && path === "/status") {
        send(res, 200, {
          cases: Object.fromEntries(
            Object.keys(CASES).map((k) => [k, !!cases[k]?.bundle]),
          ),
          voice: publicVoiceOn
            ? voiceState()
            : { configured: false, ready: false },
        });
        return true;
      }
      if (req.method === "GET" && path === "/cases") {
        send(res, 200, {
          cases: Object.entries(CASES).map(([id, c]) => ({
            id,
            ...c,
            ready: !!cases[id]?.bundle,
            documents: (cases[id]?.library ?? [])
              .filter((e) => e.doc)
              .map((e) => ({
                id: e.id,
                title: e.title,
                filename: e.filename,
                kind: e.doc.kind,
                pages: e.doc.pages?.length ?? null,
              })),
          })),
        });
        return true;
      }
      if (req.method === "POST" && path === "/ask") {
        if (!globalAsk("*") || !askLimit(ip)) {
          send(
            res,
            429,
            { error: "Lots of questions right now. Try again in a minute." },
            { "Retry-After": "30" },
          );
          return true;
        }
        const data = await readJson(req);
        const s = caseOf(data.case);
        if (!s) return (send(res, 400, { error: "Pick a case." }), true);
        if (!s.bundle)
          return (
            send(
              res,
              503,
              {
                error:
                  "This case is still loading. Try again in a few seconds.",
              },
              { "Retry-After": "3" },
            ),
            true
          );
        const q = typeof data.question === "string" ? data.question.trim() : "";
        if (!q || q.length > 400)
          return (
            send(res, 400, {
              error: "Ask a question of up to 400 characters.",
            }),
            true
          );
        const ctx =
          typeof data.context === "string" &&
          /^[A-Za-z]{1,40}$/.test(data.context)
            ? data.context
            : "";
        const shown = await resolve(s, q, ctx);
        send(res, 200, publicAnswer(shown));
        return true;
      }
      const doc = /^\/doc\/(\w+)\/([0-9a-f-]{36})(\/original)?$/.exec(path);
      if (req.method === "GET" && doc) {
        const e = entryOf(caseOf(doc[1]), doc[2]);
        if (!e) return (send(res, 404, { error: "Not found." }), true);
        if (doc[3]) {
          if (!e.original)
            return (send(res, 404, { error: "Original not available." }), true);
          res.writeHead(200, {
            "Content-Type": e.doc.mime,
            "Content-Security-Policy": "default-src 'none'; sandbox",
            "Cache-Control": "public, max-age=3600",
          });
          res.end(e.original);
          return true;
        }
        send(
          res,
          200,
          { document: documentView(e) },
          { "Cache-Control": "public, max-age=600" },
        );
        return true;
      }
      const graph = /^\/graph\/(\w+)$/.exec(path);
      if (req.method === "GET" && graph) {
        const s = caseOf(graph[1]);
        if (!s?.bundle)
          return (
            send(res, s ? 503 : 404, { error: s ? "Loading." : "Not found." }),
            true
          );
        const focus = url.searchParams.get("focus") || "all";
        if (!/^[\w:./%-]{1,200}$/.test(focus))
          return (send(res, 400, { error: "Bad focus" }), true);
        const mem = s.publicMemory ?? (s.publicMemory = createMemory());
        const g =
          focus === "all"
            ? s.bundle.clinical?.length
              ? clinicalGraph(s.bundle)
              : fullGraph(s.bundle, mem)
            : buildGraph(s.bundle, mem, focus);
        const docId = (sid) => s.sourceToEntry?.get(sid)?.id ?? null;
        for (const n of g.nodes) {
          if (n.kind === "document") n.documentId = docId(n.id.slice(4));
          if (n.evidence) n.evidence.documentId = docId(n.evidence.sourceId);
        }
        for (const e of g.edges)
          if (e.evidence) e.evidence.documentId = docId(e.evidence.sourceId);
        send(res, 200, g, { "Cache-Control": "public, max-age=300" });
        return true;
      }
      if (req.method === "POST" && path === "/voice/session") {
        if (!publicVoiceOn)
          return (
            send(res, 503, {
              error: "Voice calls are disabled on this server.",
            }),
            true
          );
        const v = voiceState();
        if (!v.configured)
          return (
            send(res, 503, {
              error: "Live calls are not configured on this server.",
            }),
            true
          );
        if (!v.ready)
          return (
            send(
              res,
              503,
              {
                error:
                  "The voice line is warming up. Try again in a few seconds.",
              },
              { "Retry-After": "5" },
            ),
            true
          );
        const now = Date.now();
        if (now - lastMint < voiceGapMs)
          return (
            send(
              res,
              429,
              {
                error:
                  "Someone is on a call right now. Try again in under a minute.",
                scope: "global",
              },
              {
                "Retry-After": String(
                  Math.ceil((voiceGapMs - (now - lastMint)) / 1000),
                ),
              },
            ),
            true
          );
        if (!voicePerIp(ip))
          return (
            send(res, 429, {
              error:
                "You've used this hour's demo calls. Type a question instead, or come back later.",
              scope: "customer",
            }),
            true
          );
        if (!voiceDaily("*"))
          return (
            send(res, 429, {
              error: "Today's demo calls are used up. Type a question instead.",
              scope: "global",
            }),
            true
          );
        lastMint = now;
        const data = await readJson(req).catch(() => ({}));
        try {
          const session = await mintVoice(data?.user_data);
          // A ticket lets this caller (and only this caller) read the
          // verified turns of the call it just started.
          const ticket = randomBytes(16).toString("hex");
          tickets.set(ticket, now);
          for (const [t, at] of tickets)
            if (now - at > 15 * 60000) tickets.delete(t);
          send(res, 200, { ...session, vm_ticket: ticket });
        } catch (e) {
          lastMint = 0;
          throw e;
        }
        return true;
      }
      if (req.method === "GET" && path === "/voice/turns") {
        const at = tickets.get(url.searchParams.get("ticket") ?? "");
        if (!at || Date.now() - at > 15 * 60000)
          return (send(res, 403, { error: "This call has ended." }), true);
        send(res, 200, { turns: voiceTurns(at - 5000) });
        return true;
      }
      send(res, 404, { error: "Not found." });
      return true;
    } catch (err) {
      if (!res.headersSent)
        send(res, Number.isSafeInteger(err?.status) ? err.status : 500, {
          error: err?.status
            ? err.message
            : "Something went wrong answering that. Try again.",
        });
      else res.end();
      return true;
    }
  };
}

/** The visitor-facing slice of an answer: no internals, every quote located. */
export function publicAnswer(shown) {
  const cite = (c) => ({
    documentId: c.documentId ?? null,
    title: c.title ?? c.sourceTitle ?? null,
    quote: c.quote ?? null,
    start: c.start ?? null,
    end: c.end ?? null,
    status: c.status ?? null,
    location: c.location
      ? {
          pages: c.location.pages ?? null,
          boxes: c.location.boxes ?? null,
          focus: c.location.focus ?? null,
          elementIds: c.location.elementIds ?? null,
        }
      : null,
  });
  return {
    question: shown.question,
    lead: shown.lead
      ? {
          text: shown.lead.text,
          verdict: shown.lead.verdict,
          field: shown.lead.field ?? null,
          citations: (shown.lead.citations ?? []).map(cite),
        }
      : null,
    answer: shown.answer ?? shown.text ?? null,
    status: shown.status ?? null,
    evidence: (shown.evidence ?? []).slice(0, 4).map(cite),
  };
}

/** Every level of the evidence graph at once: topics, documents, values and
 * the exact sentences behind each value, merged by id. */
export function fullGraph(bundle, memory) {
  const nodes = new Map();
  const edges = new Map();
  const add = (g) => {
    for (const n of g.nodes) nodes.set(n.id, { ...nodes.get(n.id), ...n });
    for (const e of g.edges)
      edges.set(e.id ?? `${e.from}->${e.to}:${e.kind}`, e);
  };
  const overview = buildGraph(bundle, memory, "overview");
  add(overview);
  for (const t of overview.nodes.filter((n) => n.kind === "topic")) {
    const g = buildGraph(bundle, memory, t.id);
    add(g);
    for (const v of g.nodes.filter(
      (n) => n.kind === "value" || n.kind === "observation",
    ))
      add(buildGraph(bundle, memory, v.id));
  }
  for (const d of overview.nodes.filter((n) => n.kind === "document"))
    add(buildGraph(bundle, memory, d.id));
  return {
    focus: "all",
    nodes: [...nodes.values()],
    edges: [...edges.values()],
  };
}

const prettyDate = (iso) => {
  if (!iso) return null;
  const d = new Date(iso + "T00:00:00Z");
  return Number.isNaN(+d)
    ? iso
    : d.toLocaleDateString("en-GB", {
        day: "numeric",
        month: "short",
        timeZone: "UTC",
      });
};

/** Lab-report graph: patients -> reports -> observations -> tests, with the
 * amendment ("corrects") and comparability edges the engine actually uses. */
export function clinicalGraph(bundle) {
  const nodes = new Map();
  const edges = new Map();
  const node = (n) => nodes.set(n.id, { ...nodes.get(n.id), ...n });
  const edge = (e) =>
    edges.set(`${e.from}->${e.to}:${e.kind}`, {
      id: `${e.from}->${e.to}:${e.kind}`,
      ...e,
    });
  const reports = bundle.clinical ?? [];
  const evidenceOf = (o, r) => {
    const src = bundle.sources.find((s) => s.id === r.sourceId);
    return src
      ? {
          sourceId: src.id,
          start: o.source.start,
          end: o.source.end,
          quote: src.text.slice(o.source.start, o.source.end),
          page: o.source.page,
          bbox: o.source.bbox,
        }
      : null;
  };
  for (const r of reports) {
    const pid = r.meta.patient?.id ?? "unidentified";
    const status = (r.meta.status ?? "unknown").toLowerCase();
    node({ id: `patient:${pid}`, kind: "patient", label: pid });
    node({
      id: `doc:${r.sourceId}`,
      kind: "document",
      label: `${prettyDate(r.meta.collected) ?? r.title} · ${status}`,
      date: r.meta.reported ?? r.meta.collected ?? null,
      status,
    });
    edge({
      from: `patient:${pid}`,
      to: `doc:${r.sourceId}`,
      kind: "has report",
    });
    for (const o of r.observations) {
      const tid = `test:${pid}:${o.key}`;
      node({ id: tid, kind: "topic", label: o.test, patient: pid });
      const id = `obs:${r.sourceId}:${o.key}`;
      node({
        id,
        kind: "value",
        label:
          `${o.comparator ?? ""}${o.raw.replace(/^[<>≤≥]=?/, "")} ${o.unit ?? ""}`.trim(),
        field: o.key,
        test: o.test,
        status: status === "preliminary" ? "preliminary" : "current",
        date: r.meta.collected ?? null,
        evidence: evidenceOf(o, r),
      });
      edge({ from: `doc:${r.sourceId}`, to: id, kind: "records" });
      edge({ from: id, to: tid, kind: "measures" });
    }
  }
  // Same collection, amended report wins: the older value is superseded.
  const pids = [
    ...new Set(reports.map((r) => r.meta.patient?.id).filter(Boolean)),
  ];
  for (const pid of pids) {
    const keys = new Set(
      reports
        .filter((r) => r.meta.patient?.id === pid)
        .flatMap((r) => r.observations.map((o) => o.key)),
    );
    for (const key of keys) {
      const series = seriesFor(reports, key, pid);
      let prev = null;
      for (const point of series) {
        const cur = `obs:${point.current.report.sourceId}:${key}`;
        node({ id: cur, status: "current" });
        for (const old of point.superseded) {
          const oid = `obs:${old.report.sourceId}:${key}`;
          node({ id: oid, status: "superseded" });
          edge({ from: cur, to: oid, kind: "corrects" });
        }
        // Unchanged repeats inside an amended report are not separate news.
        if (prev) {
          const c = compare(prev.current, point.current);
          edge({
            from: `obs:${prev.current.report.sourceId}:${key}`,
            to: cur,
            kind: c.comparable ? "then" : "not comparable",
            reason: c.comparable ? null : c.reason,
          });
        }
        prev = point;
      }
    }
  }
  return {
    focus: "all",
    nodes: [...nodes.values()],
    edges: [...edges.values()],
  };
}
