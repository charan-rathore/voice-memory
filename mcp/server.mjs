#!/usr/bin/env node
// Voice Memory as an MCP server (Model Context Protocol, stdio transport):
// any MCP client (Claude, ChatGPT connectors, IDE agents, a Bolna-side tool
// runner) can ask the evidence engine and get back a fixed verdict and the
// exact cited lines, never a free-form guess.
//
// Zero dependencies: newline-delimited JSON-RPC 2.0 on stdin/stdout, as the
// MCP stdio transport specifies. It calls the key-free public API, so it
// holds no secrets. The same handler also serves the Streamable HTTP
// transport at /api/public/mcp (src/server.mjs), so a client can add it by
// URL without cloning anything.
//
//   VM_API_BASE=https://voice-memory-beige.vercel.app/api/public node mcp/server.mjs
//
// Claude Desktop / Claude Code config:
//   { "mcpServers": { "voice-memory": { "command": "node",
//       "args": ["/path/to/voice-memory/mcp/server.mjs"] } } }
// or, remote: https://voice-memory-beige.vercel.app/api/public/mcp
//
// upload_document reads a local file and sends it to the Voice Memory
// server, so an agent misled by a prompt could try to send anything on disk.
// It is OFF unless VM_MCP_UPLOAD_ROOTS names the folders it may read
// (path-delimiter separated); it accepts only the document types the engine
// reads, under 4 MB, never inside a hidden folder, judged by the real path.
// Each upload is also confirmed by the person: through MCP elicitation when
// the client supports it; a client without elicitation is refused.
// Text imports need the same confirmation. The stateless remote transport
// cannot elicit consent and does not offer either import tool.
import { readFile, realpath, stat } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { basename, isAbsolute, sep, delimiter } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import {
  PUBLIC_TOOLS,
  lookupTestCode,
  testEducation,
} from "./public-health.mjs";

