// A table row is keyed by its first cell ("Transformer (base model)"). That
// names WHICH row, not what is asked of it: "the dropout rate for the base
// model" is not answered by the base model's BLEU row. Written across three
// document shapes (results table, invoice, spec sheet) so the rule is about
// rows, not one document.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
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

const RESULTS = [
  "Table 2: Results",
  "",
  "| Model | BLEU | Cost (FLOPs) |",
  "| --- | --- | --- |",
  "| Transformer (base model) | 27.3 | 3.3 · 10^18 |",
  "| Transformer (big) | 28.4 | 2.3 · 10^19 |",
  "",
  "Residual Dropout. We apply dropout to the output of each sub-layer. For the base model, we use a rate of 0.1.",
].join("\n");
const SPEC = [
  "Laptop Specifications",
  "",
  "| Model | RAM | Storage |",
  "| --- | --- | --- |",
  "| Aero 14 (standard) | 16 GB | 512 GB |",
  "| Aero 14 (pro) | 32 GB | 1 TB |",
  "",
  "Warranty: the Aero 14 standard model carries a two year limited warranty. Battery replacement is not covered.",
].join("\n");
const INVOICE = [
  "Invoice 2041",
  "",
  "| Item | Hours | Rate |",
  "| --- | --- | --- |",
  "| Consulting (hourly) | 40 | 150 |",
  "| Design review (fixed) | 1 | 900 |",
  "",
  "Payment terms: net 30 days. Overdue balances carry interest.",
].join("\n");

test("a row's own name does not answer a question about text elsewhere", async () => {
  const t = await ask(RESULTS, "What is the dropout rate for the base model?");
  assert.match(t, /rate of 0\.1/);
  assert.doesNotMatch(t, /27\.3/);
  const w = await ask(
    SPEC,
    "What is the warranty on the Aero 14 standard model?",
  );
  assert.match(w, /two year limited warranty/);
  assert.doesNotMatch(w, /16 GB/);
});

test("a row still answers a question that names its columns", async () => {
  assert.match(
    await ask(RESULTS, "What is the BLEU score of the base model?"),
    /27\.3/,
  );
  assert.match(
    await ask(SPEC, "How much RAM does the Aero 14 pro have?"),
    /32 GB/,
  );
  assert.match(
    await ask(INVOICE, "What is the rate for hourly consulting?"),
    /150/,
  );
  assert.match(
    await ask(INVOICE, "How many hours of consulting were billed?"),
    /\b40\b/,
  );
});
