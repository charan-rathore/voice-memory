// PDF parsing with Mozilla pdf.js (text layer) plus local OCR for pages that
// have no text layer. Layout analysis here is deliberately modest and
// testable: column detection by vertical gutter, line grouping by baseline,
// table detection by aligned cell runs, heading detection by relative font
// size, and repeated page furniture detection. It is NOT a learned layout
// model; ingest/fixtures/gold.json measures where it holds and where it fails.
import * as pdfjs from "pdfjs-dist/build/pdf.mjs";
import { IngestError, LIMITS, OCR_REVIEW_CONFIDENCE } from "./errors.mjs";
import { recognize, encodePng, OCR_ENGINE } from "./ocr.mjs";

export const PDF_PARSER = `pdf.js@${pdfjs.version} standard + vm-layout/1`;

const median = (xs) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};
const r1 = (n) => Math.round(n * 10) / 10;

function viewBox(vp, x0, yBottom, x1, yTop) {
  const [ax, ay] = vp.convertToViewportPoint(x0, yBottom);
  const [bx, by] = vp.convertToViewportPoint(x1, yTop);
  return [
    r1(Math.min(ax, bx)),
    r1(Math.min(ay, by)),
    r1(Math.max(ax, bx)),
    r1(Math.max(ay, by)),
  ];
}

/** Split items into reading-order groups: spanning items, then column bands. */
function readingGroups(items, pageWidth) {
  const body = items.filter((i) => i.x1 - i.x0 < pageWidth * 0.6);
  let gutter = null;
  if (body.length >= 6) {
    const cover = new Uint8Array(Math.ceil(pageWidth) + 1);
    for (const i of body)
      for (
        let x = Math.max(0, Math.floor(i.x0));
        x <= Math.min(cover.length - 1, Math.ceil(i.x1));
        x++
      )
        cover[x] = 1;
    let best = null;
    for (
      let x = Math.floor(pageWidth * 0.3), run = 0;
      x <= Math.ceil(pageWidth * 0.7);
      x++
    ) {
      if (!cover[x]) {
        run++;
        if (run >= 10 && (!best || run > best.run))
          best = { run, center: x - run / 2 };
      } else run = 0;
    }
    if (best) {
      const left = body.filter((i) => i.x1 <= best.center);
      const right = body.filter((i) => i.x0 >= best.center);
      const wide = (side) =>
        median(side.map((i) => i.x1 - i.x0)) >= pageWidth * 0.2;
      // Prose columns, not narrow table cells.
      if (left.length >= 3 && right.length >= 3 && wide(left) && wide(right))
        gutter = best.center;
    }
  }
  const sorted = [...items].sort((a, b) => b.y - a.y || a.x0 - b.x0);
  if (gutter === null) return { groups: [sorted], columns: 1 };
  const groups = [];
  let left = [];
  let right = [];
  const flush = () => {
    if (left.length) groups.push(left);
    if (right.length) groups.push(right);
    left = [];
    right = [];
  };
  for (const i of sorted) {
    if (i.x1 <= gutter) left.push(i);
    else if (i.x0 >= gutter) right.push(i);
    else {
      flush();
      groups.push([i]);
    }
  }
  flush();
  return { groups, columns: 2 };
}

/** Baseline grouping, then cell splitting on wide gaps. */
function toLines(group) {
  const lines = [];
  for (const it of group) {
    const line = lines.find(
      (l) => Math.abs(l.y - it.y) <= 0.35 * Math.max(l.size, it.size),
    );
    if (line) {
      line.items.push(it);
      line.size = Math.max(line.size, it.size);
    } else lines.push({ y: it.y, size: it.size, items: [it] });
  }
  for (const l of lines) {
    l.items.sort((a, b) => a.x0 - b.x0);
    const cells = [];
    let cur = null;
    for (const it of l.items) {
      if (cur && it.x0 - cur.x1 <= Math.max(l.size * 1.0, 6)) {
        const gap = it.x0 - cur.x1;
        const needsSpace =
          gap > l.size * 0.12 &&
          !cur.text.endsWith(" ") &&
          !it.str.startsWith(" ");
        cur.text += (needsSpace ? " " : "") + it.str;
        cur.x1 = Math.max(cur.x1, it.x1);
      } else {
        cur = { text: it.str, x0: it.x0, x1: it.x1 };
        cells.push(cur);
      }
    }
    l.cells = cells
      .map((c) => ({ ...c, text: c.text.replace(/\s+/g, " ").trim() }))
      .filter((c) => c.text);
    l.x0 = Math.min(...l.items.map((i) => i.x0));
    l.x1 = Math.max(...l.items.map((i) => i.x1));
    l.text = l.cells.map((c) => c.text).join(" ");
  }
  return lines
    .filter((l) => l.cells.length)
    .sort((a, b) => b.y - a.y || a.x0 - b.x0);
}

