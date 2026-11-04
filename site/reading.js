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
    if (s.status === "uploaded")
      return "In line. The engine reads one file at a time, and yours is next.";
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
      loop();
    });
  }

  const focus = () =>
    docs.find((d) => d.id === focusId) ??
    [...docs].reverse().find((d) => d.progress && !TERMINAL.has(d.status)) ??
    [...docs].reverse().find((d) => d.progress);

  function elapsedOf(d) {
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
        received: o || null,
        checked: at(s.checkedAt),
        text: at(s.textAt),
        ocr:
          steps.ocr === "done" || steps.ocr === "warn" ? at(s.finalAt) : null,
        evidence: s.evidence ? at(s.evidence.t) : null,
        answer: askAt,
      }[st.id];
      const small = li.querySelector("small");
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
        if (offsets.has(d.id) || !d.id) continue;
        const live = !TERMINAL.has(d.status);
        const drop = live ? clicks.shift() : null;
        const serverZero = received - (d.progress?.age ?? 0);
        offsets.set(d.id, drop != null ? Math.max(0, serverZero - drop) : 0);
      }
      if (replay && !docs.some((d) => d.id === replay.id)) replay = null;
      paint();
      loop();
    },
    focus(id) {
      focusId = id;
      replay = null;
      paint();
    },
  };
})();
