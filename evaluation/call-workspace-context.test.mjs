// The product rule, verbatim from the owner: the call answers from "the
// exact docs uploaded"; "only if no doc uploaded it should answer from the
// default docs". A failed, expired or still-processing upload is NOT "no
// upload" and must never silently switch the call to the default records.
// No network: Bolna minting goes through an injected fetch; the turn is
// replayed exactly as Bolna sends it (system prompt with the substituted
// vm_ws= value, the transcript as the final user message).
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createLocalServer } from "../src/server.mjs";

const agentPrompt = (v) =>
  `Voice Memory evidence agent. Workspace: vm_ws=${v}. Answers come from the Voice Memory engine.`;
const CAP = "ctx" + "9".repeat(61);

const WAREHOUSE =
  "East warehouse safety review - October 2026.\nThe east warehouse recorded 14 open safety items, of which 9 are overdue.\nThe north warehouse recorded 3 open safety items, none overdue.\n";
const BAKERY =
  "Corner bakery weekly log.\nThe bakery sold 412 loaves on Saturday and 388 on Sunday.\n";

async function boot(env = {}) {
  const saved = { ...process.env };
  const dir = mkdtempSync(path.join(tmpdir(), "vm-wsctx-"));
  Object.assign(process.env, {
    VM_VOICE_CAPABILITY: CAP,
    VM_VOICE_HARD_EXPIRES_AT: new Date(Date.now() + 3600e3).toISOString(),
    VM_DENSE: "off",
    BOLNA_API_KEY: "test-dummy",
    BOLNA_AGENT_ID: "test-dummy",
    VM_PUBLIC_VOICE: "on",
    VM_COUNTERS_ALLOW_FILE: "on",
    VM_PUBLIC_COUNTER_FILE: path.join(dir, "counters.json"),
    VM_PUBLIC_CALL_GAP_MS: "1",
    VM_PUBLIC_CALLS_PER_IP_DAY: "50",
    VM_PUBLIC_CALLS_PER_DAY: "50",
    ...env,
  });
  const minted = [];
  const vendorFetch = async (url, init) => {
    if (String(url).includes("/web-call/")) {
      minted.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ execution_id: "ex" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("{}", { status: 200 });
  };
  const srv = createLocalServer({ port: 0, vendorFetch });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  await srv.loadPublicCases({ bindVoice: true });
  await new Promise((r) => setTimeout(r, 300));
  const b = `http://127.0.0.1:${srv.address().port}`;
  const post = async (p, body, headers = {}) => {
    const r = await fetch(b + p, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  const say = async (vmWs, text) => {
    const r = await fetch(b + "/v1/chat/completions", {
      method: "POST",
      headers: {
        authorization: "Bearer " + CAP,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "voice-memory-local",
        stream: true,
        messages: [
          { role: "system", content: agentPrompt(vmWs) },
          { role: "user", content: text },
        ],
      }),
    });
    const raw = await r.text();
    return [...raw.matchAll(/^data: (.*)$/gm)]
      .map((m) => m[1])
      .filter((d) => d !== "[DONE]")
      .map((d) => JSON.parse(d).choices?.[0]?.delta?.content ?? "")
      .join("")
      .trim();
  };
  const upload = async (bytes, name) => {
    const ws = await post("/api/public/workspace", {});
    const id = ws.body.id;
    const up = await fetch(`${b}/api/public/workspace/${id}/upload`, {
      method: "POST",
      headers: {
        "content-type": "application/octet-stream",
        "x-file-name": encodeURIComponent(name),
      },
      body: bytes,
    });
    assert.equal(up.status, 202, `upload ${name}`);
    let st = null;
    for (let i = 0; i < 100; i++) {
      const r = await fetch(`${b}/api/public/workspace/${id}`);
      st = (await r.json()).documents?.[0];
      if (st && ["ready", "needs_review", "failed"].includes(st.status))
        return { id, status: st.status };
      await new Promise((r2) => setTimeout(r2, 200));
    }
    throw new Error("upload never settled: " + JSON.stringify(st));
  };
  return {
    minted,
    say,
    upload,
    mint: (user_data, ip = "10.2.0.1") =>
      post(
        "/api/public/voice/session",
        { user_data },
        { "x-forwarded-for": ip },
      ),
    scope: (ticket, c, gen) =>
      post("/api/public/voice/scope", { ticket, case: c, gen }),
    close: async () => {
      await new Promise((r) => srv.close(() => r()));
      for (const k of Object.keys(process.env))
        if (!(k in saved)) delete process.env[k];
      Object.assign(process.env, saved);
    },
  };
}

test("a live call answers from the exact uploaded documents, not the default records", async () => {
  const api = await boot();
  try {
    const { id, status } = await api.upload(WAREHOUSE, "warehouse.txt");
    assert.equal(status, "ready");
    const m = await api.mint({ vm_ws: id });
    assert.equal(m.status, 200);
    const vmWs = api.minted[0].user_data.vm_ws;
    assert.ok(vmWs.startsWith(id + ".c"));
    const said = await api.say(
      vmWs,
      "How many open safety items did the east warehouse record?",
    );
    assert.match(said, /14/);
    assert.doesNotMatch(said, /ferritin|SYN-|Northstar/i);
  } finally {
    await api.close();
  }
});

test("true no-upload control: the call answers from the default records", async () => {
  const api = await boot();
  try {
    const m = await api.mint({});
    assert.equal(m.status, 200);
    const vmWs = api.minted[0].user_data.vm_ws;
    assert.match(vmWs, /^demo\.c[0-9a-f]{24}$/);
    const said = await api.say(vmWs, "What is SYN-0001's ferritin result?");
    assert.match(said, /50 ng\/mL/);
  } finally {
    await api.close();
  }
});

test("a failed upload is not 'no upload': said plainly, never the default records", async () => {
  const api = await boot();
  try {
    const { id, status } = await api.upload(
      "%PDF-1.4 this is not really a pdf at all {{{{",
      "broken.pdf",
    );
    assert.equal(status, "failed");
    const m = await api.mint({ vm_ws: id });
    assert.equal(m.status, 200);
    const said = await api.say(
      api.minted[0].user_data.vm_ws,
      "How many open safety items did the east warehouse record?",
    );
    assert.match(said, /couldn't read/i);
    assert.doesNotMatch(said, /ferritin|50 ng\/mL|SYN-/i);
  } finally {
    await api.close();
  }
});

test("an expired workspace is not 'no upload': said plainly, never the default records", async () => {
  // A 30 ms real deadline could expire before upload on a loaded test host.
  // Advance the clock only AFTER upload and mint, then exercise the real
  // expiration path without racing parser/network scheduling.
  const api = await boot({ VM_WS_IDLE_MIN: "1" });
  const realNow = Date.now;
  try {
    const { id } = await api.upload(WAREHOUSE, "warehouse.txt");
    const m = await api.mint({ vm_ws: id });
    assert.equal(m.status, 200);
    const expiredAt = realNow() + 61000;
    Date.now = () => expiredAt;
    const said = await api.say(
      api.minted[0].user_data.vm_ws,
      "How many open safety items did the east warehouse record?",
    );
    assert.match(said, /expired/i);
    assert.doesNotMatch(said, /ferritin|50 ng\/mL|14 open/i);
  } finally {
    Date.now = realNow;
    await api.close();
  }
});

test("one caller's workspace is never another caller's answer", async () => {
  const api = await boot();
  try {
    const w1 = await api.upload(WAREHOUSE, "warehouse.txt");
    const w2 = await api.upload(BAKERY, "bakery.txt");
    const m1 = await api.mint({ vm_ws: w1.id });
    const m2 = await api.mint({ vm_ws: w2.id });
    assert.equal(m1.status, 200);
    assert.equal(m2.status, 200);
    const said1 = await api.say(
      api.minted[0].user_data.vm_ws,
      "How many open safety items did the east warehouse record?",
    );
    assert.match(said1, /14/);
    assert.doesNotMatch(said1, /412|bakery/i);
    const said2 = await api.say(
      api.minted[1].user_data.vm_ws,
      "How many loaves did the bakery sell on Saturday?",
    );
    assert.match(said2, /412/);
    assert.doesNotMatch(said2, /warehouse|safety/i);
  } finally {
    await api.close();
  }
});

test("a mid-call scope switch moves the call's corpus, and back", async () => {
  const api = await boot();
  try {
    const { id } = await api.upload(WAREHOUSE, "warehouse.txt");
    const m = await api.mint({ vm_ws: id });
    const t = m.body.vm_ticket;
    const vmWs = api.minted[0].user_data.vm_ws;
    assert.match(
      await api.say(
        vmWs,
        "How many open safety items did the east warehouse record?",
      ),
      /14/,
    );
    assert.equal((await api.scope(t, "health", 1)).body.case, "health");
    const lab = await api.say(vmWs, "What is SYN-0001's ferritin result?");
    assert.match(lab, /50 ng\/mL/);
    assert.equal((await api.scope(t, id, 2)).body.case, id);
    const back = await api.say(
      vmWs,
      "How many open safety items did the east warehouse record?",
    );
    assert.match(back, /14/);
    assert.doesNotMatch(back, /ferritin/i);
  } finally {
    await api.close();
  }
});

test("an unregistered call handle never falls back to its embedded demo scope", async () => {
  const api = await boot();
  try {
    const said = await api.say(
      "health.c" + "f".repeat(24),
      "What is SYN-0001's ferritin result?",
    );
    assert.doesNotMatch(said, /50 ng\/mL/);
    assert.match(said, /start it again|which documents|ended/i);
  } finally {
    await api.close();
  }
});

test("an expired registered call cannot retrieve or replay a still-live uploaded workspace", async () => {
  const api = await boot();
  const realNow = Date.now;
  try {
    const { id } = await api.upload(WAREHOUSE, "warehouse.txt");
    await api.mint({ vm_ws: id });
    const handle = api.minted[0].user_data.vm_ws;
    assert.match(
      await api.say(
        handle,
        "How many open safety items did the east warehouse record?",
      ),
      /14/,
    );
    const expiredAt = realNow() + 21 * 60000;
    Date.now = () => expiredAt;
    const lookup = await api.say(
      handle,
      "How many open safety items did the east warehouse record?",
    );
    assert.doesNotMatch(lookup, /14|fourteen/);
    assert.match(lookup, /start it again|which documents|ended/i);
    const said = await api.say(handle, "Say that again");
    assert.doesNotMatch(said, /14|fourteen/);
    assert.match(said, /start it again|which documents|ended/i);
  } finally {
    Date.now = realNow;
    await api.close();
  }
});