function furnitureKey(text) {
  return text.toLowerCase().replace(/\d+/g, "#").replace(/\s+/g, " ").trim();
}

async function extractImages(page, OPS) {
  const ops = await page.getOperatorList();
  const images = [];
  let ctm = [1, 0, 0, 1, 0, 0];
  const stack = [];
  const mul = (m, n) => [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
  for (let k = 0; k < ops.fnArray.length; k++) {
    const fn = ops.fnArray[k];
    const args = ops.argsArray[k];
    if (fn === OPS.save) stack.push(ctm);
    else if (fn === OPS.restore) ctm = stack.pop() ?? [1, 0, 0, 1, 0, 0];
    else if (fn === OPS.transform) ctm = mul(ctm, args);
    else if (fn === OPS.paintImageXObject) {
      try {
        const obj = await new Promise((resolve, reject) => {
          const t = setTimeout(() => reject(Error("image timeout")), 10000);
          // pdf.js promotes image objects reused across pages to commonObjs.
          const objects = args[0].startsWith("g_")
            ? page.commonObjs
            : page.objs;
          objects.get(args[0], (o) => {
            clearTimeout(t);
            resolve(o);
          });
        });
        if (obj?.data && obj.width && obj.height)
          images.push({ obj, ctm: [...ctm] });
      } catch {
        /* undecodable image: reported as no text below */
      }
    }
  }
  return images;
}

function imageToPng(obj) {
  const { width, height, data, kind } = obj;
  if (width * height > LIMITS.maxImagePixels) return null;
  if (kind === 2) return encodePng(width, height, data, 3);
  if (kind === 3) return encodePng(width, height, data, 4);
  if (kind === 1) {
    // 1 bit per pixel, rows padded to bytes; expand to 8-bit gray.
    const gray = new Uint8Array(width * height);
    const rowBytes = (width + 7) >> 3;
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++)
        gray[y * width + x] =
          data[y * rowBytes + (x >> 3)] & (0x80 >> (x & 7)) ? 255 : 0;
    return encodePng(width, height, gray, 1);
  }
  return null;
}

// Some fonts (Calibri via Word "Save as PDF") map their ligature glyphs to
// unrelated code points in the ToUnicode table: "Patient" arrives as
// "PaƟent", "after" as "aŌer". Restore the letters so search and lab-name
// matching see the words that are printed.
const LIGATURES = {
  "\u019f": "ti",
  "\u014c": "ft",
  "\u01a9": "tt",
  "\ufb00": "ff",
  "\ufb01": "fi",
  "\ufb02": "fl",
  "\ufb03": "ffi",
  "\ufb04": "ffl",
};
export const fixLigatures = (s) =>
  s.replace(/[\u019f\u014c\u01a9\ufb00-\ufb04]/g, (c) => LIGATURES[c]);

/**
 * Two phases, so a mostly-digital PDF with a few scanned pages is answerable
 * long before OCR finishes: every page's text layer is read first and handed
 * to `onPartial` (scanned pages marked ocrPending), then the scanned pages
 * are OCR'd and the full result is returned. `onEvent` receives small,
 * content-free progress records (page numbers, counts, OCR %) for the
 * on-screen pipeline view; it never sees document text.
 */
