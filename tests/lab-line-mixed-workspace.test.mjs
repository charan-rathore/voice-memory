// A research paper's reference list next to an unrelated document: a line of
// running text must not become a lab result that answers every question.
// (Narrow guard on the false lab row; whether the clinical route should
// answer questions it was not asked is a separate, open question.)
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

const NOTE = [
  "Address Allocation Note",
  "",
  "The registry reserves the following three blocks of the address space for private networks.",
  "The first block is 10.0.0.0 through 10.255.255.255. The second block is 172.16.0.0 through 172.31.255.255. The third block is 192.168.0.0 through 192.168.255.255.",
].join("\n");
const PAPER = [
  "Reference list",
  "",
  "the 2017 Conference on Empirical Methods in Natural Language Processing, pages 670-680, Copenhagen, Denmark. Association for Computational Linguistics.",
  "",
  "The model was pre-trained for one million steps with a batch size of 256 sequences.",
].join("\n");
const LAB = [
  "Laboratory Report",
  "Patient: Test Person A, ID SYN-0001",
  "Collected: 03 September 2026",
  "",
  "Test Result Unit Reference range",
  "Creatinine, Serum 0.86 mg/dL 0.67 - 1.17",
  "Hemoglobin 12.1 g/dL 13.0 - 17.0",
].join("\n");

async function workspaceWith(files) {
  const { id } = await (
    await fetch(base + "/workspace", { method: "POST" })
  ).json();
  for (const [name, text] of files) {
    const r = await fetch(`${base}/workspace/${id}/upload`, {
      method: "POST",
      headers: {
        "content-type": "application/octet-stream",
        "x-file-name": name,
      },
      body: text,
    });
    assert.equal(r.status, 202);
  }
  for (let i = 0; i < 300; i++) {
    const st = await (await fetch(`${base}/workspace/${id}`)).json();
    if (
      st.documents.every((d) =>
        ["ready", "needs_review", "failed"].includes(d.status),
      )
    )
      return id;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("documents did not finish");
}
const ask = async (id, question) => {
  const r = await fetch(base + "/ask", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ case: id, question }),
  });
  return (await r.json()).final ?? {};
};

test("a reference-list line does not turn an unrelated question into a lab answer", async () => {
  const id = await workspaceWith([
    ["note.txt", NOTE],
    ["paper.txt", PAPER],
  ]);
  const f = await ask(id, "What are the three private address blocks?");
  assert.doesNotMatch(f.text, /Your the result|from this report|your doctor/i);
  assert.match(f.text, /three blocks|private/i);
  assert.deepEqual(
    [...new Set((f.citations ?? []).map((c) => c.title))],
    ["note.txt"],
  );
});

test("a genuine lab report beside a non-clinical document still answers its test", async () => {
  const id = await workspaceWith([
    ["lab.txt", LAB],
    ["paper.txt", PAPER],
  ]);
  const f = await ask(id, "What is my creatinine result?");
  assert.match(f.text, /0\.86/);
});
