// PDF parsing with Mozilla pdf.js (text layer) plus local OCR for pages that
// have no text layer. Layout analysis here is deliberately modest and
// testable: column detection by vertical gutter, line grouping by baseline,
// table detection by aligned cell runs, heading detection by relative font
// size, and repeated page furniture detection. It is NOT a learned layout
// model; ingest/fixtures/gold.json measures where it holds and where it fails.
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { IngestError, LIMITS, OCR_REVIEW_CONFIDENCE } from "./errors.mjs";
import { recognize, encodePng, OCR_ENGINE } from "./ocr.mjs";

export const PDF_PARSER = `pdf.js@${pdfjs.version} + vm-layout/1`;

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
          page.objs.get(args[0], (o) => {
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

export async function parsePdf(buf) {
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
  let ocrBudget = LIMITS.maxOcrPages;
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
        return { str: i.str, x0: e - vx0, x1: e - vx0 + i.width, y: f, size };
      });
    const info = {
      number: n,
      width: r1(vp.width),
      height: r1(vp.height),
      rotation: page.rotate,
      textSource: "pdf",
      columns: 1,
    };
    if (!items.length) {
      info.textSource = "none";
      if (ocrBudget > 0) {
        const images = await extractImages(page, pdfjs.OPS);
        const blocks = [];
        for (const { obj, ctm } of images) {
          const png = imageToPng(obj);
          if (!png) continue;
          ocrBudget--;
          const res = await recognize(png);
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
            for (const u of p.uncertain)
              warnings.push({
                code: "ocr_uncertain_number",
                page: n,
                message: `OCR is unsure about "${u.text}" on page ${n} (${u.confidence}% confidence). Check it against the original.`,
              });
          }
        }
        if (blocks.length) {
          info.textSource = "ocr";
          ocrBlocks.set(n, blocks);
        }
      }
      if (info.textSource === "none")
        warnings.push({
          code: "no_text_layer",
          page: n,
          message:
            ocrBudget <= 0
              ? `Page ${n} has no text layer and the OCR page limit (${LIMITS.maxOcrPages}) was reached.`
              : `Page ${n} has no readable text, even with OCR.`,
        });
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
  }

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
    for (const l of lines) {
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
      const isRow =
        l.cells.length >= 3 ||
        (table && l.cells.length >= 2 && l.group === table.group);
      if (isRow) {
        flushPara();
        if (
          !table ||
          l.group !== table.group ||
          (prev && prev.y - l.y > 3 * l.size)
        ) {
          flushTable();
          table = { group: l.group, rows: [] };
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

  const ocrConfs = blocks
    .filter((b) => b.method === "ocr")
    .map((b) => b.confidence);
  const meanOcr = ocrConfs.length
    ? ocrConfs.reduce((a, b) => a + b, 0) / ocrConfs.length
    : null;
  if (meanOcr !== null && meanOcr < OCR_REVIEW_CONFIDENCE)
    warnings.push({
      code: "ocr_low_confidence",
      message: `Text on the scanned pages was read with ${Math.round(meanOcr)}% average OCR confidence. Review it before relying on numbers.`,
    });
  const parser = { name: PDF_PARSER, ocr: ocrConfs.length ? OCR_ENGINE : null };
  await doc.destroy();
  return { blocks, pages, warnings, parser };
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
