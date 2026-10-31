// Synthetic longitudinal lab reports for the clinical prototype. Separate from
// ingest/fixtures so the frozen ingestion benchmark files never change.
// Every patient, value and date here is fictional. Gold expectations live in
// gold.json and were written from these constants before any parser ran.
//
//   node clinical/fixtures/build.mjs
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";

const OUT = new URL("./files/", import.meta.url);
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const HEADER = ["Test", "Result", "Unit", "Reference range", "Flag"];

export const REPORTS = {
  // September report for patient A is ingest/fixtures/files/lab-table.pdf
  // (copied here so the series is self-contained).
  "a-2026-10-prelim.pdf": {
    title: "Synthetic Laboratory Report",
    patient: "Patient: Test Person A (synthetic), ID SYN-0001",
    dates: "Collected: 12 October 2026  Reported: 13 October 2026",
    status: "Report status: PRELIMINARY",
    rows: [
      ["Hemoglobin", "12.9", "g/dL", "13.0-17.0", "L"],
      ["HbA1c", "6.1", "%", "4.0-5.6", "H"],
      ["Creatinine", "106", "µmol/L", "62-115", ""],
      ["Urea", "14", "mg/dL", "7-20", ""],
      ["TSH", "0.30", "mIU/L", "0.40-4.00", "L"],
      ["Ferritin", "5", "ng/mL", "30-400", "L"],
    ],
    notes: [],
  },
  "a-2026-10-amended.pdf": {
    title: "Synthetic Laboratory Report",
    patient: "Patient: Test Person A (synthetic), ID SYN-0001",
    dates: "Collected: 12 October 2026  Reported: 15 October 2026",
    status: "Report status: AMENDED",
    rows: [
      ["Hemoglobin", "12.9", "g/dL", "13.0-17.0", "L"],
      ["HbA1c", "6.1", "%", "4.0-5.6", "H"],
      ["Creatinine", "106", "µmol/L", "62-115", ""],
      ["Urea", "14", "mg/dL", "7-20", ""],
      ["TSH", "0.30", "mIU/L", "0.40-4.00", "L"],
      ["Ferritin", "50", "ng/mL", "30-400", ""],
    ],
    notes: ["Amended 15 October 2026: ferritin result corrected from 5 to 50 (transcription error)."],
  },
  "c-2026-10.pdf": {
    title: "Synthetic Laboratory Report",
    patient: "Patient: Test Person C (synthetic), ID SYN-0003",
    dates: "Collected: 20 October 2026  Reported: 21 October 2026",
    status: "Report status: FINAL",
    rows: [
      ["Hemoglobin", "15.0", "g/dL", "13.0-17.0", ""],
      ["TSH", "2.10", "mIU/L", "0.40-4.00", ""],
    ],
    notes: [],
  },
};

async function labPdf(r) {
  const doc = await PDFDocument.create();
  doc.setCreationDate(new Date("2026-10-20T00:00:00Z"));
  doc.setModificationDate(new Date("2026-10-20T00:00:00Z"));
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const page = doc.addPage([595, 842]);
  const t = (text, x, y, size = 11, f = font) => page.drawText(text, { x, y, size, font: f, color: rgb(0, 0, 0) });
  t(r.title, 56, 790, 16, bold);
  t(r.patient, 56, 765);
  t(r.dates, 56, 748);
  t(r.status, 56, 731);
  const xs = [56, 200, 270, 340, 470];
  [HEADER, ...r.rows].forEach((row, i) =>
    row.forEach((cell, c) => cell && t(cell, xs[c], 690 - i * 20, 11, i === 0 ? bold : font)),
  );
  let y = 520;
  for (const n of r.notes) {
    t(n, 56, y, 9);
    y -= 14;
  }
  t("Values flagged L or H are outside the laboratory's reference range.", 56, y - 6, 9);
  return doc.save({ useObjectStreams: false });
}

for (const [name, r] of Object.entries(REPORTS)) writeFileSync(new URL(name, OUT), await labPdf(r));
// The September report for patient A, shared with the ingestion benchmark.
const { readFileSync } = await import("node:fs");
writeFileSync(new URL("a-2026-09.pdf", OUT), readFileSync(new URL("../../ingest/fixtures/files/lab-table.pdf", import.meta.url)));
console.log("clinical fixtures written to", OUT.pathname);
