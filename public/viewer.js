// Source viewer: shows the ORIGINAL (PDF page rendered by pdf.js, or the
// uploaded image) with the cited region highlighted, and the extracted text
// the answer actually quoted. Both are labelled for what they are.
const $ = (id) => document.getElementById(id);
const cache = new Map();
let current = null; // { id, doc, page, mode, target }
let pdfjs = null;
const pdfCache = new Map();
const reduce = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

async function fetchDoc(id) {
  if (cache.has(id)) return cache.get(id);
  const r = await fetch(`/api/library/${id}`);
  if (!r.ok) throw Error("This document is no longer in the session.");
  const { document } = await r.json();
  cache.set(id, document);
  return document;
}

function targetFor(doc, { evidence, quoteText }) {
  if (evidence?.location) {
    const loc = evidence.location;
    const f = loc.focus;
    // A citation that sits inside ONE element is marked to the character;
    // a chunk-sized citation falls back to the focused element(s).
    const inside = doc.elements.find(
      (e) =>
        e.indexed &&
        e.type !== "table" &&
        !e.parent &&
        e.start <= evidence.start &&
        e.end >= evidence.end,
    );
    const span =
      inside && evidence.end - evidence.start < inside.end - inside.start
        ? {
            id: inside.id,
            from: evidence.start - inside.start,
            to: evidence.end - inside.start,
          }
        : null;
    return {
      span,
      elementIds: f?.elementIds?.length ? f.elementIds : loc.elementIds,
      regions: f?.regions?.length ? f.regions : loc.regions,
      page: (f?.pages?.[0] ?? loc.pages?.[0]) || 1,
      minConfidence: loc.minConfidence,
      methods: loc.methods,
    };
  }
  if (quoteText) {
    const probe = quoteText.replace(/\s+/g, " ").trim().slice(0, 60);
    const hit = doc.elements.find(
      (e) => e.indexed && (e.text ?? "").replace(/\s+/g, " ").includes(probe),
    );
    if (hit)
      return {
        elementIds: [hit.id],
        regions:
          hit.bbox && hit.page ? [{ page: hit.page, bbox: hit.bbox }] : [],
        page: hit.page || 1,
      };
  }
  return { elementIds: [], regions: [], page: 1 };
}

const METHOD_TEXT = {
  "pdf-text": "Text read from the PDF itself.",
  ocr: "Text read from the image by OCR.",
  "docx-xml": "Text read from the Word file.",
  text: "This is the file's own text.",
};

function setMeta(doc, target) {
  const pages = doc.pages?.length;
  $("viewer-title").textContent = doc.filename;
  const bits = [];
  if (pages) bits.push(`${pages} ${pages === 1 ? "page" : "pages"}`);
  const method =
    target.methods?.[0] ?? doc.elements.find((e) => e.indexed)?.method;
  if (method) bits.push(METHOD_TEXT[method] ?? "");
  $("viewer-meta").textContent = bits.join(". ").replace(/\.\./g, ".");
  const note = $("viewer-note");
  if (target.methods?.includes("ocr") || method === "ocr") {
    note.hidden = false;
    note.textContent = `OCR confidence on the cited text: ${target.minConfidence ?? doc.stats?.meanOcrConfidence ?? "?"}%. Numbers are worth checking against the original.`;
  } else if (doc.kind === "docx") {
    note.hidden = false;
    note.textContent =
      "Word files are shown as the text that was read from them; there is no page image.";
  } else note.hidden = true;
}

function hasOriginal(doc) {
  return doc.kind === "pdf" || doc.kind === "png" || doc.kind === "jpeg";
}

function setMode(mode) {
  current.mode = mode;
  $("show-original").setAttribute("aria-pressed", String(mode === "original"));
  $("show-text").setAttribute("aria-pressed", String(mode === "text"));
  render();
}

function renderPager() {
  const n = current.doc.pages?.length ?? 0;
  const show = current.mode === "original" && n > 1;
  $("pager").hidden = !show;
  if (!show) return;
  $("page-label").textContent = `Page ${current.page} of ${n}`;
  $("page-prev").disabled = current.page <= 1;
  $("page-next").disabled = current.page >= n;
}

async function loadPdf(id) {
  if (!pdfjs) {
    pdfjs = await import("/vendor/pdf.min.mjs");
    pdfjs.GlobalWorkerOptions.workerSrc = "/vendor/pdf.worker.min.mjs";
  }
  if (!pdfCache.has(id))
    pdfCache.set(
      id,
      pdfjs.getDocument({
        url: `/api/library/${id}/original`,
        isEvalSupported: false,
        disableFontFace: true,
        standardFontDataUrl: "/vendor/standard_fonts/",
      }).promise,
    );
  return pdfCache.get(id);
}

function overlay(box, regions, page, scaleX, scaleY) {
  for (const r of regions.filter((r) => r.page === page)) {
    const [x0, y0, x1, y1] = r.bbox;
    const m = el("span", "hl-rect");
    const pad = 3;
    m.style.left = `${x0 * scaleX - pad}px`;
    m.style.top = `${y0 * scaleY - pad}px`;
    m.style.width = `${(x1 - x0) * scaleX + pad * 2}px`;
    m.style.height = `${(y1 - y0) * scaleY + pad * 2}px`;
    box.append(m);
  }
}

