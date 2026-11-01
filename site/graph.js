// Memory graph: the evidence graph the engine answers from, drawn as a
// force-directed canvas. Data comes from /api/public/graph/:case (live) or
// the engine snapshot while the free host wakes up.
(() => {
  "use strict";
  const $ = (s) => document.querySelector(s);
  const cv = $("#g");
  const ctx = cv.getContext("2d");
  const snap = window.VM_SNAPSHOT ?? { graphs: {} };
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

  const C = { mark: "#f5e27a", teal: "#8ea2ff", coral: "#f4a3b6", amber: "#f5e27a", blue: "#aab6ff", violet: "#c3b5ff", ink: "#e9ecf3", dim: "#747d96" };
  const STATUS_COLOR = {
    current: C.teal, amended: C.teal, final: C.teal, approved: C.teal, agreed: C.teal,
    superseded: C.coral, preliminary: C.amber, proposed: C.amber, discussed: C.amber, requested: C.amber, "internal-target": C.amber, unresolved: C.coral,
  };
  const SPECIAL = {
    corrects: { color: C.mark, dash: true, arrow: true, label: "corrects (amended replaces preliminary)" },
    supersedes: { color: C.mark, dash: true, arrow: true, label: "supersedes (later value replaces earlier)" },
    "not comparable": { color: C.coral, dash: true, label: "not comparable (units differ)" },
    "competes with": { color: C.coral, dash: true, label: "competes with (both on record, unresolved)" },
    then: { color: C.teal, dash: false, arrow: true, label: "then (comparable, same units)" },
  };
  const NODE_LEGEND = {
    health: [
      ["patient", C.mark, "Patient"],
      ["document", C.blue, "Report (PDF)"],
      ["topic", C.violet, "Test"],
      ["value-current", C.teal, "Value in force"],
      ["value-preliminary", C.amber, "Preliminary value"],
      ["value-superseded", C.coral, "Corrected away"],
    ],
    deal: [
      ["topic", C.violet, "Topic"],
      ["document", C.blue, "Document"],
      ["value-proposed", C.amber, "Proposed / discussed"],
      ["value-superseded", C.coral, "Superseded"],
      ["value-current", C.teal, "Approved / agreed"],
      ["evidence", C.ink, "Exact sentence"],
    ],
  };

  let W = 0, H = 0, dpr = 1;
  let view = { x: 0, y: 0, k: 1 };
  let target = null; // camera tween target
  let nodes = [], edges = [], byId = new Map();
  let hover = null, selected = null, focusSet = null;
  let wsId = null;
  try {
    wsId = sessionStorage.getItem("vm_ws");
  } catch {}
  const want = new URLSearchParams(location.search).get("case");
  let caseId = want === "deal" ? "deal" : want === "own" && wsId ? wsId : "health";
  if (wsId) {
    const b = document.createElement("button");
    b.setAttribute("role", "tab");
    b.dataset.case = wsId;
    b.textContent = "Your documents";
    document.querySelector(".seg").appendChild(b);
  }
  const kindOf = () => (nodes.some((n) => n.kind === "patient") ? "health" : "deal");
  let t = 0;
  let storyTimer = null;

  function resize() {
    dpr = Math.min(2, window.devicePixelRatio || 1);
    W = innerWidth; H = innerHeight;
    cv.width = W * dpr; cv.height = H * dpr;
  }
  addEventListener("resize", resize);
  resize();

  // ------------------------------------------------------------ data
  async function load(id) {
    let g = null;
    try {
      const ctl = new AbortController();
      setTimeout(() => ctl.abort(), 6000);
      const r = await fetch(`/api/public/graph/${id}`, { signal: ctl.signal });
      if (r.ok) g = await r.json();
    } catch {
      /* fall back to snapshot */
    }
    g ??= snap.graphs?.[id];
    if (!g) return;
    build(g, id);
  }

  const radiusOf = (n) => (n.kind === "patient" ? 20 : n.kind === "document" ? 0 : n.kind === "topic" ? 7 : n.kind === "evidence" ? 4 : 11);
  function colorOf(n) {
    if (n.kind === "patient") return C.mark;
    if (n.kind === "document") return C.blue;
    if (n.kind === "topic") return C.violet;
    if (n.kind === "evidence") return C.ink;
    return STATUS_COLOR[n.status] ?? C.teal;
  }
  const labelOf = (n) =>
    n.kind === "document"
      ? String(n.label).replace(/^a 2026 /, "").replace(/\s+/g, " ")
      : n.kind === "evidence"
        ? ""
        : n.label;

  function build(g, id) {
    caseId = id;
    document.querySelectorAll(".seg button").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.case === id)));
    const prev = new Map(nodes.map((n) => [n.id, n]));
    nodes = g.nodes.map((n, i) => {
      const p = prev.get(n.id);
      const a = i * 2.39996;
      const r = 40 + Math.sqrt(i) * 46;
      return { ...n, x: p?.x ?? Math.cos(a) * r, y: p?.y ?? Math.sin(a) * r, vx: 0, vy: 0, born: t + i * 1.2 };
    });
    byId = new Map(nodes.map((n) => [n.id, n]));
    edges = g.edges.map((e) => ({ ...e, a: byId.get(e.from), b: byId.get(e.to) })).filter((e) => e.a && e.b);
    for (const n of nodes) n.deg = 0;
    for (const e of edges) { e.a.deg++; e.b.deg++; }
    selected = null; focusSet = null; closePanel();
    legend();
    for (let i = 0; i < 260; i++) step(1);
    fit(false);
  }

  function legend() {
    $("#lg-nodes").innerHTML = NODE_LEGEND[kindOf()]
      .map(([k, col, label]) => `<li><span class="sw" style="${k === "document" ? `border:2px solid ${col};border-radius:4px` : k.startsWith("value") ? `background:${col};clip-path:polygon(25% 5%,75% 5%,100% 50%,75% 95%,25% 95%,0 50%)` : `background:${col};border-radius:50%`}"></span>${label}</li>`)
      .join("");
    const kinds = new Set(edges.map((e) => e.kind));
    $("#lg-edges").innerHTML = Object.entries(SPECIAL)
      .filter(([k]) => kinds.has(k))
      .map(([, s]) => `<li><span class="sw ln${s.dash ? " dash" : ""}" style="border-color:${s.color}"></span>${s.label}</li>`)
      .join("") + `<li><span class="sw ln" style="border-color:rgba(160,170,200,.35)"></span>records / measures / cites</li>`;
    $("#lg-sub").textContent = caseId === wsId ? "Your uploaded documents: every value and sentence the engine indexed, and how they connect." : kindOf() === "health" ? "Two synthetic patients, four reports and every lab value, with the edges the engine answers from." : "Seven fictional deal records: each value, its status, and the exact sentences behind it.";
    $("#lg-count").textContent = `${nodes.length} nodes · ${edges.length} edges · computed from the documents`;
  }

  // ------------------------------------------------------------ physics
  function step(alpha = 0.25) {
    const N = nodes.length;
    for (let i = 0; i < N; i++) {
      const a = nodes[i];
      for (let j = i + 1; j < N; j++) {
        const b = nodes[j];
        let dx = a.x - b.x, dy = a.y - b.y;
        let d2 = dx * dx + dy * dy;
        if (d2 < 1) { dx = Math.random() - 0.5; dy = Math.random() - 0.5; d2 = 1; }
        if (d2 > 160000) continue;
        const f = (a.kind === "document" || b.kind === "document" ? 2600 : 1500) / d2;
        a.vx += dx * f * alpha; a.vy += dy * f * alpha;
        b.vx -= dx * f * alpha; b.vy -= dy * f * alpha;
      }
    }
    for (const e of edges) {
      const dx = e.b.x - e.a.x, dy = e.b.y - e.a.y;
      const d = Math.hypot(dx, dy) || 1;
      const L = SPECIAL[e.kind] ? 90 : e.a.kind === "document" || e.b.kind === "document" ? 120 : 70;
      const f = ((d - L) / d) * 0.04 * alpha * 4;
      e.a.vx += dx * f; e.a.vy += dy * f;
      e.b.vx -= dx * f; e.b.vy -= dy * f;
    }
    for (const n of nodes) {
      n.vx -= n.x * 0.002 * alpha * 4; n.vy -= n.y * 0.002 * alpha * 4;
      if (n === drag?.node) continue;
      n.vx *= 0.6; n.vy *= 0.6;
      n.x += n.vx; n.y += n.vy;
    }
  }

  // ------------------------------------------------------------ camera
  function bounds(list = nodes) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const n of list) { x0 = Math.min(x0, n.x); y0 = Math.min(y0, n.y); x1 = Math.max(x1, n.x); y1 = Math.max(y1, n.y); }
    return { x0, y0, x1, y1 };
  }
  function fit(anim = true, list = nodes, pad = 140) {
    if (!list.length) return;
    const b = bounds(list);
    const leftPad = W > 760 ? 280 : 20;
    const k = Math.min((W - leftPad - pad) / Math.max(1, b.x1 - b.x0), (H - pad * 1.4) / Math.max(1, b.y1 - b.y0), 2.4);
    const cx = (b.x0 + b.x1) / 2, cy = (b.y0 + b.y1) / 2;
    const v = { k, x: leftPad / 2 + W / 2 - cx * k, y: H / 2 - cy * k + 10 };
    if (anim && !reduced) target = v;
    else view = v;
  }
  const toWorld = (sx, sy) => ({ x: (sx - view.x) / view.k, y: (sy - view.y) / view.k });

  // ------------------------------------------------------------ draw
  function hex(x, y, r) {
    ctx.beginPath();
    for (let i = 0; i < 6; i++) {
      const a = (Math.PI / 3) * i;
      ctx.lineTo(x + r * Math.cos(a), y + r * Math.sin(a));
    }
    ctx.closePath();
  }
  function roundRect(x, y, w, h, r) {
    ctx.beginPath();
    ctx.roundRect ? ctx.roundRect(x, y, w, h, r) : ctx.rect(x, y, w, h);
  }
  const neighbours = (n) => {
    const s = new Set([n.id]);
    for (const e of edges) if (e.a === n || e.b === n) { s.add(e.a.id); s.add(e.b.id); }
    return s;
  };

  function draw() {
    t++;
    if (target) {
      view.x += (target.x - view.x) * 0.09; view.y += (target.y - view.y) * 0.09; view.k += (target.k - view.k) * 0.09;
      if (Math.abs(target.k - view.k) < 0.001 && Math.abs(target.x - view.x) < 0.3) target = null;
    }
    step(0.08);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    // dot grid
    const g = 28 * view.k;
    if (g > 8) {
      ctx.fillStyle = "rgba(255,255,255,0.045)";
      const ox = view.x % g, oy = view.y % g;
      for (let x = ox; x < W; x += g) for (let y = oy; y < H; y += g) ctx.fillRect(x, y, 1.2, 1.2);
    }
    ctx.setTransform(dpr * view.k, 0, 0, dpr * view.k, dpr * view.x, dpr * view.y);
    const active = focusSet ?? (hover ? neighbours(hover) : null);

    // edges
    for (const e of edges) {
      const s = SPECIAL[e.kind];
      const on = !active || (active.has(e.a.id) && active.has(e.b.id));
      const appear = Math.min(1, Math.max(0, (t - Math.max(e.a.born, e.b.born)) / 30));
      ctx.globalAlpha = (on ? 1 : 0.08) * appear;
      const mx = (e.a.x + e.b.x) / 2 + (e.b.y - e.a.y) * 0.12, my = (e.a.y + e.b.y) / 2 - (e.b.x - e.a.x) * 0.12;
      ctx.strokeStyle = s ? s.color : "rgba(160,170,200,0.28)";
      ctx.lineWidth = (s ? 2.2 : 1) / Math.sqrt(view.k);
      ctx.setLineDash(s?.dash ? [6, 6] : []);
      ctx.lineDashOffset = -t * 0.6;
      ctx.beginPath(); ctx.moveTo(e.a.x, e.a.y); ctx.quadraticCurveTo(mx, my, e.b.x, e.b.y); ctx.stroke();
      ctx.setLineDash([]);
      if (s) {
        // travelling pulse
        const p = ((t * 0.012) % 1);
        const px = (1 - p) * (1 - p) * e.a.x + 2 * (1 - p) * p * mx + p * p * e.b.x;
        const py = (1 - p) * (1 - p) * e.a.y + 2 * (1 - p) * p * my + p * p * e.b.y;
        ctx.fillStyle = s.color; ctx.shadowColor = s.color; ctx.shadowBlur = 12;
        ctx.beginPath(); ctx.arc(px, py, 2.6, 0, Math.PI * 2); ctx.fill(); ctx.shadowBlur = 0;
        if (on && view.k > 0.75) {
          ctx.font = `500 ${10.5 / Math.sqrt(view.k)}px "Public Sans", system-ui`; ctx.fillStyle = s.color; ctx.textAlign = "center";
          ctx.fillText(e.kind, mx, my - 5);
        }
      }
    }
    ctx.globalAlpha = 1;

    // nodes
    for (const n of nodes) {
      const on = !active || active.has(n.id);
      const appear = Math.min(1, Math.max(0, (t - n.born) / 24));
      ctx.globalAlpha = (on ? 1 : 0.14) * appear;
      const col = colorOf(n);
      const r = radiusOf(n) * (0.6 + 0.4 * appear);
      const isSel = selected === n || hover === n;
      if (n.kind === "document") {
        const label = labelOf(n);
        ctx.font = "500 12px "Public Sans", system-ui";
        const w = Math.min(200, ctx.measureText(label).width + 26), h = 28;
        roundRect(n.x - w / 2, n.y - h / 2, w, h, 8);
        ctx.fillStyle = "rgba(20,26,46,0.95)"; ctx.fill();
        ctx.strokeStyle = isSel ? C.mark : "rgba(143,163,255,0.7)"; ctx.lineWidth = isSel ? 2 : 1.2; ctx.stroke();
        ctx.fillStyle = C.blue; ctx.fillRect(n.x - w / 2 + 8, n.y - 4, 5, 8);
        ctx.fillStyle = C.ink; ctx.textAlign = "left"; ctx.fillText(label, n.x - w / 2 + 18, n.y + 4, w - 24);
        n.hw = w / 2; n.hh = h / 2;
        continue;
      }
      ctx.shadowColor = col; ctx.shadowBlur = n.status === "superseded" || n.kind === "patient" || isSel ? 22 : 10;
      if (n.kind === "value") {
        hex(n.x, n.y, r); ctx.fillStyle = col + "33"; ctx.fill(); ctx.lineWidth = 2; ctx.strokeStyle = col; ctx.stroke();
      } else if (n.kind === "patient") {
        ctx.beginPath(); ctx.arc(n.x, n.y, r, 0, Math.PI * 2); ctx.fillStyle = "rgba(245,226,122,0.12)"; ctx.fill();
        ctx.lineWidth = 3; ctx.strokeStyle = col; ctx.stroke();
        ctx.beginPath(); ctx.arc(n.x, n.y, r + 6 + Math.sin(t / 20) * 2, 0, Math.PI * 2); ctx.lineWidth = 1; ctx.strokeStyle = "rgba(245,226,122,0.35)"; ctx.stroke();
      } else {
        ctx.beginPath(); ctx.arc(n.x, n.y, r, 0, Math.PI * 2); ctx.fillStyle = col; ctx.fill();
      }
      ctx.shadowBlur = 0;
      if (isSel) { ctx.beginPath(); ctx.arc(n.x, n.y, r + 7, 0, Math.PI * 2); ctx.strokeStyle = C.mark; ctx.lineWidth = 1.5; ctx.stroke(); }
      const label = labelOf(n);
      if (label && (n.kind !== "evidence")) {
        const fs = n.kind === "patient" ? 14 : n.kind === "value" ? 12.5 : 11.5;
        ctx.font = `${n.kind === "value" || n.kind === "patient" ? 600 : 500} ${fs}px "Public Sans", system-ui`;
        ctx.textAlign = "center";
        ctx.fillStyle = n.kind === "topic" ? "#cfc3ff" : n.status === "superseded" ? C.coral : C.ink;
        ctx.fillText(label, n.x, n.y + r + fs + 3);
        if (n.status === "superseded") {
          const w = ctx.measureText(label).width;
          ctx.strokeStyle = C.coral; ctx.lineWidth = 1.5;
          ctx.beginPath(); ctx.moveTo(n.x - w / 2 - 2, n.y + r + fs - 1); ctx.lineTo(n.x + w / 2 + 2, n.y + r + fs - 1); ctx.stroke();
        }
      }
    }
    ctx.globalAlpha = 1;
    requestAnimationFrame(draw);
  }

  // ------------------------------------------------------------ interaction
  function pick(sx, sy) {
    const p = toWorld(sx, sy);
    let best = null, bd = Infinity;
    for (const n of nodes) {
      if (n.kind === "document" && n.hw) {
        if (Math.abs(p.x - n.x) <= n.hw && Math.abs(p.y - n.y) <= n.hh) return n;
        continue;
      }
      const d = Math.hypot(p.x - n.x, p.y - n.y);
      if (d < Math.max(radiusOf(n) + 6, 12 / view.k) && d < bd) { bd = d; best = n; }
    }
    return best;
  }
  let drag = null;
  cv.addEventListener("pointerdown", (e) => {
    cv.setPointerCapture(e.pointerId);
    const n = pick(e.clientX, e.clientY);
    drag = { node: n, sx: e.clientX, sy: e.clientY, vx: view.x, vy: view.y, moved: false };
    cv.classList.add("drag");
  });
  cv.addEventListener("pointermove", (e) => {
    if (!drag) {
      const n = pick(e.clientX, e.clientY);
      if (n !== hover) { hover = n; cv.style.cursor = n ? "pointer" : "grab"; }
      return;
    }
    const dx = e.clientX - drag.sx, dy = e.clientY - drag.sy;
    if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
    if (drag.node) { const p = toWorld(e.clientX, e.clientY); drag.node.x = p.x; drag.node.y = p.y; drag.node.vx = drag.node.vy = 0; }
    else { target = null; view.x = drag.vx + dx; view.y = drag.vy + dy; }
  });
  cv.addEventListener("pointerup", () => {
    if (drag && !drag.moved) {
      if (drag.node) select(drag.node);
      else { selected = null; focusSet = null; closePanel(); }
    }
    drag = null; cv.classList.remove("drag");
  });
  cv.addEventListener("wheel", (e) => {
    e.preventDefault();
    target = null;
    const k = Math.min(4, Math.max(0.25, view.k * Math.exp(-e.deltaY * 0.0015)));
    const p = toWorld(e.clientX, e.clientY);
    view.x = e.clientX - p.x * k; view.y = e.clientY - p.y * k; view.k = k;
  }, { passive: false });
  const zoomBy = (f) => { const c = toWorld(W / 2, H / 2); const k = Math.min(4, Math.max(0.25, view.k * f)); target = { k, x: W / 2 - c.x * k, y: H / 2 - c.y * k }; };
  $("#zin").onclick = () => zoomBy(1.3);
  $("#zout").onclick = () => zoomBy(1 / 1.3);
  $("#fit").onclick = () => { selected = null; focusSet = null; closePanel(); fit(); };
  $("#close").onclick = () => { selected = null; focusSet = null; closePanel(); };
  document.querySelectorAll(".seg button").forEach((b) => (b.onclick = () => { stopStory(); load(b.dataset.case); history.replaceState(null, "", `?case=${b.dataset.case === wsId ? "own" : b.dataset.case}`); }));
  $("#find").addEventListener("input", (e) => {
    const q = e.target.value.trim().toLowerCase();
    if (!q) { focusSet = null; return; }
    const hits = nodes.filter((n) => String(n.label ?? "").toLowerCase().includes(q) || String(n.test ?? "").toLowerCase().includes(q));
    focusSet = new Set(hits.flatMap((n) => [...neighbours(n)]));
    if (hits.length) fit(true, hits.length === 1 ? [...focusSet].map((id) => byId.get(id)) : hits, 260);
  });
  addEventListener("keydown", (e) => { if (e.key === "Escape") { selected = null; focusSet = null; closePanel(); } });

  function select(n, { zoom = true } = {}) {
    selected = n;
    focusSet = neighbours(n);
    if (zoom) fit(true, [...focusSet].map((id) => byId.get(id)), 300);
    openPanel(n);
  }
  function closePanel() { $("#panel").hidden = true; }
  function openPanel(n) {
    const kind = { patient: "Patient", document: "Document", topic: kindOf() === "health" ? "Test" : "Topic", value: "Value", evidence: "Exact sentence" }[n.kind] ?? n.kind;
    $("#p-kind").textContent = kind;
    $("#p-title").textContent = n.kind === "evidence" ? "Cited sentence" : labelOf(n);
    const links = edges
      .filter((e) => e.a === n || e.b === n)
      .map((e) => ({ e, o: e.a === n ? e.b : e.a, dir: e.a === n ? "→" : "←" }))
      .sort((x, y) => (SPECIAL[y.e.kind] ? 1 : 0) - (SPECIAL[x.e.kind] ? 1 : 0));
    const ev = n.evidence;
    const quote = ev?.quote ?? (n.kind === "evidence" ? n.label : null);
    const ask = suggestFor(n);
    $("#p-body").innerHTML = `
      ${n.status ? `<span class="chip c-${esc(n.status)}">${esc(n.status === "current" ? "in force" : n.status)}</span>` : ""}
      ${n.date ? `<span style="margin-left:8px;color:var(--ink-3);font-size:12.5px">${esc(n.date)}</span>` : ""}
      ${quote ? `<p class="quote"><small>${esc(ev?.page ? "page " + ev.page + " · " : "")}exact source text</small>${esc(/^\s*\|/.test(quote) ? String(quote).split("|").map((x) => x.trim()).filter(Boolean).join(" · ") : String(quote).replace(/^\d+\.\s*/, ""))}</p>` : ""}
      <p class="p-sec">Connections (${links.length})</p>
      <ul class="links">${links
        .slice(0, 14)
        .map(({ e, o, dir }) => `<li><button data-node="${esc(o.id)}"><span>${esc(dir)} ${esc(labelOf(o) || "sentence")}</span><em>${esc(e.kind)}</em></button></li>`)
        .join("")}</ul>
      ${ask ? `<a class="ask-link" href="./?case=${caseId === wsId ? "own" : caseId}&q=${encodeURIComponent(ask)}#try">Ask about this →</a>` : ""}`;
    $("#panel").hidden = false;
    $("#p-body").querySelectorAll("[data-node]").forEach((b) => (b.onclick = () => select(byId.get(b.dataset.node))));
  }
  function suggestFor(n) {
    if (caseId === "health") {
      const test = n.test ?? (n.kind === "topic" ? n.label : null);
      const pid = n.patient ?? (String(n.id).includes("SYN-0003") ? "SYN-0003" : "SYN-0001");
      if (n.kind === "patient") return `What is ${n.label}'s ferritin result?`;
      if (test) return `What is ${pid}'s ${test.toLowerCase()} result?`;
      return null;
    }
    const f = n.field ?? (n.kind === "topic" ? n.id.replace(/^topic:/, "") : null);
    return { fee: "What is the engagement fee?", paymentSplit: "Did they agree on the payment split?", deadline: "What is the deadline?", signedAgreement: "Is there a signed contract?" }[f] ?? null;
  }

  // ------------------------------------------------------------ story
  const STORIES = {
    health: [
      [(n) => n.kind === "patient" && n.label === "SYN-0001", "You ask: “What's SYN-0001's ferritin?”"],
      [(n) => n.kind === "topic" && /ferritin/i.test(n.label) && n.patient === "SYN-0001", "Three ferritin values are on record for this patient."],
      [(n) => n.kind === "value" && /^5 ng/.test(n.label), "13 Oct, preliminary report: 5 ng/mL."],
      [(n) => n.kind === "value" && /^50 ng/.test(n.label), "15 Oct, amended report for the same collection: 50. It corrects the 5."],
      [(n) => n.kind === "value" && /^0\.5 ng/.test(n.label), "September's 0.5 is the earlier result, in the same unit, so it can be compared."],
      [(n) => n.kind === "topic" && /creatinine/i.test(n.label) && n.patient === "SYN-0001", "Creatinine switched from mg/dL to µmol/L. Not comparable, so it won't guess."],
    ],
    deal: [
      [(n) => n.kind === "topic" && /^fee$/i.test(n.label), "You ask: “Was the $42,000 revision finalized?”"],
      [(n) => n.kind === "value" && n.label === "$48,000", "The proposal said $48,000. It has been superseded."],
      [(n) => n.kind === "value" && n.label === "$42,000", "The revision says $42,000: proposed, and no finance approval is recorded."],
      [(n) => n.kind === "topic" && /payment/i.test(n.label), "The payment split: 40/60 proposed, 50/50 discussed. Still open."],
      [(n) => n.kind === "topic" && /signed/i.test(n.label), "And no signed agreement exists for the revised terms."],
    ],
  };
  function stopStory() { clearTimeout(storyTimer); storyTimer = null; $("#story-cap").textContent = ""; $("#story").textContent = "▶ How the answer was chosen"; }
  $("#story").onclick = () => {
    if (storyTimer) { stopStory(); fit(); return; }
    const steps = (STORIES[caseId] ?? []).map(([f, cap]) => [nodes.find(f), cap]).filter(([n]) => n);
    let i = 0;
    $("#story").textContent = "■ Stop";
    const next = () => {
      if (i >= steps.length) { stopStory(); selected = null; focusSet = null; closePanel(); fit(); return; }
      const [n, cap] = steps[i++];
      select(n);
      $("#story-cap").textContent = cap;
      storyTimer = setTimeout(next, 3400);
    };
    next();
  };

  load(caseId).then(() => {
    if (new URLSearchParams(location.search).get("story") === "1") setTimeout(() => $("#story").click(), 1500);
  });
  requestAnimationFrame(draw);
})();