const BASE = (
  process.env.VM_API_BASE || "https://voice-memory-beige.vercel.app/api/public"
).replace(/\/$/, "");
// Newest first. A client asking for one of these gets it back; anything
// else gets the newest, and the client decides whether it can continue.
export const SUPPORTED = ["2025-06-18", "2025-03-26", "2024-11-05"];
export const negotiate = (v) => (SUPPORTED.includes(v) ? v : SUPPORTED[0]);
const VERSION = "1.1.0";
const MAX_UPLOAD = 4 * 1024 * 1024;
const UPLOAD_EXT = /\.(pdf|docx|png|jpe?g|txt|md)$/i;

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
    name: "add_document_text",
    title: "Add a text document",
    description:
      "Add a document by its text (notes, a contract clause, an email) to a workspace, as a .txt or .md file. Requires person confirmation through local stdio elicitation.",
    inputSchema: {
      type: "object",
      required: ["workspace", "name", "text"],
      properties: {
        workspace: { type: "string", pattern: "^w_[0-9a-f]{32}$" },
        name: {
          type: "string",
          pattern: "^[A-Za-z0-9][A-Za-z0-9 _.-]{0,78}\\.(txt|md)$",
          description: "File name ending in .txt or .md",
        },
        text: { type: "string", maxLength: 200000 },
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
  ...PUBLIC_TOOLS,
];

async function api(path, opts = {}, ctx = {}) {
  const headers = { ...(opts.headers ?? {}) };
  // the remote transport calls the engine over loopback: keep the caller's
  // address so per-visitor limits apply to them, not to everyone at once
  if (ctx.clientIp) headers["x-forwarded-for"] = ctx.clientIp;
  const r = await fetch((ctx.base ?? BASE) + path, {
    ...opts,
    headers,
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
    verdict: a.final?.verdict ?? lead?.verdict ?? "UNKNOWN",
    answer: a.final?.text ?? lead?.text ?? a.answer ?? null,
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

/** Refuse anything that is not plainly a document the person meant to share. */
export async function checkUploadPath(
  p,
  roots = process.env.VM_MCP_UPLOAD_ROOTS,
) {
  if (typeof p !== "string" || !isAbsolute(p))
    throw new Error("path must be an absolute file path");
  const real = await realpath(p).catch(() => null);
  if (!real) throw new Error("no such file");
  if (!UPLOAD_EXT.test(real))
    throw new Error(
      "only PDF, DOCX, PNG, JPEG, TXT or MD files can be uploaded",
    );
  if (real.split(sep).some((seg) => seg.startsWith(".") && seg.length > 1))
    throw new Error("files inside hidden folders are never uploaded");
  if (!roots)
    throw new Error(
      "uploads are off: set VM_MCP_UPLOAD_ROOTS to the folders this server may read",
    );
  {
    const allowed = await Promise.all(
      roots
        .split(delimiter)
        .filter(Boolean)
        .map((r) => realpath(r).catch(() => null)),
    );
    if (!allowed.some((r) => r && (real === r || real.startsWith(r + sep))))
      throw new Error("file is outside the folders allowed for upload");
  }
  const st = await stat(real);
  if (!st.isFile()) throw new Error("not a regular file");
  if (st.size > MAX_UPLOAD) throw new Error("file is over 4 MB");
  return real;
}

export const uploadsEnabled = () => !!process.env.VM_MCP_UPLOAD_ROOTS;

/**
 * Ask the person before a file leaves their computer. Elicitation
 * (MCP 2025-06-18) when the client offers it; otherwise refuse. The legacy
 * confirmation-off environment variable never authorizes a disclosure.
 */
async function confirmUpload(ctx, file, size, workspace) {
  if (ctx.elicit) {
    const r = await ctx
      .elicit(
        `Send ${basename(file)} (${Math.ceil(size / 1024)} KB) from ${file} to Voice Memory at ${new URL(ctx.base ?? BASE).host}, workspace ${workspace}? The file leaves this computer.`,
        {
          type: "object",
          properties: {
            confirm: {
              type: "boolean",
              title: "Send this file",
              description: "Upload it to the workspace",
            },
          },
          required: ["confirm"],
        },
      )
      .catch(() => null);
    return r?.action === "accept" && r?.content?.confirm === true;
  }
  return false;
}

async function call(name, args = {}, ctx = {}) {
  const a = (path, opts) => api(path, opts, ctx);
  switch (name) {
    case "list_cases": {
      const c = await a("/cases");
      return (c.cases ?? c).map((x) => ({
        id: x.id,
        title: x.title,
        documents: (x.documents ?? []).map((d) => d.title),
      }));
    }
    case "ask_records": {
      const ans = await a("/ask", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          case: args.case,
          question: args.question,
          ...(args.context ? { context: args.context } : {}),
        }),
      });
      return shapeAnswer(ans);
    }
    case "lookup_test_code":
      return lookupTestCode(args.name, ctx);
    case "test_education":
      return testEducation(args.loinc, { ...ctx, language: args.language });
    case "create_workspace":
      return a("/workspace", { method: "POST" });
    case "upload_document": {
      if (ctx.remote)
        throw Object.assign(new Error(`unknown tool ${name}`), {
          code: -32602,
        });
      if (!/^w_[0-9a-f]{32}$/.test(String(args.workspace)))
        throw new Error("workspace must be an id from create_workspace");
      const file = await checkUploadPath(args.path);
      const size = (await stat(file)).size;
      if (!(await confirmUpload(ctx, file, size, args.workspace)))
        throw new Error("upload not confirmed by the user; nothing was sent");
      const bytes = await readFile(file);
      return a(`/workspace/${args.workspace}/upload`, {
        method: "POST",
        headers: {
          "content-type": "application/octet-stream",
          "x-file-name": encodeURIComponent(basename(file)),
        },
        body: bytes,
      });
    }
    case "add_document_text": {
      if (ctx.remote)
        throw new Error(
          "remote document import is unavailable: this transport cannot ask for confirmation",
        );
      if (!/^w_[0-9a-f]{32}$/.test(String(args.workspace)))
        throw new Error("workspace must be an id from create_workspace");
      if (
        !/^[A-Za-z0-9][A-Za-z0-9 _.-]{0,78}\.(txt|md)$/.test(String(args.name))
      )
        throw new Error("name must be a short file name ending in .txt or .md");
      const text = String(args.text ?? "");
      if (!text.trim()) throw new Error("text is empty");
      if (text.length > 200000)
        throw new Error("text is over 200,000 characters");
      if (!ctx.elicit)
        throw new Error(
          "text import not confirmed by the user; nothing was sent",
        );
      const consent = await ctx
        .elicit(
          `Send the following document ${args.name} to Voice Memory at ${new URL(ctx.base ?? BASE).host}, workspace ${args.workspace}? It leaves this computer. Workspace expires after 30 idle minutes or a server restart.\n\n${text}`,
          {
            type: "object",
            properties: {
              confirm: { type: "boolean", title: "Send this text document" },
            },
            required: ["confirm"],
          },
        )
        .catch(() => null);
      if (consent?.action !== "accept" || consent?.content?.confirm !== true)
        throw new Error(
          "text import not confirmed by the user; nothing was sent",
        );
      return a(`/workspace/${args.workspace}/upload`, {
        method: "POST",
        headers: {
          "content-type": "application/octet-stream",
          "x-file-name": encodeURIComponent(args.name),
        },
        body: Buffer.from(text, "utf8"),
      });
    }
    case "workspace_status":
      if (!/^w_[0-9a-f]{32}$/.test(String(args.workspace)))
        throw new Error("workspace must be an id from create_workspace");
      return a(`/workspace/${args.workspace}`);
    default:
      throw Object.assign(new Error(`unknown tool ${name}`), { code: -32602 });
  }
}

export async function handle(msg, ctx = {}) {
  const { id, method, params } = msg ?? {};
  if (typeof method !== "string")
    throw Object.assign(new Error("invalid request"), { code: -32600 });
  if (method === "initialize") {
    ctx.onInit?.(params?.capabilities ?? {});
    return {
      protocolVersion: negotiate(params?.protocolVersion),
      capabilities: { tools: { listChanged: false } },
      serverInfo: {
        name: "voice-memory",
        title: "Voice Memory",
        version: VERSION,
      },
      instructions:
        "Evidence engine over changing records. Relay `answer` and `citations` as given; a `closest` line is a pointer, not an answer. Demo cases are fictional; not a diagnostic product.",
    };
  }
  if (method === "ping") return {};
  if (method === "tools/list")
    return {
      tools:
        ctx.remote || !uploadsEnabled()
          ? TOOLS.filter(
              (t) =>
                t.name !== "upload_document" &&
                (!ctx.remote || t.name !== "add_document_text"),
            )
          : TOOLS,
    };
  if (method === "tools/call") {
    try {
      const out = await call(params?.name, params?.arguments ?? {}, ctx);
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

/**
 * One JSON-RPC message in, the response object (or undefined for a
 * notification) out. Shared by both transports.
 */
export async function respond(msg, ctx = {}) {
  const isReq =
    msg && typeof msg === "object" && msg.id !== undefined && msg.id !== null;
  try {
    const result = await handle(msg, ctx);
    if (!isReq || result === undefined) return undefined;
    return { jsonrpc: "2.0", id: msg.id, result };
  } catch (e) {
    if (!isReq) return undefined;
    return {
      jsonrpc: "2.0",
      id: msg.id,
      error: { code: e.code ?? -32603, message: e.message },
    };
  }
}

/**
 * Streamable HTTP transport (MCP 2025-06-18), stateless: every POST carries
 * JSON-RPC and gets JSON back; no session, no server-initiated stream.
 * ctx: { base, clientIp, allowedOrigins }.
 */
export async function mcpHttp(req, res, ctx = {}) {
  const json = (code, body, extra = {}) => {
    res.writeHead(code, {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      ...extra,
    });
    res.end(body === undefined ? "" : JSON.stringify(body));
  };
  // A browser page must not drive this endpoint from another site (DNS
  // rebinding / cross-site calls); agents and connectors send no Origin.
  const origin = req.headers.origin;
  if (origin && !(ctx.allowedOrigins ?? []).includes(origin))
    return json(403, {
      jsonrpc: "2.0",
      id: null,
      error: { code: -32000, message: "origin not allowed" },
    });
  if (req.method !== "POST")
    return json(
      405,
      {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32000, message: "use POST" },
      },
      { Allow: "POST" },
    );
  const pv = req.headers["mcp-protocol-version"];
  if (pv && !SUPPORTED.includes(pv))
    return json(400, {
      jsonrpc: "2.0",
      id: null,
      error: {
        code: -32000,
        message: `unsupported MCP-Protocol-Version ${pv}`,
      },
    });
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 1_000_000)
      return json(413, {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32000, message: "request too large" },
      });
  }
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch {
    return json(400, {
      jsonrpc: "2.0",
      id: null,
      error: { code: -32700, message: "parse error" },
    });
  }
  const c = { ...ctx, remote: true };
  if (Array.isArray(msg)) {
    // batches (2025-03-26 clients)
    const out = (
      await Promise.all(msg.slice(0, 20).map((m) => respond(m, c)))
    ).filter(Boolean);
    return out.length ? json(200, out) : json(202);
  }
  const out = await respond(msg, c);
  return out ? json(200, out) : json(202);
}

