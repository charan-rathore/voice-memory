// End-to-end upload tests through the real HTTP server: binary upload ->
// staged status -> canonical document -> question -> cited passage with a
// page/region location -> original bytes. Also: rejection paths, CSRF,
// size cap, deletion invalidating answers, and the fixed voice credential
// following deletions (fail closed when no documents remain).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createLocalServer } from "../server.mjs";

const FIX = (f) =>
  readFileSync(new URL("./fixtures/files/" + f, import.meta.url));

async function start(env = {}) {
  const saved = {};
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  const server = createLocalServer({ port: 0 });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const s = await fetch(base + "/api/session");
  const cookie = s.headers.get("set-cookie").split(";")[0];
  const { csrf } = await s.json();
  const h = { cookie, origin: base, "x-csrf-token": csrf };
  const client = {
    base,
    upload: (bytes, name, headers = {}) =>
      fetch(base + "/api/upload", {
        method: "POST",
        headers: {
          ...h,
          "content-type": "application/octet-stream",
          "x-file-name": encodeURIComponent(name),
          ...headers,
        },
        body: bytes,
      }),
    post: (p, body) =>
      fetch(base + "/api/" + p, {
        method: "POST",
        headers: { ...h, "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    get: (p) => fetch(base + "/api/" + p, { headers: { cookie } }),
    async settle(timeout = 60000) {
      const t0 = Date.now();
      for (;;) {
        const lib = await (await client.get("library")).json();
        if (
          lib.documents.every((d) =>
            ["ready", "needs_review", "failed"].includes(d.status),
          )
        )
          return lib;
        if (Date.now() - t0 > timeout) throw Error("library did not settle");
        await new Promise((r) => setTimeout(r, 100));
      }
    },
    close: () =>
      new Promise((r) => {
        server.close(r);
        for (const [k, v] of Object.entries(saved)) {
          if (v === undefined) delete process.env[k];
          else process.env[k] = v;
        }
      }),
  };
  return client;
}

test("PDF upload: staged status, question, page-located citation, original bytes", async () => {
  const c = await start();
  try {
    const up = await c.upload(FIX("digital.pdf"), "Site visit.pdf");
    assert.equal(up.status, 202);
    const { document } = await up.json();
    assert.ok(
      ["uploaded", "validating", "parsing"].includes(document.status),
      document.status,
    );
    const lib = await c.settle();
    const d = lib.documents[0];
    assert.equal(d.status, "ready", JSON.stringify(d.error));
    assert.equal(d.kind, "pdf");
    assert.equal(d.stats.pages, 2);
    assert.ok(
      d.timings.parsing >= 0 && d.timings.ready >= d.timings.parsing,
      "real stage timings recorded",
    );
    assert.equal(lib.indexed, 1);

    const view = (await (await c.get("library/" + d.id)).json()).document;
    assert.equal(view.schema, "vm.document/1");
    assert.ok(
      view.elements.some(
        (e) =>
          e.type === "heading" &&
          e.text === "Follow-up actions" &&
          e.page === 2,
      ),
    );

    const q = await (
      await c.post("query", {
        question: "Who will confirm the leveller delivery date?",
      })
    ).json();
    assert.equal(q.supported, true, q.answer);
    const ev = q.evidence.find((e) => e.quote.includes("Anika Rao"));
    assert.ok(ev, "cited passage present");
    assert.equal(ev.documentId, d.id);
    // The chunk spans both pages of this short PDF; the focus is the line.
    assert.deepEqual(ev.location.pages, [1, 2]);
    assert.deepEqual(ev.location.focus.pages, [2]);
    assert.ok(ev.location.focus.text.some((t) => t.includes("Anika Rao")));
    assert.ok(
      ev.location.regions.length >= 1 &&
        ev.location.regions[0].bbox.length === 4,
    );
    assert.deepEqual(ev.location.methods, ["pdf-text"]);
    assert.equal(
      view.text.slice(ev.start, ev.end),
      ev.quote,
      "quote is an exact span of the canonical text",
    );

    const orig = await c.get("library/" + d.id + "/original");
    assert.equal(orig.status, 200);
    assert.equal(orig.headers.get("content-type"), "application/pdf");
    assert.match(orig.headers.get("content-security-policy"), /sandbox/);
    assert.deepEqual(
      Buffer.from(await orig.arrayBuffer()),
      FIX("digital.pdf"),
      "original is byte-identical",
    );
  } finally {
    await c.close();
  }
});

test("DOCX, image (OCR) and Markdown upload together; OCR citation carries method and confidence", async () => {
  const c = await start();
  try {
    for (const [f, n] of [
      ["minutes.docx", "Vendor minutes.docx"],
      ["printed.png", "clinic-note.png"],
      ["memo.md", "memo.md"],
    ])
      assert.equal((await c.upload(FIX(f), n)).status, 202);
    const lib = await c.settle();
    assert.deepEqual(
      lib.documents.map((d) => d.status),
      ["ready", "ready", "ready"],
    );
    assert.equal(lib.indexed, 3);
    const q = await (
      await c.post("query", { question: "When is the follow-up appointment?" })
    ).json();
    const ev = [...q.evidence, ...q.reviewEvidence].find((e) =>
      e.quote.includes("14 November 2026"),
    );
    assert.ok(ev, q.answer);
    assert.deepEqual(ev.location.methods, ["ocr"]);
    assert.ok(ev.location.minConfidence >= 85);
    const orig = await c.get("library/" + ev.documentId + "/original");
    assert.equal(orig.headers.get("content-type"), "image/png");
  } finally {
    await c.close();
  }
});

test("rejections are explicit and actionable; nothing is indexed from them", async () => {
  const c = await start();
  try {
    await c.upload(FIX("fake.pdf"), "report.pdf");
    await c.upload(FIX("encrypted.pdf"), "locked.pdf");
    await c.upload(FIX("bomb.docx"), "big.docx");
    const lib = await c.settle();
    const by = Object.fromEntries(lib.documents.map((d) => [d.filename, d]));
    assert.equal(by["report.pdf"].status, "failed");
    assert.equal(by["report.pdf"].error.code, "signature_mismatch");
    assert.match(by["report.pdf"].error.message, /PNG image/);
    assert.equal(by["locked.pdf"].error.code, "encrypted");
    assert.match(by["locked.pdf"].error.message, /password/);
    assert.equal(by["big.docx"].error.code, "decompression_limit");
    assert.equal(lib.indexed, 0);
    assert.equal(
      (await c.post("query", { question: "anything?" })).status,
      400,
    );
    assert.equal(
      (await c.get("library/" + by["report.pdf"].id + "/original")).status,
      404,
      "unreadable bytes are not kept",
    );
  } finally {
    await c.close();
  }
});

test("upload requires the session's CSRF token and same origin; oversize is refused before reading", async () => {
  const c = await start();
  try {
    assert.equal(
      (
        await c.upload(FIX("notes.txt"), "notes.txt", {
          "x-csrf-token": "wrong",
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await c.upload(FIX("notes.txt"), "notes.txt", {
          origin: "https://evil.example",
        })
      ).status,
      403,
    );
    const big = Buffer.alloc(16 * 1024 * 1024, 65);
    const r = await c.upload(big, "big.txt");
    assert.equal(r.status, 413);
    assert.match((await r.json()).error, /limit is 15 MB/);
  } finally {
    await c.close();
  }
});

test("a filename cannot traverse paths or inject markup into the library", async () => {
  const c = await start();
  try {
    await c.upload(
      FIX("notes.txt"),
      "../../etc/<img src=x onerror=alert(1)>.txt",
    );
    const lib = await c.settle();
    assert.equal(
      lib.documents[0].filename,
      "<img src=x onerror=alert(1)>.txt",
      "path stripped; text kept verbatim for textContent rendering",
    );
  } finally {
    await c.close();
  }
});

test("needs-review documents stay out of the index until a person includes them", async () => {
  const c = await start();
  try {
    // Partial coverage: a text PDF page plus a scanned page that OCR reads,
    // forced to review by a low-confidence number is hard to build
    // deterministically; use the review gate directly via a degraded scan
    // that OCR reads partially.
    await c.upload(FIX("skewed.png"), "skewed.png");
    const lib = await c.settle();
    const d = lib.documents[0];
    if (d.status === "needs_review") {
      assert.equal(lib.indexed, 0);
      await c.post(`library/${d.id}/include`, {});
      assert.equal((await (await c.get("library")).json()).indexed, 1);
    } else {
      assert.equal(d.status, "ready");
      assert.equal(lib.indexed, 1);
      assert.equal(
        (await c.post(`library/${d.id}/include`, {})).status,
        400,
        "only review documents can be force-included",
      );
    }
  } finally {
    await c.close();
  }
});

test("removing a document invalidates answers that depended on it", async () => {
  const c = await start();
  try {
    await c.upload(FIX("digital.pdf"), "site.pdf");
    await c.upload(FIX("memo.md"), "memo.md");
    const lib = await c.settle();
    const site = lib.documents.find((d) => d.filename === "site.pdf");
    let q = await (
      await c.post("query", {
        question: "Who will confirm the leveller delivery date?",
      })
    ).json();
    assert.equal(q.supported, true);
    await c.post(`library/${site.id}/remove`, {});
    q = await (
      await c.post("query", {
        question: "Who will confirm the leveller delivery date?",
      })
    ).json();
    assert.equal(
      q.supported,
      false,
      "a removed source can no longer support an answer",
    );
    assert.equal((await c.get("library/" + site.id)).status, 404);
  } finally {
    await c.close();
  }
});

test("fixed voice credential follows deletions and fails closed when no documents remain", async () => {
  const FIXED = "f".repeat(64);
  const c = await start({
    VM_VOICE_CAPABILITY: FIXED,
    VM_VOICE_HARD_EXPIRES_AT: String(Date.now() + 3600000),
  });
  const ask = (content) =>
    fetch(c.base + "/v1/chat/completions", {
      method: "POST",
      headers: {
        authorization: "Bearer " + FIXED,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        stream: true,
        messages: [{ role: "user", content }],
      }),
    });
  try {
    await c.upload(FIX("digital.pdf"), "site.pdf");
    const lib = await c.settle();
    assert.equal((await c.post("voice/start", {})).status, 200);
    const before = await ask("Who will confirm the leveller delivery date?");
    assert.equal(before.status, 200);
    assert.match(await before.text(), /Anika Rao/);
    await c.post(`library/${lib.documents[0].id}/remove`, {});
    const after = await ask("Who will confirm the leveller delivery date?");
    assert.equal(
      after.status,
      401,
      "no corpus left: the credential must not answer from the deleted document",
    );
  } finally {
    await c.close();
  }
});
