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
      tiles.push(`<div class="dd-tile"><span>${esc(w.toRange)}</span><b${ins.distance ? "" : ' class="txt"'}>${esc(ins.distance ? w.by(fmt(ins.distance.by), ins.distance.side, ins.distance.bound) : t.latest.position === "within" ? w.inRange : w.noRange)}</b><em>${esc(`${t.latest.range.low}–${t.latest.range.high}${t.unit ? " " + t.unit : ""}`)}</em></div>`);
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
    const body = v.kind === "records" ? records(v, opts) : labs(v, opts);
    const narration = opts.narration ?? v.narration ?? null;
    el.innerHTML = `<div class="vz ${v.kind === "records" ? "vz-rec" : "vz-lab"}${v.focus === "answer" ? " vz-focus" : ""}${reduced ? " still" : ""}" lang="${lang === "hi" ? "hi" : "en"}">
      ${body}
      ${narration && opts.narrateButton !== false ? `<div class="vz-say"><button type="button" class="vz-listen"><i aria-hidden="true"></i><span>${esc(W(lang).listen)}</span></button><div><p class="vz-narr clamp">${esc(narration)}</p><button type="button" class="vz-more">${esc(W(lang).full[0])}</button></div></div>` : ""}
    </div>`;
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
