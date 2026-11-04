// Voice Memory landing: a live evidence desk on the public, key-free API
// (/api/public/*, proxied to the engine by vercel.json). While the free host
// wakes up, answers for the suggested questions come from a saved run of the
// same engine (snapshot.js) and are labelled as such.
(() => {
  "use strict";
  document.documentElement.classList.remove("no-js");
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const snap = window.VM_SNAPSHOT ?? {
    cases: [],
    answers: {},
    docs: {},
    graphs: {},
  };
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;

  const state = {
    drops: [],
    case: "health",
    live: false,
    cases: Object.fromEntries((snap.cases ?? []).map((c) => [c.id, c])),
    context: { health: "", deal: "", own: "" },
    ws: null, // visitor workspace id
    wsDocs: [],
    thread: [],
    current: null,
    docText: {},
    call: null,
    ticket: null,
    callScope: null, // scope the live call answers from
    askSeq: 0, // typed answers older than the latest ask or case switch are dropped
    seenTurns: new Set(),
    lang: /^hi\b/i.test(navigator.language || "") ? "hi" : "en",
    visuals: {},
  };

  const esc = (s) =>
    String(s ?? "").replace(
      /[&<>"']/g,
      (c) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[c],
    );
  const note = (t) => ($("#engine-note").textContent = t);

  // ------------------------------------------------------------ API
  // ------------------------------------------------------------ your own voice keys
  // A visitor's own Bolna, Sarvam or ElevenLabs keys. They stay in this
  // browser (this tab, or this device if they choose), are sent to this
  // server only with the one call or Listen request that needs them, and the
  // server uses them once and keeps nothing.
  let byoEnabled = false;
  const byo = (() => {
    const K = "vm-byo";
    const empty = {
      bolnaKey: "",
      bolnaAgent: "",
      ttsProvider: "",
      ttsKey: "",
      remember: false,
    };
    let v = { ...empty };
    try {
      v = {
        ...empty,
        ...JSON.parse(
          localStorage.getItem(K) || sessionStorage.getItem(K) || "{}",
        ),
      };
    } catch {
      /* storage blocked: keys live for this page only */
    }
    const save = () => {
      try {
        localStorage.removeItem(K);
        sessionStorage.removeItem(K);
        (v.remember ? localStorage : sessionStorage).setItem(
          K,
          JSON.stringify(v),
        );
      } catch {
        /* storage blocked */
      }
    };
    return {
      get: () => ({ ...v }),
      set(patch) {
        v = { ...v, ...patch };
        save();
      },
      clear() {
        v = { ...empty };
        try {
          localStorage.removeItem(K);
          sessionStorage.removeItem(K);
        } catch {
          /* storage blocked */
        }
      },
      hasCall: () => byoEnabled && !!(v.bolnaKey && v.bolnaAgent),
      hasTts: () => byoEnabled && !!(v.ttsProvider && v.ttsKey),
      ttsHeaders: () =>
        byoEnabled && v.ttsProvider && v.ttsKey
          ? { "x-vm-tts-provider": v.ttsProvider, "x-vm-tts-key": v.ttsKey }
          : {},
    };
  })();
  window.VM_BYO = { ttsHeaders: () => byo.ttsHeaders() };
  const listenOn = () => !!state.voiceOut?.enabled || byo.hasTts();
  const callOn = () => !!state.voice?.ready || byo.hasCall();
  const syncVoiceClasses = () => {
    document.documentElement.classList.toggle("voice-on", callOn());
    document.documentElement.classList.toggle("voice-out", listenOn());
  };

  async function api(path, opts = {}, timeoutMs = 20000) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const own = /^\/(speak|narrate-audio\/)/.test(path)
        ? byo.ttsHeaders()
        : {};
      const r = await fetch("/api/public" + path, {
        ...opts,
        headers: { ...(opts.headers ?? {}), ...own },
        signal: ctl.signal,
      });
      const text = await r.text();
      let body = null;
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        body = null;
      }
      if (!r.ok) {
        const e = new Error(
          body?.error ||
            (r.status >= 500
              ? "The engine is waking up. Try again in a moment."
              : "Request failed."),
        );
        e.status = r.status;
        e.retryAfter = Number(r.headers.get("retry-after")) || 0;
        throw e;
      }
      return body;
    } finally {
      clearTimeout(t);
    }
  }

  // Capped exponential backoff with full jitter (AWS Architecture Blog,
  // "Exponential Backoff And Jitter"): wait a random time in [0, min(cap,
  // base * 2^attempt)], so many visitors arriving during one cold boot spread
  // their probes out instead of hitting the waking host in lockstep. A
  // server's Retry-After is honoured as a floor.
  const backoff = (attempt, { base = 1000, cap = 30000, floor = 0 } = {}) =>
    Math.max(floor, Math.random() * Math.min(cap, base * 2 ** attempt));
  // Hidden tabs don't probe: a forgotten background tab would otherwise keep
  // the free host awake (and spend its monthly hours) indefinitely.
  const whenVisible = () =>
    document.hidden
      ? new Promise((r) =>
          document.addEventListener("visibilitychange", function on() {
            if (document.hidden) return;
            document.removeEventListener("visibilitychange", on);
            r();
          }),
        )
      : Promise.resolve();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function connect() {
    note("Connecting to the live engine…");
    // Never give up: a cold free-tier boot plus first-ingest can take several
    // minutes, so keep probing (with backoff) while the page is visible. A
    // page that stops retrying strands every visitor who arrived early.
    const t0 = Date.now();
    for (let i = 0; ; i++) {
      let floor = 0;
      try {
        const s = await api("/status", {}, 8000);
        if (s.cases.health && s.cases.deal) {
          const { cases } = await api("/cases");
          state.cases = Object.fromEntries(cases.map((c) => [c.id, c]));
          state.live = true;
          byoEnabled = s.byoVoice?.enabled === true;
          if ($("#byo")) $("#byo").hidden = !byoEnabled;
          state.voice = s.voice;
          state.semantic = s.semantic ?? null;
          state.voiceOut = s.voiceOut ?? null;
          syncVoiceClasses();
          note(
            "Live engine connected. Every answer is computed now from the fictional records.",
          );
          renderRail();
          if (!$("#viewer-body .page, #viewer-body .vw-text"))
            showEmptyViewer();
          if ($("#answer .overview")) renderOverview();
          return;
        }
      } catch (e) {
        floor = (e.retryAfter || 0) * 1000; /* free host cold start */
      }
      note(
        Date.now() - t0 < 120000
          ? "Waking the live engine (free hosting can take up to a minute). Suggested questions answer from a saved run of the same engine meanwhile."
          : "Still waking the live engine, retrying in the background. Uploads and questions work the moment it is up.",
      );
      await sleep(backoff(Math.min(i, 5), { base: 1500, cap: 20000, floor }));
      await whenVisible();
    }
  }

  // ------------------------------------------------------------ verdicts
  const VERDICT = {
    LATEST: ["v-latest", "Latest value"],
    VALUE: ["v-latest", "From the named report"],
    COMPARED: ["v-ok", "Compared"],
    SINGLE: ["v-latest", "Only one result"],
    OVERVIEW: ["v-ok", "Summary"],
    NOT_COMPARABLE: ["v-no", "Won't compare"],
    AMBIGUOUS_PATIENT: ["v-ask", "Which patient?"],
    PROPOSED: ["v-warn", "Proposed, not approved"],
    APPROVED: ["v-ok", "Approved"],
    AGREED: ["v-ok", "Agreed"],
    OPEN: ["v-warn", "Still open"],
    "NO-RECORD": ["v-no", "Not on record"],
    UNKNOWN: ["v-no", "Not in these documents"],
    EXPLAINED: ["v-ok", "Explained"],
    NO_REASON: ["v-warn", "No reason recorded"],
    DEFINED: ["v-ask", "General meaning"],
    NOT_IN_REPORT: ["v-no", "Not in these reports"],
    NOT_IN_DOCUMENTS: ["v-no", "Not in these documents"],
    CLARIFY: ["v-ask", "Which one?"],
    FLAGGED: ["v-warn", "Outside range"],
    DECLINE_ADVICE: ["v-ask", "Not mine to decide"],
    HELP: ["v-ask", "What I can do"],
    HOW_TO: ["v-ask", "How to"],
    SWITCH: ["v-ask", "Other case"],
    MIXED: ["v-ok", "Two answers"],
  };
  const verdictOf = (v) =>
    VERDICT[v] ??
    (v
      ? ["v-ok", v.replace(/[_-]/g, " ").toLowerCase()]
      : ["v-no", "Not in these documents"]);
  const statusOfDoc = (title) => {
    const t = String(title ?? "").toLowerCase();
    if (t.includes("amended")) return "amended";
    if (t.includes("prelim")) return "preliminary";
    return null;
  };
  const shortTitle = (t) =>
    String(t ?? "")
      .replace(/\.(md|pdf|txt|docx)$/i, "")
      .replace(/^\d+_/, "")
      .replace(/_/g, " ")
      .replace(
        /^a-2026-(\d\d)-?/,
        (m, mo) => `SYN-0001 · ${mo === "09" ? "Sep" : "Oct"} `,
      )
      .replace(/^c-2026-10/, "SYN-0003 · Oct")
      .trim();

  // ------------------------------------------------------------ your documents
  const apiCase = (id) => (id === "own" ? state.ws : id);
  const OWN = {
    id: "own",
    blurb:
      "Upload a lab report, contract, meeting notes or any document, then ask it anything, typed or on a call.",
    suggestions: [
      "What does this document say about the deadline?",
      "Summarize what was decided",
      "What changed since the last report?",
    ],
  };
  try {
    state.ws = sessionStorage.getItem("vm_ws");
  } catch {}
  async function ensureWorkspace() {
    if (state.ws) {
      try {
        await api(`/workspace/${state.ws}`);
        return state.ws;
      } catch {
        state.ws = null;
      }
    }
    const w = await api("/workspace", { method: "POST" });
    state.ws = w.id;
    try {
      sessionStorage.setItem("vm_ws", w.id);
    } catch {}
    syncCallScope();
    return w.id;
  }
  async function uploadFiles(list) {
    const files = [...list].slice(0, 5);
    if (!files.length) return;
    // When each file was dropped: the reading view's clock starts here.
    const dropped = performance.now();
    for (const f of files) if (f.size <= 4 * 1048576) state.drops.push(dropped);
    // Uploads must not wait for the demo cases to finish loading: visitor
    // workspaces are independent of them, so on a cold boot we retry the
    // workspace create instead of turning the visitor away. (This gate was
    // the reported "isn't taking a doc upload" failure.)
    let id = null;
    for (let attempt = 0; attempt < 6 && !id; attempt++) {
      try {
        id = await ensureWorkspace();
      } catch (e) {
        if (attempt === 5) {
          $("#upl-list").innerHTML =
            `<li><b>The live engine is still waking up and the upload did not go through. Try again in a few seconds.</b></li>`;
          return;
        }
        $("#upl-list").innerHTML =
          `<li><b>The live engine is still waking up. Retrying your upload…</b></li>`;
        await new Promise((r) => setTimeout(r, 4000));
      }
    }
    for (const f of files) {
      try {
        if (f.size > 4 * 1048576) throw new Error(`${f.name} is over 4 MB.`);
        await api(
          `/workspace/${id}/upload`,
          {
            method: "POST",
            headers: {
              "content-type": "application/octet-stream",
              "x-file-name": encodeURIComponent(f.name),
            },
            body: f,
          },
          60000,
        );
      } catch (e) {
        state.wsDocs.push({
          title: f.name,
          status: "failed",
          error: { message: e.message },
        });
      }
      refreshWorkspace();
    }
    if (state.case !== "own") setCase("own");
    pollWorkspace();
  }
  async function refreshWorkspace() {
    if (!state.ws) return renderUploads();
    try {
      const st = await api(`/workspace/${state.ws}`);
      const failed = state.wsDocs.filter(
        (d) =>
          d.status === "failed" &&
          !st.documents.some((x) => x.title === d.title),
      );
      state.wsDocs = [...st.documents, ...failed];
      state.cases.own = {
        ...OWN,
        ready: st.ready,
        documents: st.documents.filter(
          (d) => d.status === "ready" || d.included,
        ),
      };
    } catch (e) {
      state.ws = null;
      try {
        sessionStorage.removeItem("vm_ws");
      } catch {}
      if (e?.status === 404) {
        // Confirmed gone (a deploy or the idle sweep cleared it): stop
        // showing its documents as if they were still answerable.
        state.wsDocs = [
          {
            title: "Earlier upload",
            status: "failed",
            error: {
              message:
                "Cleared on the server (deploy or 30 idle minutes). Drop the file again to re-upload.",
            },
          },
        ];
        state.cases.own = { ...OWN, ready: false, documents: [] };
      }
    }
    renderUploads();
    if (state.case === "own") {
      renderRail();
      const ready = (state.cases.own?.documents ?? []).length;
      if (ready !== state.ownReady && $("#answer .overview")) {
        state.ownReady = ready;
        delete state.visuals["own|" + state.lang];
        renderOverview("own");
      }
    }
  }
  let pollTimer = null;
  function pollWorkspace() {
    clearTimeout(pollTimer);
    refreshWorkspace().then(() => {
      if (
        state.wsDocs.some(
          (d) => !["ready", "needs_review", "failed"].includes(d.status),
        )
      )
        pollTimer = setTimeout(pollWorkspace, 600);
    });
  }
  // The live reading view loads with the first upload, not the first paint.
  let readingLoad = null;
  const readingView = () =>
    (readingLoad ??= new Promise((resolve, reject) => {
      const css = document.createElement("link");
      css.rel = "stylesheet";
      css.href = "reading.css";
      document.head.append(css);
      const js = document.createElement("script");
      js.src = "reading.js";
      js.onload = () => resolve(window.VMReading);
      js.onerror = reject;
      document.head.append(js);
    }).catch(() => (readingLoad = null)));
  const STAGE = {
    uploaded: "Queued",
    validating: "Checking",
    parsing: "Reading",
    ocr: "Reading text (OCR)",
    partial: "Ask now · reading scan",
    indexing: "Indexing",
    ready: "Ready",
    needs_review: "Ready · low OCR confidence",
    failed: "Couldn't read",
  };
  function renderUploads() {
    $("#upl-list").innerHTML = state.wsDocs
      .map((d) => {
        const done = d.status === "ready" || d.status === "needs_review";
        const cls = done
          ? "ok"
          : d.status === "failed"
            ? "bad"
            : d.status === "partial"
              ? "ok busy"
              : "busy";
        const extra =
          d.status === "failed"
            ? ` — ${esc(d.error?.message ?? "")}`
            : d.stats?.pages
              ? ` · ${d.stats.pages} p`
              : "";
        return `<li${d.id ? ` data-doc="${esc(d.id)}"` : ""}><b title="${esc(d.title)}">${esc(d.title)}</b><span class="upl-st ${cls}">${esc(STAGE[d.status] ?? d.status)}</span><span class="dim" style="font-size:12px">${extra}</span></li>`;
      })
      .join("");
    if (state.wsDocs.some((d) => d.progress))
      readingView().then((R) =>
        R?.render($("#upl-flow"), state.wsDocs, { drops: state.drops }),
      );
  }
  $("#upl-list").addEventListener("click", (e) => {
    const li = e.target.closest("li[data-doc]");
    if (li && window.VMReading) window.VMReading.focus(li.dataset.doc);
  });
  const drop = $("#drop");
  $("#files").addEventListener("change", (e) => uploadFiles(e.target.files));
  ["dragenter", "dragover"].forEach((ev) =>
    drop.addEventListener(ev, (e) => {
      e.preventDefault();
      drop.classList.add("over");
    }),
  );
  ["dragleave", "drop"].forEach((ev) =>
    drop.addEventListener(ev, () => drop.classList.remove("over")),
  );
  drop.addEventListener("drop", (e) => {
    e.preventDefault();
    uploadFiles(e.dataTransfer.files);
  });

  // Colour-code suggestions by what they test: a change over time, whose
  // record, or a claim to check; plain lookups take the case's own hue.
  const chipKind = (q) =>
    /\b(chang|since|gone up|went|increase|decrease|before|previous)/i.test(q)
      ? "change"
      : /\b(which|whose|SYN-0003|for SYN|who)\b/i.test(q)
        ? "who"
        : /\b(signed|approved|final|finaliz|agree|decided|still open)/i.test(q)
          ? "check"
          : "value";

  // ------------------------------------------------------------ asking
  function setCase(id, { quiet = false } = {}) {
    $("#upload").hidden = id !== "own";
    if (id === "own") {
      state.cases.own ??= { ...OWN, documents: [] };
      refreshWorkspace();
    }
    if (state.case !== id) state.askSeq++; // an answer still arriving is stale
    state.case = id;
    syncCallScope();
    $$(".case-tab").forEach((b) =>
      b.setAttribute("aria-selected", String(b.dataset.case === id)),
    );
    const c = state.cases[id] ?? snap.cases?.find((x) => x.id === id);
    $("#q").placeholder = c?.suggestions?.[0] ?? "Ask a question";
    $("#suggest").innerHTML = (c?.suggestions ?? [])
      .map(
        (s) =>
          `<button class="chip" type="button" data-q="${esc(s)}" data-kind="${chipKind(s)}">${esc(s)}</button>`,
      )
      .join("");
    renderRail();
    if (!quiet) {
      renderOverview(id);
      showEmptyViewer();
    }
  }

  // The case or workspace on screen is the one a live call answers from.
  // On a switch, the page moves its own call (the ticket is its secret);
  // turns answered for the old scope are then dropped, not shown here.
  const scopeOf = (id) => (id === "own" ? state.ws : id);
  function syncCallScope() {
    const scope = scopeOf(state.case);
    if (!state.ticket || !state.call || !scope || state.callScope === scope)
      return;
    state.callScope = scope;
    // A counter per switch: the server applies only the newest update, so
    // quick A -> B -> A switches cannot leave the call on B.
    state.scopeGen = (state.scopeGen ?? 0) + 1;
    api("/voice/scope", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ticket: state.ticket,
        case: scope,
        gen: state.scopeGen,
      }),
    }).catch((e) => {
      // The call keeps its old scope; its turns for that scope stay off
      // this screen (pollTurns), so nothing from the wrong records shows.
      state.callScope = null;
      if (e?.status === 404 && String(scope).startsWith("w_")) {
        // The workspace died mid-call (idle sweep or deploy): stop showing
        // its documents as if they were still answerable.
        state.ws = null;
        try {
          sessionStorage.removeItem("vm_ws");
        } catch {}
        state.wsDocs = [];
        state.cases.own = { ...OWN, ready: false, documents: [] };
        renderUploads();
      }
    });
  }

  // ------------------------------------------------------------ lazy parts
  const loadScript = (src) =>
    new Promise((ok, bad) => {
      const sc = document.createElement("script");
      sc.src = src;
      sc.onload = ok;
      sc.onerror = bad;
      document.head.appendChild(sc);
    });
  const loadCss = (href) => {
    const l = document.createElement("link");
    l.rel = "stylesheet";
    l.href = href;
    document.head.appendChild(l);
  };
  // How-it-works styles ship with the section, not the first load: flow.css
  // loads as #how approaches (same pattern as the desk chunk below).
  const howNear = new Promise((ok) => {
    const how = $("#how");
    if (!how || !("IntersectionObserver" in window))
      return ok(loadCss("flow.css"));
    const io = new IntersectionObserver(
      (es) => {
        if (es.some((e) => e.isIntersecting)) {
          io.disconnect();
          loadCss("flow.css");
          ok();
        }
      },
      { rootMargin: "800px 0px" },
    );
    io.observe(how);
  });
  const deskNear = new Promise((ok) => {
    const desk = $("#desk");
    if (!desk || !("IntersectionObserver" in window)) return ok();
    const io = new IntersectionObserver(
      (es) => {
        if (es.some((e) => e.isIntersecting)) {
          io.disconnect();
          ok();
        }
      },
      { rootMargin: "800px 0px" },
    );
    io.observe(desk);
  });
  let visualP = null;
  const loadVisual = () =>
    (visualP ??= Promise.all([
      window.VMVisual ? null : loadScript("visual.js"),
      window.VM_SNAPSHOT_VISUALS ? null : loadScript("snapshot-visuals.js"),
      new Promise((ok) => {
        const l = document.createElement("link");
        l.rel = "stylesheet";
        l.href = "visual.css";
        l.onload = l.onerror = ok;
        document.head.appendChild(l);
      }),
    ]).catch(() => (visualP = null)));

  // ------------------------------------------------------------ overview
  // The empty answer panel: the case at a glance, narrated (visual.js).
  const LANGS = [
    ["en", "English"],
    ["hi", "हिन्दी"],
    ["hinglish", "Hinglish"],
  ];
  // Saved answers and document texts for the cold-boot path load only when
  // the live engine could not answer (snapshot-answers.js), never eagerly.
  let snapAnswersP = null;
  const loadSnapshotAnswers = () =>
    (snapAnswersP ??= window.VM_SNAPSHOT_ANSWERS
      ? Promise.resolve()
      : loadScript("snapshot-answers.js").catch(() => (snapAnswersP = null)));
  async function overviewFor(id, lang) {
    const k = `${id}|${lang}`;
    if (state.visuals[k]) return state.visuals[k];
    let v = null;
    if (state.live || id === "own") {
      try {
        if (id === "own" && !state.ws) throw 0;
        v = (await api(`/visual/${apiCase(id)}?lang=${lang}`, {}, 15000))
          .visual;
      } catch {
        v = null;
      }
    }
    if (!v) {
      await loadVisual(); // brings snapshot-visuals.js (memoized)
      const saved = (window.VM_SNAPSHOT_VISUALS ?? snap.visuals)?.[id];
      v = saved?.visual
        ? {
            ...saved.visual,
            lang,
            narration: saved.narration?.[lang] ?? saved.visual.narration,
          }
        : null;
    }
    if (v && id !== "own") state.visuals[k] = v;
    return v;
  }
  async function renderOverview(id = state.case) {
    const c = state.cases[id] ?? snap.cases?.find((x) => x.id === id);
    const langBar = `<div class="ov-lang" role="group" aria-label="Narration language">${LANGS.map(
      ([k, label]) =>
        `<button type="button" data-lang="${k}" aria-pressed="${state.lang === k}">${esc(label)}</button>`,
    ).join("")}</div>`;
    $("#answer").innerHTML = `<div class="overview">
        <div class="ov-top"><p class="ov-blurb">${esc(c?.blurb ?? "")}</p>${langBar}</div>
        <div class="ov-body" id="ov-body"><div class="skeleton" style="width:92%"></div><div class="skeleton" style="width:70%"></div><div class="skeleton" style="width:84%"></div></div>
        <p class="dim ov-hint">Pick a question, type or dictate your own.</p>
      </div>`;
    await deskNear;
    const [v] = await Promise.all([overviewFor(id, state.lang), loadVisual()]);
    if (state.case !== id || !$("#ov-body")) return;
    if (!v || !window.VMVisual) {
      $("#ov-body").innerHTML =
        id === "own"
          ? `<p class="ov-empty">Upload a lab report and its results appear here, each placed on the lab's own printed range.</p>`
          : "";
      return;
    }
    window.VMVisual.render($("#ov-body"), v, {
      lang: state.lang,
      caseId: id === "own" ? null : id,
      // deeper chart layers play beside the report, in the desk's right column
      stageHost: $("#desk .desk-right"),
      // Listen is offered only when the server has a neural voice; the
      // narration text is always on screen either way.
      narrateButton: listenOn(),
    });
  }

  // Demo cases ask with a cacheable GET (repeats are served by the CDN, not
  // the free host); visitor workspaces always POST. If the engine predates
  // GET /answer (the site deploys before the engine does), fall back to POST.
  let getAnswers = true;
  async function askEngine(caseId, question, context) {
    if (caseId !== "own" && getAnswers) {
      const qs = new URLSearchParams({ case: caseId, q: question });
      if (context) qs.set("context", context);
      try {
        return await api("/answer?" + qs);
      } catch (e) {
        if (e.status !== 404 && e.status !== 405) throw e;
        getAnswers = false;
      }
    }
    return api("/ask", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        case: apiCase(caseId),
        question,
        context: context || undefined,
        semantic: caseId === "own" ? !!state.aiConsent : undefined,
      }),
    });
  }

  async function ask(question, { via = "typed", caseId = state.case } = {}) {
    question = String(question ?? "").trim();
    if (!question) return;
    if (caseId !== state.case) setCase(caseId, { quiet: true });
    const seq = ++state.askSeq;
    // A slow answer must never land on a newer question or another case.
    const stale = () => seq !== state.askSeq || caseId !== state.case;
    $("#q").value = "";
    const btn = $(".ask-go");
    btn.disabled = true;
    $("#answer").innerHTML =
      `<p class="a-q"><span class="via">${via === "call" ? "Heard on the call" : via === "voice" ? "You said" : "You asked"}</span><q>${esc(question)}</q></p><div class="skeleton" style="width:88%"></div><div class="skeleton" style="width:64%"></div><div class="skeleton" style="width:76%"></div>`;
    let result = null;
    let source = "live";
    try {
      // Visitor workspaces are independent of the demo cases: don't gate
      // their asks on demo-case readiness (the same cold-boot gate that
      // blocked uploads). Demo cases keep the saved-snapshot fallback while
      // the engine wakes; a truly unreachable engine still lands in the
      // catch below via the fetch timeout.
      if (!state.live && caseId !== "own")
        throw Object.assign(new Error("not live"), { offline: true });
      if (caseId === "own" && !state.cases.own?.ready)
        throw new Error("Upload a document first, then ask about it.");
      result = await askEngine(caseId, question, state.context[caseId]);
    } catch (e) {
      if (stale()) return;
      if (!window.VM_SNAPSHOT_ANSWERS) await loadSnapshotAnswers();
      const saved =
        window.VM_SNAPSHOT_ANSWERS?.answers?.[`${caseId}|${question}`];
      if (saved) {
        result = saved;
        source = "saved";
      } else {
        $("#answer").innerHTML =
          `<p class="a-q"><span class="via">You asked</span><q>${esc(question)}</q></p><p class="a-err">${esc(
            e.offline
              ? "The live engine is still waking up. Try a suggested question, or ask again in a few seconds."
              : e.message,
          )}</p>`;
        btn.disabled = false;
        return;
      }
    }
    if (stale()) return;
    btn.disabled = false;
    if (result.lead?.field) state.context[caseId] = result.lead.field;
    if (result.semantic?.lang) state.lang = result.semantic.lang;
    renderAnswer(result, { via, source, question, caseId });
    state.thread.unshift({ question, caseId });
    state.thread = state.thread.slice(0, 5);
    renderThread();
  }

  // The motion module listens for these (sound, print and stamp effects).
  const emit = (name, detail) =>
    document.dispatchEvent(new CustomEvent(name, { detail }));
  function renderAnswer(r, { via, source, question, caseId }) {
    stopTalking();
    state.current = { ...r, question: r.question ?? question, _src: r };
    queueMicrotask(() =>
      emit("vm:answer", { verdict: r.lead?.verdict ?? null, via, source }),
    );
    const lead = r.lead;
    const [cls, label] = lead
      ? verdictOf(lead.verdict)
      : (r.evidence ?? []).length
        ? ["v-ask", "Cited passages"]
        : verdictOf(null);
    const ev = r.evidence ?? [];
    // Without a structured lead (bring-your-own documents), the citation
    // quote can span the whole document; the retrieved passage in r.answer
    // names the actual lines the answer rests on, so show that instead.
    const retrieved = /Relevant source excerpts\n\n([\s\S]*?)\n\[Source 1\]/
      .exec(r.answer ?? "")?.[1]
      ?.trim();
    const text =
      lead?.text ??
      (ev.length
        ? `From the document: “${prettyQuote(retrieved || ev[0].quote).slice(0, 280)}”${ev.length > 1 ? ` (and ${ev.length - 1} more cited passage${ev.length > 2 ? "s" : ""})` : ""}`
        : "I don't see a supported answer to that in these documents.");
    // The companion opener ("Honest answer:") is shown before the answer
    // as well as spoken, so screen and voice are the same words. Every word
    // is a span with its index in the spoken text, for karaoke highlighting.
    const opener = lead?.opener ?? null;
    let wi = 0;
    const spans = (t, offset) =>
      t
        .split(/(\s+)/)
        .map((w, i) =>
          w.trim()
            ? `<span class="w" data-i="${wi++}" style="animation-delay:${reduced ? 0 : Math.min((i + offset) * 18, 1400)}ms">${esc(w)}</span>`
            : w,
        )
        .join("");
    const openerHtml = opener
      ? `<span class="a-opener">${spans(opener, 0)}</span> `
      : "";
    const words = spans(text, opener ? opener.split(/\s+/).length * 2 : 0);
    const cites = lead?.citations?.length
      ? lead.citations
      : (r.evidence ?? []).slice(0, 3);
    $("#answer").innerHTML = `
      <p class="a-q"><span class="via">${via === "call" ? "Heard on the call" : via === "voice" ? "You said" : "You asked"}</span><q>${esc(question)}</q></p>
      <p class="a-lead"><span class="verdict-chip ${cls}">${esc(label)}</span>${openerHtml}${words}</p>
      ${
        r.lead?.interpretedAs
          ? `<p class="a-understood">Understood as “${esc(r.lead.interpretedAs)}”</p>`
          : ""
      }
      ${backgroundHtml(r.lead?.background)}
      ${alsoHtml(r.also)}
      ${closestHtml(r.closest)}
      <div class="a-visual" id="a-visual"></div>
      <div class="a-tools">
        ${
          lead?.text && listenOn() && source !== "saved"
            ? `<button class="tool listen" type="button" data-listen aria-pressed="false"><i class="eq" aria-hidden="true"><b></b><b></b><b></b></i><span>Listen</span></button>`
            : ""
        }
        <span class="dim" style="font-size:12.5px">${
          source === "saved"
            ? "Saved run of the same engine · live engine waking"
            : via === "call"
              ? "Spoken by Bolna from this exact sentence"
              : "Computed live · same sentence a call would speak"
        }</span>
      </div>
      <div class="cites">${cites
        .map((c, i) => {
          // Report status (preliminary / amended) is what a reader needs on a
          // lab citation; claim status lives in the verdict line above.
          const st = statusOfDoc(c.title);
          return `<button class="cite" type="button" data-cite="${i}" style="animation-delay:${200 + i * 90}ms">
            <span class="cite-n">${i + 1}</span>
            <span class="cite-doc">${esc(shortTitle(c.title))}${st ? `<span class="tagline tag-${esc(st)}">${esc(st)}</span>` : ""}${
              c.location?.pages?.[0]
                ? `<span>page ${c.location.pages[0]}</span>`
                : ""
            }</span>
            <span class="cite-q">${
              c.broadCitation
                ? "Wider passage cited - it supports the source, not a pinpoint line."
                : esc(prettyQuote(c.quote))
            }</span>
          </button>`;
        })
        .join("")}</div>`;
    state.currentCites = cites;
    state.currentCase = caseId;
    state.currentLang = r.semantic?.lang ?? state.lang;
    if (r.visual)
      loadVisual().then(() => {
        if (state.current?._src !== r || !$("#a-visual") || !window.VMVisual)
          return;
        window.VMVisual.render($("#a-visual"), r.visual, {
          lang: state.currentLang,
          narrateButton: false,
        });
      });
    else $("#a-visual")?.remove();
    if (cites.length) openCitation(0);
    else if (!lead?.action)
      showEmptyViewer(
        "No passage supports an answer, so nothing is highlighted.",
      );
    // the right column is never blank: if whatever ran above left the
    // viewer empty, fall back to the documents of the case
    if (!$("#viewer-body").firstElementChild) showEmptyViewer();
    runAction(lead?.action);
  }

  // Answers can move the page: show where your own documents go, or take
  // a question to the case it is about. Every action is visible and undone
  // by the next click; nothing is uploaded or asked without the visitor.
  function coach(el, text) {
    if (!el) return;
    el.classList.remove("coach");
    void el.offsetWidth;
    el.classList.add("coach");
    if (text) {
      $$(".coach-tip").forEach((x) => x.remove());
      const tip = document.createElement("span");
      tip.className = "coach-tip";
      tip.setAttribute("role", "status");
      tip.textContent = text;
      el.after(tip);
      setTimeout(() => tip.remove(), 9000);
    }
    setTimeout(() => el.classList.remove("coach"), 9000);
  }
  function runAction(a) {
    if (!a?.type) return;
    if (a.type === "upload") {
      if (a.soft) {
        coach($('.case-tab[data-case="own"]'), "Your own files go here");
        return;
      }
      setCase("own", { quiet: true });
      showEmptyViewer();
      const drop = $("#drop");
      drop?.scrollIntoView({
        behavior: reduced ? "auto" : "smooth",
        block: "center",
      });
      coach(drop, "Drop PDFs, Word files or photos here, or click to choose");
      coach($('.case-tab[data-case="own"]'));
    } else if (a.type === "switch" && a.case && a.question) {
      setTimeout(
        () => {
          setCase(a.case, { quiet: true });
          coach($(`.case-tab[data-case="${a.case}"]`));
          ask(a.question);
        },
        reduced ? 0 : 900,
      );
    }
  }
  // The half of a question that belongs to the other demo case.
  function alsoHtml(also) {
    if (!also?.length) return "";
    const name = { deal: "the Northstar deal", health: "the lab reports" };
    return also
      .map(
        (a) => `<div class="a-also">
          <span class="a-also-k">From ${esc(name[a.case] ?? a.case)}</span>
          <p>${a.opener ? `<span class="a-opener">${esc(a.opener)}</span> ` : ""}${esc(a.text ?? "")}</p>
          <button type="button" class="tool" data-switch-case="${esc(a.case)}" data-switch-q="${esc(a.question)}">Open it there, with the source →</button>
        </div>`,
      )
      .join("");
  }

  // After "I don't see that": the closest line, as a pointer to open and
  // judge, visibly not the answer. Clicking opens the document at it.
  function closestHtml(c) {
    if (!c?.line) return "";
    state.closest = c.citation;
    return `<div class="a-closest">
      <span class="a-closest-k">Closest line in ${esc(c.document)} · not an answer</span>
      <q>${esc(c.line)}</q>
      <button type="button" class="tool" data-closest>Open it in the document →</button>
    </div>`;
  }

  // General knowledge, kept apart from the documents, with its sources.
  function backgroundHtml(bg) {
    if (!bg?.sources?.length) return "";
    return `<p class="a-bg"><span>General background, not from these documents:</span> ${bg.sources
      .map(
        (s) =>
          `<a href="${esc(/^https:\/\//.test(s.uri) ? s.uri : "#")}" target="_blank" rel="noopener noreferrer">${esc(s.title || new URL(s.uri).hostname)}</a>`,
      )
      .join(", ")}</p>`;
  }
  const prettyQuote = (q) => {
    const s = String(q ?? "").trim();
    if (/^\|.*\|$/.test(s)) {
      const cells = s
        .split("|")
        .map((x) => x.trim())
        .filter((x, i, a) => i > 0 && i < a.length - 1);
      return cells.filter(Boolean).join(" · ");
    }
    return s.replace(/^\d+\.\s*/, "");
  };

  function renderThread() {
    $("#thread").innerHTML = state.thread
      .slice(1)
      .map(
        (t) =>
          `<li><button type="button" data-q="${esc(t.question)}" data-case="${t.caseId}">↺ ${esc(t.question)}</button></li>`,
      )
      .join("");
  }

  // ------------------------------------------------------------ viewer
  // What is in each demo case, so a reader sees the traps before asking.
  // Every line here restates the fictional documents themselves.
  const CASE_FILES = {
    health: {
      intro:
        "Four synthetic lab reports for two fictional people. One result was printed wrong and corrected; one test changed units between visits; a second person has their own TSH.",
      latest: {
        doc: "a-2026-10-amended.pdf",
        img: "pages/a-2026-10-amended.png",
        alt: "First page of the amended 15 Oct report for SYN-0001",
        caption:
          "Latest on record: the amended report replaces the preliminary; ferritin corrected 5 to 50 ng/mL, creatinine now in µmol/L.",
      },
      docs: {
        "a-2026-09.pdf": [
          "SYN-0001 · 3 Sep 2026 · final",
          "Baseline: creatinine 1.2 mg/dL, ferritin 0.5 ng/mL",
        ],
        "a-2026-10-prelim.pdf": [
          "SYN-0001 · 12 Oct · preliminary",
          "Ferritin printed as 5; creatinine now in µmol/L",
        ],
        "a-2026-10-amended.pdf": [
          "SYN-0001 · 12 Oct · amended 15 Oct",
          "Ferritin corrected from 5 to 50 ng/mL",
        ],
        "c-2026-10.pdf": [
          "SYN-0003 · Oct 2026",
          "A second person, so “the TSH” is ambiguous",
        ],
      },
    },
    deal: {
      intro:
        "Seven fictional records of one consulting deal. The fee was revised, the payment split was discussed two ways, and nothing was ever signed.",
      latest: {
        doc: "07_Internal_Action_Log.md",
        caption:
          "Latest on record: the 9 Oct action log; open decisions, no signed agreement exists.",
      },
      docs: {
        "01_Northstar_Proposal_v1.md": [
          "Proposal v1 · 4 Sep",
          "$48,000, 50/50 billing; an offer, not an agreement",
        ],
        "02_Client_Kickoff_Notes.md": [
          "Kickoff notes · 11 Sep",
          "Scope narrowed to two regions; finance approval pending",
        ],
        "03_Commercial_Revision.md": [
          "Commercial revision · 18 Sep",
          "$42,000, 40% upfront / 60% after; subject to sign-off",
        ],
        "04_Steering_Committee_Notes.md": [
          "Steering notes · 25 Sep",
          "50/50 discussed; no vote taken",
        ],
        "05_Project_Delivery_Update.md": [
          "Delivery update · 2 Oct",
          "22 Nov is an internal target, not a deadline",
        ],
        "06_Client_Email_Extract.md": [
          "Client email · 6 Oct",
          "Client keeps the 15 Nov deadline",
        ],
        "07_Internal_Action_Log.md": [
          "Action log · 9 Oct",
          "Open decisions; no signed agreement exists",
        ],
      },
    },
  };
  function caseFilesHtml() {
    const c =
      state.cases[state.case] ?? snap.cases?.find((x) => x.id === state.case);
    const docs = c?.documents ?? [];
    if (!docs.length)
      return `<div class="viewer-empty">${
        state.case === "own"
          ? "Your uploaded documents will be listed here. Open one to read it; answers mark the line they rest on."
          : "The original page opens here, with the cited line marked."
      }</div>`;
    const meta = CASE_FILES[state.case] ?? { intro: "", docs: {} };
    const cards = docs
      .map((d, i) => {
        const [head, note] = meta.docs[d.title] ?? [
          shortTitle(d.title),
          d.kind === "pdf"
            ? `${d.pages ?? ""} page PDF`.trim()
            : "Text document",
        ];
        return `<button type="button" class="file-card" data-doc="${esc(d.title)}" style="--i:${i}">
          <span class="file-kind">${esc((d.kind ?? "doc").replace("markdown", "md").toUpperCase())}</span>
          <b>${esc(head)}</b><span>${esc(note)}</span><i aria-hidden="true">Open</i>
        </button>`;
      })
      .join("");
    const latest = meta.latest
      ? `<button type="button" class="case-latest" data-doc="${esc(meta.latest.doc)}">
        ${meta.latest.img ? `<img src="${esc(meta.latest.img)}" alt="${esc(meta.latest.alt ?? "")}" loading="lazy" />` : ""}
        <span class="cl-cap">${esc(meta.latest.caption)} <b>Open</b></span>
      </button>`
      : "";
    return `<div class="case-files">
      <p class="case-files-intro"><b>${docs.length} documents in this case.</b> ${esc(meta.intro)}</p>
      <div class="file-grid">${cards}</div>
      ${latest}
    </div>`;
  }
  function showEmptyViewer(msg = null) {
    $("#viewer-title").textContent = msg ? "Source" : "Documents";
    $("#viewer-meta").textContent = "";
    // the case's documents are always one glance away; a message (e.g. "no
    // passage supports an answer") sits above them
    const files = caseFilesHtml();
    $("#viewer-body").innerHTML =
      msg && /case-files/.test(files)
        ? `<p class="viewer-note">${esc(msg)}</p>${files}`
        : msg
          ? `<div class="viewer-empty">${esc(msg)}</div>`
          : files;
    $$("#doc-rail button").forEach((b) => b.classList.remove("on"));
    const n = (state.cases[state.case]?.documents ?? []).length;
    const btn = $("#files-btn");
    if (btn) {
      btn.hidden = !n;
      btn.querySelector("b").textContent =
        `View the ${n} document${n === 1 ? "" : "s"}`;
    }
  }

  function renderRail() {
    const c =
      state.cases[state.case] ?? snap.cases?.find((x) => x.id === state.case);
    const docs = c?.documents ?? [];
    const btn = $("#files-btn");
    if (btn) {
      btn.hidden = !docs.length;
      btn.querySelector("b").textContent =
        `View the ${docs.length} document${docs.length === 1 ? "" : "s"}`;
    }
    $("#doc-rail").innerHTML = docs
      .map(
        (d) =>
          `<button type="button" data-doc="${esc(d.title)}">${esc(shortTitle(d.title))}</button>`,
      )
      .join("");
  }

  // The cited pages rarely fill the column the answer leaves open. Grow
  // the keep-reading continuation to fit the room: full-width report pages
  // while they fit (a small internal scroll is fine), a compact grid when
  // even one full page would overflow hard. Re-runs as images land and on
  // resize, since the room depends on the answer's own height.
  function adaptCiteMore() {
    const vb = $("#viewer-body");
    const more = vb?.querySelector(".cite-more");
    if (!more) return;
    const desk = vb.closest(".desk");
    const leftEl = desk?.querySelector(".desk-left");
    const bar = desk?.querySelector(".viewer-bar");
    const rail = desk?.querySelector(".doc-rail");
    const all = [...more.querySelectorAll(".cite-more-doc")].map((d) =>
      d.cloneNode(true),
    );
    const fit = () => {
      if (!vb.clientHeight || !desk) return;
      // The cited pages are the proof: the row must be tall enough to show
      // them whole. The answer column usually makes it so; when it does
      // not, the desk grows rather than the source clipping.
      more.style.display = "none";
      const proofNeed =
        vb.scrollHeight + (bar?.offsetHeight ?? 0) + (rail?.offsetHeight ?? 0);
      more.style.display = "";
      const lastLeft = [...(leftEl?.children ?? [])]
        .filter((c) => c.offsetHeight)
        .pop();
      const leftNeed = lastLeft
        ? lastLeft.getBoundingClientRect().bottom -
          leftEl.getBoundingClientRect().top +
          22
        : 0;
      const rowTarget = Math.max(leftNeed, proofNeed, 660);
      if (Math.abs(rowTarget - desk.offsetHeight) > 2)
        desk.style.minHeight = `${Math.round(rowTarget)}px`;
      const over = () => vb.scrollHeight - vb.clientHeight;
      // restore everything first: the room can grow as the answer's own
      // images land, and a taller row fits more of the continuation
      more.querySelectorAll(".cite-more-doc").forEach((d) => d.remove());
      more.append(...all.map((d) => d.cloneNode(true)));
      for (let guard = 0; guard < 6 && over() > 8; guard++) {
        const docs = more.querySelectorAll(".cite-more-doc");
        if (docs.length) docs[docs.length - 1].remove();
        else break;
      }
      // continuation is optional; if even one card does not fit, the
      // documents rail below already lists every report
      if (over() > 8 || !more.querySelector(".cite-more-doc"))
        more.style.display = "none";
    };
    let t = 0;
    const run = () => {
      clearTimeout(t);
      t = setTimeout(fit, 120);
    };
    more
      .querySelectorAll("img")
      .forEach((i) =>
        i.complete ? run() : i.addEventListener("load", run, { once: true }),
      );
    run();
  }
  let citeMoreRo = null;
  if (!citeMoreRo && "ResizeObserver" in window)
    citeMoreRo = new ResizeObserver(() => {
      const m = $("#viewer-body")?.querySelector(".cite-more");
      if (m) adaptCiteMore();
    });
  citeMoreRo?.observe($("#viewer-body"));

  function openCitation(i) {
    const cites = state.currentCites ?? [];
    const c = cites[i];
    if (!c) return;
    // a fresh citation re-balances the desk from scratch
    const deskEl = $("#viewer-body")?.closest(".desk");
    if (deskEl) deskEl.style.minHeight = "";
    $$(".cite").forEach((b) =>
      b.classList.toggle("on", Number(b.dataset.cite) === i),
    );
    // Lab answers that rest on several reports (a correction, a refused
    // comparison) show every cited page, the selected one first.
    const pdfTitles = [
      ...new Set(
        cites.filter((x) => /\.pdf$/i.test(x.title ?? "")).map((x) => x.title),
      ),
    ];
    if (
      state.case === "health" &&
      /\.pdf$/i.test(c.title ?? "") &&
      pdfTitles.length > 1
    ) {
      const order = [c.title, ...pdfTitles.filter((t) => t !== c.title)];
      $$("#doc-rail button").forEach((b) =>
        b.classList.toggle("on", order.includes(b.dataset.doc)),
      );
      $("#viewer-title").textContent = `${order.length} reports cited`;
      $("#viewer-meta").textContent = order
        .map((t) => shortTitle(t))
        .join(" · ");
      // Cited pages rarely fill the column; continue with the case's
      // other reports so the space keeps reading instead of going blank.
      const caseDocs =
        (
          state.cases[state.case] ??
          snap.cases?.find((x) => x.id === state.case)
        )?.documents ?? [];
      const rest = caseDocs.filter((d) => !order.includes(d.title));
      const more = rest.length
        ? `<div class="cite-more"><p class="cite-more-h">Keep reading - the other report${rest.length === 1 ? "" : "s"} in this case</p>${rest
            .map((d) => {
              const base = d.title.replace(/\.pdf$/i, "");
              return `<button type="button" class="cite-more-doc" data-doc="${esc(d.title)}"><img src="pages/${esc(base)}.png" alt="First page of ${esc(d.title)}, a synthetic lab report" loading="lazy" /><span>${esc(shortTitle(d.title))}</span></button>`;
            })
            .join("")}</div>`
        : "";
      $("#viewer-body").innerHTML =
        order
          .map((t, k) =>
            pageHtml(
              t,
              cites.filter((x) => x.title === t),
              k === 0 ? c : cites.find((x) => x.title === t),
              k,
            ),
          )
          .join("") + more;
      adaptCiteMore();
      return;
    }
    const samePage = cites.filter((x) => x.title === c.title);
    openDoc(c.title, samePage, c);
  }

  function boxesFor(cites) {
    return cites
      .map((c) => ({ c, r: c.location?.focus?.regions?.[0] }))
      .filter((x) => x.r?.bbox)
      .map(({ c, r }, k) => {
        const [x0, y0, x1, y1] = r.bbox;
        const pad = 3;
        const old = statusOfDoc(c.title) === "preliminary";
        return `<span class="box${old ? " old" : ""}" style="left:${((x0 - pad) / 595) * 100}%;top:${((y0 - pad) / 400) * 100}%;width:${
          ((x1 - x0 + pad * 2) / 595) * 100
        }%;height:${((y1 - y0 + pad * 2) / 400) * 100}%;animation-delay:${250 + k * 120}ms"></span>`;
      })
      .join("");
  }
  function pageHtml(title, cites, primary, k = 0, boxes = boxesFor(cites)) {
    const base = title.replace(/\.pdf$/i, "");
    const st = statusOfDoc(title);
    return `<div class="page${k ? " stacked" : ""}" style="animation-delay:${k * 160}ms"><img src="pages/${esc(base)}.png" alt="Page 1 of ${esc(title)}, a synthetic lab report" />${boxes}</div>
      <p class="page-note"><span class="verdict-chip ${st === "preliminary" ? "v-no" : st === "amended" ? "v-latest" : "v-ask"}">${esc(shortTitle(title))}${
        st ? " · " + esc(st) : ""
      }</span>${primary ? esc(prettyQuote(primary.quote)) : "Original page, rendered from the PDF"}</p>`;
  }
  // ------------------------------------------------------------ reader
  // Opening any document opens the whole case as one reader: every page of
  // every document, in order, with a page strip to jump between them. The
  // chosen document scrolls into view; a cited line is marked on its page.
  // The cited line itself is marked, never the whole document: a small
  // document is one retrieval chunk, so its "focus" can be every line. The
  // quote the answer rests on is found in the text (whitespace-tolerant);
  // focus lines are used only when they overlap that quote.
  const words = (x) =>
    String(x ?? "")
      .toLowerCase()
      .match(/[\p{L}\p{N}$%.,/-]+/gu) ?? [];
  const overlap = (a, b) => {
    const B = new Set(words(b));
    const A = words(a);
    return A.length ? A.filter((w) => B.has(w)).length / A.length : 0;
  };
  const findSpan = (html, quote) => {
    const q = esc(
      String(quote ?? "")
        .trim()
        .replace(/^\d+\.\s*/, ""),
    );
    if (q.length < 8 || q.length > 600) return null;
    const re = new RegExp(
      q
        .split(/\s+/)
        .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
        .join("\\s+"),
    );
    const m = re.exec(html);
    return m ? [m.index, m.index + m[0].length] : null;
  };
  const markText = (text, cites) => {
    let html = esc(text);
    const spans = [];
    for (const c of cites) {
      const quote = prettyQuote(c.quote);
      const exact = findSpan(html, quote) ?? findSpan(html, c.quote);
      if (exact) {
        spans.push(exact);
        continue;
      }
      const lines = (c.location?.focus?.text ?? [])
        .map((x) => String(x).trim())
        .filter((x) => x.length > 10)
        .filter((x, _, all) => all.length <= 2 || overlap(x, quote) >= 0.5);
      for (const l of lines) {
        const sp = findSpan(html, l);
        if (sp) spans.push(sp);
      }
    }
    // apply from the end so earlier offsets stay valid; skip overlaps
    spans.sort((a, b) => b[0] - a[0]);
    let last = Infinity;
    for (const [a, b] of spans) {
      if (b > last) continue;
      html = `${html.slice(0, a)}<mark>${html.slice(a, b)}</mark>${html.slice(b)}`;
      last = a;
    }
    return html.replace(/^# (.*)$/m, '<span class="h">$1</span>');
  };
  // Long text documents are set as pages (~42 lines), like a printout.
  const textPages = (html) => {
    const lines = html.split("\n");
    const out = [];
    for (let i = 0; i < lines.length; i += 42)
      out.push(lines.slice(i, i + 42).join("\n"));
    return out.length ? out : [html];
  };
  function boxesHtml(cites) {
    return cites
      .map((c) => ({ c, r: c.location?.focus?.regions?.[0] }))
      .filter((x) => x.r?.bbox)
      .map(({ c, r }, k) => {
        const [x0, y0, x1, y1] = r.bbox;
        const pad = 3;
        const old = statusOfDoc(c.title) === "preliminary";
        return `<span class="box${old ? " old" : ""}" style="left:${((x0 - pad) / 595) * 100}%;top:${((y0 - pad) / 400) * 100}%;width:${
          ((x1 - x0 + pad * 2) / 595) * 100
        }%;height:${((y1 - y0 + pad * 2) / 400) * 100}%;animation-delay:${250 + k * 120}ms"></span>`;
      })
      .join("");
  }
  let pdfjsP = null;
  const loadPdfjs = () =>
    (pdfjsP ??= import("./vendor/pdf.min.mjs").then((m) => {
      m.GlobalWorkerOptions.workerSrc = "vendor/pdf.worker.min.mjs";
      return m;
    }));
  // Visitor PDFs: every page rendered from the original file, in the browser.
  async function renderPdfPages(holder, docId, cites) {
    try {
      const pdfjs = await loadPdfjs();
      const r = await fetch(
        `/api/public/doc/${apiCase("own")}/${docId}/original`,
      );
      if (!r.ok) throw 0;
      const pdf = await pdfjs.getDocument({
        data: new Uint8Array(await r.arrayBuffer()),
        isEvalSupported: false,
      }).promise;
      holder.innerHTML = "";
      for (let n = 1; n <= pdf.numPages; n++) {
        const page = await pdf.getPage(n);
        const vp = page.getViewport({ scale: 1 });
        const scale =
          Math.min(2, (holder.clientWidth || 560) / vp.width) *
          (window.devicePixelRatio || 1);
        const view = page.getViewport({ scale });
        const wrap = document.createElement("div");
        wrap.className = "rd-page rd-canvas";
        wrap.style.aspectRatio = `${vp.width} / ${vp.height}`;
        wrap.innerHTML = `<span class="rd-pno">Page ${n} of ${pdf.numPages}</span>`;
        const cv = document.createElement("canvas");
        cv.width = view.width;
        cv.height = view.height;
        wrap.prepend(cv);
        for (const c of cites)
          for (const reg of c.location?.focus?.regions ?? [])
            if (reg.page === n && reg.bbox) {
              const [x0, y0, x1, y1] = reg.bbox;
              const box = document.createElement("span");
              box.className = "box";
              Object.assign(box.style, {
                left: `${(x0 / vp.width) * 100}%`,
                top: `${(y0 / vp.height) * 100}%`,
                width: `${((x1 - x0) / vp.width) * 100}%`,
                height: `${((y1 - y0) / vp.height) * 100}%`,
              });
              wrap.appendChild(box);
            }
        holder.appendChild(wrap);
        await page.render({
          canvasContext: cv.getContext("2d"),
          viewport: view,
        }).promise;
      }
    } catch {
      holder.innerHTML = `<p class="viewer-note">Couldn't render the pages of this PDF here; its text is below.</p>`;
      return false;
    }
    return true;
  }

  async function openDoc(title, cites = [], primary = null) {
    emit("vm:source", { title, cited: cites.length > 0 });
    loadVisual();
    const c =
      state.cases[state.case] ?? snap.cases?.find((x) => x.id === state.case);
    const docs = c?.documents?.length
      ? c.documents
      : [{ title, kind: /\.pdf$/i.test(title) ? "pdf" : "md", pages: 1 }];
    $$("#doc-rail button").forEach((b) =>
      b.classList.toggle("on", b.dataset.doc === title),
    );
    const pagesOf = (d) => Math.max(1, Number(d.pages) || 1);
    const total = docs.reduce((n, d) => n + pagesOf(d), 0);
    $("#viewer-title").textContent = shortTitle(title);
    $("#viewer-meta").textContent =
      `${docs.length} document${docs.length === 1 ? "" : "s"}, ${total} page${total === 1 ? "" : "s"}`;
    const strip = docs
      .map(
        (d, i) =>
          `<button type="button" class="rd-thumb${d.title === title ? " on" : ""}" data-jump="${i}" title="${esc(d.title)}">${
            /\.pdf$/i.test(d.title) && state.case === "health"
              ? `<img src="pages/${esc(d.title.replace(/\.pdf$/i, ""))}.png" alt="" loading="lazy" />`
              : `<span class="rd-tx" aria-hidden="true"><i></i><i></i><i></i><i></i></span>`
          }<span>${esc(shortTitle(d.title))}</span></button>`,
      )
      .join("");
    const sections = docs.map((d, i) => {
      const st = statusOfDoc(d.title);
      const mine = d.title === title ? cites : [];
      const head = `<header class="rd-head"><b>${esc(shortTitle(d.title))}</b>${st ? `<span class="tagline tag-${esc(st)}">${esc(st)}</span>` : ""}<span class="rd-count">Document ${i + 1} of ${docs.length}, ${pagesOf(d)} page${pagesOf(d) === 1 ? "" : "s"}</span></header>`;
      let pages = "";
      if (/\.pdf$/i.test(d.title) && state.case === "health") {
        const base = d.title.replace(/\.pdf$/i, "");
        for (let n = 1; n <= pagesOf(d); n++)
          pages += `<div class="page rd-page" style="animation-delay:${Math.min(i, 3) * 90}ms"><img src="pages/${esc(n === 1 ? base : `${base}-p${n}`)}.png" alt="Page ${n} of ${esc(d.title)}, a synthetic lab report" loading="lazy" />${n === 1 ? boxesHtml(mine) : ""}<span class="rd-pno">Page ${n} of ${pagesOf(d)}</span></div>`;
      } else
        pages = `<div class="rd-pages" data-text="${i}"><div class="skeleton" style="width:80%"></div></div>`;
      const note =
        primary && d.title === title
          ? `<p class="page-note">${esc(prettyQuote(primary.quote))}</p>`
          : "";
      return `<section class="rd-doc${d.title === title ? " focus" : ""}" data-doc-i="${i}">${head}${pages}${note}</section>`;
    });
    $("#viewer-body").innerHTML =
      `<div class="reader"><nav class="rd-strip" aria-label="Pages in this case">${strip}</nav>${sections.join("")}</div>`;
    // Text documents (and visitor PDFs) fill in as they load.
    await Promise.all(
      docs.map(async (d, i) => {
        const holder = $(`#viewer-body [data-text="${i}"]`);
        if (!holder) return;
        const mine = d.title === title ? cites : [];
        if (state.case === "own" && d.kind === "pdf" && d.id) {
          const pdfHolder = document.createElement("div");
          pdfHolder.className = "rd-pdf";
          holder.before(pdfHolder);
          if (await renderPdfPages(pdfHolder, d.id, mine)) {
            holder.remove();
            return;
          }
        }
        const text = await docText(d.title);
        if (!holder.isConnected) return;
        if (text == null) {
          holder.innerHTML = `<p class="viewer-note">Couldn't load this document right now.</p>`;
          return;
        }
        const pages = textPages(markText(text, mine));
        holder.innerHTML = pages
          .map(
            (h, n) =>
              `<div class="vw-text rd-page">${h}${pages.length > 1 ? `<span class="rd-pno">Page ${n + 1} of ${pages.length}</span>` : ""}</div>`,
          )
          .join("");
      }),
    );
    const target = $("#viewer-body mark") ?? $("#viewer-body .rd-doc.focus");
    if (
      target &&
      $("#viewer-body").scrollHeight > $("#viewer-body").clientHeight
    )
      target.scrollIntoView({
        block: target.tagName === "MARK" ? "center" : "start",
        behavior: reduced ? "auto" : "smooth",
      });
  }
  function jumpTo(i) {
    const sec = $(`#viewer-body [data-doc-i="${i}"]`);
    if (!sec) return;
    $$("#viewer-body .rd-thumb").forEach((b) =>
      b.classList.toggle("on", b.dataset.jump === String(i)),
    );
    sec.scrollIntoView({
      block: "start",
      behavior: reduced ? "auto" : "smooth",
    });
  }

  async function docText(title) {
    if (state.docText[title] && state.case !== "own")
      return state.docText[title];
    try {
      // Visitor documents come from their workspace, not the demo cases:
      // don't gate them on demo-case readiness either (see ask()).
      if (!state.live && state.case !== "own") throw 0;
      const cid = state.case === "own" ? "own" : "deal";
      const d = (state.cases[cid]?.documents ?? []).find(
        (x) => x.title === title,
      );
      if (!d) throw 0;
      const { document } = await api(`/doc/${apiCase(cid)}/${d.id}`);
      state.docText[title] = document.text;
    } catch {
      if (!window.VM_SNAPSHOT_ANSWERS) await loadSnapshotAnswers();
      const saved = window.VM_SNAPSHOT_ANSWERS?.docs?.[title];
      if (saved) state.docText[title] = saved;
    }
    return state.docText[title] ?? null;
  }

  // ------------------------------------------------------------ listen
  // The answer in the server's neural voice, word by word (listen.js, loaded
  // on the first Listen press; it never falls back to the browser's voice).
  let listenP = null;
  const loadListen = () =>
    (listenP ??= window.VMListen
      ? Promise.resolve()
      : loadScript("listen.js").catch(() => (listenP = null)));
  const stopTalking = () => window.VMListen?.stop();
  const listenAnswer = (btn) =>
    loadListen().then(() =>
      window.VMListen?.play(btn, {
        api,
        apiCase,
        esc,
        state,
        $$,
      }),
    );

  // ------------------------------------------------------------ live call
  const callbar = $("#callbar");
  const callState = (html) => ($("#call-state").innerHTML = html);
  const meter = $$(".call-meter i");

  // The Bolna call library is ~235 KB; most visitors never call, so it loads
  // on the first sign of intent (hover, focus or touch on a call button), or
  // at the latest when the call starts.
  let bolnaP = null;
  const loadBolna = () =>
    (bolnaP ??= window.BolnaWebCall
      ? Promise.resolve()
      : new Promise((ok, bad) => {
          const sc = document.createElement("script");
          sc.src = "vendor/bolna-web-call.min.js";
          sc.onload = ok;
          sc.onerror = () => ((bolnaP = null), bad(Error("load failed")));
          document.head.appendChild(sc);
        }));
  // The same intent also wakes the engine, so a free host that went to
  // sleep is up by the time the caller has clicked and allowed the mic
  // (a call into a sleeping engine hears the caller but never answers).
  let warmed = 0;
  const warmEngine = () => {
    if (Date.now() - warmed < 60000) return;
    warmed = Date.now();
    api("/status", {}, 60000).catch(() => {});
  };
  for (const ev of ["pointerenter", "focusin", "touchstart"])
    document.addEventListener(
      ev,
      (e) => {
        if (!e.target.closest?.("[data-start-call],[data-call-link]")) return;
        loadBolna();
        warmEngine();
      },
      { capture: true, passive: true },
    );

  async function startCall() {
    // Server gate first: when minting is closed, never ask for the
    // microphone - say so and stop. The buttons are hidden in this state;
    // this guard is the programmatic backstop.
    if (!callOn()) {
      callState("Voice calls are currently disabled on this server.");
      return;
    }
    const own = byo.hasCall() ? byo.get() : null;
    $("#try").scrollIntoView({
      behavior: reduced ? "auto" : "smooth",
      block: "start",
    });
    if (state.call) return stopCall();
    await loadBolna().catch(() => {});
    if (!window.BolnaWebCall) {
      callState(
        "The call library didn't load. Refresh the page and try again.",
      );
      return;
    }
    if (state.case === "own") {
      // Never mint a call that can only say "your documents expired" (the
      // server clears uploads on deploy and after 30 idle minutes), and
      // never answer from the demo records behind the caller's back.
      if (!state.ws) {
        callState("Upload your documents first, then call.");
        return;
      }
      callState("Checking your upload…");
      try {
        await api(`/workspace/${state.ws}`);
      } catch {
        state.ws = null;
        try {
          sessionStorage.removeItem("vm_ws");
        } catch {}
        state.wsDocs = [];
        state.cases.own = { ...OWN, ready: false, documents: [] };
        renderUploads();
        callState(
          "Your upload expired on the server (deploys and 30 idle minutes clear uploads). Upload it again, then call.",
        );
        return;
      }
    }
    callbar.classList.add("busy");
    $("#call-label").textContent = "Connecting…";
    // Ask for the microphone first: a Bolna session is single-use and expires
    // in about two minutes, so it is minted only once the mic is granted.
    callState("Allow the microphone to start the call…");
    let audio;
    try {
      const pre = await navigator.mediaDevices.getUserMedia({ audio: true });
      pre.getTracks().forEach((tr) => tr.stop());
      // Virtual loopback devices (BlackHole, Teams, Soundflower…) are often the
      // system default on creators' Macs and send silence. Prefer a real mic.
      const mics = (await navigator.mediaDevices.enumerateDevices()).filter(
        (d) => d.kind === "audioinput",
      );
      const virtual =
        /blackhole|virtual|loopback|soundflower|teams|zoom|obs|aggregate|vb-audio|cable/i;
      const real = mics.filter((d) => !virtual.test(d.label));
      const pick =
        real.find((d) => d.deviceId === "default") ??
        real.find((d) => /built-in|internal|microphone|mic/i.test(d.label)) ??
        real[0];
      if (pick) {
        audio = {
          deviceId: { exact: pick.deviceId },
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        };
        state.mic = pick.label.replace(/^Default - /, "");
      }
    } catch {
      callbar.classList.remove("busy");
      $("#call-label").textContent = "Call Voice Memory";
      callState(
        "Microphone blocked. Allow it in the address bar, then call again.",
      );
      return;
    }
    // Never put a caller through to a sleeping engine: wait for it first.
    if (!state.live) {
      callState("Waking the voice engine (free hosting, up to a minute)…");
      for (let i = 0; i < 24; i++) {
        try {
          const s = await api("/status", {}, 8000);
          if (s.cases?.health && s.cases?.deal) break;
        } catch {
          /* still waking */
        }
        await sleep(backoff(Math.min(i, 4), { base: 1500, cap: 6000 }));
      }
    }
    callState("Getting a call line…");
    const call = new window.BolnaWebCall({
      ...(audio ? { audio } : {}),
      getSession: async () => {
        // The open case or workspace: voice answers from what is on screen.
        const user_data = {
          page: "landing",
          vm_ws: scopeOf(state.case) || "demo",
        };
        state.callScope = user_data.vm_ws;
        // your own Bolna account pays for the call; no server allowance used
        const r = own
          ? await fetch("/api/public/voice/byo/session", {
              method: "POST",
              headers: {
                "content-type": "application/json",
                "x-bolna-key": own.bolnaKey,
              },
              body: JSON.stringify({ agent_id: own.bolnaAgent, user_data }),
            })
          : await fetch("/api/public/voice/session", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ user_data }),
            });
        const body = await r.json().catch(() => ({}));
        if (!r.ok)
          throw new Error(body.error || "Couldn't start a call right now.");
        state.ticket = body.vm_ticket;
        return body;
      },
    });
    state.call = call;
    call.on("state-change", (s) => {
      if (s === "connecting") callState("Connecting to Bolna…");
      if (s === "ringing") callState("Ringing…");
    });
    call.on("media-permission", () => callState("Microphone on · connecting…"));
    call.on("call-start", () => {
      emit("vm:call", "start");
      callbar.classList.remove("busy");
      callbar.classList.add("live");
      $("#call-label").textContent = "Hang up";
      callState(
        `<b>Live${state.mic ? " · " + esc(state.mic) : ""}.</b> Ask: “${esc(state.cases[state.case]?.suggestions?.[0] ?? "What is SYN-0001's ferritin result?")}”`,
      );
      pollTurns();
    });
    call.on("volume-level", (v) => {
      // The motion module draws a spline waveform from these levels; the
      // bars below are the fallback when it isn't loaded.
      document.dispatchEvent(new CustomEvent("vm:level", { detail: v }));
      meter.forEach(
        (m, i) =>
          (m.style.height = `${4 + Math.max(0, v * 26 - Math.abs(i - 3) * 3) * (0.7 + Math.random() * 0.6)}px`),
      );
    });
    call.on("error", (e) => {
      const msg = {
        microphone_denied:
          "Microphone blocked. Allow it in the address bar, then call again.",
        at_capacity:
          "All voice lines are busy. Try again in a minute, or type your question.",
        autoplay_blocked: "Your browser blocked audio. Click Call again.",
        connect_failed:
          "Couldn't reach the call server. Check your network and try again.",
      }[e.code];
      callState(esc(msg ?? e.message ?? "The call couldn't start."));
    });
    call.on("call-end", ({ reason }) => endUi(reason));
    try {
      await call.start();
    } catch {
      endUi("failed");
    }
  }

  function endUi(reason) {
    emit("vm:call", "end");
    document.dispatchEvent(new CustomEvent("vm:level", { detail: -1 }));
    callbar.classList.remove("live", "busy");
    $("#call-label").textContent = "Call Voice Memory";
    meter.forEach((m) => (m.style.height = "4px"));
    if (reason && reason !== "failed")
      callState("Call ended. The answers stay on screen with their sources.");
    state.call = null;
    state.callScope = null;
    setTimeout(() => (state.ticket = null), 20000);
  }
  function stopCall() {
    state.call?.stop();
  }

  async function pollTurns() {
    while (state.ticket) {
      try {
        const { turns } = await api(
          `/voice/turns?ticket=${state.ticket}`,
          {},
          6000,
        );
        for (const t of turns ?? []) {
          const key = t.at + t.question;
          if (state.seenTurns.has(key)) continue;
          state.seenTurns.add(key);
          // The server says which case answered. A turn answered for a
          // scope this page has since left is dropped, never drawn over the
          // case now on screen (nor guessed from citation file names).
          // (An engine older than the page sends no case: show it on the
          // open case, as before, rather than dropping every turn.)
          const caseId =
            t.case === undefined
              ? state.case
              : /^w_/.test(t.case ?? "")
                ? "own"
                : t.case === "health" || t.case === "deal"
                  ? t.case
                  : null;
          if (!caseId || scopeOf(caseId) !== scopeOf(state.case)) continue;
          state.askSeq++; // supersede any typed answer still arriving
          renderAnswer(
            { lead: t.lead, evidence: [] },
            { via: "call", source: "live", question: t.question, caseId },
          );
        }
      } catch (e) {
        // The server cuts the ticket at the per-call max duration (and a
        // restart drops all tickets): end the call so the audio actually
        // stops, not just the evidence feed.
        if (e?.status === 403) {
          state.ticket = null;
          if (state.call) stopCall();
          else endUi("ended");
        }
        /* keep polling while the call lasts */
      }
      await new Promise((r) => setTimeout(r, 1200));
    }
  }

  // ------------------------------------------------------------ graph preview
  // A small force layout. Integrated with dt so it runs the same at 60 Hz
  // and 144 Hz (the old per-frame `v *= 0.82` ran 2.4x faster on 144 Hz
  // screens), and the loop stops entirely while the canvas is off screen.
  function miniGraph() {
    const cv = $("#graph-mini");
    if (!cv || cv.dataset.engine === "3d") return;
    const ctx = cv.getContext("2d");
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const W = 640,
      H = 420;
    cv.width = W * dpr;
    cv.height = H * dpr;
    ctx.scale(dpr, dpr);
    const load = async () =>
      (await (
        window.VM_SNAPSHOT_GRAPHS
          ? Promise.resolve()
          : loadScript("snapshot-graphs.js")
      ).then(
        () => window.VM_SNAPSHOT_GRAPHS?.health,
        () => null,
      )) ?? (await api("/graph/health").catch(() => null));
    const COLORS = {
      patient: "#f4dc4a",
      document: "#8fa3ff",
      topic: "#eceae0",
      value: "#4fd1bd",
    };
    load().then((g) => {
      if (!g) return;
      const nodes = g.nodes.map((n, i) => ({
        ...n,
        x: W / 2 + Math.cos(i * 2.4) * (80 + (i % 7) * 22),
        y: H / 2 + Math.sin(i * 2.4) * (60 + (i % 5) * 20),
        vx: 0,
        vy: 0,
      }));
      const by = new Map(nodes.map((n) => [n.id, n]));
      const edges = g.edges
        .map((e) => ({ ...e, a: by.get(e.from), b: by.get(e.to) }))
        .filter((e) => e.a && e.b);
      let t = 0,
        raf = 0,
        last = 0,
        visible = false;
      // Constants were tuned per 60 Hz frame; k = dt * 60 rescales them.
      const step = (k) => {
        for (const a of nodes) {
          for (const b of nodes) {
            if (a === b) continue;
            const dx = a.x - b.x,
              dy = a.y - b.y;
            const d2 = dx * dx + dy * dy + 0.01;
            if (d2 < 9000) {
              const f = (60 / d2) * k;
              a.vx += dx * f;
              a.vy += dy * f;
            }
          }
          a.vx += (W / 2 - a.x) * 0.0016 * k;
          a.vy += (H / 2 - a.y) * 0.0024 * k;
        }
        for (const e of edges) {
          const dx = e.b.x - e.a.x,
            dy = e.b.y - e.a.y;
          const d = Math.hypot(dx, dy) || 1;
          const f = (d - (e.kind === "corrects" ? 40 : 62)) * 0.006 * k;
          e.a.vx += (dx / d) * f;
          e.a.vy += (dy / d) * f;
          e.b.vx -= (dx / d) * f;
          e.b.vy -= (dy / d) * f;
        }
        const damp = Math.pow(0.82, k); // exponential decay, frame-rate independent
        for (const n of nodes) {
          n.vx *= damp;
          n.vy *= damp;
          n.x += (n.vx + Math.sin(t / 1.5 + n.x) * 0.06) * k;
          n.y += (n.vy + Math.cos(t / 1.8 + n.y) * 0.06) * k;
        }
      };
      const draw = () => {
        ctx.clearRect(0, 0, W, H);
        for (const e of edges) {
          const special = e.kind === "corrects" || e.kind === "not comparable";
          ctx.strokeStyle =
            e.kind === "corrects"
              ? "rgba(244,220,74,0.9)"
              : e.kind === "not comparable"
                ? "rgba(232,115,90,0.9)"
                : "rgba(160,170,200,0.22)";
          ctx.lineWidth = special ? 2 : 1;
          ctx.setLineDash(special ? [5, 5] : []);
          ctx.lineDashOffset = -t * 30;
          ctx.beginPath();
          ctx.moveTo(e.a.x, e.a.y);
          ctx.lineTo(e.b.x, e.b.y);
          ctx.stroke();
        }
        ctx.setLineDash([]);
        for (const n of nodes) {
          const r =
            n.kind === "patient"
              ? 9
              : n.kind === "document"
                ? 7
                : n.kind === "topic"
                  ? 4.5
                  : 5.5;
          const col =
            n.status === "superseded" ? "#e8735a" : (COLORS[n.kind] ?? "#ccc");
          ctx.fillStyle = col;
          ctx.beginPath();
          ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
          ctx.fill();
          if (
            n.kind === "patient" ||
            (n.kind === "topic" && /ferritin|creatinine/i.test(n.label)) ||
            /^(5|50) ng/.test(n.label)
          ) {
            ctx.fillStyle = "rgba(236,234,224,0.85)";
            ctx.font = "500 12px Plex, system-ui, sans-serif";
            ctx.fillText(n.label, n.x + r + 5, n.y + 4);
          }
        }
      };
      const tick = (now) => {
        const dt = last ? Math.min(0.05, (now - last) / 1000) : 1 / 60;
        last = now;
        t += dt;
        step(dt * 60);
        draw();
        raf = visible && !document.hidden ? requestAnimationFrame(tick) : 0;
        if (!raf) last = 0;
      };
      const wake = () => {
        if (!raf && visible && !document.hidden)
          raf = requestAnimationFrame(tick);
      };
      // Settle the layout before the first paint, so the band never shows an
      // empty canvas (or a burst of motion) when it scrolls into view.
      for (let i = 0; i < 240; i++) step(1);
      draw();
      if (reduced) return;
      new IntersectionObserver(([en]) => {
        visible = en.isIntersecting;
        wake();
      }).observe(cv);
      document.addEventListener("visibilitychange", wake);
    });
  }

  // ------------------------------------------------------------ wiring
  document.addEventListener("click", (e) => {
    const t = e.target.closest(
      "[data-q],[data-ask],[data-cite],[data-closest],.tm-tabs [data-plug],[data-doc],[data-files],[data-listen],[data-start-call],[data-lang],[data-jump],[data-switch-case],.case-tab",
    );
    if (!t) return;
    if (t.matches(".case-tab")) return setCase(t.dataset.case);
    if (t.matches("[data-lang]")) {
      state.lang = t.dataset.lang;
      return renderOverview();
    }
    if (t.matches("[data-start-call]")) {
      e.preventDefault();
      return startCall();
    }
    if (t.matches("[data-ask]")) {
      $("#try").scrollIntoView({
        behavior: reduced ? "auto" : "smooth",
        block: "start",
      });
      return ask(t.dataset.ask, { caseId: t.dataset.askCase });
    }
    if (t.matches("[data-q]"))
      return ask(t.dataset.q, { caseId: t.dataset.case || state.case });
    if (t.matches("[data-cite]")) return openCitation(Number(t.dataset.cite));
    if (t.matches(".tm-tabs [data-plug]")) {
      $$(".tm-tabs [data-plug]").forEach((b) =>
        b.setAttribute("aria-selected", String(b === t)),
      );
      $$(".tm-code[data-plug]").forEach(
        (c) => (c.hidden = c.dataset.plug !== t.dataset.plug),
      );
      return;
    }
    if (t.matches("[data-closest]") && state.closest?.title)
      return openDoc(state.closest.title, [state.closest], state.closest);
    if (t.matches("[data-doc]")) return openDoc(t.dataset.doc);
    if (t.matches("[data-switch-case]"))
      return runAction({
        type: "switch",
        case: t.dataset.switchCase,
        question: t.dataset.switchQ,
      });
    if (t.matches("[data-jump]")) return jumpTo(Number(t.dataset.jump));
    if (t.matches("[data-files]")) {
      showEmptyViewer();
      if (matchMedia("(max-width: 1060px)").matches)
        $("#viewer").scrollIntoView({
          behavior: reduced ? "auto" : "smooth",
          block: "start",
        });
      return;
    }
    if (t.matches("[data-listen]")) {
      window.VMVisual?.stop?.();
      return listenAnswer(t);
    }
  });
  $("#askbar").addEventListener("submit", (e) => {
    e.preventDefault();
    ask($("#q").value);
  });
  $$("[data-call-link]").forEach((a) =>
    a.addEventListener("click", () =>
      setTimeout(() => $("#call-btn").focus(), 600),
    ),
  );

  // Reveal on scroll. The stat count-up lives in motion.bundle.mjs (it
  // times the numbers with the same cubic-bezier as the CSS transitions);
  // without it the final figures are already in the HTML.
  const io = new IntersectionObserver(
    (entries) =>
      entries.forEach((en) => {
        if (!en.isIntersecting) return;
        en.target.classList.add("on");
        io.unobserve(en.target);
      }),
    { threshold: 0.18 },
  );
  $$("[data-reveal]").forEach((el) => io.observe(el));

  // Dictation (dictate.js), loaded on the first sign of intent.
  let dictP = null;
  const loadDictate = () =>
    (dictP ??= Promise.all([loadScript("dictate.js"), loadVisual()])
      .then(() =>
        window.VMDictate?.init({
          input: $("#q"),
          button: $("#dict-btn"),
          status: $("#dict-status"),
          lang: () => state.lang,
          caseId: () => (state.case === "own" ? (state.ws ?? "") : state.case),
          serverTranscribe: () => !!state.semantic?.transcribe,
          providers: () => state.semantic?.transcribeProviders ?? ["gemini"],
          onText: (text) => ask(text, { via: "voice" }),
        }),
      )
      .catch(() => (dictP = null)));
  const dictBtn = $("#dict-btn");
  for (const ev of ["pointerenter", "focus", "touchstart"])
    dictBtn?.addEventListener(ev, loadDictate, { once: true, passive: true });
  dictBtn?.addEventListener("click", async (e) => {
    if (window.VMDictate) return; // dictate.js handles clicks once loaded
    e.preventDefault();
    const ctl = await loadDictate();
    ctl?.start();
  });

  // Active-section pill: a black lozenge that slides behind the nav link
  // for the section currently in view (anchor links only).
  (() => {
    const ul = $(".nav ul");
    if (!ul) return;
    const links = $$('a[href^="#"]', ul)
      .map((a) => ({ a, sec: $(a.getAttribute("href")) }))
      .filter((x) => x.sec);
    if (!links.length) return;
    const pill = document.createElement("span");
    pill.className = "nav-pill";
    pill.setAttribute("aria-hidden", "true");
    ul.prepend(pill);
    // Compact mobile indicator: a small black chip naming the active
    // section, shown only where the link list is hidden.
    const chip = document.createElement("span");
    chip.className = "nav-chip";
    chip.setAttribute("aria-hidden", "true");
    ul.before(chip);
    let current = null;
    let ticking = false;
    const place = (a) => {
      const r = a.getBoundingClientRect();
      const ur = ul.getBoundingClientRect();
      pill.style.left = `${r.left - ur.left}px`;
      pill.style.top = `${r.top - ur.top}px`;
      pill.style.width = `${r.width}px`;
      pill.style.height = `${r.height}px`;
    };
    const update = () => {
      ticking = false;
      const y = scrollY + innerHeight * 0.38;
      let active = null;
      for (const { a, sec } of links) if (sec.offsetTop <= y) active = a;
      if (active === current) return;
      current = active;
      for (const { a } of links) a.classList.toggle("active", a === active);
      chip.textContent = active ? active.textContent : "";
      if (active) {
        place(active);
        pill.style.opacity = "1";
      } else {
        pill.style.opacity = "0";
      }
    };
    addEventListener(
      "scroll",
      () => {
        if (!ticking) {
          ticking = true;
          requestAnimationFrame(update);
        }
      },
      { passive: true },
    );
    addEventListener(
      "resize",
      () => {
        if (current) place(current);
        update();
      },
      { passive: true },
    );
    update();
  })();

  // Your own voice keys: the panel under the call bar.
  (async () => {
    const root = $("#byo");
    if (!root) return;
    // Provider controls are not needed until this panel is opened.
    await new Promise((resolve) => {
      if (root.open) return resolve();
      const opened = () => {
        if (!root.open) return;
        root.removeEventListener("toggle", opened);
        resolve();
      };
      root.addEventListener("toggle", opened);
    });
    try {
      const response = await fetch("byo-panel.html");
      if (!response.ok)
        throw Error("Voice controls could not load. Reload to retry.");
      root.insertAdjacentHTML("beforeend", await response.text());
      document.head.append(
        Object.assign(document.createElement("link"), {
          rel: "stylesheet",
          href: "byo.css",
        }),
      );
    } catch (error) {
      $("#byo-state").textContent = error.message;
      return;
    }
    const f = {
      bolnaKey: $("#byo-bolna-key"),
      bolnaAgent: $("#byo-bolna-agent"),
      ttsProvider: $("#byo-tts-provider"),
      ttsKey: $("#byo-tts-key"),
      remember: $("#byo-remember"),
    };
    const fill = () => {
      const v = byo.get();
      for (const [k, el] of Object.entries(f))
        if (el)
          el.type === "checkbox"
            ? (el.checked = !!v[k])
            : (el.value = v[k] ?? "");
      $("#byo-state").textContent = [
        byo.hasCall() ? "Calls use your Bolna account" : "",
        byo.hasTts()
          ? `Listen uses your ${v.ttsProvider === "sarvam" ? "Sarvam" : "ElevenLabs"} key`
          : "",
      ]
        .filter(Boolean)
        .join(" · ");
    };
    const save = () => {
      byo.set(
        Object.fromEntries(
          Object.entries(f).map(([k, el]) => [
            k,
            el.type === "checkbox" ? el.checked : el.value.trim(),
          ]),
        ),
      );
      syncVoiceClasses();
      fill();
      if ($("#answer .overview")) renderOverview();
    };
    for (const el of Object.values(f)) el?.addEventListener("change", save);
    $("#byo-clear")?.addEventListener("click", () => {
      byo.clear();
      revokeShown();
      syncVoiceClasses();
      fill();
      $("#byo-llm").hidden = true;
      if ($("#answer .overview")) renderOverview();
    });
    // custom-LLM keys issued on this page, kept only in memory so Clear can revoke them
    const shownKeys = new Set();
    const revokeShown = () => {
      for (const key of shownKeys)
        fetch("/api/public/llm/key", {
          method: "DELETE",
          headers: { authorization: `Bearer ${key}` },
        }).catch(() => {});
      shownKeys.clear();
    };
    $("#byo-llm-get")?.addEventListener("click", async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      const scope = state.case === "own" ? state.ws : state.case;
      try {
        const k = await api("/llm/key", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ case: scope || "demo" }),
        });
        const box = $("#byo-llm");
        box.querySelector('[data-k="url"]').textContent = k.baseUrl;
        shownKeys.add(k.apiKey);
        box.querySelector('[data-k="key"]').textContent = k.apiKey;
        box.querySelector('[data-k="model"]').textContent = k.model;
        box.querySelector('[data-k="until"]').textContent = new Date(
          k.expiresAt,
        ).toLocaleString();
        box.hidden = false;
      } catch (err) {
        $("#byo-state").textContent = err.message;
      } finally {
        btn.disabled = false;
      }
    });
    root.addEventListener("click", (e) => {
      const c = e.target.closest("[data-copy]");
      if (!c) return;
      const text = c.previousElementSibling?.textContent ?? "";
      navigator.clipboard?.writeText(text).then(() => {
        c.textContent = "Copied";
        setTimeout(() => (c.textContent = "Copy"), 1200);
      });
    });
    fill();
    syncVoiceClasses();
  })();

  // The saved memory graphs live in snapshot-graphs.js, off the first load.
  // The landing's 3D band reads them from VM_SNAPSHOT.graphs when it nears
  // the viewport, so fetch them well before that (page idle, or 1600 px out)
  // and expose them there.
  (() => {
    const cv = $("#graph-mini");
    if (!cv || !window.VM_SNAPSHOT) return;
    if (!window.VM_SNAPSHOT.graphs)
      Object.defineProperty(window.VM_SNAPSHOT, "graphs", {
        configurable: true,
        get: () => window.VM_SNAPSHOT_GRAPHS,
      });
    let started = false;
    const go = () => {
      if (started || window.VM_SNAPSHOT_GRAPHS) return;
      started = true;
      loadScript("snapshot-graphs.js").catch(() => (started = false));
    };
    const io = new IntersectionObserver(
      (es) => es.some((e) => e.isIntersecting) && (io.disconnect(), go()),
      { rootMargin: "1600px 0px" },
    );
    io.observe(cv);
    (window.requestIdleCallback ?? ((f) => setTimeout(f, 2500)))(go, {
      timeout: 4000,
    });
  })();

  // Hero: hovering the card pauses the story so it can be read, but a tab
  // click must still play the chosen story through to its answer; otherwise
  // the pointer on the tab freezes the card on its empty first step.
  (() => {
    const card = $(".hero-card");
    if (!card) return;
    // "" idle, "jump" until the chosen story starts, "play" until its answer
    let phase = "";
    for (const t of $$(".hc-tab", card))
      t.addEventListener("click", () => {
        if (!card.classList.contains("hc-loop")) return;
        phase = "jump";
        card.dispatchEvent(new PointerEvent("pointerleave"));
      });
    new MutationObserver(() => {
      const s = card.dataset.step;
      if (phase === "jump" && s === "ask") phase = "play";
      if (phase !== "play" || s !== "answer") return;
      phase = "";
      if (card.matches(":hover, :focus-within"))
        card.dispatchEvent(new PointerEvent("pointerenter"));
    }).observe(card, { attributes: true, attributeFilter: ["data-step"] });
  })();

  setCase("health");
  miniGraph();
  connect();
  // Deep link: /?q=...&case=deal asks immediately (used by the walkthrough).
  const p = new URLSearchParams(location.search);
  if (p.get("q"))
    setTimeout(
      () => ask(p.get("q"), { caseId: p.get("case") || "health" }),
      400,
    );
})();
