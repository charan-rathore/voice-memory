// A raised exponent ("10" then a smaller "-9" a few points higher) sits on a
// different baseline from its base. It must stay attached to its base, not
// become a separate "-9" paragraph that every answer then drops.
import { test } from "node:test";
import assert from "node:assert/strict";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { parsePdf } from "./pdf.mjs";

async function pdfWith(draw) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([612, 792]);
  const put = (text, x, y, size = 10) =>
    page.drawText(text, { x, y, size, font });
  const width = (text, size = 10) => font.widthOfTextAtSize(text, size);
  draw({ put, width });
  return Buffer.from(await doc.save());
}
const blocksOf = async (buf) => (await parsePdf(buf)).blocks.map((b) => b.text);

test("a raised exponent stays on its line", async () => {
  const buf = await pdfWith(({ put, width }) => {
    const a = "We used the Adam optimizer with an epsilon of 10";
    put(a, 72, 700);
    const x = 72 + width(a);
    put("-9", x, 704, 7);
    put(
      ". We varied the learning rate over the course of training.",
      x + width("-9", 7),
      700,
    );
    put("The rate was changed according to the schedule below.", 72, 688);
  });
  const text = (await blocksOf(buf)).join("\n");
  assert.match(text, /epsilon of 10\^-9\. We varied/);
  assert.ok(!(await blocksOf(buf)).some((t) => t.trim() === "-9"));
});

test("a raised square in a formula stays on its line", async () => {
  const buf = await pdfWith(({ put, width }) => {
    const a = "The energy is E = mc";
    put(a, 72, 700);
    put("2", 72 + width(a), 704, 7);
    put(" in these units.", 72 + width(a) + width("2", 7), 700);
  });
  assert.match((await blocksOf(buf)).join("\n"), /E = mc\^2 in these units/);
});

test("small text far from any word on the line is not folded in", async () => {
  const buf = await pdfWith(({ put }) => {
    put("A normal sentence of body text sits here.", 72, 700);
    put("stray", 400, 704, 7);
  });
  const blocks = await blocksOf(buf);
  assert.ok(
    blocks.some((t) => /^stray$/.test(t.trim())),
    blocks.join("|"),
  );
});

test("a small-print line a full line below is not folded in", async () => {
  const buf = await pdfWith(({ put }) => {
    put("Total due on the first of the month is shown here.", 72, 700);
    put("1", 72 + 200, 688, 7);
    put("Footnote text in small print follows the sentence above.", 72, 676, 7);
  });
  const blocks = (await blocksOf(buf)).join("\n");
  assert.doesNotMatch(blocks, /shown here\.?1/);
});

test("ordinary adjacent body lines are not merged", async () => {
  const buf = await pdfWith(({ put }) => {
    put("First line of an ordinary paragraph of text", 72, 700);
    put("second line of the same paragraph follows", 72, 687);
  });
  const t = (await blocksOf(buf)).join("\n");
  assert.match(t, /paragraph of text\s+second line/);
});

test("an uploaded PDF answers with the exponent, not a bare 10", async () => {
  process.env.VM_COUNTERS_ALLOW_FILE = "on";
  const { createLocalServer } = await import("../src/server.mjs");
  const srv = createLocalServer({ port: 0 });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${srv.address().port}/api/public`;
  try {
    const buf = await pdfWith(({ put, width }) => {
      const a = "The solver stops when the relative residual falls below 10";
      put(a, 72, 700);
      const x = 72 + width(a);
      put("-9", x, 704, 7);
      put(" for double precision runs.", x + width("-9", 7), 700);
      put("Step size must not exceed 0.5 seconds in any run.", 72, 688);
    });
    const { id } = await (
      await fetch(base + "/workspace", { method: "POST" })
    ).json();
    const up = await fetch(`${base}/workspace/${id}/upload`, {
      method: "POST",
      headers: {
        "content-type": "application/octet-stream",
        "x-file-name": "tolerances.pdf",
      },
      body: buf,
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
        body: JSON.stringify({
          case: id,
          question: "What residual tolerance does the solver stop at?",
        }),
      })
    ).json();
    assert.match(r.final.text, /10\^-9/);
  } finally {
    await new Promise((r) => srv.close(r));
  }
});
