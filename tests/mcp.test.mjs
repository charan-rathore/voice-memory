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
} from "../mcp/server.mjs";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function client(base) {
  const p = spawn(process.execPath, ["mcp/server.mjs"], {
    env: { ...process.env, VM_API_BASE: base },
    stdio: ["pipe", "pipe", "inherit"],
  });
  const waiting = new Map();
  createInterface({ input: p.stdout }).on("line", (l) => {
    const m = JSON.parse(l);
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
        "upload_document",
        "add_document_text",
        "workspace_status",
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
  assert.ok(await checkUploadPath(join(d, "report.pdf")));
  for (const p of [
    join(d, "id_rsa"), // not a document type
    join(d, ".ssh", "keys.txt"), // inside a hidden folder
    join(d, "looks-fine.pdf"), // a symlink to a secret is judged by its target
    "report.pdf", // relative
    join(d, "missing.pdf"),
  ])
    await assert.rejects(checkUploadPath(p), undefined, p);
  // with roots set, only files under them
  await assert.rejects(
    checkUploadPath(join(d, "report.pdf"), tmpdir() + "-nope"),
  );
  assert.ok(await checkUploadPath(join(d, "report.pdf"), d));
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
