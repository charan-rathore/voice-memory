// mcp/server.mjs speaks MCP over stdio: initialize, tools/list and
// tools/call against a local engine, returning the verdict and cited lines.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { createLocalServer } from "../src/server.mjs";
import {
  shapeAnswer,
  checkUploadPath,
  negotiate,
  SUPPORTED,
  handle,
} from "../mcp/server.mjs";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function client(base, extraEnv = {}, onRequest) {
  const env = { ...process.env, VM_API_BASE: base, ...extraEnv };
  for (const k of ["VM_MCP_UPLOAD_ROOTS", "VM_MCP_UPLOAD_CONFIRM"])
    if (!(k in extraEnv)) delete env[k];
  const p = spawn(process.execPath, ["mcp/server.mjs"], {
    env,
    stdio: ["pipe", "pipe", "inherit"],
  });
  const waiting = new Map();
  createInterface({ input: p.stdout }).on("line", (l) => {
    const m = JSON.parse(l);
    // a request from the server (elicitation): answer it
    if (m.method && m.id !== undefined) {
      const result = onRequest?.(m) ?? { action: "decline" };
      p.stdin.write(
        JSON.stringify({ jsonrpc: "2.0", id: m.id, result }) + "\n",
      );
      return;
    }
    waiting.get(m.id)?.(m);
    waiting.delete(m.id);
  });
  let n = 0;
  const rpc = (method, params) =>
    new Promise((ok) => {
      const id = ++n;
      waiting.set(id, ok);
      p.stdin.write(
        JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n",
      );
    });
  return { rpc, close: () => p.kill() };
}

test("MCP: handshake, tool list, and a cited answer from the engine", async () => {
  const srv = createLocalServer({ port: 0 });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  await srv.loadPublicCases();
  const c = client(`http://127.0.0.1:${srv.address().port}/api/public`);
  try {
    const init = await c.rpc("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "0" },
    });
    assert.equal(init.result.serverInfo.name, "voice-memory");
    assert.ok(init.result.capabilities.tools);
    const list = await c.rpc("tools/list", {});
    assert.deepEqual(
      list.result.tools.map((t) => t.name),
      [
        "list_cases",
        "ask_records",
        "create_workspace",
        "add_document_text",
        "workspace_status",
        "lookup_test_code",
        "test_education",
      ],
    );
    const ans = await c.rpc("tools/call", {
      name: "ask_records",
      arguments: {
        case: "health",
        question: "What is SYN-0001's ferritin result?",
      },
    });
    assert.equal(ans.result.isError, false);
    const out = ans.result.structuredContent;
    assert.match(out.answer, /50/);
    assert.ok(out.citations.length >= 1);
    assert.ok(out.citations.every((x) => x.quote && x.document));
    const bad = await c.rpc("tools/call", { name: "nope", arguments: {} });
    assert.equal(bad.error.code, -32602);
    const missing = await c.rpc("no/such", {});
    assert.equal(missing.error.code, -32601);
  } finally {
    c.close();
    srv.close();
  }
});

test("MCP: a closest line is labelled as a pointer, never as the answer", () => {
  const out = shapeAnswer({
    lead: {
      text: "I don't see that in these documents.",
      verdict: "UNKNOWN",
      citations: [],
    },
    closest: {
      line: "The revised fee is $42,000.",
      document: "the revision memo",
    },
  });
  assert.equal(out.verdict, "UNKNOWN");
  assert.match(out.closest.note, /not an answer/);
  assert.doesNotMatch(out.answer, /42,000/);
});

test("MCP: protocol version is negotiated, not echoed", () => {
  assert.equal(negotiate("2024-11-05"), "2024-11-05");
  assert.equal(negotiate("1999-01-01"), SUPPORTED[0]);
  assert.equal(negotiate(undefined), SUPPORTED[0]);
});

