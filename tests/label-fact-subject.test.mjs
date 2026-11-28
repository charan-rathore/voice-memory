// A "label: value" line is a fact about its label. Matching one word of the
// label ("dropout") must not answer a question about something else when the
// question's other distinctive words ("rate", "model") are used elsewhere in
// the documents. Three document shapes: a paper's reference list, a project
// report, a product sheet.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { createLocalServer } from "../src/server.mjs";

process.env.VM_COUNTERS_ALLOW_FILE = "on";
const srv = createLocalServer({ port: 0 });
let base;
before(async () => {
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${srv.address().port}/api/public`;
});
after(() => new Promise((r) => srv.close(r)));

async function ask(text, question) {
  const { id } = await (
    await fetch(base + "/workspace", { method: "POST" })
  ).json();
  const up = await fetch(`${base}/workspace/${id}/upload`, {
    method: "POST",
    headers: {
      "content-type": "application/octet-stream",
      "x-file-name": "doc.txt",
    },
    body: text,
  });
  assert.equal(up.status, 202);
  for (let i = 0; i < 300; i++) {
    const st = await (await fetch(`${base}/workspace/${id}`)).json();
    if (
      st.documents.every((d) =>
        ["ready", "needs_review", "failed"].includes(d.status),
      )
    )
      break;
    await new Promise((r) => setTimeout(r, 50));
  }
  const r = await (
    await fetch(base + "/ask", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ case: id, question }),
    })
  ).json();
  return r.final?.text ?? "";
}

const PAPER = [
  "Paper Notes",
  "",
  "Our model uses attention layers and was trained for twelve hours on a single machine.",
  "The results section reports accuracy on the held-out test set for each model variant.",
  "",
  "References",
  "",
  "Dropout: a simple way to prevent neural networks from overfitting. Journal of Machine Learning Research, 2014",
].join("\n");
const REPORT = [
  "Project Review",
  "",
  "The migration team finished the database cutover and the rollback plan was tested twice.",
  "Support tickets about the cutover fell sharply after the second week.",
  "",
  "Owner: Facilities team",
].join("\n");
const SHEET = [
  "Kettle Product Sheet",
  "",
  "The kettle boils one litre of water quickly and switches off by itself.",
  "The lid opens fully for cleaning and the filter can be removed.",
  "",
  "Colour: matte black with a steel base",
].join("\n");

test("a reference title does not answer a dropout-rate question", async () => {
  const t = await ask(PAPER, "What dropout rate does the model use?");
  assert.doesNotMatch(t, /simple way to prevent/i);
});
test("an owner line does not answer a cutover-plan question", async () => {
  const t = await ask(
    REPORT,
    "Which team wrote the rollback plan for the database cutover?",
  );
  assert.doesNotMatch(t, /Facilities team/i);
});
test("a colour line does not answer a boiling-capacity question", async () => {
  const t = await ask(SHEET, "What colour of water does the kettle boil?");
  assert.doesNotMatch(t, /matte black/i);
});

// A short question word the documents never use ("ceo") is still part of the
// question. A two-column author or contact block read as table rows must not
// answer it because the block names the company. Built as real PDFs.
async function blockPdf(rows, body) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([612, 792]);
  let y = 720;
  for (const [a, b] of rows) {
    page.drawText(a, { x: 90, y, size: 11, font });
    page.drawText(b, { x: 340, y, size: 11, font });
    y -= 15;
  }
  y -= 20;
  for (const l of body) {
    page.drawText(l, { x: 72, y, size: 10, font });
    y -= 13;
  }
  return Buffer.from(await doc.save());
}
async function askPdf(buf, question) {
  const { id } = await (
    await fetch(base + "/workspace", { method: "POST" })
  ).json();
  await fetch(`${base}/workspace/${id}/upload`, {
    method: "POST",
    headers: {
      "content-type": "application/octet-stream",
      "x-file-name": "doc.pdf",
    },
    body: buf,
  });
  for (let i = 0; i < 300; i++) {
    const st = await (await fetch(`${base}/workspace/${id}`)).json();
    if (
      st.documents.every((d) =>
        ["ready", "needs_review", "failed"].includes(d.status),
      )
    )
      break;
    await new Promise((r) => setTimeout(r, 50));
  }
  const r = await (
    await fetch(base + "/ask", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ case: id, question }),
    })
  ).json();
  return r.final?.text ?? "";
}
const SHAPES = [
  [
    "an author block",
    [
      ["Ashish Vaswani", "Noam Shazeer"],
      ["Google Brain", "Google Research"],
      ["avaswani@google.com", "noam@google.com"],
    ],
    "Who is the CEO of Google?",
    /gives Google Brain/i,
  ],
  [
    "a supplier contact block",
    [
      ["Lena Park", "Tom Reed"],
      ["Northwind Ltd", "Contoso Ltd"],
      ["lena@northwind.com", "tom@contoso.com"],
    ],
    "Who is the CEO of Northwind?",
    /gives Northwind/i,
  ],
  [
    "a lab contact block",
    [
      ["Dana Whitfield", "Marco Ruiz"],
      ["Orchard Labs", "River Institute"],
      ["dana@orchard.org", "marco@river.org"],
    ],
    "Who is the CEO of Orchard Labs?",
    /gives Orchard Labs/i,
  ],
];
for (const [name, rows, q, bad] of SHAPES)
  test(`${name} does not answer a who-is-the-CEO question`, async () => {
    const buf = await blockPdf(rows, [
      "Overview",
      "This note reports the work done over the quarter.",
      "Results are listed in the schedule below.",
    ]);
    const t = await askPdf(buf, q);
    assert.doesNotMatch(t, bad);
    assert.doesNotMatch(t, /Contoso Ltd|Research\./);
  });
