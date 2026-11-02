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
      voiceOff: "Voice unavailable - tap to retry",
      changesLabel: "What changed",
      st_amended: "amended report",
      st_preliminary: "preliminary report",
      st_final: "final report",
      howto: "How to read this: every strip is one test. The hatched band is the range the lab printed; the dot is the newest value. A hollow struck dot is a value the lab later corrected.",
      also: "Also printed, without a range to place them on:",
      andMore: (n) => ` and ${n} more`,
      explore: (n) => `Explore ${n}`,
      close: "Close",
      since: (d) => `Since ${d}`,
      toRange: "To the printed range",
      readings: (n, m) => `${n} reading${n === 1 ? "" : "s"} across ${m} report${m === 1 ? "" : "s"}`,
      readingsK: "Readings",
      by: (b, side, bound) => `${b} ${side === "below" ? "below" : "above"} ${bound}`,
      inRange: "inside the range",
      nc: { unit: "Not compared: the units differ", bound: "Not compared: one value is a bound (like <0.05), not a number", missing_unit: "Not compared: a unit is missing", non_numeric: "Not compared: not a number", test: "Not compared" },
      ncK: "Change",
      times: (x) => `${x}× the earlier value`,
      open: "Open the source line",
      sourceOf: (d, t) => `${d} · ${t}`,
      replaced: (a) => `printed ${a} first, corrected`,
      askWhy: (n) => `Why is ${n} outside the range?`,
      askChange: (n) => `Has ${n} changed since the last report?`,
      askWhat: (n) => `What is ${n}?`,
      askCorr: (n) => `Why was ${n} corrected?`,
      askUnits: (n) => `Why is ${n} in different units?`,
      askK: "Ask about this",
      pointsK: "Every reading, oldest first",
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
      voiceOff: "आवाज़ उपलब्ध नहीं - फिर कोशिश करें",
      changesLabel: "क्या बदला",
      st_amended: "संशोधित रिपोर्ट",
      st_preliminary: "प्रारंभिक रिपोर्ट",
      st_final: "अंतिम रिपोर्ट",
      howto: "ऐसे पढ़ें: हर पट्टी एक टेस्ट है। धारीदार बैंड लैब की छपी सीमा है; बिंदु नवीनतम मान। खोखला कटा बिंदु वो मान है जिसे लैब ने बाद में सुधारा।",
      also: "ये भी छपे हैं, पर इनकी कोई सीमा नहीं दी गई:",
      andMore: (n) => ` और ${n} अन्य`,
      explore: (n) => `${n} विस्तार से`,
      close: "बंद करें",
      since: (d) => `${d} से`,
      toRange: "छपी सीमा से दूरी",
      readings: (n, m) => `${m} रिपोर्ट में ${n} नतीजे`,
      readingsK: "नतीजे",
      by: (b, side, bound) => `${bound} से ${b} ${side === "below" ? "कम" : "ज़्यादा"}`,
      inRange: "सीमा के अंदर",
      nc: { unit: "तुलना नहीं: यूनिट अलग हैं", bound: "तुलना नहीं: एक मान सीमा है (जैसे <0.05), संख्या नहीं", missing_unit: "तुलना नहीं: यूनिट नहीं छपी", non_numeric: "तुलना नहीं: संख्या नहीं", test: "तुलना नहीं" },
      ncK: "बदलाव",
      times: (x) => `पहले से ${x} गुना`,
      open: "स्रोत लाइन खोलें",
      sourceOf: (d, t) => `${d} · ${t}`,
      replaced: (a) => `पहले ${a} छपा, फिर सुधारा`,
      askWhy: (n) => `${n} सीमा से बाहर क्यों है?`,
      askChange: (n) => `क्या ${n} पिछली रिपोर्ट से बदला है?`,
      askWhat: (n) => `${n} क्या है?`,
      askCorr: (n) => `${n} क्यों सुधारा गया?`,
      askUnits: (n) => `${n} की यूनिट अलग क्यों है?`,
      askK: "इसके बारे में पूछें",
      pointsK: "हर नतीजा, पुराने से नए",
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
      voiceOff: "Voice available nahi - phir try karein",
      changesLabel: "Kya badla",
      st_amended: "amended report",
      st_preliminary: "preliminary report",
      st_final: "final report",
      howto: "Aise padhein: har strip ek test hai. Dhari wala band lab ki printed range hai; dot latest value. Khokhla kata dot wo value hai jo lab ne baad mein theek ki.",
      also: "Yeh bhi chhape hain, par inki koi range nahi di gayi:",
      andMore: (n) => ` aur ${n} aur`,
      explore: (n) => `${n} detail mein`,
      close: "Band karein",
      since: (d) => `${d} se`,
      toRange: "Printed range se doori",
      readings: (n, m) => `${m} reports mein ${n} results`,
      readingsK: "Results",
      by: (b, side, bound) => `${bound} se ${b} ${side === "below" ? "kam" : "zyada"}`,
      inRange: "range ke andar",
      nc: { unit: "Tulna nahi: units alag hain", bound: "Tulna nahi: ek value bound hai (jaise <0.05), number nahi", missing_unit: "Tulna nahi: unit nahi chhapi", non_numeric: "Tulna nahi: number nahi", test: "Tulna nahi" },
      ncK: "Badlav",
      times: (x) => `pehle se ${x} guna`,
      open: "Source line kholiye",
      sourceOf: (d, t) => `${d} · ${t}`,
      replaced: (a) => `pehle ${a} chhapa, phir sudhara`,
      askWhy: (n) => `${n} range se bahar kyun hai?`,
      askChange: (n) => `Kya ${n} pichhli report se badla?`,
      askWhat: (n) => `${n} kya hota hai?`,
      askCorr: (n) => `${n} kyun sudhara gaya?`,
      askUnits: (n) => `${n} ki unit alag kyun hai?`,
      askK: "Iske baare mein poochiye",
      pointsK: "Har result, purane se naye",
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
    const dd = `vzdd${++uid}`;
    DATA.set(dd, { t, lang });
    return `<li class="vz-row ${tone}" data-test="${esc(t.name.toLowerCase())}" style="--i:${i}">
      <button type="button" class="vz-open" aria-expanded="false" aria-controls="${dd}" data-dd="${dd}" aria-label="${esc(w.explore(t.name))}"><span aria-hidden="true">${esc(w.explore(""))}</span><i aria-hidden="true"></i></button>
      <div class="vz-name"><b>${esc(t.name)}</b><span class="vz-unit">${esc(t.unit ?? "")}</span>${L.status ? `<span class="vz-status st-${esc(L.status)}" title="status of the report this value comes from">${esc(w["st_" + L.status] ?? L.status)}</span>` : ""}</div>
      <div class="vz-strip">${strip(t, w)}</div>
      <div class="vz-read"><span class="vz-val"><b>${esc(L.raw)}</b>${t.unit ? ` ${esc(t.unit)}` : ""}${L.range && L.range.low != null ? ` · range ${esc(L.range.low)}\u2013${esc(L.range.high)}` : ""}</span><span class="vz-pos ${tone}">${esc(posWord(L.position, w))}</span>${notes.join("")}</div>
      ${withHistory ? history(t, lang) : ""}
      <div class="vz-dd" id="${dd}" role="region" aria-label="${esc(w.explore(t.name))}" hidden></div>
    </li>`;
  }

  // ------------------------------------------------------------ drill-down
  // Click a strip (or press Enter on it) to open one test the way an
  // analytics tool opens a metric: every reading on a timeline against the
  // lab's band, the change since last time (only when the engine calls the
  // two readings comparable), the distance to the printed range, each
  // reading's source line one click away, and the questions worth asking
  // next. Numbers come from the engine's insight (visual-summary.mjs).
  const DATA = new Map();
  const signed = (n) => (n > 0 ? `+${n}` : String(n));
  function timeline(t, w, lang) {
    const hs = t.history ?? [];
    if (!hs.length) return "";
    const unitsDiffer = new Set(hs.map((h) => h.unit ?? "?")).size > 1;
    const W0 = 440, H0 = 150, padX = 40, top = 24, bot = 112;
    const xs = hs.map((_, i) => (hs.length === 1 ? W0 / 2 : padX + (i / (hs.length - 1)) * (W0 - 2 * padX)));
    if (unitsDiffer) {
      // No shared axis for different units: each reading stands alone,
      // with a torn gap between them, never a connecting line.
      return `<svg class="dd-svg" viewBox="0 0 ${W0} ${H0}" role="img" aria-label="${esc(w.nc.unit)}">
        ${hs.map((h, i) => `<g class="dd-pt" tabindex="0" role="button" ${h.title ? `data-doc="${esc(h.title)}"` : ""} aria-label="${esc(`${h.raw} ${h.unit ?? ""}, ${shortDate(h.date, lang)}, ${h.status}`)}"><circle class="dd-halo" cx="${xs[i].toFixed(1)}" cy="74" r="14"/><circle class="dd-dot" cx="${xs[i].toFixed(1)}" cy="74" r="6"/><text class="dd-v" x="${xs[i].toFixed(1)}" y="56" text-anchor="middle">${esc(h.raw)}</text><text class="dd-u" x="${xs[i].toFixed(1)}" y="98" text-anchor="middle">${esc(h.unit ?? "")}</text><text class="dd-d" x="${xs[i].toFixed(1)}" y="${H0 - 8}" text-anchor="middle">${esc(shortDate(h.date, lang))}</text></g>`).join("")}
        ${xs.slice(1).map((x, i) => `<path class="dd-tear" d="M${((x + xs[i]) / 2 - 6).toFixed(1)} 48 l12 8 l-12 8 l12 8 l-12 8 l12 8 l-12 8"/>`).join("")}
      </svg>`;
    }
    const nums = hs.map((h) => h.value).filter(Number.isFinite);
    const ghosts = hs.flatMap((h) => h.superseded.map((g) => Number(g.raw))).filter(Number.isFinite);
    const r = t.latest.range;
    const bounds = [...nums, ...ghosts, r?.lowN, r?.highN].filter(Number.isFinite);
    // Values a hundredfold apart (ferritin 0.5 -> 50 against 30-400) vanish
    // on a linear axis; a labelled log axis keeps every reading readable.
    const minB = Math.min(...bounds), maxB = Math.max(...bounds);
    const log = minB > 0 && maxB / minB >= 20;
    const f = log ? Math.log10 : (v) => v;
    let lo = f(minB), hi = f(maxB);
    const pad = (hi - lo || Math.abs(hi) || 1) * 0.16;
    lo -= pad; hi += pad;
    if (!log && minB >= 0 && lo < 0) lo = 0;
    const Y = (v) => bot - ((f(v) - lo) / (hi - lo || 1)) * (bot - top);
    const band = r && Number.isFinite(r.lowN) && Number.isFinite(r.highN)
      ? `<rect class="dd-band" x="${padX - 14}" y="${Y(r.highN).toFixed(1)}" width="${W0 - 2 * padX + 38}" height="${Math.max(2, Y(r.lowN) - Y(r.highN)).toFixed(1)}" fill="url(#vz-hatch)"/><text class="dd-lim" x="2" y="${(Y(r.highN) + 4).toFixed(1)}">${esc(r.high)}</text><text class="dd-lim" x="2" y="${(Y(r.lowN) + 4).toFixed(1)}">${esc(r.low)}</text>`
      : "";
    const pts = hs.map((h, i) => ({ h, x: xs[i], y: Number.isFinite(h.value) ? Y(h.value) : (top + bot) / 2 }));
    const line = pts.length > 1 ? `<polyline class="dd-line" pathLength="1" points="${pts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ")}"/>` : "";
    const ghostSvg = pts.flatMap((p) => p.h.superseded.map((g) => {
      const gy = Y(Number(g.raw));
      if (!Number.isFinite(gy)) return "";
      return `<g class="dd-ghost"><circle cx="${(p.x - 22).toFixed(1)}" cy="${gy.toFixed(1)}" r="5.5"/><line x1="${(p.x - 29).toFixed(1)}" y1="${(gy - 7).toFixed(1)}" x2="${(p.x - 15).toFixed(1)}" y2="${(gy + 7).toFixed(1)}"/><text x="${(p.x - 34).toFixed(1)}" y="${(gy + 4).toFixed(1)}" text-anchor="end">${esc(g.raw)}</text><path class="dd-fix" d="M${(p.x - 17).toFixed(1)} ${gy.toFixed(1)} Q${(p.x - 8).toFixed(1)} ${((gy + p.y) / 2 - 10).toFixed(1)} ${(p.x - 6).toFixed(1)} ${(p.y + (gy > p.y ? 6 : -6)).toFixed(1)}"/></g>`;
    })).join("");
    const dots = pts.map((p) => {
      const bound = p.h.comparator ? `<path class="dd-bound" d="M${p.x.toFixed(1)} ${(p.y + 9).toFixed(1)} v12 m-4 -4 l4 4 l4 -4"/>` : "";
      return `<g class="dd-pt st-${esc(p.h.status)}" tabindex="0" role="button" ${p.h.title ? `data-doc="${esc(p.h.title)}"` : ""} aria-label="${esc(`${p.h.raw}${t.unit ? " " + t.unit : ""}, ${shortDate(p.h.date, lang)}, ${p.h.status}${p.h.title ? ", " + p.h.title : ""}`)}"><circle class="dd-halo" cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="14"/><circle class="dd-dot" cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="6"/>${bound}<text class="dd-v" x="${p.x.toFixed(1)}" y="${(p.y - 13).toFixed(1)}" text-anchor="middle">${esc(p.h.raw)}</text><text class="dd-d" x="${p.x.toFixed(1)}" y="${H0 - 8}" text-anchor="middle">${esc(shortDate(p.h.date, lang))}</text></g>`;
    }).join("");
    return `<svg class="dd-svg" viewBox="0 0 ${W0} ${H0}" role="img" aria-label="${esc(`${t.name}: ${hs.map((h) => h.raw).join(", ")}`)}"><line class="dd-axis" x1="${padX - 24}" y1="${bot + 8}" x2="${W0 - padX + 24}" y2="${bot + 8}"/>${band}${line}${ghostSvg}${dots}${log ? `<text class="dd-scale" x="${W0 - 4}" y="12" text-anchor="end">log scale</text>` : ""}</svg>`;
  }
  function drill(t, lang) {
    const w = W(lang);
    const ins = t.insight ?? {};
    const hs = t.history ?? [];
    const reportsN = new Set(hs.map((h) => h.title).filter(Boolean)).size + hs.reduce((n, h) => n + h.superseded.length, 0);
    const tiles = [];
    if (ins.change) {
      const c = ins.change;
      const ratio = c.pct != null && Math.abs(c.pct) >= 300 ? w.times(fmt(c.to / c.from)) : c.pct != null ? `${signed(c.pct)}%` : "";
      tiles.push(`<div class="dd-tile ${c.direction}"><span>${esc(w.since(shortDate(c.fromDate, lang)))}</span><b>${esc(signed(c.abs))}${t.unit ? ` <small>${esc(t.unit)}</small>` : ""}</b><em>${esc(`${c.from} → ${c.to}`)}${ratio ? ` · ${esc(ratio)}` : ""}</em></div>`);
    } else if (ins.notCompared) {
      tiles.push(`<div class="dd-tile nc"><span>${esc(w.ncK)}</span><b class="dd-nc">${esc(w.nc[ins.notCompared] ?? w.nc.test)}</b></div>`);
    }
    if (t.latest.range)
      tiles.push(`<div class="dd-tile"><span>${esc(w.toRange)} · ${esc(shortDate(t.latest.date, lang))}</span><b${ins.distance ? "" : ' class="txt"'}>${esc(ins.distance ? w.by(fmt(ins.distance.by), ins.distance.side, ins.distance.bound) : t.latest.position === "within" ? w.inRange : w.noRange)}</b><em>${esc(`${t.latest.range.low}–${t.latest.range.high}${t.unit ? " " + t.unit : ""}`)}</em></div>`);
    tiles.push(`<div class="dd-tile"><span>${esc(w.readingsK)}</span><b class="txt">${esc(w.readings(hs.length, Math.max(reportsN, hs.length)))}</b></div>`);
    const points = hs
      .map((h) => `<li><button type="button" class="dd-src" data-doc="${esc(h.title ?? "")}"${h.title ? "" : " disabled"}><span class="dd-src-d">${esc(shortDate(h.date, lang))}</span><b>${esc(h.raw)}${h.unit ? ` <small>${esc(h.unit)}</small>` : ""}</b><span class="vz-status st-${esc(h.status)}">${esc(w["st_" + h.status] ?? h.status)}</span>${h.superseded.map((g) => `<s class="dd-was">${esc(w.replaced(g.raw))}</s>`).join("")}<span class="dd-go">${esc(w.open)} →</span></button></li>`)
      .join("");
    const asks = [];
    if (/below|above/.test(t.latest.position)) asks.push(w.askWhy(t.name));
    if (t.corrected) asks.push(w.askCorr(t.name));
    if (t.unitChanged) asks.push(w.askUnits(t.name));
    if (hs.length > 1 && !t.unitChanged) asks.push(w.askChange(t.name));
    asks.push(w.askWhat(t.name));
    return `<div class="dd-grid">
        <div class="dd-chart">${timeline(t, w, lang)}<div class="dd-tip" role="status" aria-live="polite"></div></div>
        <div class="dd-tiles">${tiles.join("")}</div>
      </div>
      <p class="dd-k">${esc(w.pointsK)}</p><ol class="dd-points">${points}</ol>
      <p class="dd-k">${esc(w.askK)}</p><div class="dd-asks">${asks.slice(0, 4).map((q) => `<button type="button" class="dd-ask" data-q="${esc(q)}">${esc(q)}</button>`).join("")}</div>`;
  }
  const fmt = (n) => (Number.isInteger(n) ? String(n) : String(Number(n.toPrecision(3))));
  function toggle(btn, open) {
    const panel = document.getElementById(btn.dataset.dd);
    if (!panel) return;
    const want = open ?? btn.getAttribute("aria-expanded") !== "true";
    if (want && !panel.childElementCount) {
      const d = DATA.get(btn.dataset.dd);
      if (d) panel.innerHTML = drill(d.t, d.lang);
    }
    btn.setAttribute("aria-expanded", String(want));
    btn.closest(".vz-row")?.classList.toggle("open", want);
    panel.hidden = !want;
    if (want && !reduced) panel.animate([{ opacity: 0, transform: "translateY(-4px)" }, { opacity: 1, transform: "none" }], { duration: 260, easing: "cubic-bezier(0.2, 0.7, 0.2, 1)" });
  }
  // One delegated listener for every board on the page.
  document.addEventListener("click", (e) => {
    const btn = e.target.closest?.(".vz-open");
    if (btn) return toggle(btn);
    // a click anywhere on a strip opens its row (the button is the keyboard path)
    const strip = e.target.closest?.(".vz-row .vz-strip, .vz-row .vz-name");
    if (strip) strip.closest(".vz-row").querySelector(".vz-open")?.click();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      const row = e.target.closest?.(".vz-row.open");
      const btn = row?.querySelector(".vz-open");
      if (btn) (toggle(btn, false), btn.focus());
    } else if ((e.key === "Enter" || e.key === " ") && e.target.matches?.(".dd-pt")) {
      e.preventDefault();
      e.target.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    }
  });
  // Hover / focus a reading: a tooltip with its report and status.
  const tip = (e) => {
    const g = e.target.closest?.(".dd-pt");
    const chart = e.target.closest?.(".dd-chart");
    const box = chart?.querySelector(".dd-tip");
    if (!box) return;
    if (!g) return void (box.hidden = true);
    box.textContent = g.getAttribute("aria-label");
    const cr = chart.getBoundingClientRect(), gr = g.getBoundingClientRect();
    box.style.left = `${Math.min(cr.width - 180, Math.max(0, gr.left - cr.left + gr.width / 2 - 90))}px`;
    box.style.top = `${Math.max(0, gr.top - cr.top - 44)}px`;
    box.hidden = false;
  };
  document.addEventListener("pointerover", tip);
  document.addEventListener("focusin", tip);

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
    const changes = main.tests.flatMap((t) => {
      const c = [];
      if (t.corrected)
        c.push(`<span class="vz-chip fix"><i></i>${esc(t.name)} ${esc(w.corrected(t.corrected.from, t.corrected.to))}</span>`);
      if (t.unitChanged) c.push(`<span class="vz-chip unit"><i></i>${esc(t.name)}: ${esc(w.units)}</span>`);
      return c;
    });
    const head = focus
      ? ""
      : `<div class="vz-head">
          <div class="vz-who"><b>${esc(main.label)}</b>${reportTrail(main, w, lang)}</div>
          <p class="vz-tally">${esc(!ranged.length ? w.noRanges : out ? w.outside(out, ranged.length) : w.allIn(ranged.length))}</p>
        </div>${
          changes.length ? `<div class="vz-changes" aria-label="${esc(w.changesLabel)}"><span class="vz-changes-k">${esc(w.changesLabel)}</span>${changes.join("")}</div>` : ""
        }<p class="vz-howto">${esc(w.howto)}</p>`;
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

  // ------------------------------------------------------------ report charts
  // The overview is a report, read the way an analytics report is read:
  //   1. a donut that answers "how many need attention?" at a glance;
  //   2. one row per test showing where the value sits against the lab's own
  //      range and how it moved since the previous report (hollow dot ->
  //      filled dot; no arrow where the engine says the readings are not
  //      comparable);
  //   3. a timeline of what each report changed (a correction, a unit switch).
  // Every mark is a button: it opens a details panel underneath with the
  // numbers behind it, the source lines, and the questions worth asking next.
  // Records (contracts, meetings) get a decisions donut and topic lanes over
  // time instead. All numbers come from the engine's payload.
  const REPORTS = new Map();
  let rid = 0;
  const SEV = {
    within: "in",
    below_slightly: "near",
    above_slightly: "near",
    below_clearly: "out",
    above_clearly: "out",
    qual_differs: "out",
    unknown: "none",
  };
  const SEV_ORDER = ["out", "near", "in", "none"];
  const RW = {
    en: {
      sev: { out: "Clearly outside", near: "Just outside", in: "Inside range", none: "No range printed" },
      donutK: "Where the results sit",
      donutC: (n, m) => [String(n), `of ${m} outside`, "the range"],
      donutC0: (m) => ["0", `of ${m} outside`, "the range"],
      rangeK: "Each result against its own printed range",
      rangeHint: "Hollow dot: previous report. Filled dot: latest. Select a row for the detail.",
      axis: ["below", "printed range", "above"],
      tlK: "What each report changed",
      notCompared: "not compared",
      baseline: (n) => `${n} results reported`,
      prelim: "Preliminary report issued",
      amended: "Amended report replaces the preliminary",
      corrected: (n, a, b, u) => `${n} corrected ${a} → ${b}${u ? " " + u : ""}`,
      unit: (n, a, b) => `${n} now in ${b} (was ${a})`,
      flagged: (n) => `${n} result${n === 1 ? "" : "s"} outside the printed range`,
      detailK: "Detail",
      pick: "Select any slice, row or report above to see the numbers behind it.",
      inSeg: (k, n) => `${n} result${n === 1 ? "" : "s"}: ${k.toLowerCase()}`,
      openReport: "Open this report",
      decK: "Decisions on record",
      decC: (n, m) => [String(n), `of ${m} decisions`, "approved"],
      lanesK: "Where each decision was written, over time",
      lanesHint: "Each mark is a document that speaks to that topic. Select one to read the line.",
      dec: { APPROVED: "Approved", AGREED: "Agreed", PROPOSED: "Proposed only", OPEN: "Still open", "NO-RECORD": "Not on record" },
      ask: "Ask about this",
      sources: "Lines on record, oldest first",
      also: "Others in these reports",
      fieldK: "Where every result sits",
      fieldHint: "Each dot is one test, placed on its own lab's printed range: the lit band runs from the low limit to the high limit. Select a dot or a brace.",
      reg: { below: (n) => `${n} below the range`, in: (n) => `${n} inside the range`, above: (n) => `${n} above the range` },
      regHint: { below: "Furthest below first, measured from the low limit.", in: "Where each sits inside its range, closest to a limit first.", above: "Furthest above first, measured from the high limit." },
      margin: (p) => `${p}% of the range from the nearest limit`,
      lowLim: "low limit",
      highLim: "high limit",
      noRangeList: "No printed range:",
      trackK: "How far each decision got",
      trackHint: "The marker stops at the furthest step the documents support. Select a decision for its versions.",
      stages: ["Discussed", "Proposed", "Agreed", "Approved"],
      fork: "2 versions on record",
      lanesHint: "Each mark is a document that speaks to that topic. Drag the line to see what was on record on any day.",
      scrub: "Date to read the record at",
      asOf: (d) => `Latest line on record, as of ${d}`,
      nothingYet: "nothing on record yet",
      stageK: "Chart detail",
      back: "Back",
      hide: "Hide chart",
      showChart: "Show chart",
      trackerHint: "Move along the line to read any value against the printed range.",
      trBelow: (x) => `below the range by ${x}`,
      trAbove: (x) => `above the range by ${x}`,
      trIn: "inside the range",
      endK: { PROPOSED: "Approval", OPEN: "Agreement", "NO-RECORD": "Signed agreement", APPROVED: "Approved", AGREED: "Agreed" },
      end: { PROPOSED: "Not on record in any document", OPEN: "No single version agreed", "NO-RECORD": "No document records one", APPROVED: "On record", AGREED: "On record" },
    },
    hi: {
      sev: { out: "सीमा से काफ़ी बाहर", near: "सीमा से थोड़ा बाहर", in: "सीमा के अंदर", none: "सीमा नहीं छपी" },
      donutK: "नतीजे कहाँ हैं",
      donutC: (n, m) => [String(n), `${m} में से`, "सीमा से बाहर"],
      donutC0: (m) => ["0", `${m} में से`, "सीमा से बाहर"],
      rangeK: "हर नतीजा, उसकी अपनी छपी सीमा पर",
      rangeHint: "खोखला बिंदु: पिछली रिपोर्ट। भरा बिंदु: नई। विवरण के लिए पंक्ति चुनें।",
      axis: ["कम", "छपी सीमा", "ज़्यादा"],
      tlK: "हर रिपोर्ट में क्या बदला",
      notCompared: "तुलना नहीं",
      baseline: (n) => `${n} नतीजे`,
      prelim: "प्रारंभिक रिपोर्ट",
      amended: "संशोधित रिपोर्ट ने प्रारंभिक की जगह ली",
      corrected: (n, a, b, u) => `${n} ${a} से सुधारकर ${b}${u ? " " + u : ""}`,
      unit: (n, a, b) => `${n} अब ${b} में (पहले ${a})`,
      flagged: (n) => `${n} नतीजे सीमा से बाहर`,
      detailK: "विवरण",
      pick: "विवरण देखने के लिए ऊपर कोई हिस्सा, पंक्ति या रिपोर्ट चुनें।",
      inSeg: (k, n) => `${n} नतीजे: ${k}`,
      openReport: "यह रिपोर्ट खोलें",
      decK: "रिकॉर्ड में फ़ैसले",
      decC: (n, m) => [String(n), `${m} में से`, "मंज़ूर"],
      lanesK: "हर फ़ैसला कहाँ लिखा गया, समय के साथ",
      lanesHint: "हर निशान एक दस्तावेज़ है। लाइन पढ़ने के लिए चुनें।",
      dec: { APPROVED: "मंज़ूर", AGREED: "तय", PROPOSED: "सिर्फ़ प्रस्ताव", OPEN: "अभी तय नहीं", "NO-RECORD": "दर्ज नहीं" },
      ask: "इसके बारे में पूछें",
      sources: "रिकॉर्ड की लाइनें, पुराने से नए",
      also: "इन रिपोर्ट्स में और लोग",
      fieldK: "हर नतीजा कहाँ है",
      fieldHint: "हर बिंदु एक टेस्ट है, उसकी अपनी छपी सीमा पर: रोशन पट्टी निचली सीमा से ऊपरी सीमा तक है। कोई बिंदु या ब्रेस चुनें।",
      reg: { below: (n) => `${n} सीमा से कम`, in: (n) => `${n} सीमा के अंदर`, above: (n) => `${n} सीमा से ज़्यादा` },
      regHint: { below: "सबसे ज़्यादा कम पहले, निचली सीमा से नापा गया।", in: "हर नतीजा अपनी सीमा में कहाँ है, किनारे के सबसे पास पहले।", above: "सबसे ज़्यादा ऊपर पहले, ऊपरी सीमा से नापा गया।" },
      margin: (p) => `नज़दीकी सीमा से सीमा का ${p}%`,
      lowLim: "निचली सीमा",
      highLim: "ऊपरी सीमा",
      noRangeList: "कोई सीमा नहीं छपी:",
      trackK: "हर फ़ैसला कहाँ तक पहुँचा",
      trackHint: "निशान वहीं रुकता है जहाँ तक दस्तावेज़ साथ देते हैं। संस्करण देखने के लिए फ़ैसला चुनें।",
      stages: ["चर्चा", "प्रस्ताव", "सहमति", "मंज़ूरी"],
      fork: "2 संस्करण दर्ज",
      lanesHint: "हर निशान एक दस्तावेज़ है। किसी भी दिन का रिकॉर्ड देखने के लिए लाइन खींचें।",
      scrub: "किस तारीख़ का रिकॉर्ड पढ़ें",
      asOf: (d) => `${d} तक रिकॉर्ड की आख़िरी लाइन`,
      nothingYet: "अभी कुछ दर्ज नहीं",
      stageK: "चार्ट विवरण",
      back: "पीछे",
      hide: "चार्ट छिपाएँ",
      showChart: "चार्ट दिखाएँ",
      trackerHint: "लाइन पर चलकर कोई भी मान छपी सीमा के मुक़ाबले पढ़ें।",
      trBelow: (x) => `सीमा से ${x} कम`,
      trAbove: (x) => `सीमा से ${x} ज़्यादा`,
      trIn: "सीमा के अंदर",
      endK: { PROPOSED: "मंज़ूरी", OPEN: "सहमति", "NO-RECORD": "हस्ताक्षरित समझौता", APPROVED: "मंज़ूर", AGREED: "तय" },
      end: { PROPOSED: "किसी दस्तावेज़ में दर्ज नहीं", OPEN: "कोई एक संस्करण तय नहीं", "NO-RECORD": "किसी दस्तावेज़ में नहीं", APPROVED: "दर्ज है", AGREED: "दर्ज है" },
    },
  };
  RW.hinglish = {
    ...RW.en,
    sev: { out: "Range se kaafi bahar", near: "Range se thoda bahar", in: "Range ke andar", none: "Range nahi chhapi" },
    donutK: "Results kahan hain",
    donutC: (n, m) => [String(n), `${m} mein se`, "range se bahar"],
    donutC0: (m) => ["0", `${m} mein se`, "range se bahar"],
    rangeK: "Har result, apni printed range par",
    rangeHint: "Khokhla dot: pichhli report. Bhara dot: latest. Detail ke liye row chuniye.",
    axis: ["kam", "printed range", "zyada"],
    tlK: "Har report mein kya badla",
    notCompared: "tulna nahi",
    detailK: "Detail",
    pick: "Detail dekhne ke liye upar koi slice, row ya report chuniye.",
    decK: "Record mein faisle",
    decC: (n, m) => [String(n), `${m} mein se`, "manzoor"],
    lanesK: "Har faisla kahan likha gaya, samay ke saath",
    ask: "Iske baare mein poochiye",
    fieldK: "Har result kahan hai",
    fieldHint: "Har dot ek test hai, apni lab ki printed range par: roshan patti low limit se high limit tak hai. Koi dot ya brace chuniye.",
    reg: { below: (n) => `${n} range se kam`, in: (n) => `${n} range ke andar`, above: (n) => `${n} range se zyada` },
    lowLim: "low limit",
    highLim: "high limit",
    trackK: "Har faisla kahan tak pahuncha",
    trackHint: "Marker wahin rukta hai jahan tak documents saath dete hain. Versions ke liye faisla chuniye.",
    lanesHint: "Har mark ek document hai. Kisi bhi din ka record dekhne ke liye line kheenchiye.",
    asOf: (d) => `${d} tak record ki aakhri line`,
    nothingYet: "abhi kuch record mein nahi",
    hide: "Chart chhupaiye",
    showChart: "Chart dikhaiye",
    trackerHint: "Line par chal kar koi bhi value printed range ke saath padhiye.",
    trBelow: (x) => `range se ${x} kam`,
    trAbove: (x) => `range se ${x} zyada`,
    trIn: "range ke andar",
  };
  const R = (lang) => RW[lang] ?? RW.en;
  const QS = {
    fee: "What is the engagement fee?",
    split: "Did they agree on the payment split?",
    deadline: "What is the deadline?",
    contract: "Is there a signed contract?",
    open: "What's still open?",
  };

  // ------------------------------------------------------------ manim-style scenes
  // The report is drawn the way Manim animates a scene: strokes are created
  // along their length, text is written, marks grow out of the point they
  // belong to, and every move follows Manim's `smooth` rate function (a
  // normalised sigmoid), handed to CSS and WAAPI as a linear() easing.
  // Deeper layers play in a stage beside the report (the right column of the
  // desk on wide screens, under the report on phones); each layer is a new
  // scene, and the mark you clicked flies across into it.
  const sig = (x) => 1 / (1 + Math.exp(-x));
  const smooth = (t) => {
    const e = sig(-5);
    return Math.min(1, Math.max(0, (sig(10 * (t - 0.5)) - e) / (1 - 2 * e)));
  };
  const SMOOTH = (() => {
    try {
      if (CSS.supports("animation-timing-function", "linear(0, 1)"))
        return `linear(${Array.from({ length: 41 }, (_, i) => +smooth(i / 40).toFixed(4)).join(", ")})`;
    } catch {}
    return "cubic-bezier(0.45, 0, 0.55, 1)";
  })();
  document.documentElement.style.setProperty("--m-smooth", SMOOTH);
  const n1 = (x) => (Math.round(x * 10) / 10).toString();
  // Manim's Brace: a curly brace under (dir 1) or over (dir -1) a span
  const bracePath = (x0, x1, y, dir = 1) => {
    const a = 5 * dir, m = (x0 + x1) / 2, q = Math.min(8, Math.abs(x1 - x0) / 4);
    return `M${n1(x0)} ${n1(y)} Q${n1(x0)} ${n1(y + a)} ${n1(x0 + q)} ${n1(y + a)} L${n1(m - q)} ${n1(y + a)} Q${n1(m)} ${n1(y + a)} ${n1(m)} ${n1(y + 2 * a)} Q${n1(m)} ${n1(y + a)} ${n1(m + q)} ${n1(y + a)} L${n1(x1 - q)} ${n1(y + a)} Q${n1(x1)} ${n1(y + a)} ${n1(x1)} ${n1(y)}`;
  };
  const niceStep = (span, n) => {
    const raw = span / n, p = 10 ** Math.floor(Math.log10(raw)), k = raw / p;
    return (k < 1.5 ? 1 : k < 3.5 ? 2 : k < 7.5 ? 5 : 10) * p;
  };
  const tickFmt = (v) => (Math.abs(v) >= 100 ? String(Math.round(v)) : String(Number(v.toPrecision(3))));
  const shortDoc = (t) => String(t ?? "").replace(/^\d+_|\.(md|pdf|docx?)$/gi, "").replace(/_/g, " ");

  // position of a value against its printed range: 0 = low limit, 1 = high
  const posOf = (h, range) => {
    const r = range ?? h?.range;
    if (!r || !Number.isFinite(r.lowN) || !Number.isFinite(r.highN) || !Number.isFinite(h?.value)) return null;
    return (h.value - r.lowN) / (r.highN - r.lowN || 1);
  };
  const regionOf = (p) => (p == null ? "none" : p < 0 ? "below" : p > 1 ? "above" : "in");

  function rangeRows(tests, w, rw, lang) {
    const D0 = -0.8, D1 = 1.8;
    const X = (p) => 8 + ((Math.max(D0, Math.min(D1, p)) - D0) / (D1 - D0)) * 284;
    const head = `<div class="rr-axis" aria-hidden="true"><span></span><svg viewBox="0 0 300 18"><rect class="rr-band" x="${X(0)}" y="2" width="${X(1) - X(0)}" height="14" fill="url(#vz-hatch)"/><text x="${(X(D0) + X(0)) / 2}" y="13" text-anchor="middle">${esc(rw.axis[0])}</text><text x="${(X(0) + X(1)) / 2}" y="13" text-anchor="middle">${esc(rw.axis[1])}</text><text x="${(X(1) + X(D1)) / 2}" y="13" text-anchor="middle">${esc(rw.axis[2])}</text></svg><span></span></div>`;
    const rows = tests
      .map((t, i) => {
        const L = t.latest;
        const sev = SEV[L.position] ?? "none";
        const pNow = posOf(L, L.range);
        const prev = (t.history ?? []).length > 1 ? t.history[t.history.length - 2] : null;
        const pPrev = prev && !t.unitChanged ? posOf(prev, L.range) : null;
        let svg = `<line class="rr-base" x1="8" y1="11" x2="292" y2="11"/><rect class="rr-band" x="${X(0)}" y="4" width="${X(1) - X(0)}" height="14" rx="2" fill="url(#vz-hatch)"/>`;
        if (pNow != null) {
          const xn = X(pNow);
          if (sev !== "in") {
            const edge = pNow < 0 ? X(0) : X(1);
            svg += `<line class="rr-gap ${sev}" x1="${edge.toFixed(1)}" y1="11" x2="${xn.toFixed(1)}" y2="11"/>`;
          }
          if (pPrev != null && Math.abs(X(pPrev) - xn) > 3) {
            const xp = X(pPrev);
            const dir = xn > xp ? -1 : 1;
            svg += `<circle class="rr-prev" cx="${xp.toFixed(1)}" cy="11" r="4"/><path class="rr-move" d="M${xp.toFixed(1)} 11 L${(xn + dir * 7).toFixed(1)} 11"/><path class="rr-head" d="M${(xn + dir * 7).toFixed(1)} 7.5 L${(xn + dir * 3).toFixed(1)} 11 L${(xn + dir * 7).toFixed(1)} 14.5"/>`;
          }
          if (pNow < D0 || pNow > D1) svg += `<text class="rr-off" x="${xn.toFixed(1)}" y="9" text-anchor="middle">${pNow < D0 ? "◀" : "▶"}</text>`;
          svg += `<circle class="rr-dot ${sev}" cx="${xn.toFixed(1)}" cy="11" r="5.5" style="--d:${120 + i * 70}ms"/>`;
        } else svg += `<text class="rr-none" x="150" y="15" text-anchor="middle">${esc(L.qual ?? w.noRange)}</text>`;
        const note = t.corrected
          ? `<em class="rr-note fix">${esc(w.corrected(t.corrected.from, t.corrected.to))}</em>`
          : t.unitChanged
            ? `<em class="rr-note unit">${esc(rw.notCompared)}: ${esc(w.units.split(",")[0])}</em>`
            : "";
        return `<button type="button" class="rr-row ${sev}" data-sel="test:${esc(t.key)}" style="--i:${i}" aria-label="${esc(`${t.name} ${L.raw}${t.unit ? " " + t.unit : ""}, ${posWord(L.position, w)}`)}">
          <span class="rr-name"><b>${esc(t.name)}</b>${note}</span>
          <svg class="rr-svg" viewBox="0 0 300 22" aria-hidden="true">${svg}</svg>
          <span class="rr-val"><b>${esc(L.raw)}</b> <small>${esc(t.unit ?? "")}</small><i>${esc(L.range?.low != null ? `${L.range.low}–${L.range.high}` : "")}</i></span>
        </button>`;
      })
      .join("");
    return `<section class="rp-card"><header class="rp-h"><h4>${esc(rw.rangeK)}</h4><p>${esc(rw.rangeHint)}</p></header>${head}<div class="rr-rows">${rows}</div></section>`;
  }

  function reportEvents(subject, rw) {
    const reps = subject.reports ?? [];
    const out = [];
    reps.forEach((r, i) => {
      const items = [];
      if (i === 0) items.push({ kind: "base", text: rw.baseline(subject.tests.length) });
      if (r.status === "preliminary") items.push({ kind: "pre", text: rw.prelim });
      if (r.status === "amended") {
        items.push({ kind: "amd", text: rw.amended });
        for (const t of subject.tests.filter((x) => x.corrected))
          items.push({ kind: "fix", text: rw.corrected(t.name, t.corrected.from, t.corrected.to, t.unit), key: t.key });
      }
      for (const t of subject.tests.filter((x) => x.unitChanged)) {
        const hs = t.history ?? [];
        const k = hs.findIndex((h, j) => j && h.unit !== hs[j - 1].unit);
        if (k > 0 && hs[k].title === r.title)
          items.push({ kind: "unit", text: rw.unit(t.name, hs[k - 1].unit, hs[k].unit), key: t.key });
      }
      if (i === reps.length - 1) {
        const n = subject.tests.filter((t) => /below|above|qual_differs/.test(t.latest.position)).length;
        if (n) items.push({ kind: "flag", text: rw.flagged(n) });
      }
      out.push({ report: r, items });
    });
    return out;
  }


  // 1. Every result on ONE normalised number line: the lab's printed range
  //    is the lit interval (its left edge is the low limit, its right edge
  //    the high limit), so results from different tests and units can sit
  //    side by side without ever being compared to each other.
  function rangeField(subject, rw, w) {
    const L0 = 26, L1 = 474, D0 = -1, D1 = 2;
    const X = (p) => L0 + ((Math.max(D0, Math.min(D1, p)) - D0) / (D1 - D0)) * (L1 - L0);
    const pts = subject.tests
      .map((t) => ({ t, p: posOf(t.latest, t.latest.range), sev: SEV[t.latest.position] ?? "none" }))
      .filter((d) => d.p != null)
      .sort((a, b) => a.p - b.p);
    const none = subject.tests.filter((t) => posOf(t.latest, t.latest.range) == null);
    const placed = [];
    for (const d of pts) {
      d.x = X(d.p);
      let lv = 0;
      while (placed.some((o) => o.lv === lv && Math.abs(o.x - d.x) < 92)) lv++;
      d.lv = lv;
      placed.push(d);
    }
    const maxLv = placed.reduce((m, d) => Math.max(m, d.lv), 0);
    const AX = 56 + maxLv * 28;
    const H = AX + 66;
    const reg = { below: [], in: [], above: [] };
    for (const d of pts) reg[regionOf(d.p)].push(d);
    const x0 = X(0), x1 = X(1);
    const ticks = [-1, -0.5, 0, 0.5, 1, 1.5, 2]
      .map((p, i) => `<line class="m-tick${p === 0 || p === 1 ? " big" : ""}" pathLength="1" x1="${n1(X(p))}" y1="${AX - (p === 0 || p === 1 ? 7 : 4)}" x2="${n1(X(p))}" y2="${AX + (p === 0 || p === 1 ? 7 : 4)}" style="--d:${300 + i * 50}ms"/>`)
      .join("");
    const braces = [
      ["below", L0, x0 - 5, rw.reg.below(reg.below.length)],
      ["in", x0 + 3, x1 - 3, rw.reg.in(reg.in.length)],
      ["above", x1 + 5, L1, rw.reg.above(reg.above.length)],
    ]
      .filter(([k]) => k === "in" || reg[k].length)
      .map(([k, a, b, label], i) => `<g class="m-brace ${k}" data-sel="reg:${k}" tabindex="0" role="button" aria-label="${esc(label)}"><path class="m-create" pathLength="1" d="${bracePath(a, b, AX + 22, 1)}" style="--d:${900 + i * 160}ms"/><text class="m-write" x="${n1((a + b) / 2)}" y="${AX + 50}" text-anchor="middle" style="--d:${1050 + i * 160}ms">${esc(label)}</text></g>`)
      .join("");
    const dots = pts
      .map((d, i) => {
        const y = AX - 20 - d.lv * 28;
        const right = d.x < L1 - 96;
        const off = d.p < D0 || d.p > D1;
        return `<g class="m-dot ${d.sev}" data-sel="test:${esc(d.t.key)}" tabindex="0" role="button" style="--d:${1300 + i * 110}ms;--fy:${AX - y}px" aria-label="${esc(`${d.t.name} ${d.t.latest.raw}${d.t.unit ? " " + d.t.unit : ""}, ${posWord(d.t.latest.position, w)}`)}">
          <line class="m-stem" x1="${n1(d.x)}" y1="${AX}" x2="${n1(d.x)}" y2="${y}"/>
          <circle class="m-hit" cx="${n1(d.x)}" cy="${y}" r="15"/>
          <circle class="m-c" cx="${n1(d.x)}" cy="${y}" r="6.5"/>
          ${off ? `<text class="m-off" x="${n1(d.x + (d.p < D0 ? -11 : 11))}" y="${y + 3.5}" text-anchor="middle">${d.p < D0 ? "◀" : "▶"}</text>` : ""}
          <text class="m-lbl" x="${n1(d.x + (right ? 11 : -11))}" y="${y + 4}" text-anchor="${right ? "start" : "end"}">${esc(d.t.name)} <tspan>${esc(d.t.latest.raw)}</tspan></text>
        </g>`;
      })
      .join("");
    const svg = `<svg class="m-field" viewBox="0 0 500 ${H}" role="group" aria-label="${esc(rw.fieldK)}">
      <rect class="m-band m-grow-y" x="${n1(x0)}" y="10" width="${n1(x1 - x0)}" height="${AX - 10}" style="--d:500ms"/>
      <line class="m-edge m-create" pathLength="1" x1="${n1(x0)}" y1="10" x2="${n1(x0)}" y2="${AX}" style="--d:620ms"/>
      <line class="m-edge m-create" pathLength="1" x1="${n1(x1)}" y1="10" x2="${n1(x1)}" y2="${AX}" style="--d:620ms"/>
      <line class="m-axis m-create" pathLength="1" x1="${L0}" y1="${AX}" x2="${L1}" y2="${AX}" style="--d:0ms"/>
      <g class="m-ticks">${ticks}</g>
      <text class="m-lim m-write" x="${n1(x0)}" y="${AX + 17}" text-anchor="middle" style="--d:700ms">${esc(rw.lowLim)}</text>
      <text class="m-lim m-write" x="${n1(x1)}" y="${AX + 17}" text-anchor="middle" style="--d:760ms">${esc(rw.highLim)}</text>
      ${braces}${dots}
    </svg>`;
    return `<section class="rp-card m-card"><header class="rp-h"><h4>${esc(rw.fieldK)}</h4><p>${esc(rw.fieldHint)}</p></header>${svg}${none.length ? `<p class="m-none">${esc(rw.noRangeList)} ${none.map((t) => `<button type="button" class="m-chip" data-sel="test:${esc(t.key)}">${esc(t.name)}</button>`).join(" ")}</p>` : ""}</section>`;
  }

  // Records 1. How far each decision got: Discussed -> Proposed -> Agreed ->
  // Approved. The marker travels to the furthest stage the record supports
  // and stops there; what the record never says stays dashed.
  const STAGE_OF = { "NO-RECORD": -1, OPEN: 0, PROPOSED: 1, AGREED: 2, APPROVED: 3 };
  function decisionTrack(v, rw) {
    const N0 = 170, N3 = 476, RH = 54, TOP = 34;
    const NX = (k) => N0 + (k / 3) * (N3 - N0);
    const H = TOP + v.rows.length * RH;
    const head = rw.stages
      .map((s, k) => `<text class="m-stage m-write" x="${n1(NX(k))}" y="16" text-anchor="middle" style="--d:${k * 90}ms">${esc(s)}</text>`)
      .join("");
    const rows = v.rows
      .map((r, i) => {
        const [tone] = STAMP[r.verdict] ?? ["warn"];
        const k = STAGE_OF[r.verdict] ?? 0;
        const y = TOP + i * RH + 18;
        const fig = keyFigure(r.text).replace(/\s*<s-or>or<\/s-or>\s*/, " or ");
        const nodes = [0, 1, 2, 3]
          .map((j) => `<circle class="m-node${j <= k ? " on " + tone : ""}" cx="${n1(NX(j))}" cy="${y}" r="4.5" style="--d:${200 + i * 140 + j * 60}ms"/>`)
          .join("");
        const d0 = 200 + i * 140;
        const reach = k >= 0
          ? `<line class="m-reach ${tone} m-create" pathLength="1" x1="${N0}" y1="${y}" x2="${n1(NX(Math.max(k, 0)))}" y2="${y}" style="--d:${d0 + 250}ms"/>
             <g class="m-marker ${tone}" style="--d:${d0 + 250}ms;--mx:${n1(NX(Math.max(k, 0)) - N0)}px"><circle cx="${N0}" cy="${y}" r="9"/><circle class="m-ring" cx="${N0}" cy="${y}" r="13"/></g>`
          : `<g class="m-x m-write" style="--d:${d0 + 250}ms"><path d="M${N0 - 6} ${y - 6} l12 12 M${N0 + 6} ${y - 6} l-12 12"/></g>`;
        const figX = k >= 0 ? NX(Math.max(k, 0)) : N0;
        return `<g class="m-trow" data-sel="rec:${esc(r.id)}" tabindex="0" role="button" aria-label="${esc(`${r.label}: ${rw.dec[r.verdict] ?? r.verdict}`)}">
          <rect class="m-hitrow" x="0" y="${y - 22}" width="500" height="${RH - 4}" rx="8"/>
          <text class="m-rlabel m-write" x="8" y="${y - 2}" style="--d:${d0}ms">${esc(r.label)}</text>
          <text class="m-rstat ${tone} m-write" x="8" y="${y + 14}" style="--d:${d0 + 80}ms">${esc(rw.dec[r.verdict] ?? r.verdict)}</text>
          <line class="m-rail" x1="${N0}" y1="${y}" x2="${N3}" y2="${y}"/>
          ${nodes}${reach}
          ${fig && fig !== "None" ? `<text class="m-fig m-write" x="${n1(figX)}" y="${y - 15}" text-anchor="${figX > 430 ? "end" : "middle"}" style="--d:${d0 + 900}ms">${esc(fig)}</text>` : ""}
          ${r.verdict === "OPEN" ? `<text class="m-fork m-write" x="${n1(NX(0) + 16)}" y="${y + 16}" style="--d:${d0 + 900}ms">${esc(rw.fork)}</text>` : ""}
        </g>`;
      })
      .join("");
    return `<section class="rp-card m-card"><header class="rp-h"><h4>${esc(rw.trackK)}</h4><p>${esc(rw.trackHint)}</p></header><svg class="m-track" viewBox="0 0 500 ${H}" role="group" aria-label="${esc(rw.trackK)}">${head}${rows}</svg></section>`;
  }

  // Figures inside a quoted line: money, splits, dates. Used to read the
  // record "as of" a date, and to mark what changed between versions.
  const MONTHS_RE = "January|February|March|April|May|June|July|August|September|October|November|December";
  const kindOf = (fig) => (/\$\d/.test(fig) ? "money" : /\d+\/\d+/.test(fig) ? "split" : /\b\d{1,2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)/.test(fig) ? "date" : "");
  const figOf = (q, kind = "") => {
    const s = String(q ?? "");
    const all = {
      money: [...s.matchAll(/\$\d{1,3}(?:,\d{3})*(?:\.\d+)?/g)].map((m) => m[0]),
      split: [...[...s.matchAll(/(\d{1,2})%[^.%;]{0,40}?(\d{1,2})%/g)].map((m) => `${m[1]}/${m[2]}`), ...[...s.matchAll(/\b(\d{1,2}\/\d{1,2})\b/g)].map((m) => m[1])],
      date: [...s.matchAll(new RegExp(`\\b(\\d{1,2}) (${MONTHS_RE})`, "g"))].map((m) => `${m[1]} ${m[2].slice(0, 3)}`),
    };
    for (const k of kind ? [kind] : ["money", "split", "date"]) {
      const xs = [...new Set(all[k])];
      if (!xs.length) continue;
      return xs.length > 1 && /\bvs\b|versus|\bor\b/i.test(s) ? xs.slice(0, 2).join(" vs ") : xs[0];
    }
    if (kind) return "";
    const ex = s.replace(/^\d+\.\s*/, "").split(/[;:.(]/)[0].trim();
    return ex.length > 38 ? ex.slice(0, 36).trimEnd() + "…" : ex;
  };
  const markFigs = (escaped) =>
    escaped.replace(new RegExp(`(\\$\\d{1,3}(?:,\\d{3})*(?:\\.\\d+)?|\\d{1,2}%|\\b\\d{1,2}/\\d{1,2}\\b|\\b\\d{1,2} (?:${MONTHS_RE})(?: \\d{4})?)`, "g"), "<mark>$1</mark>");

  // Records 2. Where each decision was written, with a playhead that sweeps
  // the dates once and can then be dragged: the readout lists the latest
  // line on record for every topic as of that day.
  function lanes(v, rw, lang) {
    const docs = (v.documents ?? []).filter((d) => d.date).sort((a, b) => a.date.localeCompare(b.date));
    if (!docs.length) return "";
    const t0 = Date.parse(docs[0].date), t1 = Date.parse(docs.at(-1).date);
    const P = (d) => 3 + (t1 > t0 ? (Date.parse(d) - t0) / (t1 - t0) : 0.5) * 94;
    const keys = v.rows
      .map((r, i) => {
        const [tone] = STAMP[r.verdict] ?? ["warn"];
        return `<button type="button" class="ln-k" data-sel="rec:${esc(r.id)}" style="--i:${i}"><b>${esc(r.label)}</b><span class="vz-stamp ${tone}">${esc(rw.dec[r.verdict] ?? r.verdict)}</span></button>`;
      })
      .join("");
    const tracks = v.rows
      .map((r, i) => {
        const [tone] = STAMP[r.verdict] ?? ["warn"];
        const titles = [...new Set((r.sources ?? []).map((x) => x.title))];
        const mine = docs.filter((d) => titles.includes(d.title));
        const first = mine.length ? P(mine[0].date) : 3;
        const marks = mine
          .map((d) => `<button type="button" class="ln-mark ${tone}" style="left:${P(d.date).toFixed(1)}%" data-t="${Date.parse(d.date)}" data-sel="rec:${esc(r.id)}" title="${esc(`${shortDoc(d.title)} · ${shortDate(d.date, lang)}`)}" aria-label="${esc(`${r.label}: ${shortDoc(d.title)}, ${shortDate(d.date, lang)}`)}"></button>`)
          .join("");
        return `<div class="ln-track" style="--i:${i}"><span class="ln-line ${tone}" style="left:${first.toFixed(1)}%"></span>${marks}</div>`;
      })
      .join("");
    const axis = docs.map((d, i) => `<span class="${i && P(d.date) - P(docs[i - 1].date) < 7 ? "tight" : ""}" style="left:${P(d.date).toFixed(1)}%">${esc(shortDate(d.date, lang))}</span>`).join("");
    return `<section class="rp-card m-card"><header class="rp-h"><h4>${esc(rw.lanesK)}</h4><p>${esc(rw.lanesHint)}</p></header>
      <div class="ln"><div class="ln-keys">${keys}</div><div class="ln-field" data-t0="${t0}" data-t1="${t1}">${tracks}<div class="ln-ticks">${axis}</div>
        <div class="ln-play" role="slider" tabindex="0" aria-label="${esc(rw.scrub)}" aria-valuemin="${t0}" aria-valuemax="${t1}" aria-valuenow="${t1}"><i></i><b></b></div></div></div>
      <div class="ln-asof" aria-live="polite"></div></section>`;
  }
  function asOf(board, t) {
    const rep = REPORTS.get(board.dataset.rep);
    if (!rep || rep.v.kind !== "records") return;
    const v = rep.v, rw = R(rep.lang);
    const docs = new Map((v.documents ?? []).map((d) => [d.title, d]));
    const field = board.querySelector(".ln-field");
    const t0 = Number(field.dataset.t0), t1 = Number(field.dataset.t1);
    const k = t1 > t0 ? (t - t0) / (t1 - t0) : 1;
    const play = field.querySelector(".ln-play");
    play.style.left = `${(3 + Math.max(0, Math.min(1, k)) * 94).toFixed(2)}%`;
    const day = new Date(t).toISOString().slice(0, 10);
    play.querySelector("b").textContent = shortDate(day, rep.lang);
    play.setAttribute("aria-valuenow", String(Math.round(t)));
    play.setAttribute("aria-valuetext", shortDate(day, rep.lang));
    field.querySelectorAll(".ln-mark").forEach((m) => m.classList.toggle("lit", Number(m.dataset.t) <= t + 1));
    const lines = v.rows.map((r) => {
      const seen = (r.sources ?? [])
        .map((s) => ({ ...s, date: docs.get(s.title)?.date }))
        .filter((s) => s.date && Date.parse(s.date) <= t + 1)
        .sort((a, b) => a.date.localeCompare(b.date));
      const last = seen.at(-1);
      const kind = kindOf(keyFigure(r.text));
      const fig = last ? figOf(last.quote, kind) || figOf(last.quote.replace(/\$\d[\d,]*|\d{1,2}%/g, ""), "") : "";
      return `<li data-sel="rec:${esc(r.id)}" role="button" tabindex="0"><b>${esc(r.label)}</b>${last ? `<span class="ao-fig${kind ? "" : " ao-txt"}">${esc(fig)}</span><em>${esc(shortDoc(last.title))} · ${esc(shortDate(last.date, rep.lang))}</em>` : `<span class="ao-none">${esc(rw.nothingYet)}</span>`}</li>`;
    });
    board.querySelector(".ln-asof").innerHTML = `<p>${esc(rw.asOf(shortDate(day, rep.lang)))}</p><ul>${lines.join("")}</ul>`;
  }
  function mountLanes(board) {
    const field = board.querySelector(".ln-field");
    if (!field) return;
    const t0 = Number(field.dataset.t0), t1 = Number(field.dataset.t1);
    const play = field.querySelector(".ln-play");
    const marks = [...field.querySelectorAll(".ln-mark")].map((m) => Number(m.dataset.t));
    const stops = [...new Set(marks)].sort((a, b) => a - b);
    let raf = 0;
    const at = (clientX) => {
      const r = field.getBoundingClientRect();
      const k = Math.max(0, Math.min(1, ((clientX - r.left) / r.width - 0.03) / 0.94));
      return t0 + k * (t1 - t0);
    };
    const sweep = () => {
      if (reduced) return asOf(board, t1);
      const T = 2600, s0 = performance.now();
      const step = (now) => {
        if (!board.isConnected) return;
        const k = Math.min(1, (now - s0) / T);
        asOf(board, t0 + smooth(k) * (t1 - t0));
        if (k < 1) raf = requestAnimationFrame(step);
      };
      raf = requestAnimationFrame(step);
    };
    let drag = false;
    field.addEventListener("pointerdown", (e) => {
      if (e.target.closest(".ln-mark")) return;
      cancelAnimationFrame(raf);
      drag = true;
      field.setPointerCapture?.(e.pointerId);
      asOf(board, at(e.clientX));
    });
    field.addEventListener("pointermove", (e) => drag && asOf(board, at(e.clientX)));
    field.addEventListener("pointerup", () => (drag = false));
    field.addEventListener("pointercancel", () => (drag = false));
    play.addEventListener("keydown", (e) => {
      const now = Number(play.getAttribute("aria-valuenow"));
      let t = null;
      if (e.key === "ArrowRight" || e.key === "ArrowUp") t = stops.find((s) => s > now + 1) ?? t1;
      if (e.key === "ArrowLeft" || e.key === "ArrowDown") t = [...stops].reverse().find((s) => s < now - 1) ?? t0;
      if (e.key === "Home") t = t0;
      if (e.key === "End") t = t1;
      if (t == null) return;
      e.preventDefault();
      cancelAnimationFrame(raf);
      asOf(board, t);
    });
    // sweep once, when the chart is first on screen
    const io = new IntersectionObserver((es) => {
      if (!es.some((x) => x.isIntersecting)) return;
      io.disconnect();
      sweep();
    }, { threshold: 0.35 });
    asOf(board, t0);
    io.observe(field);
  }

  // Labs 3. Report dates on a number line; each node lists what it changed.
  function timelineCard(subject, rw, lang, w) {
    const ev = reportEvents(subject, rw);
    if (ev.length < 2) return "";
    const nodes = ev
      .map(
        (e, i) => `<li class="tl-node st-${esc(e.report.status)}" style="--i:${i}">
          <button type="button" class="tl-dot" data-sel="ev:${i}" aria-label="${esc(`${shortDate(e.report.date, lang)}, ${e.report.status}`)}"><i></i></button>
          <span class="tl-date">${esc(shortDate(e.report.reported ?? e.report.date, lang))}</span>
          <span class="tl-st">${esc(w["st_" + e.report.status] ?? e.report.status)}</span>
          <ul>${e.items.map((x) => `<li class="tl-it ${x.kind}"${x.key ? ` data-sel="test:${esc(x.key)}" role="button" tabindex="0"` : ""}>${esc(x.text)}</li>`).join("")}</ul>
        </li>`,
      )
      .join("");
    return `<section class="rp-card m-card"><header class="rp-h"><h4>${esc(rw.tlK)}</h4></header><ol class="tl">${nodes}</ol></section>`;
  }

  // ------------------------------------------------------------ the stage
  // One deeper layer at a time. A test plays as a number line in its own
  // units with the printed range braced, every reading placed on it, a
  // correction transformed from the old figure into the new one, and a
  // value tracker under the pointer. A decision plays as a version ladder.
  function axisModel(items, range) {
    const nums = items.map((h) => h.value).filter(Number.isFinite);
    const ghosts = items.flatMap((h) => (h.superseded ?? []).map((g) => Number(g.raw))).filter(Number.isFinite);
    const bounds = [...nums, ...ghosts, range?.lowN, range?.highN].filter(Number.isFinite);
    if (!bounds.length) return null;
    const minB = Math.min(...bounds), maxB = Math.max(...bounds);
    const log = minB > 0 && maxB / minB >= 20;
    const f = log ? Math.log10 : (x) => x;
    let lo = f(minB), hi = f(maxB);
    const pad = (hi - lo || Math.abs(hi) || 1) * 0.14;
    lo -= pad;
    hi += pad;
    if (!log && minB >= 0 && lo < 0) lo = 0;
    return { log, lo, hi, f, inv: log ? (u) => 10 ** u : (u) => u };
  }
  function numberLineScene(t, items, range, unit, lang, w, opts = {}) {
    const m = axisModel(items, range);
    if (!m) return "";
    const L0 = 40, L1 = 540, AX = opts.compact ? 64 : 110, TOPB = opts.compact ? 26 : 50, BOTB = opts.compact ? 98 : 150;
    const H = opts.compact ? 132 : 200;
    const X = (v) => L0 + ((m.f(v) - m.lo) / (m.hi - m.lo || 1)) * (L1 - L0);
    let ticks = [];
    if (m.log) {
      for (let e = Math.floor(m.lo); e <= Math.ceil(m.hi); e++) for (const k of [1, 2, 5]) { const val = k * 10 ** e; const u = Math.log10(val); if (u >= m.lo && u <= m.hi) ticks.push(val); }
    } else {
      const st = niceStep(m.hi - m.lo, 5);
      for (let val = Math.ceil(m.lo / st) * st; val <= m.hi + 1e-9; val += st) ticks.push(Number(val.toPrecision(10)));
    }
    if (ticks.length > 9) ticks = ticks.filter((_, i) => i % 2 === 0);
    const tk = ticks
      .map((val, i) => `<line class="m-tick" pathLength="1" x1="${n1(X(val))}" y1="${AX - 4}" x2="${n1(X(val))}" y2="${AX + 4}" style="--d:${250 + i * 40}ms"/><text class="m-tl m-write" x="${n1(X(val))}" y="${AX + 20}" text-anchor="middle" style="--d:${300 + i * 40}ms">${esc(tickFmt(val))}</text>`)
      .join("");
    const hasR = range && Number.isFinite(range.lowN) && Number.isFinite(range.highN);
    const rx0 = hasR ? X(range.lowN) : 0, rx1 = hasR ? X(range.highN) : 0;
    const band = hasR
      ? `<rect class="m-band m-grow-x" x="${n1(rx0)}" y="${TOPB}" width="${n1(Math.max(2, rx1 - rx0))}" height="${BOTB - TOPB}" style="--d:450ms"/>
         <path class="m-brace-p m-create" pathLength="1" d="${bracePath(rx0, rx1, TOPB - 4, -1)}" style="--d:700ms"/>
         <text class="m-blabel m-write" x="${n1(Math.min(L1, Math.max(L0, (rx0 + rx1) / 2)))}" y="${TOPB - 20}" text-anchor="middle" style="--d:820ms">${esc(`${w.range} ${range.low ?? tickFmt(range.lowN)}–${range.high ?? tickFmt(range.highN)}${unit ? " " + unit : ""}`)}</text>`
      : "";
    const pts = items.filter((h) => Number.isFinite(h.value)).map((h) => ({ h, x: X(h.value) }));
    let prevDateX = -999, lvl = 0;
    const dots = pts
      .map((p, i) => {
        const last = i === pts.length - 1;
        if (Math.abs(p.x - prevDateX) < 56) lvl = 1 - lvl;
        else lvl = 0;
        prevDateX = p.x;
        const dl = opts.compact ? "" : `<text class="m-date m-write" x="${n1(p.x)}" y="${BOTB + 18 + lvl * 15}" text-anchor="middle" style="--d:${1000 + i * 180}ms">${esc(shortDate(p.h.date, lang))}</text>`;
        const bound = p.h.comparator ? `<path class="m-bound" d="M${n1(p.x - 9)} ${AX} h-14 m5 -4 l-5 4 l5 4"/>` : "";
        return `<g class="m-pt st-${esc(p.h.status)}${last ? " now" : ""}" ${last ? "data-focus" : ""} tabindex="0" role="button" ${p.h.title ? `data-doc="${esc(p.h.title)}"` : ""} style="--d:${950 + i * 180}ms" aria-label="${esc(`${p.h.raw}${unit ? " " + unit : ""}, ${shortDate(p.h.date, lang)}, ${p.h.status}`)}">
          ${last ? `<circle class="m-flash" cx="${n1(p.x)}" cy="${AX}" r="7"/>` : ""}
          <circle class="m-c" cx="${n1(p.x)}" cy="${AX}" r="${last ? 7.5 : 6}"/>${bound}
          <text class="m-v" x="${n1(p.x)}" y="${AX - 15}" text-anchor="middle">${esc(p.h.raw)}</text>${dl}
        </g>`;
      })
      .join("");
    // a correction: the struck figure is transformed into the corrected one
    const fixes = pts
      .flatMap((p) => (p.h.superseded ?? []).map((g) => ({ p, g, gx: X(Number(g.raw)) })))
      .filter((o) => Number.isFinite(o.gx))
      .map((o, i) => `<g class="m-ghost"><circle cx="${n1(o.gx)}" cy="${AX}" r="6"/><line x1="${n1(o.gx - 8)}" y1="${AX - 8}" x2="${n1(o.gx + 8)}" y2="${AX + 8}"/><text class="m-gv" x="${n1(o.gx)}" y="${AX - 15}" text-anchor="middle">${esc(o.g.raw)}</text></g>
        <path class="m-arc fix m-create" pathLength="1" d="M${n1(o.gx)} ${AX - 26} Q${n1((o.gx + o.p.x) / 2)} ${AX - 62} ${n1(o.p.x)} ${AX - 28}" style="--d:${1500 + i * 200}ms"/>
        <text class="m-xfer" x="${n1(o.gx)}" y="${AX - 15}" text-anchor="middle" style="--d:${1500 + i * 200}ms;--tx:${n1(o.p.x - o.gx)}px">${esc(o.g.raw)}</text>`)
      .join("");
    // movement since the previous comparable reading
    let move = "";
    if (!opts.noMove && pts.length > 1 && t.insight?.change) {
      const a = pts[pts.length - 2], b = pts[pts.length - 1];
      if (Math.abs(b.x - a.x) > 10) {
        const c = t.insight.change;
        const peak = AX - (opts.compact ? 40 : 58);
        move = `<path class="m-arc m-create" pathLength="1" d="M${n1(a.x)} ${AX - 10} Q${n1((a.x + b.x) / 2)} ${peak} ${n1(b.x)} ${AX - 10}" style="--d:1350ms" marker-end="url(#m-tip)"/>
          <text class="m-delta m-write" x="${n1((a.x + b.x) / 2)}" y="${peak + 18}" text-anchor="middle" style="--d:1600ms">${esc(signed(c.abs))}${c.pct != null && Math.abs(c.pct) < 300 ? ` (${esc(signed(c.pct))}%)` : ""}</text>`;
      }
    }
    const scale = m.log ? `<text class="m-scale" x="${L1}" y="${H - 4}" text-anchor="end">log scale</text>` : "";
    return `<svg class="m-nl" viewBox="0 0 580 ${H}" role="img" tabindex="0" data-lo="${m.lo}" data-hi="${m.hi}" data-log="${m.log ? 1 : 0}" data-l0="${L0}" data-l1="${L1}" data-ax="${AX}" data-unit="${esc(unit ?? "")}" ${hasR ? `data-rlo="${range.lowN}" data-rhi="${range.highN}"` : ""} aria-label="${esc(`${t.name}: ${items.map((h) => h.raw).join(", ")}`)}">
      <defs><marker id="m-tip" viewBox="0 0 10 10" refX="7" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 1 L8 5 L0 9" class="m-tipp"/></marker></defs>
      ${band}<line class="m-axis m-create" pathLength="1" x1="${L0 - 14}" y1="${AX}" x2="${L1 + 14}" y2="${AX}" style="--d:0ms"/>${tk}
      ${fixes}${move}${dots}${scale}
      <g class="m-tracker" aria-hidden="true"><line class="m-tr-l" x1="0" y1="${TOPB - 2}" x2="0" y2="${BOTB + 2}"/><circle class="m-tr-c" cx="0" cy="${AX}" r="4"/><rect class="m-tr-bg" x="-58" y="${BOTB + 4}" width="116" height="34" rx="6"/><text class="m-tr-v" x="0" y="${BOTB + 18}" text-anchor="middle"></text><text class="m-tr-p" x="0" y="${BOTB + 32}" text-anchor="middle"></text></g>
    </svg>`;
  }

  function sceneTest(t, lang) {
    const w = W(lang), rw = R(lang);
    const hs = t.history ?? [];
    const units = [...new Set(hs.map((h) => h.unit ?? t.unit ?? ""))];
    let chart;
    if (units.length > 1) {
      const segs = units.map((u) => hs.filter((h) => (h.unit ?? t.unit ?? "") === u));
      chart = segs
        .map((items, i) => {
          const last = items.at(-1);
          const range = i === segs.length - 1 ? t.latest.range : last?.range ? { lowN: last.range.lowN, highN: last.range.highN } : null;
          return `<div class="m-seg"><p class="m-unit">${esc(units[i])}</p>${numberLineScene(t, items, range, units[i], lang, w, { compact: true, noMove: true })}</div>`;
        })
        .join(`<p class="m-neq" aria-label="${esc(w.nc.unit)}"><b>≠</b><span>${esc(w.nc.unit)}</span></p>`);
    } else chart = numberLineScene(t, hs.length ? hs : [t.latest], t.latest.range, t.unit, lang, w);
    return {
      label: t.name,
      html: `<header class="st-h"><h3 class="st-title"><span class="m-tw">${esc(t.name)}</span></h3><p class="st-sub">${esc(posWord(t.latest.position, w))} · ${esc(t.latest.raw)}${t.unit ? " " + esc(t.unit) : ""} · ${esc(shortDate(t.latest.date, lang))}</p></header>
        <div class="st-chart">${chart}</div><p class="st-tip">${esc(rw.trackerHint)}</p>
        <div class="st-drill">${drill(t, lang)}</div>`,
    };
  }

  function sceneRegion(subject, key, lang) {
    const w = W(lang), rw = R(lang);
    const ds = subject.tests
      .map((t) => ({ t, p: posOf(t.latest, t.latest.range) }))
      .filter((d) => regionOf(d.p) === key)
      .map((d) => ({ ...d, by: key === "below" ? -d.p : key === "above" ? d.p - 1 : Math.min(d.p, 1 - d.p) }))
      .sort((a, b) => (key === "in" ? a.by - b.by : b.by - a.by));
    const max = Math.max(0.05, ...ds.map((d) => d.by));
    const rows = ds
      .map((d, i) => {
        const len = key === "in" ? d.p * 100 : (d.by / max) * 100;
        const txt = key === "in" ? rw.margin(Math.round(d.by * 100)) : d.t.insight?.distance ? w.by(fmt(d.t.insight.distance.by), d.t.insight.distance.side, d.t.insight.distance.bound) : "";
        return `<button type="button" class="m-bar ${key}" data-sel="test:${esc(d.t.key)}" style="--i:${i}"><b>${esc(d.t.name)}</b><span class="m-bar-t"><i style="--w:${Math.max(2, len).toFixed(1)}%"></i>${key === "in" ? `<em style="left:${len.toFixed(1)}%"></em>` : ""}</span><span class="m-bar-v">${esc(d.t.latest.raw)} ${esc(d.t.unit ?? "")}<small>${esc(txt)}</small></span></button>`;
      })
      .join("");
    return {
      label: rw.reg[key](ds.length),
      html: `<header class="st-h"><h3 class="st-title"><span class="m-tw">${esc(rw.reg[key](ds.length))}</span></h3><p class="st-sub">${esc(rw.regHint[key])}</p></header><div class="m-bars">${rows || `<p class="rp-pick">${esc(rw.pick)}</p>`}</div>`,
    };
  }

  function sceneEvent(subject, i, lang) {
    const rw = R(lang), w = W(lang);
    const e = reportEvents(subject, rw)[i];
    if (!e) return null;
    const label = `${shortDate(e.report.reported ?? e.report.date, lang)} · ${w["st_" + e.report.status] ?? e.report.status}`;
    const items = e.items
      .map((x, k) => {
        const t = x.key ? subject.tests.find((y) => y.key === x.key) : null;
        let glyph = "";
        if (x.kind === "fix" && t?.corrected) glyph = `<span class="m-xf"><s>${esc(t.corrected.from)}</s><i>→</i><b>${esc(t.corrected.to)}</b></span>`;
        if (x.kind === "unit" && t) {
          const hs = t.history ?? [];
          const j = hs.findIndex((h, n) => n && h.unit !== hs[n - 1].unit);
          if (j > 0) glyph = `<span class="m-xf unit"><b>${esc(hs[j - 1].unit)}</b><i>≠</i><b>${esc(hs[j].unit)}</b></span>`;
        }
        return `<li class="m-ev ${x.kind}" style="--i:${k}"${x.key ? ` data-sel="test:${esc(x.key)}" role="button" tabindex="0"` : ""}>${glyph}<span>${esc(x.text)}</span></li>`;
      })
      .join("");
    return {
      label,
      html: `<header class="st-h"><h3 class="st-title"><span class="m-tw">${esc(label)}</span></h3><p class="st-sub">${esc(shortDoc(e.report.title))}</p></header><ol class="m-evs">${items}</ol><button type="button" class="dd-src" data-doc="${esc(e.report.title)}"><span class="dd-src-d">${esc(shortDate(e.report.date, lang))}</span><b>${esc(shortDoc(e.report.title))}</b><span class="dd-go">${esc(rw.openReport)} →</span></button>`,
    };
  }

  function sceneDecision(v, r, lang) {
    const rw = R(lang);
    const [tone] = STAMP[r.verdict] ?? ["warn"];
    const docs = new Map((v.documents ?? []).map((d) => [d.title, d]));
    const byDoc = new Map();
    for (const s of r.sources ?? []) {
      const d = docs.get(s.title);
      if (!byDoc.has(s.title)) byDoc.set(s.title, { title: s.title, date: d?.date ?? "", type: d?.type ?? "", quotes: [] });
      const q = String(s.quote).replace(/^\d+\.\s*/, "");
      if (!byDoc.get(s.title).quotes.includes(q)) byDoc.get(s.title).quotes.push(q);
    }
    const nodes = [...byDoc.values()].sort((a, b) => String(a.date).localeCompare(String(b.date)));
    const kind = kindOf(keyFigure(r.text));
    let prev = "";
    const steps = nodes
      .map((n, i) => {
        const fig = kind ? (n.quotes.map((q) => figOf(q, kind)).find(Boolean) ?? "") : "";
        // a later figure replaces an earlier one only when the topic was
        // revised; for an open topic the two stand side by side
        const xf = fig && prev && fig !== prev && !/ vs /.test(fig)
          ? r.verdict === "OPEN"
            ? `<span class="m-xf unit"><b>${esc(prev)}</b><i>≠</i><b>${esc(fig)}</b></span>`
            : `<span class="m-xf"><s>${esc(prev)}</s><i>→</i><b>${esc(fig)}</b></span>`
          : "";
        if (fig && !/ vs /.test(fig)) prev = fig;
        return `<li class="vl-n" style="--i:${i}" data-doc="${esc(n.title)}" role="button" tabindex="0" ${i === nodes.length - 1 ? "data-focus" : ""}>
          <span class="vl-dot" aria-hidden="true"></span>
          <span class="vl-meta"><b>${esc(n.date ? shortDate(n.date, lang) : "")}</b> ${esc(shortDoc(n.title))}${n.type ? ` · ${esc(n.type)}` : ""}</span>
          ${xf}${n.quotes.map((q) => `<q class="vl-q">${markFigs(esc(q))}</q>`).join("")}
        </li>`;
      })
      .join("");
    const end = `<li class="vl-n end ${tone}" style="--i:${nodes.length}"><span class="vl-dot" aria-hidden="true"></span><span class="vl-meta"><b>${esc(rw.endK[r.verdict] ?? "")}</b></span><span class="vl-end">${esc(rw.end[r.verdict] ?? "")}</span></li>`;
    return {
      label: r.label,
      html: `<header class="st-h"><h3 class="st-title"><span class="m-tw">${esc(r.label)}</span> <span class="vz-stamp ${tone}">${esc(rw.dec[r.verdict] ?? r.verdict)}</span></h3><p class="st-sub">${esc(r.text)}</p></header>
        <ol class="vl">${steps}${end}</ol>
        ${QS[r.id] ? `<p class="dd-k">${esc(rw.ask)}</p><div class="dd-asks"><button type="button" class="dd-ask" data-q="${esc(QS[r.id])}">${esc(QS[r.id])}</button></div>` : ""}`,
    };
  }

  function sceneFor(rep, key) {
    const [kind, id] = key.split(":");
    const v = rep.v, lang = rep.lang;
    if (v.kind === "records") {
      const r = v.rows.find((x) => x.id === id);
      return r ? sceneDecision(v, r, lang) : null;
    }
    const subject = v.subjects[rep.subject] ?? v.subjects[0];
    if (kind === "test") {
      const t = subject.tests.find((x) => x.key === id);
      return t ? sceneTest(t, lang) : null;
    }
    if (kind === "reg") return sceneRegion(subject, id, lang);
    if (kind === "ev") return sceneEvent(subject, Number(id), lang);
    return null;
  }
  const defaultKey = (rep) => {
    if (rep.v.kind === "records") return rep.v.rows[0] ? `rec:${rep.v.rows[0].id}` : null;
    const s = rep.v.subjects[rep.subject] ?? rep.v.subjects[0];
    const order = (t) => ({ out: 0, near: 1, in: 2, none: 3 })[SEV[t.latest.position] ?? "none"];
    const t = [...(s?.tests ?? [])].sort((a, b) => order(a) - order(b) || Number(!!b.corrected) - Number(!!a.corrected))[0];
    return t ? `test:${t.key}` : null;
  };

  // The stage element lives beside the report on wide desks (stageHost),
  // and in the report's own detail slot otherwise.
  const narrow = matchMedia("(max-width: 900px)");
  function placeStage(board) {
    const rep = REPORTS.get(board.dataset.rep);
    const st = rep?.stage;
    if (!st) return;
    const host = rep.opts.stageHost;
    const slot = board.querySelector(".rp-detail");
    const wide = host && !narrow.matches;
    if (wide && st.parentElement !== host) host.prepend(st);
    if (!wide && slot && st.parentElement !== slot) slot.replaceChildren(st);
    host?.closest(".desk")?.classList.toggle("has-stage", !!wide);
    if (slot) slot.hidden = !!wide;
  }
  function mountStage(board) {
    const rep = REPORTS.get(board.dataset.rep);
    if (!rep) return;
    for (const old of document.querySelectorAll(".stage")) if (old !== rep.stage) old.remove();
    const rw = R(rep.lang);
    const st = document.createElement("aside");
    st.className = `stage${reduced ? " still" : ""}`;
    st.dataset.lang = rep.lang;
    st.setAttribute("aria-label", rw.stageK);
    st.innerHTML = `<header class="st-bar"><button type="button" class="st-back" aria-label="${esc(rw.back)}" disabled>←</button><nav class="st-crumbs" aria-label="${esc(rw.stageK)}"></nav><button type="button" class="st-min" aria-expanded="true">${esc(rw.hide)}</button></header><div class="st-body"></div>`;
    rep.stage = st;
    rep.stack = [];
    st.querySelector(".st-back").addEventListener("click", () => {
      if (rep.stack.length < 2) return;
      rep.stack.pop();
      show(board, rep.stack.pop(), null);
    });
    st.querySelector(".st-min").addEventListener("click", (e) => {
      const min = st.classList.toggle("min");
      e.currentTarget.setAttribute("aria-expanded", String(!min));
      e.currentTarget.textContent = min ? rw.showChart : rw.hide;
    });
    // opening a source line folds the stage so the page has the column
    st.addEventListener("click", (e) => {
      const d = e.target.closest("[data-doc]");
      if (d && rep.opts.stageHost && !narrow.matches) {
        st.classList.add("min");
        const b = st.querySelector(".st-min");
        b.setAttribute("aria-expanded", "false");
        b.textContent = rw.showChart;
      }
      const s = e.target.closest("[data-sel]");
      if (s) select(board, s.dataset.sel, s);
    });
    mountTracker(st);
    placeStage(board);
    const k = defaultKey(rep);
    if (k) show(board, k, null);
    // the stage leaves with its report
    const watch = new MutationObserver(() => {
      if (board.isConnected) return;
      watch.disconnect();
      st.remove();
      rep.opts.stageHost?.closest(".desk")?.classList.remove("has-stage");
    });
    watch.observe(document.body, { childList: true, subtree: true });
  }
  narrow.addEventListener?.("change", () => document.querySelectorAll(".vz[data-rep]").forEach(placeStage));

  function show(board, key, from) {
    const rep = REPORTS.get(board.dataset.rep);
    const st = rep?.stage;
    if (!st) return;
    const sc = sceneFor(rep, key);
    if (!sc) return;
    rep.stack.push(key);
    if (rep.stack.length > 6) rep.stack.shift();
    board.querySelectorAll("[data-sel].sel").forEach((x) => x.classList.remove("sel"));
    board.querySelectorAll(`[data-sel="${CSS.escape(key)}"]`).forEach((x) => x.classList.add("sel"));
    const body = st.querySelector(".st-body");
    const old = body.firstElementChild;
    const scene = document.createElement("div");
    scene.className = "st-scene play";
    scene.dataset.key = key;
    scene.innerHTML = sc.html;
    if (old && !reduced) {
      old.classList.add("leaving");
      old.style.position = "absolute";
      setTimeout(() => old.remove(), 260);
    } else old?.remove();
    body.append(scene);
    // crumbs: the scenes on the stack
    const labels = rep.stack.map((k) => sceneFor(rep, k)?.label ?? "");
    st.querySelector(".st-crumbs").innerHTML = labels
      .slice(-3)
      .map((l, i, a) => `<span${i === a.length - 1 ? ' aria-current="true"' : ""}>${esc(l)}</span>`)
      .join(`<i aria-hidden="true">›</i>`);
    st.querySelector(".st-back").disabled = rep.stack.length < 2;
    if (st.classList.contains("min") && from) st.querySelector(".st-min").click();
    if (from) flyTo(from, scene.querySelector("[data-focus] .m-c, [data-focus] .vl-dot") ?? scene.querySelector(".st-title"));
    const r = st.getBoundingClientRect();
    if (from && (r.top > innerHeight - 120 || r.bottom < 60)) st.scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "nearest" });
  }

  // TransformFromCopy: a copy of the clicked mark travels an arc into the
  // scene it opens, on Manim's smooth curve.
  function flyTo(src, dst) {
    if (reduced || !src || !dst) return;
    const a = src.getBoundingClientRect(), b = dst.getBoundingClientRect();
    if (!a.width || !b.width || a.bottom < 0 || a.top > innerHeight || b.bottom < 0 || b.top > innerHeight) return;
    const ax = a.left + a.width / 2, ay = a.top + a.height / 2, bx = b.left + b.width / 2, by = b.top + b.height / 2;
    const cx = (ax + bx) / 2, cy = Math.min(ay, by) - Math.min(160, Math.abs(bx - ax) * 0.35 + 40);
    const dot = document.createElement("i");
    const tone = ["out", "near", "in", "none", "warn", "no", "ok"].find((k) => src.classList?.contains(k) || src.closest?.(`.${k}`));
    dot.className = `m-fly ${tone ?? ""}`;
    document.body.append(dot);
    const frames = Array.from({ length: 25 }, (_, i) => {
      const k = smooth(i / 24), u = 1 - k;
      const x = u * u * ax + 2 * u * k * cx + k * k * bx, y = u * u * ay + 2 * u * k * cy + k * k * by;
      return { transform: `translate(${x - 7}px, ${y - 7}px) scale(${1 + Math.sin(Math.PI * k) * 0.5})`, opacity: i === 24 ? 0 : 1 };
    });
    dot.animate(frames, { duration: 720, easing: "linear" }).finished.finally(() => dot.remove());
  }

  // ValueTracker: a live reading under the pointer (or arrow keys), with
  // where that value would sit against the printed range.
  function mountTracker(st) {
    const upd = (svg, x) => {
      const L0 = Number(svg.dataset.l0), L1 = Number(svg.dataset.l1), lo = Number(svg.dataset.lo), hi = Number(svg.dataset.hi);
      x = Math.max(L0, Math.min(L1, x));
      const u = lo + ((x - L0) / (L1 - L0)) * (hi - lo);
      const val = svg.dataset.log === "1" ? 10 ** u : u;
      const g = svg.querySelector(".m-tracker");
      g.setAttribute("transform", `translate(${n1(x)} 0)`);
      g.classList.add("on");
      svg.dataset.tx = String(x);
      const rlo = Number(svg.dataset.rlo), rhi = Number(svg.dataset.rhi);
      const rw = R(st.dataset.lang);
      g.querySelector(".m-tr-v").textContent = `${tickFmt(val)} ${svg.dataset.unit}`;
      g.querySelector(".m-tr-p").textContent = !Number.isFinite(rlo) ? "" : val < rlo ? rw.trBelow(tickFmt(rlo - val)) : val > rhi ? rw.trAbove(tickFmt(val - rhi)) : rw.trIn;
    };
    const toX = (svg, e) => {
      const p = svg.createSVGPoint();
      p.x = e.clientX;
      p.y = e.clientY;
      return p.matrixTransform(svg.getScreenCTM().inverse()).x;
    };
    st.addEventListener("pointermove", (e) => {
      const svg = e.target.closest?.(".m-nl");
      if (svg) upd(svg, toX(svg, e));
    });
    st.addEventListener("pointerout", (e) => {
      const svg = e.target.closest?.(".m-nl");
      if (svg && !svg.contains(e.relatedTarget)) svg.querySelector(".m-tracker")?.classList.remove("on");
    });
    st.addEventListener("keydown", (e) => {
      const svg = e.target.closest?.(".m-nl");
      if (!svg || !/^Arrow(Left|Right)$/.test(e.key)) return;
      e.preventDefault();
      const L0 = Number(svg.dataset.l0), L1 = Number(svg.dataset.l1);
      upd(svg, Number(svg.dataset.tx ?? (L0 + L1) / 2) + (e.key === "ArrowRight" ? 1 : -1) * (L1 - L0) / 50);
    });
  }

  function labReport(v, opts, subjectIndex = 0) {
    const lang = opts.lang ?? v.lang ?? "en";
    const w = W(lang),
      rw = R(lang);
    const subject = v.subjects[subjectIndex] ?? v.subjects[0];
    if (!subject) return "";
    const order = (t) => ({ out: 0, near: 1, in: 2, none: 3 })[SEV[t.latest.position] ?? "none"];
    const tests = [...subject.tests].sort((a, b) => order(a) - order(b) || Number(!!b.corrected) - Number(!!a.corrected));
    const who = v.subjects.length > 1
      ? `<div class="rp-who" role="tablist">${v.subjects.map((s, i) => `<button type="button" role="tab" class="rp-subj" data-subject="${i}" aria-selected="${i === subjectIndex}">${esc(s.label)}</button>`).join("")}</div>`
      : `<div class="rp-who"><b>${esc(subject.label)}</b></div>`;
    return `<div class="rp-top">${who}${reportTrail(subject, w, lang)}</div>
      ${rangeField(subject, rw, w)}
      ${rangeRows(tests, w, rw, lang)}
      ${timelineCard(subject, rw, lang, w)}
      <section class="rp-detail" aria-live="polite"><p class="rp-pick">${esc(rw.pick)}</p></section>`;
  }

  function recordsReport(v, opts) {
    const lang = opts.lang ?? v.lang ?? "en";
    const rw = R(lang);
    REPORTS.set("__docs", v.documents ?? []);
    return `${decisionTrack(v, rw)}
      ${lanes(v, rw, lang)}
      <section class="rp-detail" aria-live="polite"><p class="rp-pick">${esc(rw.pick)}</p></section>`;
  }

  // one delegated handler: a mark opens its scene on the stage
  function select(board, key, from) {
    const rep = REPORTS.get(board.dataset.rep);
    if (!rep?.stage) return;
    if (rep.stack.at(-1) === key && !rep.stage.classList.contains("min")) return;
    show(board, key, from ?? null);
  }
  document.addEventListener("click", (e) => {
    const subj = e.target.closest?.(".rp-subj");
    if (subj) {
      const board = subj.closest(".vz[data-rep]");
      const rep = REPORTS.get(board?.dataset.rep);
      if (!rep) return;
      rep.subject = Number(subj.dataset.subject);
      board.querySelector(".rp-body").innerHTML = labReport(rep.v, rep.opts, rep.subject);
      rep.stack = [];
      placeStage(board);
      const k = defaultKey(rep);
      if (k) show(board, k, null);
      return;
    }
    const m = e.target.closest?.("[data-sel]");
    if (!m || m.closest(".vz-dd") || m.closest(".stage")) return;
    const board = m.closest(".vz[data-rep]");
    if (board) select(board, m.dataset.sel, m);
  });
  document.addEventListener("keydown", (e) => {
    if ((e.key === "Enter" || e.key === " ") && e.target.matches?.("[data-sel][tabindex], .vl-n[tabindex], .m-pt[tabindex]")) {
      e.preventDefault();
      e.target.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    }
  });

  // ------------------------------------------------------------ narration
  // narration-split: /.+?(?:[.!?।]+(?!\d)|$)\s*/g (decimals stay inline; MUST match the other side)
  // the server speaks one indexed sentence; rows highlight by that index.)
  const splitSentences = (text) =>
    String(text).match(/.+?(?:[.!?।]+(?!\d)|$)\s*/g) ?? [text];
  // Rows the narration speaks about: the main subject's list only. Other
  // people on the board live inside .vz-other details; a shared analyte name
  // must never light their rows while the main subject is being read.
  const spokenRows = (root) =>
    [...(root?.querySelectorAll(".vz-row") ?? [])].filter(
      (r) => !r.closest(".vz-other"),
    );
  let speaking = null; // {audio, root, btn, lang}
  function stop() {
    if (!speaking) return;
    speaking.resolve?.(); // release a mid-play await so narrate() can exit
    speaking.audio?.pause();
    if ("speechSynthesis" in window) speechSynthesis.cancel();
    speaking.root
      ?.querySelectorAll(".vz-row.speaking")
      .forEach((r) => r.classList.remove("speaking"));
    speaking.btn?.classList.remove("on");
    if (speaking.btn)
      speaking.btn.querySelector("span").textContent = W(speaking.lang).listen;
    speaking = null;
  }
  function voiceUnavailable(btn, lang) {
    if (!btn) return;
    btn.classList.remove("on");
    btn.querySelector("span").textContent = W(lang).voiceOff;
  }
  /**
   * Read the board's narration aloud, sentence by sentence, in the server's
   * voice (Sarvam Bulbul). There is deliberately no browser-voice fallback:
   * when the server voice is unavailable the button says so and the text
   * stays on screen to read. Row highlighting follows the spoken sentence.
   */
  // Owner-app boards (no public case): keep the pre-existing in-browser
  // voice. It is local-only audio for the owner's own workspace - nothing
  // leaves the browser - and it is NOT the public demo's readout voice.
  function pickVoice(lang) {
    const voices = speechSynthesis.getVoices();
    const want =
      lang === "hi"
        ? ["hi-IN"]
        : lang === "hinglish"
          ? ["en-IN", "hi-IN"]
          : ["en-IN", "en-GB", "en-US"];
    const score = (v) =>
      (/natural|online|neural|google/i.test(v.name) ? 2 : 0) +
      (v.localService ? 0 : 1);
    for (const tag of want) {
      const m = voices
        .filter((v) => v.lang.replace("_", "-").startsWith(tag))
        .sort((a, b) => score(b) - score(a));
      if (m.length) return m[0];
    }
    return null;
  }
  function narrateLocal(text, lang, root, btn) {
    if (!("speechSynthesis" in window)) return (voiceUnavailable(btn, lang), false);
    const parts = splitSentences(text);
    speaking = { root, btn, lang, audio: null };
    btn?.classList.add("on");
    if (btn) btn.querySelector("span").textContent = W(lang).stop;
    const voice = pickVoice(lang);
    const rows = spokenRows(root);
    parts.forEach((s, i) => {
      const u = new SpeechSynthesisUtterance(s.trim());
      if (voice) u.voice = voice;
      u.lang = voice?.lang ?? (lang === "hi" ? "hi-IN" : "en-IN");
      u.onstart = () =>
        rows.forEach((r) =>
          r.classList.toggle("speaking", s.toLowerCase().includes(r.dataset.test)),
        );
      if (i === parts.length - 1)
        u.onend = u.onerror = () => speaking?.btn === btn && stop();
      speechSynthesis.speak(u);
    });
    return true;
  }
  async function narrate(text, lang, root, btn, caseId, sentences) {
    if (!text) return false;
    if (speaking) {
      const same = speaking.btn === btn;
      stop();
      if (same) return true;
    }
    if (!caseId) return narrateLocal(text, lang, root, btn);
    const parts = sentences?.length ? sentences : splitSentences(text);
    speaking = { root, btn, lang, audio: null };
    btn?.classList.add("on");
    if (btn) btn.querySelector("span").textContent = W(lang).stop;
    const rows = spokenRows(root);
    const alive = () => speaking && speaking.btn === btn;
    const get = (i) =>
      fetch(
        `/api/public/narrate-audio/${caseId}/${i}?lang=${encodeURIComponent(lang)}`,
      )
        .then((r) => (r.ok ? r.blob() : null))
        .catch(() => null);
    let next = get(0);
    for (let i = 0; i < parts.length; i++) {
      const blob = await next;
      if (!alive()) return true;
      if (!blob) {
        stop();
        voiceUnavailable(btn, lang);
        return false;
      }
      if (i + 1 < parts.length) next = get(i + 1);
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      speaking.audio = audio;
      const s = parts[i];
      rows.forEach((r) =>
        r.classList.toggle(
          "speaking",
          s.toLowerCase().includes(r.dataset.test),
        ),
      );
      await new Promise((res) => {
        speaking.resolve = res;
        audio.onended = res;
        audio.onerror = res;
        audio.play().catch(res);
      });
      speaking.resolve = null;
      URL.revokeObjectURL(url);
    }
    if (alive()) stop();
    return true;
  }

  /**
   * @param {HTMLElement} el
   * @param {object} v visual payload from the engine
   * @param {{lang?: string, narration?: string|null, compact?: boolean}} opts
   */
  function render(el, v, opts = {}) {
    if (!el || !v) return;
    stop();
    const lang = opts.lang ?? v.lang ?? "en";
    const focus = v.focus === "answer";
    const id = `rp${++rid}`;
    if (!focus) REPORTS.set(id, { v, opts, lang, subject: 0 });
    // Answers show the picture of that answer (the test's own drill-down);
    // the overview is the report.
    const body = focus
      ? v.kind === "records"
        ? records(v, opts)
        : v.subjects[0]?.tests?.length
          ? v.subjects[0].tests.slice(0, 2).map((t) => `<div class="vz-answer-test"><h5 class="dt-h">${esc(t.name)}</h5>${drill(t, lang)}</div>`).join("")
          : labs(v, opts)
      : v.kind === "records"
        ? recordsReport(v, opts)
        : labReport(v, opts, 0);
    const narration = opts.narration ?? v.narration ?? null;
    el.innerHTML = `<div class="vz ${v.kind === "records" ? "vz-rec" : "vz-lab"}${focus ? " vz-focus" : " vz-report"}${reduced ? " still" : ""}"${focus ? "" : ` data-rep="${id}"`} lang="${lang === "hi" ? "hi" : "en"}">
      ${focus ? body : `${DEFS}<div class="rp-body">${body}</div>`}
      ${narration && (opts.narrateButton !== false || !focus) ? `<div class="vz-say${opts.narrateButton === false ? " no-voice" : ""}">${opts.narrateButton === false ? "" : `<button type="button" class="vz-listen"><i aria-hidden="true"></i><span>${esc(W(lang).listen)}</span></button>`}<div><p class="vz-narr clamp">${esc(narration)}</p><button type="button" class="vz-more">${esc(W(lang).full[0])}</button></div></div>` : ""}
    </div>`;
    const board = el.querySelector(".vz[data-rep]");
    if (board) {
      mountStage(board);
      mountLanes(board);
    }
    const btn = el.querySelector(".vz-listen");
    btn?.addEventListener("click", () =>
      narrate(narration, lang, el, btn, opts.caseId ?? null, v.sentences),
    );
    el.querySelector(".vz-more")?.addEventListener("click", (e) => {
      const p = el.querySelector(".vz-narr");
      const open = p.classList.toggle("clamp");
      e.currentTarget.textContent = W(lang).full[open ? 0 : 1];
    });
  }

  window.VMVisual = { render, narrate, stop, words: W };
})();