test("MCP: upload_document only reads documents a person meant to share", async () => {
  const d = mkdtempSync(join(tmpdir(), "vm-mcp-"));
  writeFileSync(join(d, "report.pdf"), "%PDF-1.4");
  writeFileSync(join(d, "id_rsa"), "secret");
  mkdirSync(join(d, ".ssh"));
  writeFileSync(join(d, ".ssh", "keys.txt"), "secret");
  symlinkSync(join(d, "id_rsa"), join(d, "looks-fine.pdf"));
  // no roots configured: uploads are off entirely
  await assert.rejects(
    checkUploadPath(join(d, "report.pdf"), ""),
    /uploads are off/,
  );
  assert.ok(await checkUploadPath(join(d, "report.pdf"), d));
  for (const p of [
    join(d, "id_rsa"), // not a document type
    join(d, ".ssh", "keys.txt"), // inside a hidden folder
    join(d, "looks-fine.pdf"), // a symlink to a secret is judged by its target
    "report.pdf", // relative
    join(d, "missing.pdf"),
  ])
    await assert.rejects(checkUploadPath(p, d), undefined, p);
  // with roots set, only files under them
  await assert.rejects(
    checkUploadPath(join(d, "report.pdf"), tmpdir() + "-nope"),
  );
});

test("MCP: an upload needs allowed folders and the person's yes", async () => {
  const srv = createLocalServer({ port: 0 });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${srv.address().port}/api/public`;
  const ok = mkdtempSync(join(tmpdir(), "vm-ok-"));
  const other = mkdtempSync(join(tmpdir(), "vm-other-"));
  writeFileSync(join(ok, "notes.txt"), "The renewal fee is $9,000.");
  writeFileSync(join(other, "tax-return.txt"), "private");
  const init = (c, capabilities = {}) =>
    c.rpc("initialize", {
      protocolVersion: "2025-06-18",
      capabilities,
      clientInfo: { name: "test", version: "0" },
    });
  const names = async (c) =>
    (await c.rpc("tools/list", {})).result.tools.map((t) => t.name);
  const upload = async (c, path) => {
    const ws = await c.rpc("tools/call", {
      name: "create_workspace",
      arguments: {},
    });
    const out = ws.result.structuredContent;
    const workspace = out.id ?? out.workspace;
    return (
      await c.rpc("tools/call", {
        name: "upload_document",
        arguments: { workspace, path },
      })
    ).result;
  };
  const clients = [];
  const mk = (...a) => {
    const c = client(base, ...a);
    clients.push(c);
    return c;
  };
  try {
    // no roots: not offered, and refused if called anyway
    const off = mk();
    await init(off, { elicitation: {} });
    assert.ok(!(await names(off)).includes("upload_document"));
    const r0 = await upload(off, join(ok, "notes.txt"));
    assert.equal(r0.isError, true);
    assert.match(r0.content[0].text, /uploads are off/);

    // roots set, client asks the person: outside the roots is refused before asking
    let asked = 0;
    const yes = mk({ VM_MCP_UPLOAD_ROOTS: ok }, (m) => {
      assert.equal(m.method, "elicitation/create");
      assert.match(m.params.message, /notes\.txt/);
      asked++;
      return { action: "accept", content: { confirm: true } };
    });
    await init(yes, { elicitation: {} });
    assert.ok((await names(yes)).includes("upload_document"));
    const r1 = await upload(yes, join(other, "tax-return.txt"));
    assert.equal(r1.isError, true);
    assert.match(r1.content[0].text, /outside the folders/);
    assert.equal(asked, 0);
    const r2 = await upload(yes, join(ok, "notes.txt"));
    assert.equal(r2.isError, false, JSON.stringify(r2));
    assert.equal(asked, 1);

    // the person says no
    const no = mk({ VM_MCP_UPLOAD_ROOTS: ok }, () => ({ action: "decline" }));
    await init(no, { elicitation: {} });
    const r3 = await upload(no, join(ok, "notes.txt"));
    assert.equal(r3.isError, true);
    assert.match(r3.content[0].text, /not confirmed/);

    // A client that cannot ask is refused, even with the legacy bypass flag.
    const mute = mk({ VM_MCP_UPLOAD_ROOTS: ok });
    await init(mute);
    assert.match(
      (await upload(mute, join(ok, "notes.txt"))).content[0].text,
      /not confirmed/,
    );
    const optOut = mk({
      VM_MCP_UPLOAD_ROOTS: ok,
      VM_MCP_UPLOAD_CONFIRM: "off",
    });
    await init(optOut);
    assert.equal((await upload(optOut, join(ok, "notes.txt"))).isError, true);
  } finally {
    clients.forEach((c) => c.close());
    srv.close();
  }
});

test("MCP over Streamable HTTP: the engine serves the same tools at /api/public/mcp", async () => {
  const srv = createLocalServer({ port: 0 });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  await srv.loadPublicCases();
  const url = `http://127.0.0.1:${srv.address().port}/api/public/mcp`;
  const post = (body, headers = {}) =>
    fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...headers,
      },
      body: JSON.stringify(body),
    });
  try {
    const init = await post({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "test", version: "0" },
      },
    });
    assert.equal(init.status, 200);
    assert.equal((await init.json()).result.serverInfo.name, "voice-memory");
    const note = await post({
      jsonrpc: "2.0",
      method: "notifications/initialized",
    });
    assert.equal(note.status, 202);
    const list = await (
      await post({ jsonrpc: "2.0", id: 2, method: "tools/list" })
    ).json();
    const names = list.result.tools.map((t) => t.name);
    assert.ok(names.includes("ask_records"));
    assert.ok(!names.includes("upload_document"), "no local files remotely");
    const ans = await (
      await post({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "ask_records",
          arguments: {
            case: "deal",
            question: "Was the $42,000 revision finalized?",
          },
        },
      })
    ).json();
    assert.equal(ans.result.isError, false);
    assert.ok(ans.result.structuredContent.citations.length >= 1);
    const cross = await post(
      { jsonrpc: "2.0", id: 4, method: "ping" },
      { origin: "https://evil.example" },
    );
    assert.equal(cross.status, 403);
    assert.equal((await fetch(url)).status, 405);
  } finally {
    srv.close();
  }
});

