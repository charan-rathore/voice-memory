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
  const BUDGET_S = 120; // the promise: fully read in under two minutes
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
    if (!s.pages.length && doc.progress?.pages?.length && s.cached)
      s.pages = doc.progress.pages.map((p) => ({ ...p }));
    if (!s.textAt && s.cached && s.finalAt != null) s.textAt = s.finalAt;
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
      received: "done",
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
        <div class="rd-budget" aria-hidden="true">
          <i class="rd-budget-fill"></i><i class="rd-budget-ask"></i>
          <span class="rd-budget-l">0</span><span class="rd-budget-r">2:00 budget</span>
        </div>
        <ol class="rd-rail">${STEPS.map(
          (st, i) =>
            `<li data-step="${st.id}" style="--i:${i}"><i class="rd-dot"></i><b>${st.plain}</b><small data-tech="${esc(st.tech)}"></small></li>`,
        ).join("")}<i class="rd-packet" aria-hidden="true"></i></ol>
        <div class="rd-pages" aria-hidden="true"></div>
        <section class="rd-eng" aria-label="Inside the engine">
          <header><b>Inside the engine</b><span>how your file becomes something it can answer from</span></header>
          <ol class="rd-film"></ol>
        </section>
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
      (replaying ? `  ·  replay at ${Math.round(replay.speed)}×` : "");
    const o = off(d);
    const at = (t) => (t == null ? null : t + o);
    root.querySelector(".rd-clock").textContent = clock(tau + o);

    // Budget bar: where we are against two minutes, and when asking opened.
    const pct = (ms) => `${Math.min(100, (ms / (BUDGET_S * 1000)) * 100)}%`;
    const fill = root.querySelector(".rd-budget-fill");
    fill.style.width = pct(tau + o);
    fill.classList.toggle("over", tau + o > BUDGET_S * 1000);
    const ask = root.querySelector(".rd-budget-ask");
    const askAt = at(
      s.partialAt ??
        (done && s.status !== "failed"
          ? s.evidence
            ? Math.max(s.evidence.t ?? 0, s.finalAt)
            : s.finalAt
          : null),
    );
    ask.hidden = askAt == null;
    if (askAt != null) {
      ask.style.left = pct(askAt);
      ask.title = `You could ask from ${fmtS(askAt)}`;
    }

    // Rail: each station's state, its time stamp, and the packet position.
    let active = 0;
    STEPS.forEach((st, i) => {
      const li = root.querySelector(`[data-step="${st.id}"]`);
      li.dataset.state = steps[st.id];
      if (["done", "live", "warn"].includes(steps[st.id])) active = i;
      if (steps[st.id] === "active") active = i;
      const stamp = {
        received: d.status === "sending" ? null : o || null,
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
    root.querySelector(".rd-packet").style.setProperty("--at", String(active));
    root.querySelector(".rd-packet").dataset.state = done
      ? s.status === "failed"
        ? "bad"
        : "done"
      : "moving";

    // Page filmstrip.
    const strip = root.querySelector(".rd-pages");
    const maxChars = Math.max(1, ...s.pages.map((p) => p?.chars ?? 0));
    const shown = s.pages.slice(0, 30);
    if (
      strip.childElementCount !==
      shown.length + (s.pages.length > 30 ? 1 : 0)
    ) {
      strip.innerHTML =
        shown
          .map(
            (p, i) =>
              `<figure data-n="${i + 1}"><div class="pg"><i class="pg-fill"></i><i class="pg-scan"></i><em></em></div><figcaption>${i + 1}</figcaption></figure>`,
          )
          .join("") +
        (s.pages.length > 30
          ? `<figure class="more"><div class="pg"></div><figcaption>+${s.pages.length - 30}</figcaption></figure>`
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
              : `${p.confidence}%`
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
                ? `Page ${p.n}: OCR ${p.confidence}% mean confidence${p.uncertain ? `, ${p.uncertain} uncertain numbers` : ""}`
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
      ? `<span>${s.status === "failed" ? "Stopped" : "Read"} in <b>${fmtS(total)}</b>${askAt != null && s.partialAt != null ? ` · you could ask from <b>${fmtS(askAt)}</b>` : ""}${total <= BUDGET_S * 1000 ? " · inside the 2-minute budget" : ""}</span>${!reduced() && total > 1500 && !replaying ? `<button type="button" data-replay>Replay</button>` : ""}`
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

  // ------------------------------------------------- inside the engine
  // Five frames, each shown only when the data for it exists (digest =
  // what the server computed from this document after indexing it).
  const FRAMES = [
    {
      id: "structure",
      n: "1",
      plain: "Pages become structure",
      tech: "layout → typed blocks",
    },
    {
      id: "records",
      n: "2",
      plain: "Structure becomes records",
      tech: "packet segments + authority",
    },
    {
      id: "facts",
      n: "3",
      plain: "Records become facts",
      tech: "table facts, lab rows, supersession",
    },
    {
      id: "numbers",
      n: "4",
      plain: "Words become numbers",
      tech: "BM25 term weights (k1 1.5, b 0.75)",
    },
    {
      id: "graph",
      n: "5",
      plain: "Numbers become a graph",
      tech: "evidence graph (grounded edges)",
    },
  ];
  const bar = (v, max, cls = "") =>
    `<i class="rd-b ${cls}" style="--w:${Math.max(2, Math.min(100, (v / (max || 1)) * 100)).toFixed(1)}%"></i>`;
  const AUTH = { authoritative: "auth", provisional: "prov", unknown: "unk" };
  let engineKey = "";
  function paintEngine(d, s, tech, replayTau) {
    const film = root.querySelector(".rd-film");
    const eng = root.querySelector(".rd-eng");
    const g = d.digest;
    // During a replay, a frame appears at the moment its data was produced.
    const ready = {
      structure: !!(s.counts || g),
      records:
        !!g && (replayTau == null || (s.evidence && s.evidence.t <= replayTau)),
      facts:
        !!g && (replayTau == null || (s.evidence && s.evidence.t <= replayTau)),
      numbers:
        !!g?.lookup &&
        (replayTau == null || s.finalAt != null || s.partialAt != null),
      graph: !!g && (replayTau == null || s.finalAt != null),
    };
    eng.hidden = !ready.structure;
    if (eng.hidden) return;
    const key = JSON.stringify([
      d.id,
      ready,
      tech,
      !!g,
      s.counts,
      g?.graph?.facts,
    ]);
    if (key === engineKey) return;
    engineKey = key;
    const L = g?.layout ?? s.counts ?? {};
    const html = FRAMES.map((f) => {
      if (!ready[f.id])
        return `<li class="rd-fr wait" data-f="${f.id}"><em>${f.n}</em><b>${tech ? f.tech : f.plain}</b><p class="rd-dim">waiting</p></li>`;
      let body = "";
      if (f.id === "structure") {
        const parts = [
          ["h", L.headings ?? 0, "headings"],
          ["t", L.tables ?? 0, "tables"],
          ["p", L.paragraphs ?? 0, "paragraphs"],
          ["o", L.ocr ?? 0, "read by OCR"],
        ];
        const total = parts.reduce((a, p) => a + p[1], 0) || 1;
        body =
          `<div class="rd-mix">${parts.map(([c, v]) => `<i class="m-${c}" style="flex:${v || 0}"></i>`).join("")}</div>` +
          `<ul class="rd-kv">${parts
            .filter((p) => p[1])
            .map(([c, v, l]) => `<li><i class="m-${c}"></i>${n0(v)} ${l}</li>`)
            .join("")}` +
          (L.furniture
            ? `<li class="rd-dim"><i class="m-f"></i>${n0(L.furniture)} headers and footers set aside</li>`
            : "") +
          `</ul>` +
          (tech && L.rows
            ? `<p class="rd-mono">${n0(L.rows)} table rows · ${n0(L.characters)} chars</p>`
            : "") +
          `<p class="rd-cap">${tech ? "Columns found by their grid; repeated page furniture excluded from the index." : "Tables stay tables, so a label keeps its value."}</p>`;
        void total;
      }
      if (f.id === "records") {
        const recs = g.records ?? [];
        body =
          `<ul class="rd-recs">${recs
            .slice(0, 9)
            .map(
              (r) =>
                `<li class="a-${AUTH[r.authority] ?? "unk"}"><span>p.${esc(r.pages?.join("-") ?? r.n)}</span><b>${esc(r.title.toLowerCase())}</b>${r.status ? `<small>${esc(r.status)}</small>` : ""}${r.patient ? `<code>${esc(r.patient)}</code>` : ""}</li>`,
            )
            .join("")}</ul>` +
          `<p class="rd-cap">${recs.length > 1 ? `${recs.length} records in one file` : "One record"}${g.graph.patients ? ` · ${g.graph.patients} patient${g.graph.patients > 1 ? "s" : ""}` : ""}${g.graph.sameName ? " · same name, different ID: kept apart" : ""}. ${tech ? "Teal: signed/final/posted. Amber: estimate/draft/preliminary." : "Signed and final records outrank estimates and drafts."}</p>`;
      }
      if (f.id === "facts") {
        const samples = (g.records ?? [])
          .filter((r) => r.authority === "authoritative")
          .sort((a, b) => b.n - a.n)
          .flatMap((r) => r.sample)
          .slice(0, 3);
        body =
          `<div class="rd-big"><span><b>${n0(g.graph.facts)}</b>facts</span><span><b>${n0(g.graph.labRows)}</b>lab rows</span><span><b>${n0(g.graph.supersedes + g.graph.corrections)}</b>replaced</span></div>` +
          `<ul class="rd-facts">${samples.map((x) => `<li><span>${esc(x.label)}</span><b>${esc(x.value)}</b></li>`).join("")}</ul>` +
          `<p class="rd-cap">${g.graph.corrections ? `${g.graph.corrections} lab value corrected by an amendment. ` : ""}${g.graph.supersedes ? `${g.graph.supersedes} earlier value${g.graph.supersedes > 1 ? "s" : ""} replaced by a signed or final record.` : "Every fact keeps the exact line it came from."}</p>`;
      }
      if (f.id === "numbers") {
        const lk = g.lookup;
        const maxIdf = Math.max(...lk.terms.map((t) => t.idf), 0.01);
        const maxScore = Math.max(...lk.hits.map((h) => h.score), 0.01);
        const vec = g.passage?.vector ?? [];
        const maxW = Math.max(...vec.map((v) => v.w), 0.01);
        body =
          `<p class="rd-q">Looking up “${esc(lk.query)}”</p>` +
          `<ul class="rd-idf">${lk.terms.map((t, i) => `<li><span class="t${i % 4}">${esc(t.t)}</span>${bar(t.idf, maxIdf, "t" + (i % 4))}<code>${t.idf.toFixed(3)}</code></li>`).join("")}</ul>` +
          `<ul class="rd-hits">${lk.hits
            .slice(0, 3)
            .map(
              (h) =>
                `<li><span>${esc((h.heading || "passage " + h.ordinal).toLowerCase())}</span><i class="rd-stack" style="--w:${((h.score / maxScore) * 100).toFixed(1)}%">${h.parts.map((p, i) => (p ? `<i class="t${i % 4}" style="flex:${p}"></i>` : "")).join("")}</i><code>${h.score.toFixed(2)}</code></li>`,
            )
            .join("")}</ul>` +
          (vec.length
            ? `<div class="rd-vec" title="The top passage as numbers: one weight per word">${vec.map((v) => `<i style="--h:${((v.w / maxW) * 100).toFixed(0)}%" title="${esc(v.t)} ${v.w}"></i>`).join("")}</div>`
            : "") +
          `<p class="rd-cap">${
            tech
              ? `idf = ln(1 + (N − df + 0.5)/(df + 0.5)), N = ${g.index.bundlePassages} passages · ${n0(g.index.vocabulary)} terms here. Meaning vectors: ${g.dense.state === "on" ? `${g.passage?.embedding?.dims ?? ""}-d, ${g.dense.embedded} passages` : g.dense.state === "pending" ? "computing in the background" : "off on this host (memory)"}.`
              : `Every word gets a weight. Rare words decide; words found everywhere (${esc(lk.terms.reduce((a, t) => (t.idf < a.idf ? t : a), lk.terms[0])?.t ?? "")}) count for almost nothing. The best-scoring passage is what an answer is read from.`
          }</p>`;
      }
      if (f.id === "graph") body = miniGraph(g.graph.mini, tech, g.graph);
      return `<li class="rd-fr" data-f="${f.id}"><em>${f.n}</em><b>${tech ? f.tech : f.plain}</b>${body}</li>`;
    }).join("");
    film.innerHTML = html;
    // Follow the newest frame, like a film advancing.
    const last = [...film.querySelectorAll(".rd-fr:not(.wait)")].pop();
    if (last && !reduced())
      film.scrollTo({
        left: last.offsetLeft - film.offsetLeft - 8,
        behavior: "smooth",
      });
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
    render(container, list, { focus: id, drops = [] } = {}) {
      if (root !== container) {
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