// Started as a program (also through a symlink, npx, or on Windows), not
// when imported by the engine or the tests.
const isMain = (() => {
  try {
    return (
      !!process.argv[1] &&
      realpathSync(fileURLToPath(import.meta.url)) ===
        realpathSync(process.argv[1])
    );
  } catch {
    return false;
  }
})();
const send = (o) => process.stdout.write(JSON.stringify(o) + "\n");
if (isMain) {
  // requests this server sends to the client (elicitation) and their replies
  const waiting = new Map();
  let seq = 0;
  let clientCaps = {};
  const ctx = {
    onInit: (caps) => (clientCaps = caps),
    get elicit() {
      if (!clientCaps.elicitation) return undefined;
      return (message, requestedSchema) =>
        new Promise((ok, bad) => {
          const id = `vm-elicit-${++seq}`;
          const t = setTimeout(() => {
            waiting.delete(id);
            bad(new Error("no answer"));
          }, 120000);
          waiting.set(id, (m) => {
            clearTimeout(t);
            m.error ? bad(new Error(m.error.message)) : ok(m.result);
          });
          send({
            jsonrpc: "2.0",
            id,
            method: "elicitation/create",
            params: { message, requestedSchema },
          });
        });
    },
  };
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
    // a reply to one of our requests
    if (msg && !msg.method && waiting.has(msg.id)) {
      const done = waiting.get(msg.id);
      waiting.delete(msg.id);
      return done(msg);
    }
    const out = await respond(msg, ctx);
    if (out) send(out);
  });
}
