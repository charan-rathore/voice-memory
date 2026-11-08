// Assembles mixed-quality.pdf: page 1 a digital text layer, page 2 a clean
// 300-dpi scan, page 3 a degraded phone-photo scan (see build.py).
import { PDFDocument, StandardFonts } from "pdf-lib";
import { readFileSync, writeFileSync } from "node:fs";

const here = (p) => new URL(p, import.meta.url);
const gold = JSON.parse(readFileSync(here("./gold.json"), "utf8"));
const pdf = await PDFDocument.create();
const font = await pdf.embedFont(StandardFonts.Helvetica);
const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
const A4 = [595.28, 841.89];
{
  const g = gold.pages["1"];
  const page = pdf.addPage(A4);
  let y = 790;
  const t = (s, x, f = font, size = 11) =>
    page.drawText(s, { x, y, size, font: f });
  t(g.title, 40, bold, 14);
  y -= 30;
  t("Patient: Test Person G (synthetic), ID SYN-0007", 40);
  y -= 18;
  t(g.dates, 40);
  y -= 18;
  t("Report status: FINAL", 40);
  y -= 36;
  const cols = [40, 210, 295, 390, 520];
  ["Test", "Result", "Unit", "Reference range", "Flag"].forEach((h, i) =>
    t(h, cols[i], bold),
  );
  y -= 22;
  for (const r of g.rows) {
    r.forEach((c, i) => t(c, cols[i]));
    y -= 20;
  }
  y = 50;
  t("Page 1 of 3", 40);
}
for (const n of [2, 3]) {
  const png = await pdf.embedPng(readFileSync(here(`./page-${n}.png`)));
  const page = pdf.addPage(A4);
  page.drawImage(png, { x: 0, y: 0, width: A4[0], height: A4[1] });
}
writeFileSync(here("./mixed-quality.pdf"), await pdf.save());
console.log("wrote mixed-quality.pdf");
