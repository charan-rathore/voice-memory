// Visual summary for the evidence desk: what a report says, at a glance.
//
// Lab results are drawn as measuring strips on chart paper: the lab's OWN
// printed range is the hatched band, the person's value is the ink dot, a
// corrected value stays visible as a struck-through ghost, and a unit change
// is a torn break (never a line: values in different units are not compared).
// Records (contracts, meetings) are a "where it stands" board with ink stamps.
//
// Narration reads the server's sentence aloud in the language the person
// used, and marks each strip while its sentence is spoken.
(() => {
  "use strict";
  const esc = (s) =>
    String(s ?? "").replace(
      /[&<>"']/g,
      (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
    );
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const MONTH = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const MONTH_HI = ["जन", "फ़र", "मार्च", "अप्रै", "मई", "जून", "जुला", "अग", "सित", "अक्टू", "नव", "दिस"];
  const shortDate = (iso, lang) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso ?? "");
    if (!m) return iso ?? "";
    return `${Number(m[3])} ${(lang === "hi" ? MONTH_HI : MONTH)[Number(m[2]) - 1]}`;
  };

  const WORDS = {
    en: {
      inside: "inside the lab's range",
      belowS: "a little below range",
      aboveS: "a little above range",
      below: "below range",
      above: "above range",
      noRange: "no printed range",
      corrected: (a, b) => `corrected from ${a} to ${b}`,
      units: "units changed, not compared",
      reports: (n) => (n === 1 ? "1 report" : `${n} reports`),
      outside: (n, m) => `${n} of ${m} results outside the printed range`,
      allIn: (m) => `All ${m} results inside the printed range`,
      separate: "a separate person, kept apart",
      listen: "Listen",
      stop: "Stop",
      range: "Lab range",
      prelim: "preliminary",
      amended: "amended",
      final: "final",
      legend: ["Lab's printed range", "Your value", "Corrected away"],
      board: "Where it stands",
      timeline: "Records, oldest first",
      general: "General background, not from your documents",
      more: (n) => `Show ${n} more results`,
      noRanges: "No reference ranges printed",
      full: ["Show full text", "Show less"],
      also: "Also printed, without a range to place them on:",
      andMore: (n) => ` and ${n} more`,
    },
    hi: {
      inside: "लैब की सीमा के अंदर",
      belowS: "सीमा से थोड़ा कम",
      aboveS: "सीमा से थोड़ा ज़्यादा",
      below: "सीमा से कम",
      above: "सीमा से ज़्यादा",
      noRange: "सीमा नहीं छपी",
      corrected: (a, b) => `${a} से सुधारकर ${b}`,
      units: "यूनिट बदली, तुलना नहीं",
      reports: (n) => `${n} रिपोर्ट`,
      outside: (n, m) => `${m} में से ${n} नतीजे सीमा से बाहर`,
      allIn: (m) => `सभी ${m} नतीजे सीमा के अंदर`,
      separate: "अलग व्यक्ति, अलग रखा गया",
      listen: "सुनें",
      stop: "रोकें",
      range: "लैब सीमा",
      prelim: "प्रारंभिक",
      amended: "संशोधित",
      final: "अंतिम",
      legend: ["लैब की छपी सीमा", "आपका नतीजा", "सुधारा गया नतीजा"],
      board: "अभी क्या स्थिति है",
      timeline: "दस्तावेज़, पुराने से नए",
      general: "सामान्य जानकारी, आपके दस्तावेज़ों से नहीं",
      more: (n) => `${n} और नतीजे देखें`,
      noRanges: "कोई सीमा नहीं छपी",
      full: ["पूरा पढ़ें", "कम दिखाएं"],
      also: "ये भी छपे हैं, पर इनकी कोई सीमा नहीं दी गई:",
      andMore: (n) => ` और ${n} अन्य`,
    },
    hinglish: {
      inside: "lab ki range ke andar",
      belowS: "range se thoda kam",
      aboveS: "range se thoda zyada",
      below: "range se kam",
      above: "range se zyada",
      noRange: "range nahi chhapi",
      corrected: (a, b) => `${a} se sudhaar kar ${b}`,
      units: "unit badli, tulna nahi",
      reports: (n) => `${n} report${n === 1 ? "" : "s"}`,
      outside: (n, m) => `${m} mein se ${n} results range se bahar`,
      allIn: (m) => `Sabhi ${m} results range ke andar`,
      separate: "alag vyakti, alag rakha gaya",
      listen: "Suniye",
      stop: "Rokiye",
      range: "Lab range",
      prelim: "preliminary",
      amended: "amended",
      final: "final",
      legend: ["Lab ki printed range", "Aapka result", "Sudhaara gaya result"],
      board: "Abhi kya sthiti hai",
      timeline: "Documents, purane se naye",
      general: "General jaankari, aapke documents se nahi",
      more: (n) => `${n} aur results dekhiye`,
      noRanges: "Koi range nahi chhapi",
      full: ["Poora padhiye", "Kam dikhaiye"],
      also: "Yeh bhi chhape hain, par inki koi range nahi di gayi:",
      andMore: (n) => ` aur ${n} aur`,
    },
  };
  const W = (lang) => WORDS[lang] ?? WORDS.en;

  const TONE = {
    within: "in",
    below_slightly: "near",
    above_slightly: "near",
    below_clearly: "out",
    above_clearly: "out",
    qual_differs: "out",
    unknown: "none",
  };
  const posWord = (p, w) =>
    ({
      within: w.inside,
      below_slightly: w.belowS,
      above_slightly: w.aboveS,
      below_clearly: w.below,
      above_clearly: w.above,
      qual_differs: w.above,
      unknown: w.noRange,
    })[p] ?? w.noRange;

  // ------------------------------------------------------------ strip
  let uid = 0;
  function strip(t, w) {
    const L = t.latest;
    const r = L.range;
    const id = `vz${++uid}`;
    const ghost = t.corrected ? Number(t.corrected.from) : null;
    const vals = [L.value, ghost].filter((x) => Number.isFinite(x));
    if (!r || r.lowN == null || r.highN == null || !Number.isFinite(L.value)) {
      return `<svg class="vz-svg" viewBox="0 0 480 44" aria-hidden="true"><line class="vz-base" x1="12" y1="28" x2="468" y2="28"/><text class="vz-none" x="240" y="22" text-anchor="middle">${esc(L.qual ?? w.noRange)}</text></svg>`;
    }
    const span = r.highN - r.lowN || Math.abs(r.highN) || 1;
    let lo = Math.min(r.lowN - span * 0.55, ...vals.map((v) => v - span * 0.12));
    let hi = Math.max(r.highN + span * 0.55, ...vals.map((v) => v + span * 0.12));
    if (r.lowN >= 0 && lo < 0) lo = 0;
    const X = (v) => 12 + ((v - lo) / (hi - lo || 1)) * 456;
    const x0 = X(r.lowN), x1 = X(r.highN), xv = X(L.value);
    const tone = TONE[L.position] ?? "none";
    const ticks = [];
    const step = (hi - lo) / 24;
    for (let k = 0; k <= 24; k++) {
      const x = 12 + (k / 24) * 456;
      ticks.push(`<line class="vz-tick${k % 6 === 0 ? " big" : ""}" x1="${x.toFixed(1)}" y1="28" x2="${x.toFixed(1)}" y2="${k % 6 === 0 ? 33 : 31}"/>`);
    }
    void step;
    let ghostSvg = "";
    if (ghost != null && Number.isFinite(ghost)) {
      const xg = X(ghost);
      const mid = (xg + xv) / 2;
      const lift = Math.min(18, Math.abs(xv - xg) / 3 + 6);
      ghostSvg = `<g class="vz-ghost"><circle cx="${xg.toFixed(1)}" cy="28" r="4.5"/><line x1="${(xg - 6).toFixed(1)}" y1="22" x2="${(xg + 6).toFixed(1)}" y2="34"/><text x="${xg.toFixed(1)}" y="13" text-anchor="middle">${esc(t.corrected.from)}</text>
        <path class="vz-pen" pathLength="1" d="M${(xg + 5).toFixed(1)} 24 Q${mid.toFixed(1)} ${(24 - lift).toFixed(1)} ${(xv - 7).toFixed(1)} 23"/><path class="vz-pen-head" d="M${(xv - 12).toFixed(1)} 20 L${(xv - 7).toFixed(1)} 23 L${(xv - 12).toFixed(1)} 27"/></g>`;
    }
    const near = ghost != null && Math.abs(X(ghost) - xv) < 30;
    const labelAbove = `<text class="vz-num ${tone}" x="${(near ? xv + 7 : xv).toFixed(1)}" y="13" text-anchor="${near ? "start" : xv < 40 ? "start" : xv > 440 ? "end" : "middle"}">${esc(L.raw)}</text>`;
    return `<svg class="vz-svg" viewBox="0 0 480 50" role="img" aria-labelledby="${id}">
      <title id="${id}">${esc(`${t.name} ${L.raw}${t.unit ? " " + t.unit : ""}: ${posWord(L.position, w)} (${r.low} to ${r.high})`)}</title>
      <line class="vz-base" x1="12" y1="28" x2="468" y2="28"/>${ticks.join("")}
      <rect class="vz-band" x="${x0.toFixed(1)}" y="21" width="${Math.max(2, x1 - x0).toFixed(1)}" height="14" rx="2" fill="url(#vz-hatch)"/>
      <line class="vz-edge" x1="${x0.toFixed(1)}" y1="19" x2="${x0.toFixed(1)}" y2="37"/><line class="vz-edge" x1="${x1.toFixed(1)}" y1="19" x2="${x1.toFixed(1)}" y2="37"/>
      <text class="vz-lim" x="${x0.toFixed(1)}" y="46" text-anchor="middle">${esc(r.low)}</text><text class="vz-lim" x="${x1.toFixed(1)}" y="46" text-anchor="middle">${esc(r.high)}</text>
      ${ghostSvg}
      <line class="vz-stem ${tone}" x1="${xv.toFixed(1)}" y1="17" x2="${xv.toFixed(1)}" y2="28"/>
      <circle class="vz-dot ${tone}" cx="${xv.toFixed(1)}" cy="28" r="5.5"/>
      ${labelAbove}
    </svg>`;
  }

  // History across reports: one small chart per unit; a torn edge between units.
  function history(t, lang) {
    if ((t.history ?? []).length < 2) return "";
    const segs = [];
    for (const h of t.history) {
      const last = segs[segs.length - 1];
      if (last && last.unit === h.unit) last.items.push(h);
      else segs.push({ unit: h.unit, items: [h] });
    }
    const part = (seg) => {
      const nums = seg.items.map((h) => h.value).filter(Number.isFinite);
      const lo = Math.min(...nums), hi = Math.max(...nums);
      const n = seg.items.length;
      const pts = seg.items.map((h, i) => {
        const x = n === 1 ? 100 : 22 + (i / (n - 1)) * 156;
        const y = hi === lo ? 26 : 36 - ((h.value - lo) / (hi - lo)) * 20;
        return { x, y, h };
      });
      return `<span class="vz-seg"><svg viewBox="0 0 200 56" aria-hidden="true">
        ${pts.length > 1 ? `<polyline class="vz-line" points="${pts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ")}"/>` : ""}
        ${pts.map((p) => `<circle class="vz-hdot${p.h.status === "preliminary" ? " pre" : ""}" cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="3.2"/><text class="vz-hval" x="${p.x.toFixed(1)}" y="${(p.y - 6).toFixed(1)}" text-anchor="middle">${esc(p.h.raw)}</text><text class="vz-hdate" x="${p.x.toFixed(1)}" y="53" text-anchor="middle">${esc(shortDate(p.h.date, lang))}</text>`).join("")}
      </svg><i>${esc(seg.unit ?? "")}</i></span>`;
    };
    return `<div class="vz-hist">${segs.map(part).join(`<span class="vz-tear" aria-hidden="true"></span>`)}</div>`;
  }

  function row(t, w, lang, i, withHistory) {
    const L = t.latest;
    const tone = TONE[L.position] ?? "none";
    const notes = [];
    if (t.corrected) notes.push(`<span class="vz-note fix">${esc(w.corrected(t.corrected.from, t.corrected.to))}</span>`);
    if (t.unitChanged) notes.push(`<span class="vz-note unit">${esc(w.units)}</span>`);
    return `<li class="vz-row ${tone}" data-test="${esc(t.name.toLowerCase())}" style="--i:${i}">
      <div class="vz-name"><b>${esc(t.name)}</b><span class="vz-unit">${esc(t.unit ?? "")}</span></div>
      <div class="vz-strip">${strip(t, w)}</div>
      <div class="vz-read"><span class="vz-pos ${tone}">${esc(posWord(L.position, w))}</span>${notes.join("")}</div>
      ${withHistory ? history(t, lang) : ""}
    </li>`;
  }

  const DEFS = `<svg class="vz-defs" width="0" height="0" aria-hidden="true" focusable="false"><defs>
    <pattern id="vz-hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="6" height="6" class="vz-hatch-bg"/><line x1="0" y1="0" x2="0" y2="6" class="vz-hatch-ln"/></pattern>
  </defs></svg>`;

  function reportTrail(s, w, lang) {
    return `<ol class="vz-trail" aria-label="${esc(w.reports(s.reports.length))}">${s.reports
      .map((r) => {
        const st = r.status === "preliminary" ? "pre" : r.status === "amended" ? "amd" : "fin";
        const word = r.status === "preliminary" ? w.prelim : r.status === "amended" ? w.amended : w.final;
        return `<li class="${st}"><i aria-hidden="true"></i><span>${esc(shortDate(r.date, lang))}</span><em>${esc(word)}</em></li>`;
      })
      .join("")}</ol>`;
  }

  function labs(v, opts) {
    const lang = opts.lang ?? v.lang ?? "en";
    const w = W(lang);
    const [main, ...rest] = v.subjects;
    if (!main) return "";
    const ranged = main.tests.filter((t) => t.latest.range && t.latest.position !== "unknown");
    const out = ranged.filter((t) => /below|above/.test(t.latest.position)).length;
    const focus = v.focus === "answer";
    const head = focus
      ? ""
      : `<div class="vz-head">
          <div class="vz-who"><b>${esc(main.label)}</b>${reportTrail(main, w, lang)}</div>
          <p class="vz-tally">${esc(!ranged.length ? w.noRanges : out ? w.outside(out, ranged.length) : w.allIn(ranged.length))}</p>
        </div>`;
    // Strips are for values the lab printed a range for; the rest (logs,
    // text results) are listed, not drawn on a scale they don't have.
    const drawable = (t) =>
      (t.latest.range && Number.isFinite(t.latest.value)) || t.latest.qual || t.corrected || t.unitChanged;
    const drawn = focus ? main.tests : main.tests.filter(drawable);
    const plain = focus ? [] : main.tests.filter((t) => !drawable(t));
    const MAX = 8;
    const rows =
      drawn.slice(0, MAX).map((t, i) => row(t, w, lang, i, focus)).join("") +
      (drawn.length > MAX
        ? `<li class="vz-more-rows"><details><summary>${esc(w.more(drawn.length - MAX))}</summary><ul class="vz-rows">${drawn
            .slice(MAX)
            .map((t, i) => row(t, w, lang, i, false))
            .join("")}</ul></details></li>`
        : "") +
      (plain.length
        ? `<li class="vz-also">${esc(w.also)} ${esc(
            plain
              .slice(0, 6)
              .map((t) => `${t.name} ${t.latest.raw}${t.unit ? " " + t.unit : ""}`)
              .join(", "),
          )}${plain.length > 6 ? esc(w.andMore(plain.length - 6)) : ""}</li>`
        : "");
    const others = focus
      ? ""
      : rest
          .map(
            (s) => `<details class="vz-other"><summary><b>${esc(s.label)}</b> <span>${esc(w.separate)}</span></summary><ul class="vz-rows">${s.tests.filter(drawable).slice(0, MAX).map((t, i) => row(t, w, lang, i, false)).join("")}</ul></details>`,
          )
          .join("");
    const legend = `<p class="vz-legend" aria-hidden="true"><span class="lg-band"></span>${esc(w.legend[0])}<span class="lg-dot"></span>${esc(w.legend[1])}${main.tests.some((t) => t.corrected) ? `<span class="lg-ghost"></span>${esc(w.legend[2])}` : ""}</p>`;
    return `${DEFS}${head}<ul class="vz-rows">${rows}</ul>${others}${legend}`;
  }

  // ------------------------------------------------------------ records board
  const STAMP = {
    PROPOSED: ["warn", { en: "Proposed", hi: "प्रस्तावित", hinglish: "Proposed" }],
    OPEN: ["warn", { en: "Still open", hi: "अभी तय नहीं", hinglish: "Abhi open" }],
    APPROVED: ["ok", { en: "Approved", hi: "मंज़ूर", hinglish: "Approved" }],
    AGREED: ["ok", { en: "Agreed", hi: "तय", hinglish: "Agreed" }],
    "NO-RECORD": ["no", { en: "Not on record", hi: "दर्ज नहीं", hinglish: "Record mein nahi" }],
  };
  const shortMonths = (t) =>
    t.replace(/\b(\d{1,2}) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]* \d{4}\b/g, "$1 $2");
  const keyFigure = (text0) => {
    const text = shortMonths(text0);
    const vs = /([\w$,./ ]{2,28}?)\s+versus\s+([\w$,./ ]{2,28}?)\s+(?:are|is)\b/i.exec(text);
    if (vs) return `${vs[1].trim()} <s-or>or</s-or> ${vs[2].trim()}`;
    const money = /\$\d[\d,]*/.exec(text);
    if (money) return money[0];
    if (/^No\b/.test(text)) return "None";
    return "";
  };
  function records(v, opts) {
    const lang = opts.lang ?? v.lang ?? "en";
    const w = W(lang);
    const dated = (v.documents ?? []).filter((d) => d.date);
    const t0 = dated.length ? Date.parse(dated[0].date) : 0;
    const t1 = dated.length ? Date.parse(dated[dated.length - 1].date) : 1;
    const timeline = dated.length
      ? `<div class="vz-tl" aria-label="${esc(w.timeline)}"><span class="vz-tl-line"></span>${dated
          .map((d) => {
            const p = t1 > t0 ? ((Date.parse(d.date) - t0) / (t1 - t0)) * 100 : 50;
            return `<span class="vz-tl-pt" style="left:${p.toFixed(1)}%" title="${esc(d.title)}"><i></i><em>${esc(shortDate(d.date, lang))}</em><b>${esc(d.type ?? "")}</b></span>`;
          })
          .join("")}</div>`
      : "";
    const rows = v.rows
      .map((r, i) => {
        const [tone, label] = STAMP[r.verdict] ?? ["warn", { en: r.verdict }];
        const fig = keyFigure(r.text);
        return `<li class="vz-board-row" style="--i:${i}"><span class="vz-board-k">${esc(r.label)}</span><span class="vz-board-v">${fig ? fig.split(/<s-or>or<\/s-or>/).map(esc).join(`<span class="vz-or">or</span>`) : ""}</span><span class="vz-stamp ${tone}" style="--r:${(i % 2 ? 1.5 : -2) + i * 0.4}deg">${esc(label[lang] ?? label.en)}</span></li>`;
      })
      .join("");
    return `<div class="vz-board"><ul>${rows}</ul></div>${timeline}`;
  }

  // ------------------------------------------------------------ narration
  let speaking = null;
  function pickVoice(lang) {
    const voices = speechSynthesis.getVoices();
    const want = lang === "hi" ? ["hi-IN"] : lang === "hinglish" ? ["en-IN", "hi-IN"] : ["en-IN", "en-GB", "en-US"];
    // Prefer the natural/neural voices browsers ship (Google, Microsoft "Online").
    const score = (v) =>
      (/natural|online|neural|google/i.test(v.name) ? 2 : 0) + (v.localService ? 0 : 1);
    for (const tag of want) {
      const m = voices.filter((v) => v.lang.replace("_", "-").startsWith(tag)).sort((a, b) => score(b) - score(a));
      if (m.length) return m[0];
    }
    return null;
  }
  function stop() {
    if ("speechSynthesis" in window) speechSynthesis.cancel();
    speaking?.root?.querySelectorAll(".vz-row.speaking").forEach((r) => r.classList.remove("speaking"));
    speaking?.btn?.classList.remove("on");
    if (speaking?.btn) speaking.btn.querySelector("span").textContent = W(speaking.lang).listen;
    speaking = null;
  }
  /** Read `text` aloud sentence by sentence, marking the strip each sentence is about. */
  function narrate(text, lang, root, btn) {
    if (!("speechSynthesis" in window) || !text) return false;
    if (speaking) {
      const same = speaking.btn === btn;
      stop();
      if (same) return true;
    }
    const sentences = String(text).match(/[^.!?।]+[.!?।]*\s*/g) ?? [text];
    speaking = { root, btn, lang };
    btn?.classList.add("on");
    if (btn) btn.querySelector("span").textContent = W(lang).stop;
    const voice = pickVoice(lang);
    const rows = [...(root?.querySelectorAll(".vz-row") ?? [])];
    sentences.forEach((s, i) => {
      const u = new SpeechSynthesisUtterance(s.trim());
      if (voice) u.voice = voice;
      u.lang = voice?.lang ?? (lang === "hi" ? "hi-IN" : "en-IN");
      u.rate = lang === "en" ? 0.98 : 0.95;
      u.pitch = 1;
      u.onstart = () => {
        rows.forEach((r) => r.classList.toggle("speaking", s.toLowerCase().includes(r.dataset.test)));
      };
      if (i === sentences.length - 1) u.onend = u.onerror = () => speaking?.btn === btn && stop();
      speechSynthesis.speak(u);
    });
    return true;
  }
  if ("speechSynthesis" in window) speechSynthesis.getVoices();

  /**
   * @param {HTMLElement} el
   * @param {object} v visual payload from the engine
   * @param {{lang?: string, narration?: string|null, compact?: boolean}} opts
   */
  function render(el, v, opts = {}) {
    if (!el || !v) return;
    stop();
    const lang = opts.lang ?? v.lang ?? "en";
    const body = v.kind === "records" ? records(v, opts) : labs(v, opts);
    const narration = opts.narration ?? v.narration ?? null;
    el.innerHTML = `<div class="vz ${v.kind === "records" ? "vz-rec" : "vz-lab"}${v.focus === "answer" ? " vz-focus" : ""}${reduced ? " still" : ""}" lang="${lang === "hi" ? "hi" : "en"}">
      ${body}
      ${narration && opts.narrateButton !== false ? `<div class="vz-say"><button type="button" class="vz-listen"><i aria-hidden="true"></i><span>${esc(W(lang).listen)}</span></button><div><p class="vz-narr clamp">${esc(narration)}</p><button type="button" class="vz-more">${esc(W(lang).full[0])}</button></div></div>` : ""}
    </div>`;
    const btn = el.querySelector(".vz-listen");
    btn?.addEventListener("click", () => narrate(narration, lang, el, btn));
    el.querySelector(".vz-more")?.addEventListener("click", (e) => {
      const p = el.querySelector(".vz-narr");
      const open = p.classList.toggle("clamp");
      e.currentTarget.textContent = W(lang).full[open ? 0 : 1];
    });
  }

  window.VMVisual = { render, narrate, stop, words: W };
})();
