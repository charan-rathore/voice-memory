import test from "node:test";
import assert from "node:assert/strict";
import { buildDocument } from "./canonical.mjs";
import { parseBuffer } from "./parse.mjs";
import { shutdownOcr } from "./ocr.mjs";
import { readFileSync } from "node:fs";
test.after(() => shutdownOcr());
const make = (text, lines) =>
  buildDocument({
    blocks: [
      { type: "paragraph", text, page: 1, method: "ocr", sourceLines: lines },
    ],
    kind: "png",
    mime: "image/png",
    filename: "test.png",
    bytes: Buffer.from("x"),
    parser: {},
    pages: [{ number: 1 }],
  });
test("additive lines retain literal IDs and map canonical spans without changing text", () => {
  const text = "Patient ID: 0000123_A Ferritin 40 ng/mL";
  const d = make(text, [
    { rawText: "Patient ID: 0000123_A", bbox: [0, 0, 100, 10], confidence: 94 },
    { rawText: "Ferritin 40 ng/mL", bbox: [0, 12, 100, 22], confidence: 85 },
  ]);
  assert.equal(d.text, text);
  const ls = d.elements[0].sourceLines;
  assert.equal(ls.length, 2);
  for (const l of ls) {
    assert.equal(d.text.slice(l.canonicalStart, l.canonicalEnd), l.rawText);
    assert.equal(l.alignment, "exact");
  }
  assert.equal(ls[0].rawText.includes("0000123_A"), true);
});
test("ambiguous repeated or transformed lines remain unmapped rather than guessed", () => {
  const d = make("Repeat Repeat hyphenated", [
    { rawText: "Repeat" },
    { rawText: "hyphen- ated" },
    { rawText: "missing" },
  ]);
  for (const l of d.elements[0].sourceLines) {
    assert.equal(l.alignment, "unmapped");
    assert.equal(l.canonicalStart, null);
  }
});
test("verified whitespace normalization retains raw text and correct canonical slice", () => {
  const d = make("Ferritin 40 ng/mL", [{ rawText: "Ferritin  40\tng/mL" }]);
  const l = d.elements[0].sourceLines[0];
  assert.equal(l.rawText, "Ferritin  40\tng/mL");
  assert.equal(l.alignment, "verified-whitespace");
  assert.equal(
    d.text.slice(l.canonicalStart, l.canonicalEnd),
    "Ferritin 40 ng/mL",
  );
});
for (const f of ["digital.pdf", "printed.png", "scanned.pdf"])
  test("actual extraction preserves source lines: " + f, async () => {
    const { doc } = await parseBuffer(
      readFileSync(new URL("./fixtures/files/" + f, import.meta.url)),
      f,
    );
    const lines = doc.elements.flatMap((e) => e.sourceLines ?? []);
    assert.ok(lines.length > 0);
    assert.ok(
      lines.every((l) => typeof l.rawText === "string" && l.bbox?.length === 4),
    );
    assert.ok(lines.some((l) => l.alignment !== "unmapped"));
    for (const l of lines.filter((l) => l.alignment !== "unmapped"))
      assert.equal(
        doc.text
          .slice(l.canonicalStart, l.canonicalEnd)
          .replace(/\s+/g, " ")
          .trim(),
        l.rawText.replace(/\s+/g, " ").trim(),
      );
  });
test("repeated lines stay unmapped even after a unique middle anchor", () => {
  const d = make("Repeat Middle Repeat", [
    { rawText: "Repeat" },
    { rawText: "Middle" },
    { rawText: "Repeat" },
  ]);
  assert.equal(d.elements[0].sourceLines[0].alignment, "unmapped");
  assert.equal(d.elements[0].sourceLines[2].alignment, "unmapped");
});
test("substring matches and out-of-order source lines do not acquire exact authority", () => {
  const d = make("biomass 17 kg", [{ rawText: "mass 17 kg" }]);
  assert.equal(d.elements[0].sourceLines[0].alignment, "unmapped");
  const q = make("Alpha Beta", [{ rawText: "Beta" }, { rawText: "Alpha" }]);
  assert.equal(q.elements[0].sourceLines[1].alignment, "unmapped");
});
test("non-indexed overlay and furniture preserve unmapped extracted lines without indexed authority", () => {
  const b = {
    text: "SAMPLE COPY",
    page: 1,
    bbox: [1, 2, 20, 30],
    method: "pdf-text",
    sourceLines: [{ rawText: "SAMPLE COPY", bbox: [1, 2, 20, 30], group: 2 }],
  };
  const d = buildDocument({
    blocks: [
      { ...b, type: "overlay" },
      { ...b, type: "furniture" },
      {
        type: "paragraph",
        text: "A supported paragraph with enough text.",
        page: 1,
        method: "pdf-text",
      },
    ],
    kind: "pdf",
    mime: "application/pdf",
    filename: "test.pdf",
    bytes: Buffer.from("x"),
    parser: {},
    pages: [{ number: 1 }],
  });
  for (const e of d.elements.slice(0, 2)) {
    assert.equal(e.sourceLines.length, 1);
    assert.equal(e.sourceLines[0].canonicalStart, null);
    assert.equal(e.sourceLines[0].alignment, "unmapped");
    assert.equal(e.sourceLines[0].group, 2);
  }
  assert.ok(!d.text.includes("SAMPLE COPY"));
});
