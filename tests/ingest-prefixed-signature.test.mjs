import test from "node:test";
import assert from "node:assert/strict";
import { detectFormat } from "../ingest/detect.mjs";
test("a text document that discusses PDF magic is still readable Markdown", () => {
  assert.equal(detectFormat(Buffer.from("# PDF format guide\nA file starts with %PDF-1.7.\n"), "guide.md").kind, "markdown");
});
test("container magic takes precedence over an embedded PDF signature", () => {
  const zipHeader = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from("abc%PDF-1.7")]);
  // Detection only; central-directory validity is checked by the DOCX parser.
  assert.equal(detectFormat(zipHeader, "packet.docx").kind, "docx");
});
test("prefixed PDFs remain recognized and actual PDF magic cannot masquerade as text", () => {
  assert.equal(detectFormat(Buffer.from("garbage\n%PDF-1.7"), "sample.pdf").kind, "pdf");
  assert.throws(() => detectFormat(Buffer.from("%PDF-1.7"), "mislabeled.txt"));
});