async function renderOriginal(sheet) {
  const { doc, id, target } = current;
  const page = el("div", "page");
  sheet.append(page);
  if (doc.kind === "pdf") {
    const pdf = await loadPdf(id);
    const p = await pdf.getPage(current.page);
    const vp1 = p.getViewport({ scale: 1 });
    const width = Math.min(sheet.clientWidth - 2, 900);
    const scale = width / vp1.width;
    const vp = p.getViewport({ scale });
    const dpr = Math.min(2, devicePixelRatio || 1);
    const canvas = el("canvas", "page-canvas");
    canvas.width = Math.floor(vp.width * dpr);
    canvas.height = Math.floor(vp.height * dpr);
    canvas.style.width = `${vp.width}px`;
    canvas.style.height = `${vp.height}px`;
    canvas.setAttribute("role", "img");
    canvas.setAttribute(
      "aria-label",
      `Page ${current.page} of ${doc.filename}`,
    );
    page.style.width = `${vp.width}px`;
    page.append(canvas);
    await p.render({
      canvasContext: canvas.getContext("2d"),
      viewport: vp,
      transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null,
    }).promise;
    overlay(page, target.regions, current.page, scale, scale);
  } else {
    const img = el("img", "page-img");
    img.alt = `${doc.filename} (original image)`;
    img.src = `/api/library/${id}/original`;
    page.append(img);
    await img.decode().catch(() => {});
    const pg = doc.pages[0];
    const sx = img.clientWidth / pg.width;
    overlay(page, target.regions, 1, sx, sx);
  }
  const first = page.querySelector(".hl-rect");
  if (first)
    first.scrollIntoView({
      block: "center",
      behavior: reduce() ? "auto" : "smooth",
    });
}

function renderText(sheet) {
  const { doc, target } = current;
  const marked = new Set(target.elementIds);
  // Rows are children of tables: mark the parent table's row instead.
  const article = el("article", "extracted");
  let firstMark = null;
  const top = doc.elements.filter((e) => e.indexed && !e.parent);
  const rowsOf = (t) => doc.elements.filter((e) => e.parent === t.id);
  let lastPage = null;
  for (const e of top) {
    if (e.page && e.page !== lastPage && doc.pages?.length > 1) {
      article.append(el("p", "page-break", `Page ${e.page}`));
      lastPage = e.page;
    }
    let node;
    if (e.type === "heading") node = el(e.level <= 1 ? "h3" : "h4", "", e.text);
    else if (e.type === "table") {
      node = el("table");
      for (const r of rowsOf(e)) {
        const tr = el("tr");
        for (const c of r.cells)
          tr.append(el(r.type === "table-header" ? "th" : "td", "", c));
        if (marked.has(r.id) || marked.has(e.id)) {
          tr.className = "hl-row";
          firstMark ??= tr;
        }
        node.append(tr);
      }
    } else node = el("p", "", e.text);
    const span = target.span?.id === e.id ? target.span : null;
    if (span && node.textContent === e.text) {
      const t = e.text;
      node.replaceChildren(
        document.createTextNode(t.slice(0, span.from)),
        el("mark", "hl", t.slice(span.from, span.to)),
        document.createTextNode(t.slice(span.to)),
      );
      firstMark ??= node;
    } else if (e.type !== "table" && marked.has(e.id)) {
      const m = el("mark", "hl", node.textContent);
      node.replaceChildren(m);
      firstMark ??= node;
    }
    article.append(node);
  }
  sheet.append(article);
  firstMark?.scrollIntoView({
    block: "center",
    behavior: reduce() ? "auto" : "smooth",
  });
}

let renderSeq = 0;
async function render() {
  const seq = ++renderSeq;
  const sheet = $("sheet");
  sheet.replaceChildren();
  sheet.dataset.mode = current.mode;
  renderPager();
  try {
    if (current.mode === "original") await renderOriginal(sheet);
    else renderText(sheet);
  } catch {
    if (seq !== renderSeq) return;
    sheet.replaceChildren(
      el(
        "p",
        "sheet-error",
        "The original couldn't be displayed here. The extracted text is still available.",
      ),
    );
  }
}

export async function openSource({
  documentId,
  evidence,
  quoteText,
  quiet = false,
}) {
  if (!documentId) return;
  const viewer = $("viewer");
  try {
    const doc = await fetchDoc(documentId);
    const target = targetFor(doc, { evidence, quoteText });
    current = {
      id: documentId,
      doc,
      target,
      page: target.page || 1,
      mode: hasOriginal(doc) ? "original" : "text",
    };
    $("show-original").disabled = !hasOriginal(doc);
    setMeta(doc, target);
    viewer.hidden = false;
    document.body.dataset.viewer = "open";
    $("show-original").setAttribute(
      "aria-pressed",
      String(current.mode === "original"),
    );
    $("show-text").setAttribute(
      "aria-pressed",
      String(current.mode === "text"),
    );
    await render();
    if (!quiet) $("viewer-close").focus({ preventScroll: true });
  } catch (e) {
    viewer.hidden = false;
    $("sheet").replaceChildren(el("p", "sheet-error", e.message));
  }
}

export function closeSource(id) {
  if (id) {
    cache.delete(id);
    pdfCache.delete(id);
    if (current?.id !== id) return;
  } else {
    cache.clear();
    pdfCache.clear();
  }
  current = null;
  $("viewer").hidden = true;
  delete document.body.dataset.viewer;
}

$("viewer-close").onclick = () => closeSource(current?.id);
$("show-original").onclick = () => current && setMode("original");
$("show-text").onclick = () => current && setMode("text");
$("page-prev").onclick = () => {
  if (current && current.page > 1) {
    current.page--;
    render();
  }
};
$("page-next").onclick = () => {
  if (current && current.page < (current.doc.pages?.length ?? 1)) {
    current.page++;
    render();
  }
};
addEventListener("keydown", (e) => {
  if (e.key === "Escape" && current) closeSource(current.id);
});
let resizeTimer;
addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => current?.mode === "original" && render(), 200);
});
