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
    seenTurns: new Set(),
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
  async function api(path, opts = {}, timeoutMs = 20000) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const r = await fetch("/api/public" + path, {
        ...opts,
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
          state.voice = s.voice;
          if (s.voice?.ready)
            document.documentElement.classList.add("voice-on");
          note(
            "Live engine connected. Every answer is computed now from the fictional records.",
          );
          renderRail();
          if (!$("#viewer-body .page, #viewer-body .vw-text")) showEmptyViewer();
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
    COMPARED: ["v-ok", "Compared"],
    OVERVIEW: ["v-ok", "Summary"],
    NOT_COMPARABLE: ["v-no", "Won't compare"],
    AMBIGUOUS_PATIENT: ["v-ask", "Which patient?"],
    PROPOSED: ["v-warn", "Proposed, not approved"],
    APPROVED: ["v-ok", "Approved"],
    AGREED: ["v-ok", "Agreed"],
    OPEN: ["v-warn", "Still open"],
    "NO-RECORD": ["v-no", "Not on record"],
    UNKNOWN: ["v-no", "Not in these documents"],
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
    return w.id;
  }
  async function uploadFiles(list) {
    const files = [...list].slice(0, 5);
    if (!files.length) return;
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
    } catch {
      state.ws = null;
      try {
        sessionStorage.removeItem("vm_ws");
      } catch {}
    }
    renderUploads();
    if (state.case === "own") renderRail();
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
        pollTimer = setTimeout(pollWorkspace, 1200);
    });
  }
  const STAGE = {
    uploaded: "Queued",
    validating: "Checking",
    parsing: "Reading",
    ocr: "Reading text (OCR)",
    indexing: "Indexing",
    ready: "Ready",
    needs_review: "Ready · low OCR confidence",
    failed: "Couldn't read",
  };
  function renderUploads() {
    $("#upl-list").innerHTML = state.wsDocs
      .map((d) => {
        const done = d.status === "ready" || d.status === "needs_review";
        const cls = done ? "ok" : d.status === "failed" ? "bad" : "busy";
        const extra =
          d.status === "failed"
            ? ` — ${esc(d.error?.message ?? "")}`
            : d.stats?.pages
              ? ` · ${d.stats.pages} p`
              : "";
        return `<li><b title="${esc(d.title)}">${esc(d.title)}</b><span class="upl-st ${cls}">${esc(STAGE[d.status] ?? d.status)}</span><span class="dim" style="font-size:12px">${extra}</span></li>`;
      })
      .join("");
  }
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
    state.case = id;
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
      $("#answer").innerHTML =
        `<div class="answer-empty"><p>${esc(c?.blurb ?? "")}</p><p class="dim">Pick a question or type your own.</p></div>`;
      showEmptyViewer();
    }
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
      }),
    });
  }

  async function ask(question, { via = "typed", caseId = state.case } = {}) {
    question = String(question ?? "").trim();
    if (!question) return;
    if (caseId !== state.case) setCase(caseId, { quiet: true });
    $("#q").value = "";
    const btn = $(".ask-go");
    btn.disabled = true;
    $("#answer").innerHTML =
      `<p class="a-q"><span class="via">${via === "call" ? "Heard on the call" : "You asked"}</span><q>${esc(question)}</q></p><div class="skeleton" style="width:88%"></div><div class="skeleton" style="width:64%"></div><div class="skeleton" style="width:76%"></div>`;
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
      const saved = snap.answers?.[`${caseId}|${question}`];
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
    btn.disabled = false;
    if (result.lead?.field) state.context[caseId] = result.lead.field;
    renderAnswer(result, { via, source, question, caseId });
    state.thread.unshift({ question, caseId });
    state.thread = state.thread.slice(0, 5);
    renderThread();
  }

  // The motion module listens for these (sound, print and stamp effects).
  const emit = (name, detail) =>
    document.dispatchEvent(new CustomEvent(name, { detail }));
  function renderAnswer(r, { via, source, question, caseId }) {
    state.current = r;
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
    const words = text
      .split(/(\s+)/)
      .map((w, i) =>
        w.trim()
          ? `<span class="w" style="animation-delay:${reduced ? 0 : Math.min(i * 18, 1400)}ms">${esc(w)}</span>`
          : w,
      )
      .join("");
    const cites = lead?.citations?.length
      ? lead.citations
      : (r.evidence ?? []).slice(0, 3);
    $("#answer").innerHTML = `
      <p class="a-q"><span class="via">${via === "call" ? "Heard on the call" : "You asked"}</span><q>${esc(question)}</q></p>
      <p class="a-lead"><span class="verdict-chip ${cls}">${esc(label)}</span>${words}</p>
      <div class="a-tools">
        <button class="tool" type="button" data-listen>▶ Listen</button>
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
            <span class="cite-q">${esc(prettyQuote(c.quote))}</span>
          </button>`;
        })
        .join("")}</div>`;
    state.currentCites = cites;
    state.currentCase = caseId;
    if (cites.length) openCitation(0);
    else
      showEmptyViewer(
        "No passage supports an answer, so nothing is highlighted.",
      );
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
      docs: {
        "a-2026-09.pdf": ["SYN-0001 · 3 Sep 2026 · final", "Baseline: creatinine 1.2 mg/dL, ferritin 0.5 ng/mL"],
        "a-2026-10-prelim.pdf": ["SYN-0001 · 12 Oct · preliminary", "Ferritin printed as 5; creatinine now in µmol/L"],
        "a-2026-10-amended.pdf": ["SYN-0001 · 12 Oct · amended 15 Oct", "Ferritin corrected from 5 to 50 ng/mL"],
        "c-2026-10.pdf": ["SYN-0003 · Oct 2026", "A second person, so “the TSH” is ambiguous"],
      },
    },
    deal: {
      intro:
        "Seven fictional records of one consulting deal. The fee was revised, the payment split was discussed two ways, and nothing was ever signed.",
      docs: {
        "01_Northstar_Proposal_v1.md": ["Proposal v1 · 4 Sep", "$48,000, 50/50 billing; an offer, not an agreement"],
        "02_Client_Kickoff_Notes.md": ["Kickoff notes · 11 Sep", "Scope narrowed to two regions; finance approval pending"],
        "03_Commercial_Revision.md": ["Commercial revision · 18 Sep", "$42,000, 40% upfront / 60% after; subject to sign-off"],
        "04_Steering_Committee_Notes.md": ["Steering notes · 25 Sep", "50/50 discussed; no vote taken"],
        "05_Project_Delivery_Update.md": ["Delivery update · 2 Oct", "22 Nov is an internal target, not a deadline"],
        "06_Client_Email_Extract.md": ["Client email · 6 Oct", "Client keeps the 15 Nov deadline"],
        "07_Internal_Action_Log.md": ["Action log · 9 Oct", "Open decisions; no signed agreement exists"],
      },
    },
  };
  function caseFilesHtml() {
    const c = state.cases[state.case] ?? snap.cases?.find((x) => x.id === state.case);
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
        const [head, note] = meta.docs[d.title] ?? [shortTitle(d.title), d.kind === "pdf" ? `${d.pages ?? ""} page PDF`.trim() : "Text document"];
        return `<button type="button" class="file-card" data-doc="${esc(d.title)}" style="--i:${i}">
          <span class="file-kind">${esc((d.kind ?? "doc").replace("markdown", "md").toUpperCase())}</span>
          <b>${esc(head)}</b><span>${esc(note)}</span><i aria-hidden="true">Open</i>
        </button>`;
      })
      .join("");
    return `<div class="case-files">
      <p class="case-files-intro"><b>${docs.length} documents in this case.</b> ${esc(meta.intro)}</p>
      <div class="file-grid">${cards}</div>
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
      btn.querySelector("b").textContent = `View the ${n} document${n === 1 ? "" : "s"}`;
    }
  }

  function renderRail() {
    const c =
      state.cases[state.case] ?? snap.cases?.find((x) => x.id === state.case);
    const docs = c?.documents ?? [];
    const btn = $("#files-btn");
    if (btn) {
      btn.hidden = !docs.length;
      btn.querySelector("b").textContent = `View the ${docs.length} document${docs.length === 1 ? "" : "s"}`;
    }
    $("#doc-rail").innerHTML = docs
      .map(
        (d) =>
          `<button type="button" data-doc="${esc(d.title)}">${esc(shortTitle(d.title))}</button>`,
      )
      .join("");
  }

  function openCitation(i) {
    const cites = state.currentCites ?? [];
    const c = cites[i];
    if (!c) return;
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
      $("#viewer-body").innerHTML = order
        .map((t, k) =>
          pageHtml(
            t,
            cites.filter((x) => x.title === t),
            k === 0 ? c : cites.find((x) => x.title === t),
            k,
          ),
        )
        .join("");
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
  async function openDoc(title, cites = [], primary = null) {
    emit("vm:source", { title, cited: cites.length > 0 });
    $$("#doc-rail button").forEach((b) =>
      b.classList.toggle("on", b.dataset.doc === title),
    );
    $("#viewer-title").textContent = shortTitle(title);
    const st = statusOfDoc(title);
    if (/\.pdf$/i.test(title) && state.case === "health") {
      const base = title.replace(/\.pdf$/i, "");
      $("#viewer-meta").textContent =
        `${title} · page 1${st ? " · " + st : ""}`;
      const boxes = cites
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
      $("#viewer-body").innerHTML = pageHtml(title, cites, primary, 0, boxes);
      return;
    }
    $("#viewer-meta").textContent = title;
    const text = await docText(title);
    if (text == null) {
      $("#viewer-body").innerHTML =
        `<div class="viewer-empty">Couldn't load this document right now.</div>`;
      return;
    }
    let html = esc(text);
    for (const c of cites) {
      // Prefer the focused lines: a small document is one chunk, so the raw
      // quote can span the whole file and marking it highlights everything.
      const lines = (c.location?.focus?.text ?? [])
        .map((x) => esc(String(x).trim()))
        .filter((x) => x.length > 10);
      const needles = lines.length
        ? lines
        : [esc(String(c.quote ?? "").trim())].filter(
            (q) => q && q.length <= 600,
          );
      for (const q of needles)
        if (q && html.includes(q)) html = html.replace(q, `<mark>${q}</mark>`);
    }
    html = html.replace(/^# (.*)$/m, '<span class="h">$1</span>');
    $("#viewer-body").innerHTML = `<div class="vw-text">${html}</div>`;
    $("#viewer-body mark")?.scrollIntoView({
      block: "center",
      behavior: reduced ? "auto" : "smooth",
    });
  }

  async function docText(title) {
    if (state.docText[title] && state.case !== "own")
      return state.docText[title];
    const saved = snap.docs?.[title];
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
      if (saved) state.docText[title] = saved;
    }
    return state.docText[title] ?? null;
  }

  // ------------------------------------------------------------ listen
  function speak(text) {
    if (!("speechSynthesis" in window)) return;
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.rate = 1.02;
    speechSynthesis.speak(u);
  }

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
    if (!state.voice?.ready) {
      callState("Voice calls are currently disabled on this server.");
      return;
    }
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
        const r = await fetch("/api/public/voice/session", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            user_data: {
              page: "landing",
              vm_ws: state.case === "own" && state.ws ? state.ws : "demo",
            },
          }),
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
          const caseId = (t.lead?.citations ?? []).some((c) =>
            /\.pdf$/i.test(c.title ?? ""),
          )
            ? "health"
            : t.lead
              ? "deal"
              : state.case;
          if (caseId !== state.case) setCase(caseId, { quiet: true });
          renderAnswer(
            { lead: t.lead, evidence: [] },
            { via: "call", source: "live", question: t.question, caseId },
          );
        }
      } catch {
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
      snap.graphs?.health ?? (await api("/graph/health").catch(() => null));
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
      "[data-q],[data-ask],[data-cite],[data-doc],[data-files],[data-listen],[data-start-call],.case-tab",
    );
    if (!t) return;
    if (t.matches(".case-tab")) return setCase(t.dataset.case);
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
    if (t.matches("[data-doc]")) return openDoc(t.dataset.doc);
    if (t.matches("[data-files]")) {
      showEmptyViewer();
      if (matchMedia("(max-width: 1060px)").matches)
        $("#viewer").scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "start" });
      return;
    }
    if (t.matches("[data-listen]"))
      return speak(state.current?.lead?.text ?? "");
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