export async function parsePdf(
  buf,
  { onEvent = () => {}, onPartial = null, waitForOcr = null } = {},
) {
  let doc;
  try {
    doc = await pdfjs.getDocument({
      data: new Uint8Array(buf),
      isEvalSupported: false,
      disableFontFace: true,
      useSystemFonts: false,
      verbosity: 0,
    }).promise;
  } catch (e) {
    if (e?.name === "PasswordException")
      throw new IngestError(
        "encrypted",
        "This PDF is password-protected. Remove the password (for example, print it to a new PDF) and upload it again.",
        { stage: "parsing" },
      );
    throw new IngestError(
      "corrupted",
      "This PDF could not be opened. It may be damaged or incomplete.",
      {
        stage: "parsing",
      },
    );
  }
  if (doc.numPages > LIMITS.maxPdfPages)
    throw new IngestError(
      "too_many_pages",
      `This PDF has ${doc.numPages} pages. The current limit is ${LIMITS.maxPdfPages} pages per file.`,
      { stage: "parsing" },
    );
  const warnings = [];
  const pages = [];
  const pageLines = []; // per page: lines with page/bbox
  const ocrBlocks = new Map(); // page -> blocks
  const scans = []; // pages with no text layer, OCR'd after the text pass
  let ocrBudget = LIMITS.maxOcrPages;
  onEvent({ k: "open", pages: doc.numPages });
  for (let n = 1; n <= doc.numPages; n++) {
    let page;
    try {
      page = await doc.getPage(n);
    } catch {
      warnings.push({
        code: "page_unreadable",
        page: n,
        message: `Page ${n} could not be read.`,
      });
      pages.push({
        number: n,
        width: null,
        height: null,
        rotation: 0,
        textSource: "none",
      });
      pageLines.push([]);
      continue;
    }
    const vp = page.getViewport({ scale: 1 });
    const [vx0, , vx1] = page.view;
    const pageWidth = vx1 - vx0;
    const tc = await page.getTextContent();
    const items = tc.items
      .filter((i) => typeof i.str === "string" && i.str.trim())
      .map((i) => {
        const [a, b, c, d, e, f] = i.transform;
        const size = Math.hypot(c, d) || Math.hypot(a, b) || i.height || 10;
        return {
          str: fixLigatures(i.str),
          x0: e - vx0,
          x1: e - vx0 + i.width,
          y: f,
          size,
        };
      });
    // A declared Watermark annotation is a stamp layered OVER the page
    // text (LalPath "Sample Report" copies). pdf.js does not put its
    // appearance text into the text content, and encrypted documents
    // cannot be raw-parsed, so which cells it covers is unknown here:
    // the page is flagged, and answers qualify provenance accordingly.
    let watermark = false;
    try {
      const anns = await page.getAnnotations();
      watermark = anns.some((a) => a?.subtype === "Watermark");
    } catch {
      watermark = false;
    }
    const info = {
      number: n,
      width: r1(vp.width),
      height: r1(vp.height),
      rotation: page.rotate,
      textSource: "pdf",
      columns: 1,
      watermark,
    };
    if (!items.length) {
      info.textSource = "none";
      info.ocrPending = true;
      scans.push({ n, page, vp, info });
      onEvent({ k: "scan", n });
      pages.push(info);
      pageLines.push([]);
      continue;
    }
    const { groups, columns } = readingGroups(items, pageWidth);
    info.columns = columns;
    const lines = [];
    groups.forEach((g, gi) => {
      for (const l of toLines(g)) {
        l.group = gi;
        l.page = n;
        l.vp = vp;
        l.pageHeight = page.view[3] - page.view[1];
        l.bbox = viewBox(
          vp,
          l.x0 + vx0,
          l.y - 0.22 * l.size,
          l.x1 + vx0,
          l.y + 0.78 * l.size,
        );
        lines.push(l);
      }
    });
    pageLines.push(lines);
    pages.push(info);
    onEvent({
      k: "text",
      n,
      lines: lines.length,
      chars: lines.reduce((a, l) => a + l.text.length, 0),
    });
  }

  const ocrWarnings = [];
  const finish = (final) => {
    const blocks = assemble(pageLines, pages, ocrBlocks);
    const ws = [...warnings, ...ocrWarnings];
    const ocrConfs = blocks
      .filter((b) => b.method === "ocr")
      .map((b) => b.confidence);
    const meanOcr = ocrConfs.length
      ? ocrConfs.reduce((a, b) => a + b, 0) / ocrConfs.length
      : null;
    if (meanOcr !== null && meanOcr < OCR_REVIEW_CONFIDENCE)
      ws.push({
        code: "ocr_low_confidence",
        message: `Text on the scanned pages was read with ${Math.round(meanOcr)}% average OCR confidence. Review it before relying on numbers.`,
      });
    if (!final)
      for (const s of scans)
        ws.push({
          code: "ocr_pending",
          page: s.n,
          message: `Page ${s.n} is a scanned image and is still being read.`,
        });
    const count = (t) => blocks.filter((b) => b.type === t).length;
    onEvent({
      k: final ? "layout" : "layout-partial",
      tables: count("table"),
      headings: count("heading"),
      paragraphs: count("paragraph"),
      furniture: count("furniture"),
    });
    return {
      blocks,
      pages: pages.map((p) => ({ ...p })),
      warnings: ws,
      parser: {
        name: PDF_PARSER,
        ocr: ocrConfs.length ? OCR_ENGINE : null,
      },
    };
  };

  // Phase 1 done: everything with a text layer is readable now.
  if (scans.length && onPartial && pages.some((p) => p.textSource === "pdf"))
    await onPartial(finish(false));

  // Phase 2: OCR the scanned pages. OCR is the memory-heavy step, so when
  // several files are read at once they take turns at it (waitForOcr); the
  // text pages above were already read concurrently.
  if (scans.length && ocrBudget > 0 && waitForOcr) {
    onEvent({ k: "ocr-wait" });
    await waitForOcr();
  }
  for (const { n, page, vp, info } of scans) {
    delete info.ocrPending;
    if (ocrBudget > 0) {
      onEvent({ k: "ocr-start", n });
      const images = await extractImages(page, pdfjs.OPS);
      const blocks = [];
      let uncertainCount = 0;
      for (const { obj, ctm } of images) {
        const png = imageToPng(obj);
        if (!png) continue;
        ocrBudget--;
        let last = -1;
        const res = await recognize(png, {
          onProgress: (p) => {
            const pct = Math.floor(p * 20) * 5;
            if (pct !== last) {
              last = pct;
              onEvent({ k: "ocr", n, p: pct });
            }
          },
        });
        const toUser = (px, py) => {
          const u = px / obj.width;
          const v = 1 - py / obj.height;
          return [
            ctm[0] * u + ctm[2] * v + ctm[4],
            ctm[1] * u + ctm[3] * v + ctm[5],
          ];
        };
        for (const p of res.paragraphs) {
          const [ux0, uy0] = toUser(p.bbox.x0, p.bbox.y1);
          const [ux1, uy1] = toUser(p.bbox.x1, p.bbox.y0);
          blocks.push({
            type: "paragraph",
            text: p.text.replace(/\n/g, " "),
            page: n,
            bbox: viewBox(
              vp,
              Math.min(ux0, ux1),
              Math.min(uy0, uy1),
              Math.max(ux0, ux1),
              Math.max(uy0, uy1),
            ),
            method: "ocr",
            confidence: Math.round(p.confidence),
          });
          for (const u of p.uncertain) {
            uncertainCount++;
            ocrWarnings.push({
              code: "ocr_uncertain_number",
              page: n,
              message: `OCR is unsure about "${u.text}" on page ${n} (${u.confidence}% confidence). Check it against the original.`,
            });
          }
        }
      }
      if (blocks.length) {
        info.textSource = "ocr";
        ocrBlocks.set(n, blocks);
      }
      // Kept on the page record itself so a cached parse can re-stamp the
      // same per-page facts (the reading view's page tiles read them).
      info.ocrConfidence = blocks.length
        ? Math.round(
            blocks.reduce((a, b) => a + b.confidence, 0) / blocks.length,
          )
        : null;
      info.ocrUncertain = uncertainCount;
      onEvent({
        k: "ocr-done",
        n,
        paragraphs: blocks.length,
        confidence: info.ocrConfidence,
        uncertain: uncertainCount,
      });
    }
    if (info.textSource === "none") {
      onEvent({ k: "ocr-skip", n, budget: ocrBudget <= 0 });
      ocrWarnings.push({
        code: "no_text_layer",
        page: n,
        message:
          ocrBudget <= 0
            ? `Page ${n} has no text layer and the OCR page limit (${LIMITS.maxOcrPages}) was reached.`
            : `Page ${n} has no readable text, even with OCR.`,
      });
    }
  }
  const out = finish(true);
  await doc.destroy();
  return out;
}

