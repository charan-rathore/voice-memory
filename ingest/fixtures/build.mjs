// Deterministic fixture builder for the ingestion benchmark.
// Every fixture is synthetic and fictional. The gold labels in gold.json were
// written from the CONTENT constants below before any parser ran on them;
// they must never be regenerated from parser output.
//
// Usage: node ingest/fixtures/build.mjs   (writes into ingest/fixtures/files/)
import { PDFDocument, StandardFonts, degrees, rgb } from "pdf-lib";
import { zipSync, strToU8 } from "fflate";
import { mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { chromium } from "playwright";

const OUT = new URL("./files/", import.meta.url);
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
const put = (name, bytes) => writeFileSync(new URL(name, OUT), bytes);

// ---------------------------------------------------------------- content
export const SITE_VISIT = {
  title: "Harbor Logistics Site Visit Report",
  p1: [
    "Visit date: 12 August 2026. Prepared by the regional operations team.",
    "The east warehouse recorded 14 open safety items during the inspection.",
    "Loading bay 3 remains closed until the dock leveller is replaced.",
  ],
  p2: [
    "Follow-up actions",
    "Facilities lead Anika Rao will confirm the leveller delivery date by 29 August 2026.",
    "The revised maintenance budget of $18,400 is proposed and not yet approved.",
  ],
};

export const TWO_COL = {
  title: "Quarterly Field Notes",
  left: [
    "Left column first paragraph: the river crossing survey began on Monday.",
    "Left column second paragraph: soil samples were sent to the lab.",
  ],
  right: [
    "Right column first paragraph: the bridge design review is pending.",
    "Right column second paragraph: the contractor shortlist has three names.",
  ],
};

// Lab table chosen to break naive extraction: 1.2 vs 12, 0.05 vs 0.5, a "<"
// comparator, and two analytes sharing a unit.
export const LAB_ROWS = [
  ["Test", "Result", "Unit", "Reference range", "Flag"],
  ["Hemoglobin", "12.1", "g/dL", "13.0-17.0", "L"],
  ["HbA1c", "6.4", "%", "4.0-5.6", "H"],
  ["Creatinine", "1.2", "mg/dL", "0.7-1.3", ""],
  ["Urea", "12", "mg/dL", "7-20", ""],
  ["TSH", "<0.05", "mIU/L", "0.40-4.00", "L"],
  ["Ferritin", "0.5", "ng/mL", "30-400", "L"],
];
export const LAB_META = {
  title: "Synthetic Laboratory Report",
  patient: "Patient: Test Person A (synthetic), ID SYN-0001",
  collected: "Collected: 03 September 2026  Reported: 04 September 2026",
  status: "Report status: FINAL",
};

export const REPEATED = [
  {
    heading: "Observations",
    fact: "Page one observation: generator A tested at 230 volts.",
  },
  {
    heading: "Observations",
    fact: "Page two observation: generator B tested at 215 volts.",
  },
  {
    heading: "Observations",
    fact: "Page three observation: generator C failed to start.",
  },
];

export const DOCX = {
  title: "Vendor Review Minutes",
  paragraphs: [
    "Attendees: procurement, finance and the vendor account team.",
    "The vendor proposed a unit price of $4.20 per item for the 2027 contract.",
  ],
  heading2: "Pricing table",
  table: [
    ["Item", "Unit price", "Status"],
    ["Standard pallet", "$4.20", "Proposed"],
    ["Cold-chain pallet", "$6.85", "Approved"],
  ],
  closing: "Finance approval for the standard pallet price is still pending.",
};

export const PRINTED = [
  "Clinic Visit Summary (synthetic)",
  "Blood pressure: 128/82 mmHg",
  "Follow-up appointment on 14 November 2026",
  "Bring the previous lipid panel report",
];

export const CHROME_LAB = {
  title: "Synthetic Chemistry Panel",
  patient: "Patient: Test Person B (synthetic), ID SYN-0002",
  dates: "Collected 05 September 2026, reported 06 September 2026",
  rows: [
    ["Analyte", "Result", "Units", "Reference interval", "Flag"],
    ["Glucose (fasting)", "104", "mg/dL", "70-99", "H"],
    ["Total cholesterol", "5.2", "mmol/L", "<5.0", "H"],
    ["Potassium", "4.1", "mmol/L", "3.5-5.1", ""],
    ["Vitamin B12", "<150", "pg/mL", "200-900", "L"],
    ["eGFR", ">90", "mL/min/1.73m2", "", ""],
  ],
  amendment:
    "Amended 06 September 2026: potassium result corrected from 41 to 4.1 (transcription error).",
};

export const COLUMNS = {
  title: "Field Station Newsletter",
  paragraphs: [
    "Alpha paragraph. The north field station replaced its weather mast in July, and the new anemometer has logged continuous readings since the second week of the month without a gap.",
    "Bravo paragraph. Water sampling moved from weekly to fortnightly after the regional lab confirmed that turnaround times would stay under ten working days for the rest of the season.",
    "Charlie paragraph. Two volunteers completed first-aid refresher training, and the station's emergency radio was tested against the district relay on the first Monday of September.",
    "Delta paragraph. The solar array upgrade is proposed for November, but the funding request has not been approved and the current batteries will be kept in service until then.",
  ],
};

export const BP_ROWS = Array.from({ length: 70 }, (_, i) => [
  `Day ${i + 1}`,
  String(118 + ((i * 7) % 23)),
  String(76 + ((i * 5) % 13)),
  "mmHg",
]);

// ------------------------------------------------------------- builders
async function pdfWithLines(pages, { rotate } = {}) {
  const doc = await PDFDocument.create();
  doc.setCreationDate(new Date("2026-09-01T00:00:00Z"));
  doc.setModificationDate(new Date("2026-09-01T00:00:00Z"));
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  for (const lines of pages) {
    const page = doc.addPage([595, 842]);
    if (rotate) page.setRotation(degrees(rotate));
    for (const l of lines)
      page.drawText(l.text, {
        x: l.x ?? 56,
        y: l.y,
        size: l.size ?? 11,
        font: l.bold ? bold : font,
        color: rgb(0, 0, 0),
      });
  }
  return doc.save({ useObjectStreams: false });
}

const flow = (items, start = 780, gap = 22) =>
  items.map((t, i) => ({
    ...(typeof t === "string" ? { text: t } : t),
    y: start - i * gap,
  }));

// 1. Digital, two pages.
put(
  "digital.pdf",
  await pdfWithLines([
    flow([{ text: SITE_VISIT.title, size: 18, bold: true }, ...SITE_VISIT.p1]),
    flow([
      { text: SITE_VISIT.p2[0], size: 14, bold: true },
      ...SITE_VISIT.p2.slice(1),
    ]),
  ]),
);

// 2. Two-column. Lines are drawn interleaved (right before left on each row)
// so content-stream order is WRONG for reading; layout analysis must fix it.
{
  const lines = [{ text: TWO_COL.title, size: 16, bold: true, y: 780 }];
  const wrap = (s) => {
    const words = s.split(" ");
    const out = [];
    let cur = "";
    for (const w of words) {
      if ((cur + " " + w).trim().length > 34) {
        out.push(cur.trim());
        cur = w;
      } else cur += " " + w;
    }
    if (cur.trim()) out.push(cur.trim());
    return out;
  };
  const col = (paras) => paras.flatMap((p) => [...wrap(p), ""]);
  const L = col(TWO_COL.left);
  const R = col(TWO_COL.right);
  for (let i = 0; i < Math.max(L.length, R.length); i++) {
    const y = 740 - i * 16;
    if (R[i]) lines.push({ text: R[i], x: 320, y, size: 10 });
    if (L[i]) lines.push({ text: L[i], x: 56, y, size: 10 });
  }
  put("two-column.pdf", await pdfWithLines([lines]));
}

// 3. Lab table: each cell drawn as its own text run at a column x position.
{
  const xs = [56, 200, 270, 340, 470];
  const lines = [
    { text: LAB_META.title, size: 16, bold: true, y: 790 },
    { text: LAB_META.patient, y: 765 },
    { text: LAB_META.collected, y: 748 },
    { text: LAB_META.status, y: 731 },
  ];
  LAB_ROWS.forEach((row, r) =>
    row.forEach((cell, c) => {
      if (cell)
        lines.push({ text: cell, x: xs[c], y: 690 - r * 20, bold: r === 0 });
    }),
  );
  lines.push({
    text: "Values flagged L or H are outside the laboratory's reference range.",
    y: 520,
    size: 9,
  });
  put("lab-table.pdf", await pdfWithLines([lines]));
}

// 4. Repeated headings and footers on every page.
put(
  "repeated-headings.pdf",
  await pdfWithLines(
    REPEATED.map((p, i) => [
      { text: p.heading, size: 14, bold: true, y: 780 },
      { text: p.fact, y: 750 },
      { text: "Confidential - internal use only", y: 40, size: 8 },
    ]),
  ),
);

// 5. Rotated page (page /Rotate 90): text must still be extracted in order.
put(
  "rotated.pdf",
  await pdfWithLines(
    [
      flow([
        "Rotated page heading",
        "This page is stored with a 90 degree rotation flag.",
      ]),
    ],
    {
      rotate: 90,
    },
  ),
);

// 6. Image of printed text (rendered by Chromium) -> PNG and JPEG.
let pngBytes;
{
  const browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH || undefined,
  });
  const page = await browser.newPage({
    viewport: { width: 900, height: 320 },
    deviceScaleFactor: 2,
  });
  await page.setContent(
    `<body style="margin:0;background:#fff"><div style="padding:28px 36px;font:24px/1.6 'DejaVu Sans',sans-serif;color:#111">${PRINTED.map(
      (l) => `<div>${l}</div>`,
    ).join("")}</div></body>`,
  );
  pngBytes = await page.screenshot({ type: "png" });
  put("printed.png", pngBytes);
  put("printed.jpg", await page.screenshot({ type: "jpeg", quality: 85 }));

  // Chromium-printed PDFs: real glyph runs, kerning splits, CSS layout.
  const esc = (s) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const pdfPage = await browser.newPage();
  const printPdf = async (name, html) => {
    await pdfPage.setContent(
      `<!doctype html><html><head><style>body{font:11pt/1.45 'DejaVu Sans',sans-serif;color:#111;margin:0}h1{font-size:18pt;margin:0 0 8pt}h2{font-size:13pt}table{border-collapse:collapse;width:100%}th,td{border:1px solid #999;padding:4pt 6pt;text-align:left}</style></head><body>${html}</body></html>`,
    );
    put(
      name,
      await pdfPage.pdf({
        format: "A4",
        margin: { top: "18mm", bottom: "18mm", left: "16mm", right: "16mm" },
      }),
    );
  };
  await printPdf(
    "chrome-lab.pdf",
    `<h1>${esc(CHROME_LAB.title)}</h1><p>${esc(CHROME_LAB.patient)}</p><p>${esc(CHROME_LAB.dates)}</p><table><thead><tr>${CHROME_LAB.rows[0]
      .map((c) => `<th>${esc(c)}</th>`)
      .join("")}</tr></thead><tbody>${CHROME_LAB.rows
      .slice(1)
      .map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join("")}</tr>`)
      .join("")}</tbody></table><p>${esc(CHROME_LAB.amendment)}</p>`,
  );
  await printPdf(
    "chrome-columns.pdf",
    `<h1>${esc(COLUMNS.title)}</h1><div style="columns:2;column-gap:18pt">${COLUMNS.paragraphs.map((p) => `<p>${esc(p)}</p>`).join("")}</div>`,
  );
  await printPdf(
    "chrome-multipage-table.pdf",
    `<h1>Home blood pressure log (synthetic)</h1><table><thead><tr><th>Day</th><th>Systolic</th><th>Diastolic</th><th>Unit</th></tr></thead><tbody>${BP_ROWS.map(
      (r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`,
    ).join("")}</tbody></table>`,
  );
  await browser.close();
}

// 7. Scanned PDF: one page that is only an image, no text layer.
{
  const doc = await PDFDocument.create();
  const img = await doc.embedPng(pngBytes);
  const page = doc.addPage([595, 842]);
  page.drawImage(img, { x: 20, y: 600, width: 555, height: 198 });
  put("scanned.pdf", await doc.save({ useObjectStreams: false }));
}

// 8. Encrypted PDF (user password) via qpdf.
execFileSync("qpdf", [
  "--encrypt",
  "user-secret",
  "owner-secret",
  "256",
  "--",
  new URL("digital.pdf", OUT).pathname,
  new URL("encrypted.pdf", OUT).pathname,
]);

// 9. Corrupted: a PDF header followed by noise.
{
  const noise = Buffer.alloc(4096);
  let x = 1234567;
  for (let i = 0; i < noise.length; i++) {
    x = (x * 1103515245 + 12345) >>> 0;
    noise[i] = x >>> 24;
  }
  put("corrupted.pdf", Buffer.concat([Buffer.from("%PDF-1.7\n"), noise]));
}

// 10. DOCX with headings, paragraphs and a table (hand-written OOXML).
{
  const esc = (s) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const p = (t, style) =>
    `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ""}<w:r><w:t xml:space="preserve">${esc(t)}</w:t></w:r></w:p>`;
  const tbl = (rows) =>
    `<w:tbl>${rows
      .map(
        (r) =>
          `<w:tr>${r.map((c) => `<w:tc><w:p><w:r><w:t>${esc(c)}</w:t></w:r></w:p></w:tc>`).join("")}</w:tr>`,
      )
      .join("")}</w:tbl>`;
  const body =
    p(DOCX.title, "Title") +
    DOCX.paragraphs.map((t) => p(t)).join("") +
    p(DOCX.heading2, "Heading2") +
    tbl(DOCX.table) +
    p(DOCX.closing);
  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`;
  const contentTypes = `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`;
  const fixed = { mtime: new Date("2026-09-01T00:00:00Z") };
  put(
    "minutes.docx",
    zipSync(
      {
        "[Content_Types].xml": [strToU8(contentTypes), fixed],
        "word/document.xml": [strToU8(documentXml), fixed],
      },
      { level: 6 },
    ),
  );
  // Decompression bomb: a tiny archive whose document.xml inflates to 64 MB.
  put(
    "bomb.docx",
    zipSync(
      {
        "[Content_Types].xml": [strToU8(contentTypes), fixed],
        "word/document.xml": [new Uint8Array(64 * 1024 * 1024).fill(32), fixed],
      },
      { level: 9 },
    ),
  );
}

// 11. Text formats.
put(
  "notes.txt",
  "Weekly call notes (fictional)\n\nThe pilot launch moved to 18 November 2026.\nNo budget change was discussed.\n",
);
put(
  "memo.md",
  "# Renewal memo\n\n## Context\n\nThe renewal fee of $9,600 was proposed on 2 October 2026.\n\n## Open questions\n\nLegal review is pending.\n",
);

// 12. Mislabelled and binary files.
put("fake.pdf", pngBytes);
put(
  "binary.txt",
  Buffer.from([0x48, 0x69, 0x00, 0x00, 0xff, 0xfe, 0x01, 0x02, 0x48, 0x69]),
);
put("empty.txt", Buffer.alloc(0));

console.log("fixtures written to", OUT.pathname);