test("MCP text imports require a person, and remote imports are unavailable", async () => {
  const original = globalThis.fetch;
  let sent = 0;
  globalThis.fetch = async () => {
    sent++;
    return new Response(JSON.stringify({ accepted: true }), { status: 200 });
  };
  const msg = {
    id: 1,
    method: "tools/call",
    params: {
      name: "add_document_text",
      arguments: {
        workspace: "w_" + "a".repeat(32),
        name: "notes.txt",
        text: "Synthetic test note only.",
      },
    },
  };
  try {
    for (const ctx of [
      {},
      { elicit: async () => ({ action: "decline" }) },
      {
        remote: true,
        elicit: async () => ({ action: "accept", content: { confirm: true } }),
      },
      {
        elicit: async () => {
          throw Error("timeout");
        },
      },
    ]) {
      const result = await handle(msg, ctx);
      assert.equal(result.isError, true);
      assert.equal(sent, 0, "no document text sent before consent");
    }
    const list = await handle({ method: "tools/list" }, { remote: true });
    assert.ok(!list.tools.some((t) => t.name === "add_document_text"));
    let prompt = "";
    const result = await handle(msg, {
      elicit: async (message) => {
        prompt = message;
        return { action: "accept", content: { confirm: true } };
      },
    });
    assert.equal(result.isError, false);
    assert.equal(sent, 1);
    assert.match(prompt, /notes\.txt/);
    assert.match(prompt, /Synthetic test note only/);
    assert.match(prompt, /voice-memory-beige\.vercel\.app/);
  } finally {
    globalThis.fetch = original;
  }
});