/** Reading-order blocks from text-layer lines plus any OCR'd pages. */
function assemble(pageLines, pages, ocrBlocks) {
  // Page furniture: margin lines whose digit-normalized text repeats on 2+ pages.
  const furniture = new Set();
  if (pages.length > 1) {
    const seen = new Map();
    for (const lines of pageLines)
      for (const l of lines) {
        const inMargin = l.y < l.pageHeight * 0.08 || l.y > l.pageHeight * 0.92;
        if (!inMargin) continue;
        const k = furnitureKey(l.text);
        seen.set(k, (seen.get(k) ?? new Set()).add(l.page));
      }
    for (const [k, ps] of seen) if (ps.size >= 2) furniture.add(k);
  }

  // Document-wide font statistics for heading detection.
  const allLines = pageLines.flat();
  const body = median(
    allLines.flatMap((l) => Array(Math.max(1, l.text.length)).fill(l.size)),
  );
  const headingSizes = [
    ...new Set(
      allLines
        .filter((l) => l.size >= body * 1.2 && l.text.length < 120)
        .map((l) => Math.round(l.size)),
    ),
  ].sort((a, b) => b - a);
  const levelOf = (size) =>
    Math.min(4, headingSizes.indexOf(Math.round(size)) + 1);

  const blocks = [];
  for (let p = 0; p < pageLines.length; p++) {
    if (ocrBlocks.has(p + 1)) {
      blocks.push(...ocrBlocks.get(p + 1));
      continue;
    }
    const lines = pageLines[p];
    const runs = gridRuns(lines, body);
    let para = null;
    let table = null;
    const flushPara = () => {
      if (para) blocks.push(para);
      para = null;
    };
    const flushTable = () => {
      if (!table) return;
      if (table.rows.length >= 2) blocks.push(finalizeTable(table));
      else
        for (const r of table.rows)
          blocks.push({
            type: "paragraph",
            text: r.line.text,
            page: r.line.page,
            bbox: r.line.bbox,
            method: "pdf-text",
          });
      table = null;
    };
    let prev = null;
    // Overlay-scale text (a "Sample Report" stamp or watermark) is far
    // bigger than any heading and crosses rows it is not part of. Keep it
    // out of the reading flow; its box later marks rows whose printed
    // cells are SUSPECTED covered - a heuristic signal, never proof.
    const overlaySize = Math.max(24, body * 4);
    for (const l of lines) {
      // Margin text (barcodes, big folios) is furniture, never an overlay.
      if (
        l.size >= overlaySize &&
        !(l.y < l.pageHeight * 0.08 || l.y > l.pageHeight * 0.92)
      ) {
        flushPara();
        flushTable();
        blocks.push({
          type: "overlay",
          text: l.text,
          page: l.page,
          bbox: l.bbox,
          method: "pdf-text",
        });
        prev = null;
        continue;
      }
      if (
        furniture.has(furnitureKey(l.text)) ||
        (/^(page\s*)?\d+(\s*(of|\/)\s*\d+)?$/i.test(l.text.trim()) &&
          (l.y < l.pageHeight * 0.08 || l.y > l.pageHeight * 0.92))
      ) {
        flushPara();
        flushTable();
        blocks.push({
          type: "furniture",
          text: l.text,
          page: l.page,
          bbox: l.bbox,
          method: "pdf-text",
        });
        prev = null;
        continue;
      }
      const run = runs.get(l) ?? null;
      const isRow =
        run !== null ||
        l.cells.length >= 3 ||
        (table && !table.run && l.cells.length >= 2 && l.group === table.group);
      if (isRow) {
        flushPara();
        if (
          !table ||
          l.group !== table.group ||
          (run !== null
            ? table.run !== run
            : table.run != null || (prev && prev.y - l.y > 3 * l.size))
        ) {
          flushTable();
          table = { group: l.group, rows: [], run };
        }
        table.rows.push({ line: l });
        prev = l;
        continue;
      }
      flushTable();
      const isHeading = l.size >= body * 1.2 && l.text.length < 120;
      const gapBreak =
        prev &&
        (prev.group !== l.group ||
          prev.y - l.y > 1.6 * Math.max(prev.size, l.size));
      const sizeBreak = para && Math.abs(para.size - l.size) > 0.15 * para.size;
      if (isHeading) {
        flushPara();
        blocks.push({
          type: "heading",
          level: levelOf(l.size),
          text: l.text,
          page: l.page,
          bbox: l.bbox,
          method: "pdf-text",
        });
      } else if (!para || gapBreak || sizeBreak) {
        flushPara();
        para = {
          type: "paragraph",
          text: l.text,
          page: l.page,
          bbox: [...l.bbox],
          size: l.size,
          method: "pdf-text",
        };
      } else {
        const joinHyphen = /[a-z]-$/.test(para.text) && /^[a-z]/.test(l.text);
        para.text = joinHyphen
          ? para.text.slice(0, -1) + l.text
          : para.text + " " + l.text;
        para.bbox = [
          Math.min(para.bbox[0], l.bbox[0]),
          Math.min(para.bbox[1], l.bbox[1]),
          Math.max(para.bbox[2], l.bbox[2]),
          Math.max(para.bbox[3], l.bbox[3]),
        ];
      }
      prev = l;
    }
    flushPara();
    flushTable();
  }
  for (const b of blocks) delete b.size;
  return blocks;
}

