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
  assert.match(
    (await blocksOf(buf)).join("\n"),
    /E = mc\[raised 2\] in these units/,
  );
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

test("a footnote mark after money or a noun is not written as a power", async () => {
  const buf = await pdfWith(({ put, width }) => {
    const a = "The penalty applies above $5,000";
    put(a, 72, 700);
    put("1", 72 + width(a), 704, 7);
    put(" of unpaid tax in a year.", 72 + width(a) + width("1", 7), 700);
    put("The training used eight GPUs", 72, 688);
    put("5", 72 + width("The training used eight GPUs"), 692, 7);
    put(".", 72 + width("The training used eight GPUs") + width("5", 7), 688);
    put("1", 72, 100, 6);
    put(" Amounts are in US dollars.", 72 + width("1", 6), 96, 9);
    put("5", 72, 88, 6);
    put(" Eight NVIDIA P100 cards.", 72 + width("5", 6), 84, 9);
  });
  const t = (await blocksOf(buf)).join("\n");
  assert.match(t, /\$5,000\[\^1\] of unpaid/);
  assert.match(t, /eight GPUs\[\^5\]\./);
  assert.doesNotMatch(t, /5,000\^1|GPUs\^5/);
});

test("the same digit as a note mark and as an exponent is not called either", async () => {
  const buf = await pdfWith(({ put, width }) => {
    const a = "Energy scales as n";
    put(a, 72, 700);
    put("2", 72 + width(a), 704, 7);
    put(" for this method.", 72 + width(a) + width("2", 7), 700);
    put("A claim", 72, 688);
    put("2", 72 + width("A claim"), 692, 7);
    put("2", 72, 100, 6);
    put(" Source: the annual report.", 72 + width("2", 6), 96, 9);
  });
  const t = (await blocksOf(buf)).join("\n");
  assert.match(t, /scales as n\[raised 2\] for/);
  assert.match(t, /A claim\[raised 2\]/);
  assert.doesNotMatch(t, /\^2|\[\^2\]/);
});

test("a raised digit whose note is not on the page is not called a power", async () => {
  const buf = await pdfWith(({ put, width }) => {
    put("The committee approved the plan", 72, 700);
    put("7", 72 + width("The committee approved the plan"), 704, 7);
    put(
      " after a long debate.",
      72 + width("The committee approved the plan") + width("7", 7),
      700,
    );
  });
  const t = (await blocksOf(buf)).join("\n");
  assert.match(t, /plan\[raised 7\] after/);
  assert.doesNotMatch(t, /\^7/);
});

test("a real exponent in its own maths font stays a power beside a footnote", async () => {
  const doc = await PDFDocument.create();
  const body = await doc.embedFont(StandardFonts.Helvetica);
  const math = await doc.embedFont(StandardFonts.TimesRoman);
  const page = doc.addPage([612, 792]);
  const draw = (t, x, y, size, font) => page.drawText(t, { x, y, size, font });
  const a = "The cost grows as n";
  draw(a, 72, 700, 10, body);
  draw("2", 72 + body.widthOfTextAtSize(a, 10), 704, 7, math);
  draw(" per step.", 72 + body.widthOfTextAtSize(a, 10) + 4, 700, 10, body);
  draw("See the appendix", 72, 688, 10, body);
  draw("3", 72 + body.widthOfTextAtSize("See the appendix", 10), 692, 7, body);
  draw("3", 72, 100, 6, body);
  draw(" Appendix B lists the data.", 76, 96, 9, body);
  const t = (await blocksOf(Buffer.from(await doc.save()))).join("\n");
  assert.match(t, /grows as n\^2 per step/);
  assert.match(t, /appendix\[\^3\]/);
});
