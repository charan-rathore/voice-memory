// Voice Memory landing: a live evidence desk on the public, key-free API
// (/api/public/*, proxied to the engine by vercel.json). While the free host
// wakes up, answers for the suggested questions come from a saved run of the
// same engine (snapshot.js) and are labelled as such.
(() => {
  "use strict";
  document.documentElement.classList.remove("no-js");
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const snap = window.VM_SNAPSHOT ?? { cases: [], answers: {}, docs: {}, graphs: {} };
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
    String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const note = (t) => ($("#engine-note").textContent = t);

  // ------------------------------------------------------------ API
  async function api(path, opts = {}, timeoutMs = 20000) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const r = await fetch("/api/public" + path, { ...opts, signal: ctl.signal });
      const text = await r.text();
      let body = null;
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        body = null;
      }
      if (!r.ok) {
        const e = new Error(body?.error || (r.status >= 500 ? "The engine is waking up. Try again in a moment." : "Request failed."));
        e.status = r.status;
        throw e;
      }
      return body;
    } finally {
      clearTimeout(t);
    }
  }

  async function connect() {
    note("Connecting to the live engine…");
    // Never give up: a cold free-tier boot plus first-ingest can take several
    // minutes, so after the fast phase keep polling slowly in the background.
    // A page that stops retrying strands every visitor who arrived early.
    for (let i = 0; ; i++) {
      try {
        const s = await api("/status", {}, 8000);
        if (s.cases.health && s.cases.deal) {
          const { cases } = await api("/cases");
          state.cases = Object.fromEntries(cases.map((c) => [c.id, c]));
          state.live = true;
          state.voice = s.voice;
          note("Live engine connected · every answer is computed now from the fictional records.");
          renderRail();
          return;
        }
      } catch {
        /* free host cold start */
      }
      note(
        i < 40
          ? "Waking the live engine (free hosting can take up to a minute). Suggested questions answer from a saved run of the same engine meanwhile."
          : "Still waking the live engine — retrying in the background. Uploads and questions work the moment it is up."
      );
      await new Promise((r) => setTimeout(r, i < 40 ? 3000 : 15000));
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
  const verdictOf = (v) => VERDICT[v] ?? (v ? ["v-ok", v.replace(/[_-]/g, " ").toLowerCase()] : ["v-no", "Not in these documents"]);
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
      .replace(/^a-2026-(\d\d)-?/, (m, mo) => `SYN-0001 · ${mo === "09" ? "Sep" : "Oct"} `)
      .replace(/^c-2026-10/, "SYN-0003 · Oct")
      .trim();

  // ------------------------------------------------------------ your documents
  const apiCase = (id) => (id === "own" ? state.ws : id);
  const OWN = {
    id: "own",
    blurb: "Upload a lab report, contract, meeting notes or any document, then ask it anything, typed or on a call.",
    suggestions: ["What does this document say about the deadline?", "Summarize what was decided", "What changed since the last report?"],
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
          $("#upl-list").innerHTML = `<li><b>The live engine is still waking up and the upload did not go through. Try again in a few seconds.</b></li>`;
          return;
        }
        $("#upl-list").innerHTML = `<li><b>The live engine is still waking up. Retrying your upload…</b></li>`;
        await new Promise((r) => setTimeout(r, 4000));
      }
    }
    for (const f of files) {
      try {
        if (f.size > 4 * 1048576) throw new Error(`${f.name} is over 4 MB.`);
        await api(`/workspace/${id}/upload`, { method: "POST", headers: { "content-type": "application/octet-stream", "x-file-name": encodeURIComponent(f.name) }, body: f }, 60000);
      } catch (e) {
        state.wsDocs.push({ title: f.name, status: "failed", error: { message: e.message } });
      }
      refreshWorkspace();
    }
    pollWorkspace();
  }
  async function refreshWorkspace() {
    if (!state.ws) return renderUploads();
    try {
      const st = await api(`/workspace/${state.ws}`);
      const failed = state.wsDocs.filter((d) => d.status === "failed" && !st.documents.some((x) => x.title === d.title));
      state.wsDocs = [...st.documents, ...failed];
      state.cases.own = { ...OWN, ready: st.ready, documents: st.documents.filter((d) => d.status === "ready" || d.included) };
    } catch {
      state.ws = null;
      try { sessionStorage.removeItem("vm_ws"); } catch {}
    }
    renderUploads();
    if (state.case === "own") renderRail();
  }
  let pollTimer = null;
  function pollWorkspace() {
    clearTimeout(pollTimer);
    refreshWorkspace().then(() => {
      if (state.wsDocs.some((d) => !["ready", "needs_review", "failed"].includes(d.status))) pollTimer = setTimeout(pollWorkspace, 1200);
    });
  }
  const STAGE = { uploaded: "Queued", validating: "Checking", parsing: "Reading", ocr: "Reading text (OCR)", indexing: "Indexing", ready: "Ready", needs_review: "Ready · low OCR confidence", failed: "Couldn't read" };
  function renderUploads() {
    $("#upl-list").innerHTML = state.wsDocs
      .map((d) => {
        const done = d.status === "ready" || d.status === "needs_review";
        const cls = done ? "ok" : d.status === "failed" ? "bad" : "busy";
        const extra = d.status === "failed" ? ` — ${esc(d.error?.message ?? "")}` : d.stats?.pages ? ` · ${d.stats.pages} p` : "";
        return `<li><b title="${esc(d.title)}">${esc(d.title)}</b><span class="upl-st ${cls}">${esc(STAGE[d.status] ?? d.status)}</span><span class="dim" style="font-size:12px">${extra}</span></li>`;
      })
      .join("");
  }
  const drop = $("#drop");
  $("#files").addEventListener("change", (e) => uploadFiles(e.target.files));
  ["dragenter", "dragover"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("over"); }));
  ["dragleave", "drop"].forEach((ev) => drop.addEventListener(ev, () => drop.classList.remove("over")));
  drop.addEventListener("drop", (e) => { e.preventDefault(); uploadFiles(e.dataTransfer.files); });

  // ------------------------------------------------------------ asking
  function setCase(id, { quiet = false } = {}) {
    $("#upload").hidden = id !== "own";
    if (id === "own") {
      state.cases.own ??= { ...OWN, documents: [] };
      refreshWorkspace();
    }
    state.case = id;
    $$(".case-tab").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.case === id)));
    const c = state.cases[id] ?? snap.cases?.find((x) => x.id === id);
    $("#q").placeholder = c?.suggestions?.[0] ?? "Ask a question";
    $("#suggest").innerHTML = (c?.suggestions ?? [])
      .map((s) => `<button class="chip" type="button" data-q="${esc(s)}">${esc(s)}</button>`)
      .join("");
    renderRail();
    if (!quiet) {
      $("#answer").innerHTML = `<div class="answer-empty"><p>${esc(c?.blurb ?? "")}</p><p class="dim">Pick a question or type your own.</p></div>`;
      showEmptyViewer();
    }
  }

  async function ask(question, { via = "typed", caseId = state.case } = {}) {
    question = String(question ?? "").trim();
    if (!question) return;
    if (caseId !== state.case) setCase(caseId, { quiet: true });
    $("#q").value = "";
    const btn = $(".ask-go");
    btn.disabled = true;
    $("#answer").innerHTML = `<p class="a-q"><span class="via">${via === "call" ? "Heard on the call" : "You asked"}</span><q>${esc(question)}</q></p><div class="skeleton" style="width:88%"></div><div class="skeleton" style="width:64%"></div><div class="skeleton" style="width:76%"></div>`;
    let result = null;
    let source = "live";
    try {
      if (!state.live) throw Object.assign(new Error("not live"), { offline: true });
      if (caseId === "own" && !state.cases.own?.ready) throw new Error("Upload a document first, then ask about it.");
      result = await api("/ask", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ case: apiCase(caseId), question, context: state.context[caseId] || undefined }),
      });
    } catch (e) {
      const saved = snap.answers?.[`${caseId}|${question}`];
      if (saved) {
        result = saved;
        source = "saved";
      } else {
        $("#answer").innerHTML = `<p class="a-q"><span class="via">You asked</span><q>${esc(question)}</q></p><p class="a-err">${esc(
          e.offline ? "The live engine is still waking up. Try a suggested question, or ask again in a few seconds." : e.message,
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

  function renderAnswer(r, { via, source, question, caseId }) {
    state.current = r;
    const lead = r.lead;
    const [cls, label] = lead ? verdictOf(lead.verdict) : (r.evidence ?? []).length ? ["v-ask", "Cited passages"] : verdictOf(null);
    const ev = r.evidence ?? [];
    const text =
      lead?.text ??
      (ev.length
        ? `From the document: “${prettyQuote(ev[0].quote).slice(0, 280)}”${ev.length > 1 ? ` (and ${ev.length - 1} more cited passage${ev.length > 2 ? "s" : ""})` : ""}`
        : "I don't see a supported answer to that in these documents.");
    const words = text
      .split(/(\s+)/)
      .map((w, i) => (w.trim() ? `<span class="w" style="animation-delay:${reduced ? 0 : Math.min(i * 18, 1400)}ms">${esc(w)}</span>` : w))
      .join("");
    const cites = lead?.citations?.length ? lead.citations : (r.evidence ?? []).slice(0, 3);
    $("#answer").innerHTML = `
      <p class="a-q"><span class="via">${via === "call" ? "Heard on the call" : "You asked"}</span><q>${esc(question)}</q></p>
      <p class="a-lead"><span class="verdict-chip ${cls}">${esc(label)}</span>${words}</p>
      <div class="a-tools">
        <button class="tool" type="button" data-listen>▶ Listen</button>
        <span class="dim" style="font-size:12.5px">${
          source === "saved" ? "Saved run of the same engine · live engine waking" : via === "call" ? "Spoken by Bolna from this exact sentence" : "Computed live · same sentence a call would speak"
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
              c.location?.pages?.[0] ? `<span>page ${c.location.pages[0]}</span>` : ""
            }</span>
            <span class="cite-q">${esc(prettyQuote(c.quote))}</span>
          </button>`;
        })
        .join("")}</div>`;
    state.currentCites = cites;
    state.currentCase = caseId;
    if (cites.length) openCitation(0);
    else showEmptyViewer("No passage supports an answer, so nothing is highlighted.");
  }

  const prettyQuote = (q) => {
    const s = String(q ?? "").trim();
    if (/^\|.*\|$/.test(s)) {
      const cells = s.split("|").map((x) => x.trim()).filter((x, i, a) => i > 0 && i < a.length - 1);
      return cells.filter(Boolean).join(" · ");
    }
    return s.replace(/^\d+\.\s*/, "");
  };

  function renderThread() {
    $("#thread").innerHTML = state.thread
      .slice(1)
      .map((t) => `<li><button type="button" data-q="${esc(t.question)}" data-case="${t.caseId}">↺ ${esc(t.question)}</button></li>`)
      .join("");
  }

  // ------------------------------------------------------------ viewer
  function showEmptyViewer(msg = "The original page opens here, with the cited line marked.") {
    $("#viewer-title").textContent = "Source";
    $("#viewer-meta").textContent = "";
    $("#viewer-body").innerHTML = `<div class="viewer-empty">${esc(msg)}</div>`;
    $$("#doc-rail button").forEach((b) => b.classList.remove("on"));
  }

  function renderRail() {
    const c = state.cases[state.case];
    const docs = c?.documents ?? [];
    $("#doc-rail").innerHTML = docs
      .map((d) => `<button type="button" data-doc="${esc(d.title)}">${esc(shortTitle(d.title))}</button>`)
      .join("");
  }

  function openCitation(i) {
    const cites = state.currentCites ?? [];
    const c = cites[i];
    if (!c) return;
    $$(".cite").forEach((b) => b.classList.toggle("on", Number(b.dataset.cite) === i));
    // Lab answers that rest on several reports (a correction, a refused
    // comparison) show every cited page, the selected one first.
    const pdfTitles = [...new Set(cites.filter((x) => /\.pdf$/i.test(x.title ?? "")).map((x) => x.title))];
    if (state.case === "health" && /\.pdf$/i.test(c.title ?? "") && pdfTitles.length > 1) {
      const order = [c.title, ...pdfTitles.filter((t) => t !== c.title)];
      $$("#doc-rail button").forEach((b) => b.classList.toggle("on", order.includes(b.dataset.doc)));
      $("#viewer-title").textContent = `${order.length} reports cited`;
      $("#viewer-meta").textContent = order.map((t) => shortTitle(t)).join(" · ");
      $("#viewer-body").innerHTML = order
        .map((t, k) => pageHtml(t, cites.filter((x) => x.title === t), k === 0 ? c : cites.find((x) => x.title === t), k))
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
    $$("#doc-rail button").forEach((b) => b.classList.toggle("on", b.dataset.doc === title));
    $("#viewer-title").textContent = shortTitle(title);
    const st = statusOfDoc(title);
    if (/\.pdf$/i.test(title) && state.case === "health") {
      const base = title.replace(/\.pdf$/i, "");
      $("#viewer-meta").textContent = `${title} · page 1${st ? " · " + st : ""}`;
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
      $("#viewer-body").innerHTML = `<div class="viewer-empty">Couldn't load this document right now.</div>`;
      return;
    }
    let html = esc(text);
    for (const c of cites) {
      const q = esc(String(c.quote ?? "").trim());
      if (q && html.includes(q)) html = html.replace(q, `<mark>${q}</mark>`);
    }
    html = html.replace(/^# (.*)$/m, '<span class="h">$1</span>');
    $("#viewer-body").innerHTML = `<div class="vw-text">${html}</div>`;
    $("#viewer-body mark")?.scrollIntoView({ block: "center", behavior: reduced ? "auto" : "smooth" });
  }

  async function docText(title) {
    if (state.docText[title] && state.case !== "own") return state.docText[title];
    const saved = snap.docs?.[title];
    try {
      if (!state.live) throw 0;
      const cid = state.case === "own" ? "own" : "deal";
      const d = (state.cases[cid]?.documents ?? []).find((x) => x.title === title);
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

  async function startCall() {
    $("#try").scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "start" });
    if (state.call) return stopCall();
    if (!window.BolnaWebCall) {
      callState("The call library didn't load. Refresh the page and try again.");
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
      const mics = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "audioinput");
      const virtual = /blackhole|virtual|loopback|soundflower|teams|zoom|obs|aggregate|vb-audio|cable/i;
      const real = mics.filter((d) => !virtual.test(d.label));
      const pick = real.find((d) => d.deviceId === "default") ?? real.find((d) => /built-in|internal|microphone|mic/i.test(d.label)) ?? real[0];
      if (pick) {
        audio = { deviceId: { exact: pick.deviceId }, echoCancellation: true, noiseSuppression: true, autoGainControl: true };
        state.mic = pick.label.replace(/^Default - /, "");
      }
    } catch {
      callbar.classList.remove("busy");
      $("#call-label").textContent = "Call Voice Memory";
      callState("Microphone blocked. Allow it in the address bar, then call again.");
      return;
    }
    callState("Getting a call line…");
    const call = new window.BolnaWebCall({
      ...(audio ? { audio } : {}),
      getSession: async () => {
        const r = await fetch("/api/public/voice/session", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ user_data: { page: "landing", vm_ws: state.case === "own" && state.ws ? state.ws : "demo" } }),
        });
        const body = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(body.error || "Couldn't start a call right now.");
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
      callbar.classList.remove("busy");
      callbar.classList.add("live");
      $("#call-label").textContent = "Hang up";
      callState(`<b>Live${state.mic ? " · " + esc(state.mic) : ""}.</b> Ask: “${esc(state.cases[state.case]?.suggestions?.[0] ?? "What is SYN-0001's ferritin result?")}”`);
      pollTurns();
    });
    call.on("volume-level", (v) => {
      meter.forEach((m, i) => (m.style.height = `${4 + Math.max(0, v * 26 - Math.abs(i - 3) * 3) * (0.7 + Math.random() * 0.6)}px`));
    });
    call.on("error", (e) => {
      const msg = {
        microphone_denied: "Microphone blocked. Allow it in the address bar, then call again.",
        at_capacity: "All voice lines are busy. Try again in a minute, or type your question.",
        autoplay_blocked: "Your browser blocked audio. Click Call again.",
        connect_failed: "Couldn't reach the call server. Check your network and try again.",
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
    callbar.classList.remove("live", "busy");
    $("#call-label").textContent = "Call Voice Memory";
    meter.forEach((m) => (m.style.height = "4px"));
    if (reason && reason !== "failed") callState("Call ended. The answers stay on screen with their sources.");
    state.call = null;
    setTimeout(() => (state.ticket = null), 20000);
  }
  function stopCall() {
    state.call?.stop();
  }

  async function pollTurns() {
    while (state.ticket) {
      try {
        const { turns } = await api(`/voice/turns?ticket=${state.ticket}`, {}, 6000);
        for (const t of turns ?? []) {
          const key = t.at + t.question;
          if (state.seenTurns.has(key)) continue;
          state.seenTurns.add(key);
          const caseId = (t.lead?.citations ?? []).some((c) => /\.pdf$/i.test(c.title ?? "")) ? "health" : t.lead ? "deal" : state.case;
          if (caseId !== state.case) setCase(caseId, { quiet: true });
          renderAnswer({ lead: t.lead, evidence: [] }, { via: "call", source: "live", question: t.question, caseId });
        }
      } catch {
        /* keep polling while the call lasts */
      }
      await new Promise((r) => setTimeout(r, 1200));
    }
  }

  // ------------------------------------------------------------ graph preview
  function miniGraph() {
    const cv = $("#graph-mini");
    if (!cv) return;
    const ctx = cv.getContext("2d");
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const W = 640, H = 420;
    cv.width = W * dpr;
    cv.height = H * dpr;
    ctx.scale(dpr, dpr);
    const load = async () => snap.graphs?.health ?? (await api("/graph/health").catch(() => null));
    const COLORS = { patient: "#f4dc4a", document: "#8fa3ff", topic: "#eceae0", value: "#4fd1bd" };
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
      const edges = g.edges.map((e) => ({ ...e, a: by.get(e.from), b: by.get(e.to) })).filter((e) => e.a && e.b);
      let t = 0;
      let visible = true;
      new IntersectionObserver(([en]) => (visible = en.isIntersecting)).observe(cv);
      const tick = () => {
        requestAnimationFrame(tick);
        if (!visible) return;
        t += 1;
        // tiny force layout
        for (const a of nodes) {
          for (const b of nodes) {
            if (a === b) continue;
            const dx = a.x - b.x, dy = a.y - b.y;
            const d2 = dx * dx + dy * dy + 0.01;
            if (d2 < 9000) { const f = 60 / d2; a.vx += dx * f; a.vy += dy * f; }
          }
          a.vx += (W / 2 - a.x) * 0.0016;
          a.vy += (H / 2 - a.y) * 0.0024;
        }
        for (const e of edges) {
          const dx = e.b.x - e.a.x, dy = e.b.y - e.a.y;
          const d = Math.hypot(dx, dy) || 1;
          const f = (d - (e.kind === "corrects" ? 40 : 62)) * 0.006;
          e.a.vx += (dx / d) * f; e.a.vy += (dy / d) * f;
          e.b.vx -= (dx / d) * f; e.b.vy -= (dy / d) * f;
        }
        for (const n of nodes) {
          n.vx *= 0.82; n.vy *= 0.82;
          n.x += n.vx + Math.sin(t / 90 + n.x) * 0.06;
          n.y += n.vy + Math.cos(t / 110 + n.y) * 0.06;
        }
        ctx.clearRect(0, 0, W, H);
        for (const e of edges) {
          const special = e.kind === "corrects" || e.kind === "not comparable";
          ctx.strokeStyle = e.kind === "corrects" ? "rgba(244,220,74,0.9)" : e.kind === "not comparable" ? "rgba(232,115,90,0.9)" : "rgba(160,170,200,0.22)";
          ctx.lineWidth = special ? 2 : 1;
          ctx.setLineDash(special ? [5, 5] : []);
          ctx.lineDashOffset = -t / 2;
          ctx.beginPath(); ctx.moveTo(e.a.x, e.a.y); ctx.lineTo(e.b.x, e.b.y); ctx.stroke();
        }
        ctx.setLineDash([]);
        for (const n of nodes) {
          const r = n.kind === "patient" ? 9 : n.kind === "document" ? 7 : n.kind === "topic" ? 4.5 : 5.5;
          const col = n.status === "superseded" ? "#e8735a" : COLORS[n.kind] ?? "#ccc";
          ctx.fillStyle = col;
          ctx.shadowColor = col; ctx.shadowBlur = n.kind === "patient" || n.status === "superseded" ? 16 : 6;
          ctx.beginPath(); ctx.arc(n.x, n.y, r, 0, Math.PI * 2); ctx.fill();
          ctx.shadowBlur = 0;
          if (n.kind === "patient" || n.kind === "topic" && /ferritin|creatinine/i.test(n.label) || /^(5|50) ng/.test(n.label)) {
            ctx.fillStyle = "rgba(236,234,224,0.85)";
            ctx.font = "500 12px Plex, system-ui, sans-serif";
            ctx.fillText(n.label, n.x + r + 5, n.y + 4);
          }
        }
      };
      tick();
    });
  }

  // ------------------------------------------------------------ wiring
  document.addEventListener("click", (e) => {
    const t = e.target.closest("[data-q],[data-ask],[data-cite],[data-doc],[data-listen],[data-start-call],.case-tab");
    if (!t) return;
    if (t.matches(".case-tab")) return setCase(t.dataset.case);
    if (t.matches("[data-start-call]")) {
      e.preventDefault();
      return startCall();
    }
    if (t.matches("[data-ask]")) {
      $("#try").scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "start" });
      return ask(t.dataset.ask, { caseId: t.dataset.askCase });
    }
    if (t.matches("[data-q]")) return ask(t.dataset.q, { caseId: t.dataset.case || state.case });
    if (t.matches("[data-cite]")) return openCitation(Number(t.dataset.cite));
    if (t.matches("[data-doc]")) return openDoc(t.dataset.doc);
    if (t.matches("[data-listen]")) return speak(state.current?.lead?.text ?? "");
  });
  $("#askbar").addEventListener("submit", (e) => {
    e.preventDefault();
    ask($("#q").value);
  });
  $$("[data-call-link]").forEach((a) => a.addEventListener("click", () => setTimeout(() => $("#call-btn").focus(), 600)));

  // reveal + count-up
  const io = new IntersectionObserver(
    (entries) =>
      entries.forEach((en) => {
        if (!en.isIntersecting) return;
        en.target.classList.add("on");
        io.unobserve(en.target);
        const num = $(".stat-num", en.target);
        if (num && !reduced) {
          const to = Number(num.dataset.count), pre = num.dataset.prefix ?? "", suf = num.dataset.suffix ?? "";
          const dec = String(to).includes(".") ? 1 : 0;
          const t0 = performance.now();
          const step = (now) => {
            const k = Math.min(1, (now - t0) / 1100);
            const v = to * (1 - Math.pow(1 - k, 3));
            num.textContent = pre + v.toFixed(dec) + suf;
            if (k < 1) requestAnimationFrame(step);
          };
          requestAnimationFrame(step);
        }
      }),
    { threshold: 0.18 },
  );
  $$("[data-reveal]").forEach((el) => io.observe(el));

  setCase("health");
  miniGraph();
  connect();
  // Deep link: /?q=...&case=deal asks immediately (used by the walkthrough).
  const p = new URLSearchParams(location.search);
  if (p.get("q")) setTimeout(() => ask(p.get("q"), { caseId: p.get("case") || "health" }), 400);
})();
