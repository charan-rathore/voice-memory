// "Watch it read": a live view of how an uploaded document is being read.
//
// Everything on screen comes from the server's own progress record for the
// upload (GET /api/public/workspace/:id, documents[].progress): page states,
// counts, OCR percentage and a timestamped milestone log. Nothing here is a
// canned animation; when the server has not reported a step, the step is not
// shown as done. The same reducer replays a finished upload from its log, at
// a stated speed, so a visitor can watch what happened after the fact.
//
// No document text is ever shown or sent here: page numbers, counts and
// timings only. Loaded on first upload (not part of the first page load).
(() => {
  const STEPS = [
    {
      id: "received",
      plain: "Received",
      tech: "upload → private workspace",
    },
    { id: "checked", plain: "Checked", tech: "signature + size limits" },
    { id: "text", plain: "Text read", tech: "pdf.js text layer + layout" },
    { id: "ocr", plain: "Scans read", tech: "tesseract.js OCR (LSTM)" },
    {
      id: "evidence",
      plain: "Evidence built",
      tech: "elements → spans → index",
    },
    { id: "answer", plain: "Ready to ask", tech: "BM25 index live" },
  ];
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
  const fmtS = (ms) =>
    ms == null
      ? ""
      : ms < 10000
        ? (ms / 1000).toFixed(1) + " s"
        : Math.round(ms / 1000) + " s";
  const clock = (ms) => {
    const s = Math.max(0, ms) / 1000;
    return `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, "0")}`;
  };
  const n0 = (n) => Number(n ?? 0).toLocaleString("en-US");
  const TERMINAL = new Set(["ready", "needs_review", "failed"]);
  const reduced = () =>
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  const pref = {
    get hidden() {
      try {
        return sessionStorage.getItem("vm_reading") === "off";
      } catch {
        return false;
      }
    },
    set hidden(v) {
      try {
        sessionStorage.setItem("vm_reading", v ? "off" : "on");
      } catch {}
    },
    get tech() {
      try {
        return sessionStorage.getItem("vm_reading_mode") === "tech";
      } catch {
        return false;
      }
    },
    set tech(v) {
      try {
        sessionStorage.setItem("vm_reading_mode", v ? "tech" : "plain");
      } catch {}
    },
  };

  /**
   * What had happened by time tau (ms since upload), from the log alone.
   * `live` pages (the server's latest page states) supply the current OCR
   * percentage, which is deliberately not logged tick by tick.
   */
  function stateAt(doc, tau, livePages) {
    const log = doc.progress?.log ?? [];
    const s = {
      status: "uploaded",
      pages: [],
      counts: null,
      checkedAt: null,
      textAt: null,
      partialStatusAt: null,
      partialAt: null,
      finalAt: null,
      evidence: null,
      salvaged: false,
      cached: false,
      ocr: [],
    };
    const pg = (n) => (s.pages[n - 1] ??= { n, state: "waiting" });
    for (const e of log) {
      if (e.t > tau) break;
      switch (e.k) {
        case "status":
          s.status = e.status;
          if (e.status === "parsing") s.checkedAt ??= e.t;
          if (e.status === "partial") s.partialStatusAt = e.t;
          if (TERMINAL.has(e.status)) s.finalAt = e.t;
          break;
        case "cache":
          s.cached = true;
          break;
        case "open":
          for (let n = 1; n <= e.pages; n++) pg(n);
          break;
        case "text":
          Object.assign(pg(e.n), {
            state: "text",
            chars: e.chars,
            lines: e.lines,
          });
          break;
        case "scan":
          Object.assign(pg(e.n), { state: "scan" });
          break;
        case "ocr-start":
          Object.assign(pg(e.n), { state: "ocr", p: 0, from: e.t });
          s.ocr.push(e.n);
          break;
        case "ocr-done":
          Object.assign(pg(e.n), {
            state: e.paragraphs ? "ocr-done" : "unread",
            p: 100,
            confidence: e.confidence,
            uncertain: e.uncertain,
          });
          break;
        case "ocr-skip":
          Object.assign(pg(e.n), { state: "unread" });
          break;
        case "salvaged":
          s.salvaged = true;
          for (const p of s.pages)
            if (p.state === "scan" || p.state === "ocr") p.state = "unread";
          break;
        case "layout":
        case "layout-partial":
          s.counts = e;
          s.textAt ??= e.t;
          break;
        case "indexed":
          // Answerable from the moment the index holds the pages, which is
          // after it is rebuilt, not when the status first changed.
          s.evidence = e;
          if (s.partialStatusAt != null && s.finalAt == null)
            s.partialAt ??= e.t;
          break;
      }
    }
    // OCR percentage: the server's live figure while running; during a
    // replay, the recorded start and finish times bound it.
    for (const p of s.pages) {
      if (p?.state !== "ocr") continue;
      if (livePages) p.p = livePages[p.n - 1]?.p ?? p.p;
      else {
        const done = log.find((e) => e.k === "ocr-done" && e.n === p.n);
        if (done && done.t > p.from)
          p.p = Math.min(
            99,
            Math.round(((tau - p.from) / (done.t - p.from)) * 100),
          );
      }
    }
    // Pages from a cached result arrive without page events.
    // The live workspace API carries per-page states even if the historical
    // upload log is empty (cached or interrupted import). Do not invent states
    // during replay, where only recorded events may advance the film.
    if (!s.pages.length && livePages?.length)
      s.pages = livePages.map((p) => ({ ...p }));
    if (!s.textAt && s.cached && s.finalAt != null) s.textAt = s.finalAt;
    // The server's status is authoritative: a settled document is done even
    // when the terminal log event falls outside the replay window (an older
    // server could stamp it 1 ms after the final timing). Live view only:
    // a replay (livePages null) keeps its honest mid-flight states.
    if (livePages && TERMINAL.has(doc.status)) {
      s.status = doc.status;
      s.finalAt ??= tau;
      if (doc.status !== "failed" && s.textAt == null) s.textAt = tau;
    }
    return s;
  }

  function stepStates(s, doc) {
    const anyScan =
      s.pages.some((p) => p && p.state !== "text" && p.state !== "waiting") ||
      (doc.stats?.ocrPages ?? 0) > 0;
    const textDone = s.textAt != null;
    const ocrRunning = s.pages.some(
      (p) => p?.state === "ocr" || p?.state === "scan",
    );
    const failed = s.status === "failed";
    const final = s.finalAt != null;
    const answerable = s.partialAt != null || (final && !failed);
    const st = {
      received: failed && doc.local && !doc.serverId ? "bad" : "done",
      checked: s.checkedAt != null ? "done" : failed ? "bad" : "active",
      text:
        textDone || final
          ? failed && !textDone
            ? "bad"
            : "done"
          : s.checkedAt != null
            ? "active"
            : "wait",
      ocr: !anyScan
        ? final
          ? "skip"
          : "wait"
        : final
          ? s.salvaged || s.pages.some((p) => p?.state === "unread")
            ? "warn"
            : "done"
          : ocrRunning && textDone
            ? "active"
            : "wait",
      evidence:
        s.evidence || (final && !failed)
          ? "done"
          : textDone && !failed
            ? "active"
            : failed
              ? "bad"
              : "wait",
      answer: failed ? "bad" : answerable ? (final ? "done" : "live") : "wait",
    };
    if (s.status === "uploaded") st.checked = "active";
    return st;
  }

  function narrate(s, doc, steps, tech, o = 0) {
    const total = s.pages.length;
    const textPages = s.pages.filter((p) => p?.state === "text").length;
    const ocrPage = s.pages.find((p) => p?.state === "ocr");
    const scans = s.pages.filter(
      (p) => p && p.state !== "text" && p.state !== "waiting",
    );
    const uncertain = s.pages.reduce((a, p) => a + (p?.uncertain ?? 0), 0);
    const chars = s.pages.reduce((a, p) => a + (p?.chars ?? 0), 0);
    if (tech) {
      const parts = [];
      if (total)
        parts.push(
          `pdf.js text layer ${textPages}/${total} p · ${n0(chars)} chars`,
        );
      if (s.counts)
        parts.push(
          `layout: ${s.counts.headings} headings, ${s.counts.paragraphs} paras, ${s.counts.tables} tables, ${s.counts.furniture} furniture`,
        );
      if (ocrPage)
        parts.push(
          ocrPage.p
            ? `tesseract p${ocrPage.n} recognise ${ocrPage.p}%`
            : `tesseract p${ocrPage.n} decode + layout analysis`,
        );
      for (const p of scans)
        if (p.state === "ocr-done")
          parts.push(
            `p${p.n} OCR conf ${p.confidence}%${p.uncertain ? `, ${p.uncertain} low-conf numbers` : ""}`,
          );
      if (s.evidence)
        parts.push(
          `${n0(s.evidence.elements)} elements${s.evidence.observations != null ? `, ${s.evidence.observations} lab rows` : ""} indexed`,
        );
      if (s.partialAt != null && s.finalAt == null)
        parts.push(`partial index live @ ${fmtS(s.partialAt + o)}`);
      if (s.status === "failed")
        parts.push(`failed: ${doc.error?.code ?? "error"}`);
      return parts.join("  ·  ") || "waiting for a parse slot";
    }
    if (s.status === "failed")
      return doc.error?.message ?? "This file could not be read.";
    if (s.cached && s.finalAt != null)
      return "This exact file was read moments ago, so the saved reading was reused.";
    if (doc.local && doc.status === "sending") {
      const L = doc.local;
      const pct = L.total ? Math.round((L.sent / L.total) * 100) : 0;
      if (tech)
        return L.phase === "sending"
          ? `XHR upload ${n0(L.sent)} / ${n0(L.total)} bytes (${pct}%)`
          : `POST /api/public/workspace … ${L.phase}`;
      return L.phase === "waking"
        ? "The engine was asleep (free hosting sleeps when idle). Waking it; this first wait is the slowest part."
        : L.phase === "sending"
          ? `Sending your file to the engine: ${pct}%.`
          : L.phase === "sent"
            ? "Received. Opening it now."
            : "Connecting to the engine.";
    }
    if (s.status === "uploaded")
      return "In line: another file is being read. Yours starts in a moment.";
    if (s.status === "validating" || (s.checkedAt != null && !total))
      return "Checking that it really is the kind of file it says it is, and not too large.";
    if (s.finalAt != null) {
      const ms = fmtS(s.finalAt + o);
      if (s.salvaged)
        return `Done in ${ms}. The scanned page took too long, so it was left out and marked. Every other page can be asked about.`;
      if (uncertain)
        return `Done in ${ms}. ${uncertain} number${uncertain > 1 ? "s" : ""} on the scanned page ${uncertain > 1 ? "were" : "was"} hard to read; answers that use ${uncertain > 1 ? "them" : "it"} will say so.`;
      return `Done in ${ms}. Every answer will point at the exact line it came from.`;
    }
    if (ocrPage) {
      const rest =
        s.partialAt != null
          ? ` You can already ask about the other ${total - scans.length} pages.`
          : "";
      // tesseract reports 0% while it decodes the image and finds where
      // the text is, then the share of text it has recognised.
      return ocrPage.p
        ? `Page ${ocrPage.n} is a photo of a page, so its letters are being recognised from the pixels: ${ocrPage.p}% done.${rest}`
        : `Page ${ocrPage.n} is a photo of a page, not text. Finding where the writing is on it before reading the letters.${rest}`;
    }
    if (s.partialAt != null)
      return `You can ask now. ${textPages} of ${total} pages are in; the scanned page is next.`;
    if (total && textPages < total) {
      const next = s.pages.find((p) => p?.state === "waiting");
      return `Reading page ${next?.n ?? textPages + 1} of ${total}. Pages with real text are read straight from the file, which is fast.`;
    }
    return "Turning the pages into evidence: headings, tables and lines that answers can point back to.";
  }

  // ------------------------------------------------------------- rendering
  let root = null;
  let docs = [];
  let focusId = null;
  let received = 0; // performance.now() when the latest status arrived
  let replay = null; // { id, start, speed, total }
  let raf = 0;
  // Times shown count from the visitor's drop, not from when the server
  // first saw the file: the upload itself (and any wait for the engine)
  // is part of what they waited through. offsets: doc id -> ms between
  // the drop and the server's zero; clicks: drop times not yet matched.
  const offsets = new Map();
  let clicks = [];
  let dropsSeen = 0;
  const off = (d) => offsets.get(d.id) ?? 0;

  function skeleton() {
    root.innerHTML = `
      <section class="rd" aria-label="How your document is being read">
        <header class="rd-head">
          <div class="rd-title"><b>Watch it read</b><span class="rd-file"></span></div>
          <div class="rd-tools">
            <span class="rd-clock" aria-label="Elapsed time"></span>
            <div class="rd-mode" role="group" aria-label="Detail level">
              <button type="button" data-mode="plain">Plain</button>
              <button type="button" data-mode="tech">Technical</button>
            </div>
            <button type="button" class="rd-hide">Hide</button>
          </div>
        </header>
        <ol class="rd-rail">${STEPS.map(
          (st, i) =>
            `<li data-step="${st.id}" style="--i:${i}"><i class="rd-dot"></i><b>${st.plain}</b><small data-tech="${esc(st.tech)}"></small></li>`,
        ).join("")}</ol>
        <div class="rd-pages" role="group" aria-label="Source pages: select one to open it"></div>
        <section class="rd-eng" aria-label="Recorded evidence journey">
          <header><b>How this file became evidence</b><span>Expand any stage to inspect its recorded data</span></header>
          <ol class="rd-film"></ol>
        </section>
        <section class="rd-query" hidden aria-label="Evidence behind your latest question"></section>
        <p class="rd-say" aria-live="polite"></p>
        <ol class="rd-log"></ol>
        <footer class="rd-foot"></footer>
      </section>
      <button type="button" class="rd-show" hidden>Show how it's being read</button>`;
    root.querySelector(".rd-hide").onclick = () => {
      pref.hidden = true;
      paint();
    };
    root.querySelector(".rd-show").onclick = () => {
      pref.hidden = false;
      paint();
    };
    for (const b of root.querySelectorAll(".rd-mode button"))
      b.onclick = () => {
        pref.tech = b.dataset.mode === "tech";
        paint();
      };
    // Each page tile opens that original page in the source viewer.
    root.querySelector(".rd-pages").addEventListener("click", (e) => {
      const more = e.target.closest("[data-expand-pages]");
      if (more) { pageLimit += 30; engineKey = ""; paint(); return; }
      const pg = e.target.closest(".rd-pg");
      if (!pg) return;
      const d = focus();
      root
        .querySelectorAll(".rd-pg[aria-pressed]")
        .forEach((x) => x.setAttribute("aria-pressed", "false"));
      pg.setAttribute("aria-pressed", "true");
      document.dispatchEvent(
        new CustomEvent("vm:open-page", {
          detail: {
            title: d?.title ?? d?.filename ?? null,
            page: Number(pg.dataset.n),
          },
        }),
      );
    });
    // Loaded only with uploads: source navigation does not inflate first paint.
    document.addEventListener("vm:open-page", async (e) => {
      const { title, page, citation } = e.detail ?? {};
      if (!title || !openSource) return;
      await openSource(title, citation ? [citation] : [], citation ?? null);
      const sec = document.querySelector("#viewer-body .rd-doc.focus");
      const target = sec?.querySelectorAll(".rd-page")[Math.max(0, Number(page || 1) - 1)] ?? sec;
      target?.scrollIntoView({ block: "start", behavior: reduced() ? "auto" : "smooth" });
      target?.setAttribute("tabindex", "-1");
      target?.focus({ preventScroll: true });
    });
    document.addEventListener("vm:answer", (e) => {
      const payload = e.detail ?? {};
      if (payload.caseId !== "own" || !payload.final) return;
      latestQuery = { ...payload, id: ++querySerial, workspace: workspaceId };
      engineKey = "";
      paint();
    });
    root.querySelector(".rd-foot").addEventListener("click", (e) => {
      const b = e.target.closest("[data-replay]");
      if (!b) return;
      const d = focus();
      const total = d?.timings ? Math.max(...Object.values(d.timings)) : 0;
      if (!total) return;
      // About eight seconds of screen time, whatever the real duration was.
      const speed = Math.max(1, total / 8000);
      replay = { id: d.id, start: performance.now(), speed, total };
      engineKey = "";
      loop();
    });
  }

  // Follow the file being read right now (a queued file has nothing to
  // show yet); else the most recent one. A click on a file in the list
  // pins it (focus()).
  const ACTIVE = new Set(["validating", "parsing", "partial", "indexing"]);
  const focus = () =>
    docs.find((d) => d.id === focusId) ??
    docs.find((d) => ACTIVE.has(d.status)) ??
    docs.find((d) => d.local && !TERMINAL.has(d.status)) ??
    [...docs].reverse().find((d) => d.progress && !TERMINAL.has(d.status)) ??
    [...docs].reverse().find((d) => d.progress);

  function elapsedOf(d) {
    // Still in the browser: the clock runs from the drop.
    if (d.local && d.status === "sending")
      return performance.now() - d.local.since - off(d);
    if (replay?.id === d.id)
      return Math.min(
        replay.total,
        (performance.now() - replay.start) * replay.speed,
      );
    const fin = d.timings
      ? Math.max(
          ...["ready", "needs_review", "failed"].map((k) => d.timings[k] ?? -1),
        )
      : -1;
    if (fin >= 0) return fin;
    return (d.progress?.age ?? 0) + (performance.now() - received);
  }

  function paint() {
    if (!root) return;
    const sec = root.querySelector(".rd");
    const show = root.querySelector(".rd-show");
    const d = focus();
    if (d && d.id !== stripDocId) {
      stripDocId = d.id;
      pageLimit = 30;
      engineKey = "";
    }
    if (!d) {
      root.hidden = true;
      return;
    }
    root.hidden = false;
    sec.hidden = pref.hidden;
    show.hidden = !pref.hidden;
    if (pref.hidden) return;
    const tech = pref.tech;
    sec.classList.toggle("is-tech", tech);
    for (const b of root.querySelectorAll(".rd-mode button"))
      b.setAttribute(
        "aria-pressed",
        String((b.dataset.mode === "tech") === tech),
      );
    const replaying = replay?.id === d.id;
    const tau = elapsedOf(d);
    const s = stateAt(d, tau, replaying ? null : d.progress?.pages);
    const steps = stepStates(s, d);
    if (d.status === "sending" || d.status === "uploaded")
      for (const k of ["checked", "text", "ocr", "evidence", "answer"])
        steps[k] = "wait";
    const done = s.finalAt != null;
    root.querySelector(".rd-file").textContent =
      (docs.length > 1
        ? `${d.title ?? d.filename}`
        : (d.title ?? d.filename ?? "")) +
      (replaying ? "  ·  Replay of this completed ingestion" : "");
    const o = off(d);
    const at = (t) => (t == null ? null : t + o);
    root.querySelector(".rd-clock").textContent = clock(tau + o);

    // When asking became possible (no time budget is promised).
    const askAt = at(
      s.partialAt ??
        (done && s.status !== "failed"
          ? s.evidence
            ? Math.max(s.evidence.t ?? 0, s.finalAt)
            : s.finalAt
          : null),
    );

    // Rail: each station's state, its time stamp, and the packet position.
    let active = 0;
    STEPS.forEach((st, i) => {
      const li = root.querySelector(`[data-step="${st.id}"]`);
      if (st.id === "received")
        li.querySelector("b").textContent =
          steps.received === "bad" ? "Not received" : st.plain;
      if (st.id === "answer")
        li.querySelector("b").textContent =
          s.status === "failed" ? "Not ready to ask" : st.plain;
      li.dataset.state = steps[st.id];
      if (["done", "live", "warn"].includes(steps[st.id])) active = i;
      if (steps[st.id] === "active") active = i;
      const stamp = {
        received:
          d.status === "sending" || steps.received === "bad" ? null : o || null,
        checked: at(s.checkedAt),
        text: at(s.textAt),
        ocr:
          steps.ocr === "done" || steps.ocr === "warn" ? at(s.finalAt) : null,
        evidence: s.evidence ? at(s.evidence.t) : null,
        answer: askAt,
      }[st.id];
      const small = li.querySelector("small");
      if (st.id === "received" && d.local && d.status === "sending") {
        const L = d.local;
        small.textContent =
          L.phase === "sending" && L.total
            ? `${Math.round((L.sent / L.total) * 100)}%`
            : L.phase === "waking"
              ? "waking"
              : "now";
        li.dataset.state = "active";
        return;
      }
      small.textContent = tech
        ? small.dataset.tech
        : steps[st.id] === "skip"
          ? "no scans"
          : stamp != null
            ? fmtS(stamp)
            : steps[st.id] === "active"
              ? "now"
              : "";
    });

    // Page filmstrip.
    const strip = root.querySelector(".rd-pages");
    const maxChars = Math.max(1, ...s.pages.map((p) => p?.chars ?? 0));
    const shown = s.pages.slice(0, pageLimit);
    if (
      strip.childElementCount !==
      shown.length + (s.pages.length > pageLimit ? 1 : 0)
    ) {
      strip.innerHTML =
        shown
          .map(
            (p, i) =>
              `<button type="button" class="rd-pg" data-n="${i + 1}" aria-label="Open page ${i + 1}"><span class="pg" aria-hidden="true"><i class="pg-fill"></i><em></em></span><span class="rd-pg-n">${i + 1}</span></button>`,
          )
          .join("") +
        (s.pages.length > pageLimit
          ? `<button type="button" class="rd-pg more" data-expand-pages aria-label="Show more pages"><span class="rd-pg-n">+${s.pages.length - pageLimit} pages</span></button>`
          : "");
    }
    shown.forEach((p, i) => {
      const f = strip.children[i];
      if (!p || !f) return;
      f.dataset.state = p.state;
      const fill = Math.round(((p.chars ?? 0) / maxChars) * 100);
      f.style.setProperty(
        "--fill",
        p.state === "text"
          ? `${Math.max(18, fill)}%`
          : p.state === "ocr-done"
            ? "70%"
            : "0%",
      );
      f.style.setProperty("--p", `${p.p ?? 0}%`);
      const badge = f.querySelector("em");
      badge.textContent =
        p.state === "ocr"
          ? p.p
            ? `${p.p}%`
            : "finding"
          : p.state === "ocr-done"
            ? p.uncertain
              ? `${p.uncertain} to check`
              : p.confidence != null
                ? `${p.confidence}%`
                : "read"
            : p.state === "unread"
              ? "unread"
              : p.state === "scan"
                ? "scan"
                : "";
      f.classList.toggle("flag", !!p.uncertain);
      f.title =
        p.state === "text"
          ? `Page ${p.n}: text layer, ${n0(p.chars)} characters`
          : p.state === "scan"
            ? `Page ${p.n}: scanned image, waiting for OCR`
            : p.state === "ocr"
              ? `Page ${p.n}: OCR ${p.p ?? 0}%`
              : p.state === "ocr-done"
                ? p.confidence != null
                  ? `Page ${p.n}: OCR ${p.confidence}% mean confidence${p.uncertain ? `, ${p.uncertain} uncertain numbers` : ""}`
                  : `Page ${p.n}: read by OCR`
                : p.state === "unread"
                  ? `Page ${p.n}: not read`
                  : `Page ${p.n}`;
    });

    paintEngine(d, s, tech, replaying ? tau : null);

    const say = root.querySelector(".rd-say");
    const line = narrate(s, d, steps, tech, o);
    if (say.textContent !== line) say.textContent = line;

    // Technical log: the last milestones, as recorded by the server.
    const logEl = root.querySelector(".rd-log");
    logEl.hidden = !tech;
    if (tech) {
      const rows = (d.progress?.log ?? [])
        .filter((e) => e.t <= tau && e.k !== "status")
        .slice(-7)
        .map(
          (e) =>
            `<li><time>+${(e.t / 1000).toFixed(2)}s</time> ${esc(logLine(e))}</li>`,
        )
        .join("");
      if (logEl.innerHTML !== rows) logEl.innerHTML = rows;
    }

    const foot = root.querySelector(".rd-foot");
    const total = done ? s.finalAt + o : null;
    const html = done
      ? `<span>${s.status === "failed" ? "Stopped" : "Read"} in <b>${fmtS(total)}</b>${askAt != null && s.partialAt != null ? ` · you could ask from <b>${fmtS(askAt)}</b>` : ""}</span>${!reduced() && total > 1500 && !replaying ? `<button type="button" data-replay>Replay of this completed ingestion</button>` : ""}`
      : s.partialAt != null
        ? `<span class="live">Answers are live while the rest is read</span>`
        : "";
    if (foot.innerHTML !== html) foot.innerHTML = html;
    sec.dataset.phase = done
      ? s.status === "failed"
        ? "failed"
        : "done"
      : "live";
  }

  // ------------------------------------------------- source-linked evidence disclosures
  let engineKey = "";
  let latestQuery = null;
  let querySerial = 0;
  let openSource = null;
  let workspaceId = null;
  let scopeGeneration = null;
  let pageLimit = 30;
  let stripDocId = null;

  function make(tag, cls = "", value = null) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (value !== null && value !== undefined) node.textContent = String(value);
    return node;
  }
  const sourceTitle = (d) => d?.title ?? d?.filename ?? null;
  function openPage(title, page, citation = null) {
    if (!title || !Number.isInteger(Number(page)) || Number(page) < 1) return;
    document.dispatchEvent(new CustomEvent("vm:open-page", {
      detail: { title, page: Number(page), citation },
    }));
  }
  function openQuoted(c) {
    if (!c?.title || typeof c.quote !== "string" || !c.quote.trim()) return;
    openPage(c.title, c.location?.pages?.[0] ?? 1, c);
  }
  function row(parent, text, subtext, citation, pageTitle, pageNumber) {
    const li = make(parent.tagName === "UL" ? "li" : "div", "rd-data-row");
    li.append(make("span", "", text));
    if (subtext) li.append(make("small", "", subtext));
    if (citation?.quote) {
      const b = make("button", "", "Open exact source line");
      b.type = "button";
      b.onclick = () => openQuoted(citation);
      li.append(b);
    } else if (pageTitle && pageNumber > 0) {
      const b = make("button", "", "Open page " + pageNumber);
      b.type = "button";
      b.onclick = () => openPage(pageTitle, pageNumber);
      li.append(b);
    }
    parent.append(li);
    return li;
  }
  function evidenceList(parent, label, citations, related = false) {
    if (!citations?.length) return;
    parent.append(make("h4", "", label));
    const list = make("ul", "rd-data-list");
    for (const c of citations) {
      const pg = c.location?.pages?.[0];
      const li = row(
        list,
        c.quote ?? "",
        (c.title ?? "Source") + (pg ? " · page " + pg : "") +
          (related ? " · related only; not an answer" : " · admitted evidence"),
        c,
      );
      if (related) li.classList.add("related");
    }
    parent.append(list);
  }
  // General education is from the existing MedlinePlus-backed clinical
  // glossary, never derived from the upload or substituted for a report fact.
  const LAB_EDUCATION = [
    {
      match: /\bferritin\b/i,
      name: "Ferritin",
      measures: "Ferritin reflects how much iron the body stores.",
      source: "https://medlineplus.gov/lab-tests/ferritin-blood-test/",
    },
    {
      match: /\bcreatinine\b/i,
      name: "Creatinine",
      measures: "Creatinine is a muscle waste product filtered by the kidneys; the test helps describe kidney function.",
      source: "https://medlineplus.gov/lab-tests/creatinine-test/",
    },
    {
      match: /\b(?:haemoglobin|hemoglobin|hgb)\b/i,
      name: "Hemoglobin",
      measures: "Hemoglobin is the protein in red blood cells that carries oxygen.",
      source: "https://medlineplus.gov/lab-tests/hemoglobin-test/",
    },
    {
      match: /\b(?:tsh|thyroid.stimulating.hormone)\b/i,
      name: "TSH",
      measures: "TSH is a hormone that signals the thyroid how much thyroid hormone to make.",
      source: "https://medlineplus.gov/labtests/tshthyroidstimulatinghormonetest.html",
    },
    {
      match: /\b(?:ldl|low.density.lipoprotein)\b/i,
      name: "LDL cholesterol",
      measures: "LDL refers to cholesterol carried in low-density lipoproteins.",
      source: "https://medlineplus.gov/lab-tests/cholesterol-levels/",
    },
  ];

  function labExplanation(host, d, q) {
    const f = q?.final;
    if (!(d.digest?.graph?.labRows > 0) ||
        typeof f?.admittedText !== "string" || !f.citations?.length) return;
    const first = f.citations[0];
    const identifier = [first.quote, q.lead?.field].filter(Boolean).join(" ");
    const known = LAB_EDUCATION.find((item) => item.match.test(identifier));
    const revised = f.citations.find((c) =>
      /amended|corrected|correction/i.test(c.title ?? "") ||
      /amended|corrected|correction/i.test(c.quote ?? "")
    );
    // An interval is named only when an admitted source actually prints
    // "reference"/"interval"/"range". We never import population thresholds.
    const printedRange = f.citations.find((c) =>
      /\b(?:reference(?:\s+range)?|interval|range)\b/i.test(c.quote ?? "")
    );
    const lab = make("section", "rd-lab");
    lab.setAttribute("aria-label", "Lab result explanation");
    lab.append(make("h3", "", "Understanding this result"));
    const general = make("div", "rd-education");
    general.append(make("h4", "", "What is this"));
    row(general, known?.name ?? q.lead?.field ?? "The test printed in this report",
      "Open the exact source line to verify the test's printed name.", first);
    general.append(make("h4", "", "What it measures"));
    general.append(make("p", "",
      known?.measures ?? "No vetted general description is available for this test."));
    if (known) {
      const link = make("a", "", "MedlinePlus — general education, not this patient's finding");
      link.href = known.source;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      general.append(link);
    }
    // Any background supplied by the server is also external, never a
    // citation to this person's report.
    for (const item of (q.background?.sources ?? []).filter(
      (x) => /^https:\/\//.test(x?.uri ?? "")
    )) {
      if (known && item.uri === known.source) continue;
      const link = make("a", "", item.title ?? "General reference");
      link.href = item.uri;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      general.append(link);
    }
    lab.append(general);
    lab.append(make("h4", "", "What this report showed"));
    row(lab, first.quote, "Verbatim admitted passage from the report.", first);
    lab.append(make("h4", "", "Against this lab's printed interval only"));
    row(lab, printedRange
      ? printedRange.quote
      : "The admitted source lines do not establish a printed reference interval.",
      "No outside limits or health interpretation are used.", printedRange ?? first);
    lab.append(make("h4", "", "What changed"));
    row(lab, revised
      ? "A cited record is amended or corrected. This is a change to the printed record, not proof of a body change."
      : "No correction is established by these admitted source lines.",
      "Open the cited report to inspect the original status.", revised ?? first);
    lab.append(make("h4", "", "Why we trust this record"));
    row(lab, "This statement is admitted with the exact source passage and location.",
      "A source citation does not establish independent clinical validation.", first);
    host.append(lab);
  }
  function paintQuery(d) {
    const host = root.querySelector(".rd-query");
    if (!host) return;
    host.replaceChildren();
    const q = latestQuery;
    if (!q?.final || (q.workspace && workspaceId && q.workspace !== workspaceId)) {
      host.hidden = true;
      return;
    }
    host.hidden = false;
    const f = q.final;
    const supported = typeof f.admittedText === "string";
    host.append(make("h3", "", "What your question established"));
    host.append(make("p", "rd-query-question", q.question ?? ""));
    const verdict = make("div", "rd-query-verdict");
    verdict.dataset.kind = f.kind ?? "unknown";
    verdict.append(make("b", "", supported ? f.kind === "partial" ? "Partially supported" : "Admitted answer" : "No supported answer"));
    verdict.append(make("p", "", supported ? f.admittedText : f.text ?? "These documents did not establish an answer."));
    host.append(verdict);
    if (f.scope) host.append(make("p", "rd-scope",
      "Source scope " + (f.scope.key ?? "unknown") + " · version " + (f.scope.version ?? "unknown")));
    evidenceList(host, "Admitted evidence", Array.isArray(f.citations) ? f.citations : []);
    const unresolved = Array.isArray(f.unresolvedRequirements) ? f.unresolvedRequirements : [];
    if (unresolved.length) {
      host.append(make("h4", "", "Unresolved parts"));
      const list = make("ul", "rd-data-list");
      for (const r of unresolved) row(list, r.text ?? "Requested part", r.reason ?? r.status ?? "Not established");
      host.append(list);
    }
    evidenceList(host, "Related evidence — not an answer",
      Array.isArray(f.relatedEvidence) ? f.relatedEvidence : [], true);
    labExplanation(host, d, q);
  }
  function paintEngine(d, s, tech, replayTau) {
    const film = root.querySelector(".rd-film");
    const eng = root.querySelector(".rd-eng");
    if (!film || !eng) return;
    eng.hidden = false;
    const g = d.digest;
    const pages = Array.isArray(s.pages) ? s.pages : [];
    const count = d.pages ?? g?.layout?.pages ?? (pages.length || null);
    const readable = pages.filter((p) => p.state === "text" || p.state === "ocr-done").length;
    const records = g?.records ?? [];
    const facts = g?.inspectedFacts ?? [];
    const index = g?.index ?? null;
    const key = JSON.stringify([
      d.id, d.status, d.answerable, d.createdAt, d.bytes, count,
      pages.map((p) => [p.n, p.state, p.uncertain]),
      records.length, facts.length, index?.passages, s.evidence?.t,
      tech, pageLimit, workspaceId, latestQuery?.id,
    ]);
    if (key === engineKey) return;
    engineKey = key;
    const opened = new Set([...film.querySelectorAll("details[open]")].map(
      (el) => el.closest("[data-stage]")?.dataset.stage
    ));
    if (!film.querySelector("details")) opened.add("received");
    film.replaceChildren();
    function stage(id, title, summary, fill) {
      const li = make("li", "rd-stage");
      li.dataset.stage = id;
      const details = make("details");
      details.open = opened.has(id);
      const heading = make("summary");
      heading.append(make("span", "rd-stage-mark", "▸"));
      heading.append(make("b", "", title));
      heading.append(make("small", "", summary));
      const body = make("div", "rd-stage-body");
      fill(body);
      details.append(heading, body);
      li.append(details);
      film.append(li);
    }
    stage("received", "File received", d.status === "failed" ? "failed" : "receipt recorded", (body) => {
      const list = make("dl", "rd-meta");
      for (const [label, value] of [
        ["Name", d.filename ?? d.title ?? "Not reported"],
        ["Type", d.kind ?? "Not reported"],
        ["Bytes", d.bytes == null ? "Not reported" : n0(d.bytes)],
        ["Received", d.createdAt == null ? "Not reported" : new Date(d.createdAt).toLocaleString()],
      ]) {
        const box = make("div");
        box.append(make("dt", "", label), make("dd", "", value));
        list.append(box);
      }
      body.append(list);
      if (d.error) body.append(make("p", "rd-uncertain", d.error.message ?? "Upload failed"));
    });
    stage("pages", "Pages read", count == null ? "count not reported" : n0(count) + " pages", (body) => {
      body.append(make("p", "", count == null ? "Page count not reported." :
        n0(count) + " pages recorded; " + readable + " have reported readable text."));
      const ul = make("ul", "rd-data-list");
      for (const p of pages.slice(0, pageLimit)) {
        const uncertain = Number(p.uncertain) > 0;
        const unread = p.state === "unread";
        const reason = uncertain
          ? "OCR uncertainty: " + n0(p.uncertain) + " number(s) need checking."
          : unread ? "Page could not be read reliably." : "";
        const name = p.state === "text" ? "Text layer read" :
          p.state === "ocr-done" ? "Scanned text read" :
          p.state === "ocr" ? "OCR in progress" :
          p.state === "scan" ? "Scan detected" :
          unread ? "Unreadable" : "State not reported";
        const li = row(ul, "Page " + n0(p.n) + " · " + name, reason,
          null, sourceTitle(d), p.n);
        if (reason) {
          li.classList.add("warn");
          const btn = li.querySelector("button");
          if (btn) btn.textContent = "Open page to review";
        }
      }
      if (pages.length) body.append(ul);
      if (pages.length > pageLimit) {
        const more = make("button", "rd-more", "Show next " + Math.min(30, pages.length - pageLimit) + " pages");
        more.type = "button";
        more.onclick = () => { pageLimit += 30; engineKey = ""; paint(); };
        body.append(more);
      }
      if (!pages.length && count === 0) body.append(make("p", "rd-uncertain", "Zero readable pages reported. No page link is invented."));
      for (const w of d.warnings ?? []) body.append(make("p", "rd-uncertain", w.message ?? "Page reading warning"));
    });
    stage("records", "Records identified", records.length + " records", (body) => {
      if (!records.length) body.append(make("p", "", "No record boundaries established yet."));
      const list = make("ul", "rd-data-list");
      for (const r of records) row(list,
        (r.title ?? "Record") + " · subject " + (r.patient ?? "ID not verified"),
        "Printed status: " + (r.status ?? "not reported") + " · pages " +
          ((r.pages ?? []).join(", ") || "not reported"),
        null, sourceTitle(d), r.pages?.[0]);
      body.append(list);
    });
    stage("facts", "Facts extracted", facts.length + " cited rows shown", (body) => {
      if (!facts.length) body.append(make("p", "", "No exact source-linked fact rows reported; nothing was invented."));
      else body.append(make("p", "", "Showing " + facts.length + " source-linked rows of " +
        n0(g?.graph?.facts ?? facts.length) + " recorded facts."));
      const list = make("ul", "rd-data-list");
      for (const f of facts) row(list, f.label + ": " + f.value,
        "Recorded in " + (f.citation?.title ?? "source"), f.citation);
      body.append(list);
    });
    stage("indexed", "Evidence indexed", index ? n0(index.passages) + " passages" : "not indexed yet", (body) => {
      if (!index) { body.append(make("p", "", "Index counts have not been reported yet.")); return; }
      body.append(make("p", "", n0(index.passages) + " passages from this file; " +
        n0(index.bundlePassages) + " in the workspace."));
      body.append(make("p", "", readable + " pages with reported readable text of " +
        (count == null ? "unknown" : n0(count)) + ". Coverage counts, not confidence or accuracy scores."));
      if (g.lookup?.illustrative === true) body.append(make("p", "rd-example",
        (g.lookup.label ?? "Example of indexing — not your search.") +
        " Term: " + (g.lookup.query ?? "") + ". Not a response to the visitor."));
    });
    stage("ready", "Ready", d.answerable === true ? "ask enabled" : "not ready", (body) => {
      body.append(make("p", "", d.answerable === true
        ? "This document can be questioned with source verification."
        : "No supported query can be made from this document yet."));
      body.append(make("p", "", "Workspace: " + (workspaceId ?? "not established")));
      const b = make("button", "rd-ready-button", "Ask about this workspace");
      b.type = "button";
      b.disabled = d.answerable !== true;
      b.onclick = () => document.getElementById("q")?.focus();
      body.append(b);
    });
    paintQuery(d);
  }

  function miniGraph(mini, tech, gg) {
    const nodes = mini?.nodes ?? [];
    const edges = mini?.edges ?? [];
    if (!nodes.length)
      return `<p class="rd-cap">No records with linked facts in this file.</p>`;
    // Four columns: patients, records, values in force, values replaced.
    // A replaced value sits level with the value that replaced it, so each
    // coral link reads left to right: "this one, instead of that one".
    const col = (n) =>
      n.kind === "patient"
        ? 0
        : n.kind === "document"
          ? 1
          : n.status === "superseded"
            ? 3
            : 2;
    const cols = [[], [], [], []];
    for (const n of nodes) cols[col(n)].push(n);
    const sup = edges.filter((e) => e.kind === "supersedes");
    cols[3].sort(
      (a, b) =>
        cols[2].findIndex((n) =>
          sup.some((e) => e.to === a.id && e.from === n.id),
        ) -
        cols[2].findIndex((n) =>
          sup.some((e) => e.to === b.id && e.from === n.id),
        ),
    );
    const W = 230,
      H = Math.max(120, Math.max(...cols.map((c) => c.length)) * 14 + 20);
    const pos = new Map();
    cols.forEach((c, i) =>
      c.forEach((n, j) =>
        pos.set(n.id, {
          x: 14 + i * ((W - 28) / 3),
          y: 12 + ((j + 0.5) * (H - 24)) / c.length,
        }),
      ),
    );
    const path = (a, b) =>
      `M${a.x},${a.y} C${(a.x + b.x) / 2},${a.y} ${(a.x + b.x) / 2},${b.y} ${b.x},${b.y}`;
    const svg =
      `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Records, patients and replaced values">` +
      edges
        .map((e) => {
          const a = pos.get(e.from),
            b = pos.get(e.to);
          if (!a || !b) return "";
          const cls =
            e.kind === "supersedes"
              ? "e-sup"
              : e.kind.startsWith("same name")
                ? "e-id"
                : e.kind === "records"
                  ? "e-rec"
                  : "e-has";
          return e.kind.startsWith("same name")
            ? `<path class="${cls}" d="M${a.x},${a.y} Q${a.x - 14},${(a.y + b.y) / 2} ${b.x},${b.y}"/>`
            : `<path class="${cls}" d="${path(a, b)}"/>`;
        })
        .join("") +
      nodes
        .map((n) => {
          const p = pos.get(n.id);
          const cls =
            n.kind === "patient"
              ? "n-pat"
              : n.kind === "document"
                ? `n-rec a-${AUTH[n.authority] ?? "unk"}`
                : n.status === "superseded"
                  ? "n-old"
                  : "n-val";
          return `<circle class="${cls}" cx="${p.x}" cy="${p.y}" r="${n.kind === "patient" ? 5 : 3.4}"><title>${esc(n.label)}</title></circle>`;
        })
        .join("") +
      `</svg>`;
    return (
      `<div class="rd-graph">${svg}<div class="rd-glab"><span>patients</span><span>records</span><span>in force</span><span>replaced</span></div></div>` +
      (mini.replaced?.length
        ? `<ul class="rd-rep">${mini.replaced
            .slice(0, 3)
            .map(
              (r) =>
                `<li><span>${esc(r.field)}</span><b>${esc(r.now)}</b> <s>${esc(r.was)}</s>${r.wasStatus ? ` <small>${esc(r.wasStatus)}</small>` : ""}</li>`,
            )
            .join("")}</ul>`
        : "") +
      `<p class="rd-cap">${tech ? `${gg.records} record nodes · ${gg.supersedes} supersedes · ${gg.corrections} corrects · ${gg.sameName} identity split. Every value node cites its line.` : "Coral lines: an earlier value replaced by a later, signed one. Red: same name, different person. Open Memory graph to explore it all."}</p>`
    );
  }

  function logLine(e) {
    switch (e.k) {
      case "open":
        return `opened PDF, ${e.pages} pages`;
      case "text":
        return `p${e.n} text layer: ${e.lines} lines, ${n0(e.chars)} chars`;
      case "scan":
        return `p${e.n} has no text layer → queued for OCR`;
      case "layout-partial":
        return `layout (text pages): ${e.headings} headings, ${e.paragraphs} paras, ${e.tables} tables`;
      case "layout":
        return `layout (all pages): ${e.headings} headings, ${e.paragraphs} paras, ${e.tables} tables`;
      case "indexed":
        return `indexed ${n0(e.elements)} elements${e.observations != null ? `, ${e.observations} lab rows` : ""}`;
      case "ocr-start":
        return `p${e.n} OCR started`;
      case "ocr-done":
        return `p${e.n} OCR done: ${e.paragraphs} paragraphs, ${e.confidence}% mean confidence${e.uncertain ? `, ${e.uncertain} uncertain numbers` : ""}`;
      case "ocr-skip":
        return `p${e.n} not OCR'd`;
      case "salvaged":
        return "OCR overran: kept the text pages, marked the scan unread";
      case "cache":
        return "identical file read recently: reused";
      case "ocr-wait":
        return "waiting for the OCR engine (one file at a time)";
      default:
        return e.k;
    }
  }

  function loop() {
    cancelAnimationFrame(raf);
    const tick = () => {
      paint();
      const d = focus();
      const live = d && !TERMINAL.has(d.status);
      if (
        replay &&
        performance.now() - replay.start >= replay.total / replay.speed
      ) {
        replay = null;
        paint();
      }
      if (live || replay) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
  }

  window.VMReading = {
    /** Render into `container` from the latest workspace status. */
    render(container, list, { focus: id, drops = [], workspace = null, generation = null, openSource: opener = null } = {}) {
      if (workspaceId !== workspace || (scopeGeneration !== null && generation !== scopeGeneration)) {
        latestQuery = null;
        engineKey = "";
      }
      workspaceId = workspace;
      scopeGeneration = generation;
      openSource = opener;
      if (root !== container || !container.querySelector(".rd")) {
        root = container;
        skeleton();
      }
      docs = (list ?? []).filter((d) => d.progress);
      if (id) focusId = id;
      received = performance.now();
      clicks.push(...drops.slice(dropsSeen));
      dropsSeen = drops.length;
      for (const d of docs) {
        if (!d.id) continue;
        // A placeholder still in the browser has no server zero yet.
        if (d.status === "sending") {
          offsets.set(d.id, 0);
          continue;
        }
        if (offsets.has(d.id) && !(offsets.get(d.id) === 0 && d.local))
          continue;
        const live = !TERMINAL.has(d.status);
        const drop = d.local?.since ?? (live ? clicks.shift() : null);
        const serverZero = received - (d.progress?.age ?? 0);
        offsets.set(d.id, drop != null ? Math.max(0, serverZero - drop) : 0);
      }
      if (replay && !docs.some((d) => d.id === replay.id)) replay = null;
      paint();
      loop();
    },
    tick() {
      paint();
    },
    focus(id) {
      focusId = id;
      replay = null;
      paint();
    },
  };
})();
