// Public landing API: key-free, read-only answers over the built-in
// fictional cases. Visitors get the same deterministic, source-located
// answers as the voice call, and nothing that mutates or spends.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createLocalServer } from "./server.mjs";

const srv = createLocalServer({ port: 0 });
let base;
before(async () => {
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${srv.address().port}`;
  await srv.loadPublicCases();
});
after(() => new Promise((r) => srv.close(r)));

const ask = async (c, question, extra = {}) => {
  const r = await fetch(base + "/api/public/ask", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ case: c, question, ...extra }),
  });
  return { status: r.status, body: await r.json() };
};

test("cases load with no cookie, key or session", async () => {
  const r = await fetch(base + "/api/public/cases");
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("set-cookie"), null);
  const { cases } = await r.json();
  const ids = cases.map((c) => c.id);
  assert.deepEqual(ids, ["health", "deal"]);
  assert.equal(cases.find((c) => c.id === "health").documents.length, 4);
  assert.equal(cases.find((c) => c.id === "deal").documents.length, 7);
});

test("ferritin: the amended 50 is used and the preliminary 5 is cited", async () => {
  const { status, body } = await ask(
    "health",
    "What is SYN-0001's ferritin result?",
  );
  assert.equal(status, 200);
  assert.equal(body.lead.verdict, "LATEST");
  assert.match(body.lead.text, /50 ng\/mL/);
  assert.match(body.lead.text, /corrected from 5 to 50/);
  const quotes = body.lead.citations.map((c) => c.quote);
  assert.ok(quotes.some((q) => /\| Ferritin \| 50 \|/.test(q)));
  assert.ok(quotes.some((q) => /\| Ferritin \| 5 \|/.test(q)));
  for (const c of body.lead.citations) {
    assert.ok(c.documentId, "citation opens a document");
    assert.equal(c.location.pages[0], 1);
    assert.ok(c.location.focus.regions[0].bbox, "line is located on the page");
  }
});

test("creatinine in different units is refused, not compared", async () => {
  const { body } = await ask(
    "health",
    "Has creatinine gone up since September?",
  );
  assert.equal(body.lead.verdict, "NOT_COMPARABLE");
  assert.match(body.lead.text, /mg\/dL/);
  assert.match(body.lead.text, /µmol\/L/);
  assert.doesNotMatch(body.lead.text, /higher|lower|went up|went down/);
});

test("patients are never mixed", async () => {
  const { body } = await ask("health", "What is the TSH?");
  assert.equal(body.lead.verdict, "AMBIGUOUS_PATIENT");
});

test("Northstar: $42,000 is proposed, not approved; the split is open", async () => {
  const a = await ask("deal", "Was the $42,000 revision finalized?");
  assert.equal(a.body.lead.verdict, "PROPOSED");
  assert.match(a.body.lead.text, /not approved/);
  assert.ok(a.body.lead.citations.some((c) => /\$42,000/.test(c.quote)));
  const b = await ask("deal", "Did they agree on the payment split?");
  assert.equal(b.body.lead.verdict, "OPEN");
  assert.match(b.body.lead.text, /40\/60/);
  assert.match(b.body.lead.text, /50\/50/);
});

test("documents and originals are readable; ids are case-scoped", async () => {
  const { cases } = await (await fetch(base + "/api/public/cases")).json();
  const pdf = cases[0].documents[0];
  const v = await fetch(`${base}/api/public/doc/health/${pdf.id}`);
  assert.equal(v.status, 200);
  assert.ok((await v.json()).document.elements.length > 3);
  const o = await fetch(`${base}/api/public/doc/health/${pdf.id}/original`);
  assert.equal(o.headers.get("content-type"), "application/pdf");
  assert.match(o.headers.get("content-security-policy"), /sandbox/);
  const cross = await fetch(`${base}/api/public/doc/deal/${pdf.id}`);
  assert.equal(cross.status, 404);
});

test("graphs: amendment and unit edges for labs, supersession for the deal", async () => {
  const h = await (await fetch(base + "/api/public/graph/health")).json();
  assert.ok(h.edges.some((e) => e.kind === "corrects"));
  assert.ok(h.edges.some((e) => e.kind === "not comparable"));
  const d = await (await fetch(base + "/api/public/graph/deal")).json();
  assert.ok(d.edges.some((e) => e.kind === "supersedes"));
  assert.ok(d.nodes.some((n) => n.kind === "evidence"));
});

test("bad input gets a plain error; nothing mutates", async () => {
  assert.equal((await ask("nope", "hi")).status, 400);
  assert.equal((await ask("deal", "")).status, 400);
  assert.equal((await ask("deal", "x".repeat(401))).status, 400);
  for (const p of [
    "/api/public/upload",
    "/api/public/import",
    "/api/public/reset",
  ])
    assert.equal((await fetch(base + p, { method: "POST" })).status, 404);
});

test("voice minting fails closed without Bolna configuration", async () => {
  const r = await fetch(base + "/api/public/voice/session", { method: "POST" });
  assert.equal(r.status, 503);
  const t = await fetch(base + "/api/public/voice/turns?ticket=forged");
  assert.equal(t.status, 403);
});
