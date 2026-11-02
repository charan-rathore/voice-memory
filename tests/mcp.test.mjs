// mcp/server.mjs speaks MCP over stdio: initialize, tools/list and
// tools/call against a local engine, returning the verdict and cited lines.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { createLocalServer } from "../src/server.mjs";
import { shapeAnswer } from "../mcp/server.mjs";

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