/**
 * Tables whose rows sit far apart (forms and hospital layouts print one row
 * every 2-3 line heights, often with only two columns: a label and its
 * value) are found by their column grid: consecutive lines whose cells start
 * at the same x positions, in the same reading group, within a few line
 * heights of each other. Returns line -> run id for lines in a run of at
 * least three rows (or two rows of three or more cells). Prose never has
 * cells, so it never forms a run.
 */
function gridRuns(lines, body) {
  const TOL = 6;
  const out = new Map();
  let run = null;
  let id = 0;
  const close = () => {
    if (
      run &&
      (run.lines.length >= 3 ||
        (run.lines.length >= 2 && run.lines.every((l) => l.cells.length >= 3)))
    )
      for (const l of run.lines) out.set(l, run.id);
    run = null;
  };
  const near = (x, anchors) => anchors.some((a) => Math.abs(a - x) <= TOL);
  for (const l of lines) {
    const ok =
      l.cells.length >= 2 &&
      l.cells.length <= 8 &&
      l.size < body * 1.2 &&
      l.size < Math.max(24, body * 4);
    if (!ok) {
      close();
      continue;
    }
    const xs = l.cells.map((c) => c.x0);
    if (run) {
      const last = run.lines[run.lines.length - 1];
      const aligned =
        Math.abs(xs[0] - run.anchors[0]) <= TOL &&
        xs.filter((x) => near(x, run.anchors)).length >= Math.min(2, xs.length);
      const gap = last.y - l.y;
      // Rows of one table are evenly spaced: a gap well beyond the run's
      // own spacing starts the next table, even on the same column grid.
      const evenly = run.maxGap == null || gap <= run.maxGap * 1.5 + 2;
      if (
        l.group === run.group &&
        gap <= 7 * Math.max(l.size, last.size) &&
        aligned &&
        evenly
      ) {
        run.maxGap = Math.max(run.maxGap ?? 0, gap);
        run.lines.push(l);
        for (const x of xs) if (!near(x, run.anchors)) run.anchors.push(x);
        continue;
      }
      close();
    }
    run = { id: ++id, group: l.group, anchors: [...xs], lines: [l] };
  }
  close();
  return out;
}

function finalizeTable(table) {
  // Column anchors from the row with the most cells; every cell is assigned
  // to its nearest anchor so a missing cell (an empty flag) leaves a gap
  // instead of shifting the unit or range into the wrong column.
  const widest = table.rows.reduce((a, b) =>
    b.line.cells.length > a.line.cells.length ? b : a,
  );
  const anchors = widest.line.cells.map((c) => c.x0);
  const rows = table.rows.map(({ line }) => {
    const cells = Array(anchors.length).fill("");
    for (const c of line.cells) {
      let best = 0;
      for (let i = 1; i < anchors.length; i++)
        if (Math.abs(anchors[i] - c.x0) < Math.abs(anchors[best] - c.x0))
          best = i;
      cells[best] = cells[best] ? cells[best] + " " + c.text : c.text;
    }
    return { cells, bbox: line.bbox };
  });
  const first = table.rows[0].line;
  const last = table.rows[table.rows.length - 1].line;
  return {
    type: "table",
    rows,
    page: first.page,
    bbox: [
      Math.min(...rows.map((r) => r.bbox[0])),
      first.bbox[1],
      Math.max(...rows.map((r) => r.bbox[2])),
      last.bbox[3],
    ],
    method: "pdf-text",
  };
}
