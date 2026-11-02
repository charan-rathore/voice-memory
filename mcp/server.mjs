#!/usr/bin/env node
// Voice Memory as an MCP server (Model Context Protocol, stdio transport):
// any MCP client (Claude, ChatGPT connectors, IDE agents, a Bolna-side tool
// runner) can ask the evidence engine and get back a fixed verdict and the
// exact cited lines, never a free-form guess.
//
// Zero dependencies: newline-delimited JSON-RPC 2.0 on stdin/stdout, as the
// MCP stdio transport specifies. It calls the key-free public API, so it
// holds no secrets.
//
//   VM_API_BASE=https://voice-memory-beige.vercel.app/api/public node mcp/server.mjs
//
// Claude Desktop / Claude Code config:
//   { "mcpServers": { "voice-memory": { "command": "node",
//       "args": ["/path/to/voice-memory/mcp/server.mjs"] } } }
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { createInterface } from "node:readline";

const BASE = (
  process.env.VM_API_BASE || "https://voice-memory-beige.vercel.app/api/public"
).replace(/\/$/, "");
const PROTOCOL = "2025-06-18";
const VERSION = "1.0.0";

const TOOLS = [
  {
    name: "list_cases",
    title: "List document sets",
    description:
      "The document sets you can ask about (fictional demo cases), with their documents.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "ask_records",
    title: "Ask the records",
    description:
      "Ask one question of a document set and get the engine's verdict (e.g. corrected value, proposed not approved, not comparable, not in these documents) with the exact cited lines. Relay the answer and its citations as given; do not add facts. English, Hindi and Hinglish questions are understood. A 'closest' line, when present, is a pointer to open, not an answer.",
    inputSchema: {
      type: "object",
      required: ["case", "question"],
      properties: {
        case: {
          type: "string",
          description:
            "`health` or `deal` (fictional demo cases), or a workspace id from create_workspace",
        },
        question: { type: "string", maxLength: 400 },
        context: {
          type: "string",
          pattern: "^[A-Za-z]{1,40}$",
          description: "The field asked about in the previous turn (optional)",
        },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "create_workspace",
    title: "Start a private workspace",
    description:
      "Start a private workspace for your own documents (deleted after 30 idle minutes). Returns its id.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "upload_document",
    title: "Upload a document",
    description:
      "Upload one local file (PDF, DOCX, PNG, JPEG, TXT, MD; up to 4 MB; at most 5 per workspace) into a workspace.",
    inputSchema: {
      type: "object",
      required: ["workspace", "path"],
      properties: {
        workspace: { type: "string", pattern: "^w_[0-9a-f]{32}$" },
        path: { type: "string", description: "Absolute path of the file" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "workspace_status",
    title: "Workspace status",
    description: "Each uploaded document's processing stage.",
    inputSchema: {
      type: "object",
      required: ["workspace"],
      properties: {
        workspace: { type: "string", pattern: "^w_[0-9a-f]{32}$" },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
];

async function api(path, opts = {}) {
  const r = await fetch(BASE + path, {
    ...opts,
    signal: AbortSignal.timeout(45000),
  });
  const text = await r.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = { error: text.slice(0, 300) };
  }
  if (!r.ok)
    throw new Error(`${r.status} ${body?.error ?? body?.message ?? "error"}`);
  return body;
}

// What an agent should relay: the verdict, the sentence, and where it rests.
export function shapeAnswer(a) {
  const lead = a.lead ?? null;
  return {
    verdict: lead?.verdict ?? "UNKNOWN",
    answer: lead?.text ?? a.answer ?? null,
    citations: (lead?.citations?.length ? lead.citations : (a.evidence ?? []))
      .slice(0, 4)
      .map((c) => ({ document: c.title, quote: c.quote, status: c.status })),
    background: lead?.background ?? null,
    understoodAs: lead?.interpretedAs ?? null,
    closest: a.closest
      ? {
          note: "closest line in the records, not an answer",
          document: a.closest.document,
          line: a.closest.line,
        }
      : null,
    otherCase: (a.also ?? []).map((x) => ({
      case: x.case,
      question: x.question,
      answer: x.text,
      verdict: x.verdict,
    })),
  };
}

async function call(name, args = {}) {
  switch (name) {
    case "list_cases": {
      const c = await api("/cases");
      return (c.cases ?? c).map((x) => ({
        id: x.id,
        title: x.title,
        documents: (x.documents ?? []).map((d) => d.title),
      }));
    }
    case "ask_records": {
      const a = await api("/ask", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          case: args.case,
          question: args.question,
          ...(args.context ? { context: args.context } : {}),
        }),
      });
      return shapeAnswer(a);
    }
    case "create_workspace":
      return api("/workspace", { method: "POST" });
    case "upload_document": {
      const bytes = await readFile(args.path);
      return api(`/workspace/${args.workspace}/upload`, {
        method: "POST",
        headers: {
          "content-type": "application/octet-stream",
          "x-file-name": encodeURIComponent(basename(args.path)),
        },
        body: bytes,
      });
    }
    case "workspace_status":
      return api(`/workspace/${args.workspace}`);
    default:
      throw Object.assign(new Error(`unknown tool ${name}`), { code: -32602 });
  }
}

async function handle(msg) {
  const { id, method, params } = msg;
  if (method === "initialize")
    return {
      protocolVersion: params?.protocolVersion || PROTOCOL,
      capabilities: { tools: { listChanged: false } },
      serverInfo: {
        name: "voice-memory",
        title: "Voice Memory",
        version: VERSION,
      },
      instructions:
        "Evidence engine over changing records. Relay `answer` and `citations` as given; a `closest` line is a pointer, not an answer. Demo cases are fictional; not a diagnostic product.",
    };
  if (method === "ping") return {};
  if (method === "tools/list") return { tools: TOOLS };
  if (method === "tools/call") {
    try {
      const out = await call(params?.name, params?.arguments ?? {});
      return {
        content: [{ type: "text", text: JSON.stringify(out, null, 2) }],
        structuredContent: Array.isArray(out) ? { items: out } : out,
        isError: false,
      };
    } catch (e) {
      if (e.code) throw e;
      return {
        content: [{ type: "text", text: `Voice Memory: ${e.message}` }],
        isError: true,
      };
    }
  }
  if (id === undefined) return undefined; // a notification
  throw Object.assign(new Error(`method not found: ${method}`), {
    code: -32601,
  });
}

const send = (o) => process.stdout.write(JSON.stringify(o) + "\n");
if (import.meta.url === `file://${process.argv[1]}`) {
  const rl = createInterface({ input: process.stdin });
  rl.on("line", async (line) => {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return send({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "parse error" },
      });
    }
    try {
      const result = await handle(msg);
      if (msg.id !== undefined && result !== undefined)
        send({ jsonrpc: "2.0", id: msg.id, result });
    } catch (e) {
      if (msg.id !== undefined)
        send({
          jsonrpc: "2.0",
          id: msg.id,
          error: { code: e.code ?? -32603, message: e.message },
        });
    }
  });
}
