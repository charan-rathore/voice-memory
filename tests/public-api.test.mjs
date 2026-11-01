// Public landing API: key-free, read-only answers over the built-in
// fictional cases. Visitors get the same deterministic, source-located
// answers as the voice call, and nothing that mutates or spends.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createLocalServer } from "../src/server.mjs";

// The suites exercise the non-durable file backend and injected fakes:
// explicit local dev/test opt-in required by the fail-closed selector.
process.env.VM_COUNTERS_ALLOW_FILE = "on";

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

test("VM_PUBLIC_VOICE is deny-by-default: unset, off and unknown values deny and hide voice", async () => {
  const saved = {
    BOLNA_API_KEY: process.env.BOLNA_API_KEY,
    BOLNA_AGENT_ID: process.env.BOLNA_AGENT_ID,
    VM_PUBLIC_VOICE: process.env.VM_PUBLIC_VOICE,
  };
  const restore = () => {
    for (const [k, v] of Object.entries(saved))
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
  };
  const spawned = [];
  const spawn = async () => {
    const s = createLocalServer({ port: 0 });
    await new Promise((r) => s.listen(0, "127.0.0.1", r));
    spawned.push(s);
    return { s, b: `http://127.0.0.1:${s.address().port}` };
  };
  try {
    process.env.BOLNA_API_KEY = "test-dummy";
    process.env.BOLNA_AGENT_ID = "test-dummy";
    // Every value except exact lowercase "on" must keep minting closed.
    // The 503 is thrown before any mint call, so dummy creds never reach
    // the network on these variants.
    for (const variant of ["__unset__", "off", "OFF", "yes", "1", ""]) {
      if (variant === "__unset__") delete process.env.VM_PUBLIC_VOICE;
      else process.env.VM_PUBLIC_VOICE = variant;
      const srv = await spawn();
      await srv.s.loadPublicCases();
      const mint = await fetch(srv.b + "/api/public/voice/session", {
        method: "POST",
      });
      assert.equal(mint.status, 503, `variant ${variant}`);
      assert.match((await mint.json()).error, /disabled/i);
      const st = await (await fetch(srv.b + "/api/public/status")).json();
      assert.deepEqual(
        st.voice,
        { configured: false, ready: false },
        `variant ${variant}`,
      );
      // Typed demo stays open under every variant.
      assert.equal(
        (await fetch(srv.b + "/api/public/cases")).status,
        200,
        `variant ${variant}`,
      );
      const typed = await fetch(srv.b + "/api/public/ask", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          case: "health",
          question: "What is SYN-0001's ferritin result?",
        }),
      });
      assert.equal(typed.status, 200, `variant ${variant}`);
    }

    // Explicit opt-in: status advertises voice again (no mint exercised
    // here - mint-through with a mock is covered in the factory test).
    process.env.VM_PUBLIC_VOICE = "on";
    const on = await spawn();
    const stOn = await (await fetch(on.b + "/api/public/status")).json();
    assert.equal(stOn.voice.configured, true);
  } finally {
    restore();
    // Close every spawned server even when an assertion failed midway, so a
    // genuine regression fails promptly instead of hanging the runner.
    await Promise.all(
      spawned.map((x) => new Promise((r) => x.close(() => r()))),
    );
  }
});

test("VM_PUBLIC_VOICE=on mints through the factory (mock mint, no network)", async () => {
  const saved = {
    BOLNA_API_KEY: process.env.BOLNA_API_KEY,
    BOLNA_AGENT_ID: process.env.BOLNA_AGENT_ID,
    VM_PUBLIC_VOICE: process.env.VM_PUBLIC_VOICE,
  };
  const restore = () => {
    for (const [k, v] of Object.entries(saved))
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
  };
  const { createPublicApi } = await import("../src/public-api.mjs");
  const { createServer } = await import("node:http");
  let srv = null;
  try {
    process.env.BOLNA_API_KEY = "test-dummy";
    process.env.BOLNA_AGENT_ID = "test-dummy";
    process.env.VM_PUBLIC_VOICE = "on";
    process.env.VM_PUBLIC_COUNTER_FILE = path.join(
      mkdtempSync(path.join(tmpdir(), "vm-counters-")),
      "c.json",
    );
    let mints = 0;
    const api = createPublicApi({
      cases: {},
      resolve: async () => {
        throw new Error("not exercised");
      },
      mintVoice: async (userData) => {
        mints += 1;
        return { fake_session: true, user_data: userData ?? null };
      },
      voiceTurns: () => [],
      voiceState: () => ({ configured: true, ready: true }),
    });
    srv = createServer((req, res) => api(req, res));
    await new Promise((r) => srv.listen(0, "127.0.0.1", r));
    const b = `http://127.0.0.1:${srv.address().port}`;
    const mint = await fetch(b + "/api/public/voice/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ user_data: { page: "landing" } }),
    });
    assert.equal(mint.status, 200);
    const body = await mint.json();
    assert.equal(body.fake_session, true);
    // The mint payload carries the caller's user_data plus the reconcile
    // correlation tag (this call's reservation id).
    assert.equal(body.user_data.page, "landing");
    assert.match(body.user_data.vm_res, /^r_/);
    assert.equal(mints, 1);
    const st = await (await fetch(b + "/api/public/status")).json();
    assert.deepEqual(st.voice, { configured: true, ready: true });
  } finally {
    restore();
    if (srv) await new Promise((r) => srv.close(() => r()));
  }
});

test("anonymous POSTs to owner voice routes are denied on the public host", async () => {
  const saved = {
    VM_PUBLIC_HOST: process.env.VM_PUBLIC_HOST,
    VM_PUBLIC_ORIGIN: process.env.VM_PUBLIC_ORIGIN,
    VM_OWNER_KEY: process.env.VM_OWNER_KEY,
    BOLNA_API_KEY: process.env.BOLNA_API_KEY,
    BOLNA_AGENT_ID: process.env.BOLNA_AGENT_ID,
  };
  const restore = () => {
    for (const [k, v] of Object.entries(saved))
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
  };
  const { request } = await import("node:http");
  try {
    process.env.VM_PUBLIC_HOST = "public.example";
    process.env.VM_PUBLIC_ORIGIN = "https://public.example";
    process.env.VM_OWNER_KEY = "test-owner-key";
    process.env.BOLNA_API_KEY = "test-dummy";
    process.env.BOLNA_AGENT_ID = "test-dummy";
    const s = createLocalServer({ port: 0 });
    await new Promise((r) => s.listen(0, "127.0.0.1", r));
    const port = s.address().port;
    // undici overrides the Host header, so drive the raw client.
    const post = (path) =>
      new Promise((resolve, reject) => {
        const req = request(
          {
            host: "127.0.0.1",
            port,
            path,
            method: "POST",
            headers: {
              host: "public.example",
              "content-type": "application/json",
            },
          },
          (res) => {
            const chunks = [];
            res.on("data", (c) => chunks.push(c));
            res.on("end", () =>
              resolve({
                status: res.statusCode,
                body: Buffer.concat(chunks).toString(),
              }),
            );
          },
        );
        req.on("error", reject);
        req.end("{}");
      });
    try {
      for (const path of [
        "/api/bolna-session",
        "/api/voice/start",
        "/api/voice/turn",
      ]) {
        const r = await post(path);
        assert.equal(r.status, 403, path);
        assert.match(r.body, /Owner access required/, path);
      }
    } finally {
      await new Promise((r) => s.close(r));
    }
  } finally {
    restore();
  }
});

test("visitors upload their own documents and ask them anything", async () => {
  const { readFileSync } = await import("node:fs");
  const ws = await (
    await fetch(base + "/api/public/workspace", { method: "POST" })
  ).json();
  assert.match(ws.id, /^w_[0-9a-f]{32}$/);
  for (const [f, name] of [
    ["../clinical/fixtures/files/a-2026-10-amended.pdf", "my-report.pdf"],
    ["../examples/corpus-md/07_Internal_Action_Log.md", "action-log.md"],
  ]) {
    const r = await fetch(`${base}/api/public/workspace/${ws.id}/upload`, {
      method: "POST",
      headers: {
        "x-file-name": name,
        "content-type": "application/octet-stream",
      },
      body: readFileSync(new URL(f, import.meta.url)),
    });
    assert.equal(r.status, 202);
  }
  let st;
  for (let i = 0; i < 200; i++) {
    st = await (await fetch(`${base}/api/public/workspace/${ws.id}`)).json();
    if (
      st.documents.length === 2 &&
      st.documents.every((d) => d.status === "ready")
    )
      break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(st.ready);
  const a = await ask(ws.id, "What is the ferritin?");
  assert.match(a.body.lead.text, /50 ng\/mL/);
  const b = await ask(ws.id, "Is there a signed agreement?");
  assert.match(b.body.lead.text, /no signed commercial agreement/i);
  const g = await (await fetch(`${base}/api/public/graph/${ws.id}`)).json();
  assert.ok(g.nodes.some((n) => n.kind === "patient"));
  assert.ok(
    g.nodes.some(
      (n) =>
        n.kind === "topic" &&
        n.id.startsWith("topic:") &&
        !n.id.startsWith("topic:lab"),
    ),
  );
  // another visitor's guess cannot read it
  assert.equal(
    (await ask("w_" + "0".repeat(32), "What is the ferritin?")).status,
    400,
  );
});
test("bring-your-own answers complete wrapped sentences and keep one supporting passage", async () => {
  const { readFileSync } = await import("node:fs");
  const ws = await (
    await fetch(base + "/api/public/workspace", { method: "POST" })
  ).json();
  // PDF text layers often carry one visual line per blank-line block; this
  // markdown fixture has the same shape, so the excerpt builder faces the
  // same wrapped sentence and the same clipped duplicate line.
  const wrapped = [
    "# Harbor & Fig Catering Services Agreement",
    "",
    "2. Menu deadline. Final menu selections and headcount must be confirmed in",
    "",
    "writing no later than 27 March 2027. Changes after that date incur a",
    "",
    "replanning fee of Rs 18,000.",
    "",
    "5. Allergens. The Caterer will label all dishes containing nuts, dairy and",
    "",
    "gluten, and will provide a nut-free preparation line on request.",
  ].join("\n");
  const r = await fetch(`${base}/api/public/workspace/${ws.id}/upload`, {
    method: "POST",
    headers: {
      "x-file-name": "harbor-fig-catering.md",
      "content-type": "application/octet-stream",
    },
    body: wrapped,
  });
  assert.equal(r.status, 202);
  let st;
  for (let i = 0; i < 200; i++) {
    st = await (await fetch(`${base}/api/public/workspace/${ws.id}`)).json();
    if (st.documents?.length && st.documents.every((d) => d.status === "ready"))
      break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(st.ready);
  const a = await ask(
    ws.id,
    "What is the menu deadline and what fee applies if it changes after that?",
  );
  assert.equal(a.status, 200);
  // The excerpt must complete the wrapped sentence: the deadline AND the fee,
  // not a cut-off "...incur a".
  assert.match(a.body.answer, /27 March 2027/);
  assert.match(a.body.answer, /Rs 18,000/);
  assert.doesNotMatch(a.body.answer, /incur a\n\[Source/);
  // The clipped duplicate line must not appear beside the completed passage.
  const occurrences = a.body.answer.split("27 March 2027").length - 1;
  assert.ok(occurrences <= 2, `deadline repeated ${occurrences} times`);
  // Continuation must not swallow the following unrelated block.
  assert.doesNotMatch(a.body.answer.split("[Source 1]")[0], /Allergens/);
});

// ---- Public-call counters: visitor allowance, ceilings, cutoff, fail-closed
// Each factory test gets its own counter file; nothing touches the network
// (mintVoice is a mock) and nothing spends.

import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { createCallCounters } from "../src/public-call-counters.mjs";

const VOICE_ENV = [
  "BOLNA_API_KEY",
  "BOLNA_AGENT_ID",
  "VM_PUBLIC_VOICE",
  "VM_PUBLIC_COUNTER_FILE",
  "VM_PUBLIC_CALLS_PER_IP_DAY",
  "VM_PUBLIC_CALLS_PER_DAY",
  "VM_PUBLIC_CALLS_LIFETIME_MAX",
  "VM_PUBLIC_CALL_MAX_MS",
  "VM_PUBLIC_CALL_GAP_MS",
];
const saveEnv = () => {
  const saved = Object.fromEntries(VOICE_ENV.map((k) => [k, process.env[k]]));
  return () => {
    for (const k of VOICE_ENV)
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
  };
};

async function voiceFactory({ env = {}, mintVoice } = {}) {
  const { createPublicApi } = await import("../src/public-api.mjs");
  const dir = mkdtempSync(path.join(tmpdir(), "vm-counters-"));
  process.env.BOLNA_API_KEY = "test-dummy";
  process.env.BOLNA_AGENT_ID = "test-dummy";
  process.env.VM_PUBLIC_VOICE = "on";
  process.env.VM_PUBLIC_COUNTER_FILE = path.join(dir, "counters.json");
  process.env.VM_PUBLIC_CALL_GAP_MS = "1";
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  let stops = 0;
  const api = createPublicApi({
    cases: {},
    resolve: async () => {
      throw new Error("not exercised");
    },
    mintVoice:
      mintVoice ?? (async () => ({ fake_session: true, run_id: "run-test-1" })),
    stopVoice: async () => {
      stops += 1;
    },
    voiceTurns: () => [],
    voiceState: () => ({ configured: true, ready: true }),
  });
  const srv = createServer((req, res) => api(req, res));
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const b = `http://127.0.0.1:${srv.address().port}`;
  const mint = (ip) =>
    fetch(b + "/api/public/voice/session", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": ip },
      body: "{}",
    });
  return {
    b,
    mint,
    stops: () => stops,
    close: () => new Promise((r) => srv.close(() => r())),
  };
}

test("visitor allowance: 3 per visitor per day, per-visitor isolation", async () => {
  const restore = saveEnv();
  const f = await voiceFactory({ env: { VM_PUBLIC_CALLS_PER_IP_DAY: "2" } });
  try {
    assert.equal((await f.mint("10.0.0.1")).status, 200);
    assert.equal((await f.mint("10.0.0.1")).status, 200);
    const third = await f.mint("10.0.0.1");
    assert.equal(third.status, 429);
    const body = await third.json();
    assert.equal(body.scope, "customer");
    assert.match(body.error, /today's demo calls/i);
    // A different visitor still gets their own allowance.
    assert.equal((await f.mint("10.0.0.2")).status, 200);
  } finally {
    await f.close();
    restore();
  }
});

test("global day allowance holds across visitors", async () => {
  const restore = saveEnv();
  const f = await voiceFactory({
    env: { VM_PUBLIC_CALLS_PER_IP_DAY: "9", VM_PUBLIC_CALLS_PER_DAY: "2" },
  });
  try {
    assert.equal((await f.mint("10.0.1.1")).status, 200);
    assert.equal((await f.mint("10.0.1.2")).status, 200);
    const third = await f.mint("10.0.1.3");
    assert.equal(third.status, 429);
    assert.equal((await third.json()).scope, "global");
  } finally {
    await f.close();
    restore();
  }
});

test("lifetime count caps total mints", async () => {
  const restore = saveEnv();
  const f = await voiceFactory({
    env: {
      VM_PUBLIC_CALLS_PER_IP_DAY: "9",
      VM_PUBLIC_CALLS_PER_DAY: "9",
      VM_PUBLIC_CALLS_LIFETIME_MAX: "2",
    },
  });
  try {
    assert.equal((await f.mint("10.0.2.1")).status, 200);
    assert.equal((await f.mint("10.0.2.2")).status, 200);
    assert.equal((await f.mint("10.0.2.3")).status, 429);
  } finally {
    await f.close();
    restore();
  }
});

test("counter store failure fails closed (no mint, 503)", async () => {
  const restore = saveEnv();
  // Point the store at an existing DIRECTORY: reads fail non-ENOENT.
  const dir = mkdtempSync(path.join(tmpdir(), "vm-counters-"));
  const { createPublicApi } = await import("../src/public-api.mjs");
  process.env.BOLNA_API_KEY = "test-dummy";
  process.env.BOLNA_AGENT_ID = "test-dummy";
  process.env.VM_PUBLIC_VOICE = "on";
  process.env.VM_PUBLIC_COUNTER_FILE = dir;
  const api = createPublicApi({
    cases: {},
    resolve: async () => {
      throw new Error("not exercised");
    },
    mintVoice: async () => ({ fake_session: true }),
    voiceTurns: () => [],
    voiceState: () => ({ configured: true, ready: true }),
  });
  const srv = createServer((req, res) => api(req, res));
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  try {
    const r = await fetch(
      `http://127.0.0.1:${srv.address().port}/api/public/voice/session`,
      { method: "POST" },
    );
    assert.equal(r.status, 503);
  } finally {
    await new Promise((r) => srv.close(() => r()));
    restore();
  }
});

test("per-call max duration: ticket dies and vendor stop is attempted", async () => {
  const restore = saveEnv();
  const f = await voiceFactory({ env: { VM_PUBLIC_CALL_MAX_MS: "60" } });
  try {
    const mint = await f.mint("10.0.3.1");
    assert.equal(mint.status, 200);
    const { vm_ticket } = await mint.json();
    const ok = await fetch(f.b + `/api/public/voice/turns?ticket=${vm_ticket}`);
    assert.equal(ok.status, 200);
    await new Promise((r) => setTimeout(r, 150));
    const gone = await fetch(
      f.b + `/api/public/voice/turns?ticket=${vm_ticket}`,
    );
    assert.equal(gone.status, 403);
    assert.equal(f.stops(), 1);
  } finally {
    await f.close();
    restore();
  }
});

test("a failed mint hands the allowance back", async () => {
  const restore = saveEnv();
  let calls = 0;
  const f = await voiceFactory({
    env: { VM_PUBLIC_CALLS_PER_IP_DAY: "1" },
    mintVoice: async () => {
      calls += 1;
      if (calls === 1) {
        const e = new Error("vendor busy");
        e.status = 502;
        e.preSession = true; // definitive: vendor created nothing
        throw e;
      }
      return { fake_session: true };
    },
  });
  try {
    assert.equal((await f.mint("10.0.4.1")).status, 502);
    assert.equal((await f.mint("10.0.4.1")).status, 200);
  } finally {
    await f.close();
    restore();
  }
});

test("counter module: day rollover resets allowances, visitor lifetime persists, owner counted SEPARATELY", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "vm-counters-"));
  let t = Date.parse("2026-11-01T10:00:00Z");
  const c = createCallCounters({
    file: path.join(dir, "c.json"),
    now: () => t,
  });
  const lim = { perIpDay: 1, globalDay: 5, lifetimeMax: 3 };
  assert.equal((await c.admitVisitor("1.1.1.1", lim)).ok, true);
  assert.equal((await c.admitVisitor("1.1.1.1", lim)).scope, "visitor-day");
  // Next UTC day: the per-visitor allowance resets...
  t = Date.parse("2026-11-02T10:00:00Z");
  assert.equal((await c.admitVisitor("1.1.1.1", lim)).ok, true);
  // ...the visitor lifetime count persists, and the owner is counted in a
  // SEPARATE counter that never consumes visitor admission budget.
  assert.equal((await c.admitOwner()).ok, true);
  assert.equal((await c.admitVisitor("2.2.2.2", lim)).ok, true);
  assert.equal((await c.admitVisitor("3.3.3.3", lim)).scope, "lifetime");
  const p = await c.peek();
  assert.equal(p.lifetime, 3);
  assert.equal(p.ownerLifetime, 1);
});

test("owner mints are counted but never capped by the visitor abuse budget", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "vm-counters-"));
  const c = createCallCounters({ file: path.join(dir, "c.json") });
  const lim = { perIpDay: 1, globalDay: 1, lifetimeMax: 1 };
  // Visitor budget exhausted (lifetime 1 of 1)...
  assert.equal((await c.admitVisitor("1.1.1.1", lim)).ok, true);
  assert.equal((await c.admitVisitor("2.2.2.2", lim)).scope, "lifetime");
  // ...the owner still mints (unlimited count), counted SEPARATELY.
  const own = await c.admitOwner();
  assert.equal(own.ok, true);
  let p = await c.peek();
  assert.equal(p.lifetime, 1); // visitor budget untouched by owner mints
  assert.equal(p.ownerLifetime, 1);
  // Owner reservation lifecycle: settle is exactly-once, refund after
  // settle is a no-op, and an owner refund never touches day buckets.
  await c.settleReservation(own.reservation);
  await c.refundReservation(own.reservation);
  p = await c.peek();
  assert.equal(p.lifetime, 1);
  assert.equal(p.ownerLifetime, 1);
  assert.equal(p.today.perIp["1.1.1.1"], 1);
  // A pre-settle owner refund releases ONLY the owner counter.
  const own2 = await c.admitOwner();
  await c.refundReservation(own2.reservation);
  p = await c.peek();
  assert.equal(p.lifetime, 1);
  assert.equal(p.ownerLifetime, 1);
});

test("adversarial: 10 concurrent mints, one visitor, allowance 3 - exactly 3 pass", async () => {
  const restore = saveEnv();
  const f = await voiceFactory({ env: { VM_PUBLIC_CALLS_PER_IP_DAY: "3" } });
  try {
    const rs = await Promise.all(
      Array.from({ length: 10 }, () => f.mint("10.0.9.1")),
    );
    const oks = rs.filter((r) => r.status === 200).length;
    const refused = rs.filter((r) => r.status === 429).length;
    assert.equal(oks, 3);
    assert.equal(refused, 7);
  } finally {
    await f.close();
    restore();
  }
});

test("adversarial: refund is exactly-once per reservation, never releases another call's capacity", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "vm-counters-"));
  const c = createCallCounters({ file: path.join(dir, "c.json") });
  const lim = { perIpDay: 5, globalDay: 5, lifetimeMax: 5 };
  // Three active reservations from the same visitor.
  const a = await c.admitVisitor("1.1.1.1", lim);
  const b = await c.admitVisitor("1.1.1.1", lim);
  const d = await c.admitVisitor("1.1.1.1", lim);
  assert.equal((await c.peek()).today.perIp["1.1.1.1"], 3);
  // Refund A twice (duplicate callback): only A's slot is released.
  await c.refundReservation(a.reservation);
  await c.refundReservation(a.reservation);
  let p = await c.peek();
  assert.equal(p.today.perIp["1.1.1.1"], 2);
  assert.equal(p.lifetime, 2);
  // Unknown id: no-op.
  await c.refundReservation("r_forged");
  // Settle B (mint succeeded), then a late refund for B: no-op, B stays counted.
  await c.settleReservation(b.reservation);
  await c.refundReservation(b.reservation);
  p = await c.peek();
  assert.equal(p.today.perIp["1.1.1.1"], 2);
  assert.equal(p.lifetime, 2);
  // Refund D once: exactly one more slot released.
  await c.refundReservation(d.reservation);
  p = await c.peek();
  assert.equal(p.today.perIp["1.1.1.1"], 1);
  assert.equal(p.lifetime, 1);
});

test("adversarial: crash recovery - a fresh instance on the same file keeps the counts", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "vm-counters-"));
  const file = path.join(dir, "c.json");
  const lim = { perIpDay: 2, globalDay: 9, lifetimeMax: 9 };
  const c1 = createCallCounters({ file });
  assert.equal((await c1.admitVisitor("1.1.1.1", lim)).ok, true);
  // Simulate a process restart: brand-new instance, same file.
  const c2 = createCallCounters({ file });
  assert.equal((await c2.peek()).lifetime, 1);
  assert.equal((await c2.admitVisitor("1.1.1.1", lim)).ok, true);
  assert.equal((await c2.admitVisitor("1.1.1.1", lim)).scope, "visitor-day");
});

test("adversarial: deleted store file reinitializes (documented reset, no durability pretense)", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "vm-counters-"));
  const file = path.join(dir, "c.json");
  const c = createCallCounters({ file });
  const lim = { perIpDay: 1, globalDay: 9, lifetimeMax: 9 };
  assert.equal((await c.admitVisitor("1.1.1.1", lim)).ok, true);
  const { rmSync } = await import("node:fs");
  rmSync(file);
  // A brand-new process would see NO file: counters start over. This is the
  // documented reset behavior - the store is rate smoothing, not a ceiling.
  const c2 = createCallCounters({ file });
  assert.equal((await c2.peek()).lifetime, 0);
  assert.equal((await c2.admitVisitor("1.1.1.1", lim)).ok, true);
});

test("adversarial: corrupt store file fails closed with 503", async () => {
  const restore = saveEnv();
  const dir = mkdtempSync(path.join(tmpdir(), "vm-counters-"));
  const file = path.join(dir, "c.json");
  const { writeFileSync } = await import("node:fs");
  writeFileSync(file, "{not json");
  const { createPublicApi } = await import("../src/public-api.mjs");
  process.env.BOLNA_API_KEY = "test-dummy";
  process.env.BOLNA_AGENT_ID = "test-dummy";
  process.env.VM_PUBLIC_VOICE = "on";
  process.env.VM_PUBLIC_COUNTER_FILE = file;
  const api = createPublicApi({
    cases: {},
    resolve: async () => {
      throw new Error("not exercised");
    },
    mintVoice: async () => ({ fake_session: true }),
    voiceTurns: () => [],
    voiceState: () => ({ configured: true, ready: true }),
  });
  const srv3 = createServer((req, res) => api(req, res));
  await new Promise((r) => srv3.listen(0, "127.0.0.1", r));
  try {
    const r = await fetch(
      `http://127.0.0.1:${srv3.address().port}/api/public/voice/session`,
      { method: "POST" },
    );
    assert.equal(r.status, 503);
  } finally {
    await new Promise((r) => srv3.close(() => r()));
    restore();
  }
});

test("lifecycle: settle failure after a live session - no ended claim, cleanup retained until cutoff retries", async () => {
  const restore = saveEnv();
  const dir = mkdtempSync(path.join(tmpdir(), "vm-counters-"));
  const counterFile = path.join(dir, "c.json");
  let stops = 0;
  let refunds = 0;
  const realCounters = createCallCounters({ file: counterFile });
  const failingSettle = {
    admitVisitor: (ip, lim) => realCounters.admitVisitor(ip, lim),
    refundReservation: async (r) => {
      refunds += 1;
      return realCounters.refundReservation(r);
    },
    settleReservation: async () => {
      const e = new Error("store write failed");
      e.status = 503;
      throw e;
    },
  };
  const { createPublicApi } = await import("../src/public-api.mjs");
  process.env.BOLNA_API_KEY = "test-dummy";
  process.env.BOLNA_AGENT_ID = "test-dummy";
  process.env.VM_PUBLIC_VOICE = "on";
  process.env.VM_PUBLIC_COUNTER_FILE = counterFile;
  process.env.VM_PUBLIC_CALL_GAP_MS = "1";
  process.env.VM_PUBLIC_CALL_MAX_MS = "40";
  const api = createPublicApi({
    cases: {},
    resolve: async () => {
      throw new Error("not exercised");
    },
    mintVoice: async () => ({ fake_session: true, run_id: "run-live-1" }),
    // Vendor stop that FAILS: cleanup must NOT be abandoned after one try.
    stopVoice: async () => {
      stops += 1;
      throw new Error("vendor stop failed");
    },
    counters: failingSettle,
    voiceTurns: () => [],
    voiceState: () => ({ configured: true, ready: true }),
  });
  const srv4 = createServer((req, res) => api(req, res));
  await new Promise((r) => srv4.listen(0, "127.0.0.1", r));
  try {
    const r = await fetch(
      `http://127.0.0.1:${srv4.address().port}/api/public/voice/session`,
      { method: "POST" },
    );
    assert.equal(r.status, 503);
    const body = await r.text();
    // No "the call was ended" claim on an unconfirmed stop attempt.
    assert.ok(!/was ended|is ended/.test(body), body);
    assert.equal(stops, 1);
    // Reservation NOT refunded: the call stays charged.
    const p = await realCounters.peek();
    assert.equal(p.lifetime, 1);
    assert.equal(refunds, 0);
    // The cutoff timer was RETAINED: past the 40ms cutoff it retries the stop.
    await new Promise((r2) => setTimeout(r2, 120));
    assert.ok(stops >= 2, `expected cutoff retry, stops=${stops}`);
    assert.equal(refunds, 0);
  } finally {
    await new Promise((r) => srv4.close(() => r()));
    restore();
  }
});

test("lifecycle: settle failure with vendor-CONFIRMED stop tears down cleanly", async () => {
  const restore = saveEnv();
  const dir = mkdtempSync(path.join(tmpdir(), "vm-counters-"));
  const counterFile = path.join(dir, "c.json");
  let stops = 0;
  const realCounters = createCallCounters({ file: counterFile });
  const failingSettle = {
    admitVisitor: (ip, lim) => realCounters.admitVisitor(ip, lim),
    refundReservation: (r) => realCounters.refundReservation(r),
    settleReservation: async () => {
      const e = new Error("store write failed");
      e.status = 503;
      throw e;
    },
  };
  const { createPublicApi } = await import("../src/public-api.mjs");
  process.env.BOLNA_API_KEY = "test-dummy";
  process.env.BOLNA_AGENT_ID = "test-dummy";
  process.env.VM_PUBLIC_VOICE = "on";
  process.env.VM_PUBLIC_COUNTER_FILE = counterFile;
  process.env.VM_PUBLIC_CALL_GAP_MS = "1";
  process.env.VM_PUBLIC_CALL_MAX_MS = "40";
  const api = createPublicApi({
    cases: {},
    resolve: async () => {
      throw new Error("not exercised");
    },
    mintVoice: async () => ({ fake_session: true, run_id: "run-gone" }),
    // Vendor CONFIRMS terminal (adapter contract: resolves true).
    stopVoice: async () => {
      stops += 1;
      return true;
    },
    counters: failingSettle,
    voiceTurns: () => [],
    voiceState: () => ({ configured: true, ready: true }),
  });
  const srv4b = createServer((req, res) => api(req, res));
  await new Promise((r) => srv4b.listen(0, "127.0.0.1", r));
  try {
    const r = await fetch(
      `http://127.0.0.1:${srv4b.address().port}/api/public/voice/session`,
      { method: "POST" },
    );
    assert.equal(r.status, 503);
    const body = await r.text();
    assert.ok(/confirmed ended/.test(body), body);
    assert.equal(stops, 1);
    // Confirmed terminal: no cutoff retry later.
    await new Promise((r2) => setTimeout(r2, 120));
    assert.equal(stops, 1);
    const p = await realCounters.peek();
    assert.equal(p.lifetime, 1); // still charged - never refunded
  } finally {
    await new Promise((r) => srv4b.close(() => r()));
    restore();
  }
});

test("gap: two concurrent session requests cannot both mint (async counter race)", async () => {
  const restore = saveEnv();
  const dir = mkdtempSync(path.join(tmpdir(), "vm-counters-"));
  const counterFile = path.join(dir, "c.json");
  process.env.BOLNA_API_KEY = "test-dummy";
  process.env.BOLNA_AGENT_ID = "test-dummy";
  process.env.VM_PUBLIC_VOICE = "on";
  process.env.VM_PUBLIC_COUNTER_FILE = counterFile;
  process.env.VM_PUBLIC_CALL_GAP_MS = "45000";
  let admits = 0;
  let mints = 0;
  const gatedCounters = {
    admitVisitor: async () => {
      admits += 1;
      // Slow ASYNC admission: without the synchronous gap claim the second
      // request would pass the gap check while this one is in flight.
      await new Promise((r) => setTimeout(r, 60));
      return { ok: true, reservation: "r" + admits };
    },
    settleReservation: async () => {},
    refundReservation: async () => {},
  };
  const { createPublicApi } = await import("../src/public-api.mjs");
  const api = createPublicApi({
    cases: {},
    resolve: async () => {
      throw new Error("not exercised");
    },
    mintVoice: async () => {
      mints += 1;
      return { fake_session: true, run_id: "x" };
    },
    stopVoice: async () => true,
    counters: gatedCounters,
    voiceTurns: () => [],
    voiceState: () => ({ configured: true, ready: true }),
  });
  const srv6 = createServer((req, res) => api(req, res));
  await new Promise((r) => srv6.listen(0, "127.0.0.1", r));
  try {
    const statuses = await Promise.all(
      [1, 2].map(async () => {
        const r = await fetch(
          `http://127.0.0.1:${srv6.address().port}/api/public/voice/session`,
          { method: "POST" },
        );
        await r.text();
        return r.status;
      }),
    );
    // The gap slot is claimed synchronously before any await: exactly one
    // request mints, the other gets the 429 gap response.
    assert.deepEqual(statuses.sort(), [200, 429]);
    assert.equal(mints, 1);
    assert.equal(admits, 1); // the second request never reached admission
  } finally {
    await new Promise((r) => srv6.close(() => r()));
    restore();
  }
});

test("bolna mint classification: 429/4xx definitive pre-session, 5xx ambiguous", async () => {
  const { classifyBolnaMintFailure } = await import("../src/server.mjs");
  assert.equal(classifyBolnaMintFailure(429), "preSession");
  assert.equal(classifyBolnaMintFailure(400), "preSession");
  assert.equal(classifyBolnaMintFailure(401), "preSession");
  assert.equal(classifyBolnaMintFailure(422), "preSession");
  // 5xx: the vendor may have created the session - stays charged.
  assert.equal(classifyBolnaMintFailure(500), "ambiguous");
  assert.equal(classifyBolnaMintFailure(502), "ambiguous");
  assert.equal(classifyBolnaMintFailure(503), "ambiguous");
});

test("lifecycle: ambiguous vendor timeout stays charged (no auto-refund)", async () => {
  const restore = saveEnv();
  const dir = mkdtempSync(path.join(tmpdir(), "vm-counters-"));
  const counterFile = path.join(dir, "c.json");
  const realCounters = createCallCounters({ file: counterFile });
  const { createPublicApi } = await import("../src/public-api.mjs");
  process.env.BOLNA_API_KEY = "test-dummy";
  process.env.BOLNA_AGENT_ID = "test-dummy";
  process.env.VM_PUBLIC_VOICE = "on";
  process.env.VM_PUBLIC_COUNTER_FILE = counterFile;
  process.env.VM_PUBLIC_CALL_GAP_MS = "1";
  const api = createPublicApi({
    cases: {},
    resolve: async () => {
      throw new Error("not exercised");
    },
    mintVoice: async () => {
      const e = new Error("The operation timed out"); // NO preSession mark
      e.status = 504;
      throw e;
    },
    counters: realCounters,
    voiceTurns: () => [],
    voiceState: () => ({ configured: true, ready: true }),
  });
  const srv5 = createServer((req, res) => api(req, res));
  await new Promise((r) => srv5.listen(0, "127.0.0.1", r));
  try {
    const r = await fetch(
      `http://127.0.0.1:${srv5.address().port}/api/public/voice/session`,
      { method: "POST" },
    );
    assert.equal(r.status, 504);
    // Ambiguous outcome: allowance stays consumed until reconciled.
    const p = await realCounters.peek();
    assert.equal(p.lifetime, 1);
  } finally {
    await new Promise((r) => srv5.close(() => r()));
    restore();
  }
});

test("file backend: parseable but invalid counter shape fails closed", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "vm-counters-"));
  const file = path.join(dir, "c.json");
  const { writeFileSync } = await import("node:fs");
  writeFileSync(file, JSON.stringify({ days: {}, lifetime: "not-a-number" }));
  const c = createCallCounters({ file });
  await assert.rejects(
    () =>
      c.admitVisitor("1.1.1.1", { perIpDay: 1, globalDay: 1, lifetimeMax: 1 }),
    (e) => e.status === 503 && /invalid shape/.test(e.message),
  );
});

test("demo trial scope: server transcription is refused for every caller, zero provider calls", async () => {
  // Under VM_SEMANTIC_AUDIENCE=demo the approved trial covers typed asks on
  // the built-in demos only: no audio may reach a provider from this server,
  // consent header or not. Dictation falls back to the browser's speech
  // service (503 + fallback flag, which the client already handles).
  let providerCalls = 0;
  const countingGemini = new Proxy(
    {},
    {
      get: (_, prop) => {
        if (prop === "enabled" || prop === "searchEnabled") return () => true;
        return (..._args) => {
          providerCalls++;
          if (prop === "status") return {};
          return Promise.resolve(null);
        };
      },
    },
  );
  const srv6 = createLocalServer({ port: 0, gemini: countingGemini });
  await new Promise((r) => srv6.listen(0, "127.0.0.1", r));
  const base6 = `http://127.0.0.1:${srv6.address().port}`;
  const prev = process.env.VM_SEMANTIC_AUDIENCE;
  process.env.VM_SEMANTIC_AUDIENCE = "demo";
  const audio = Buffer.alloc(1200, 7);
  const clip = (headers) =>
    fetch(base6 + "/api/public/transcribe", {
      method: "POST",
      headers: { "content-type": "audio/webm", ...headers },
      body: audio,
    }).then(async (r) => ({ status: r.status, body: await r.json() }));
  try {
    const variants = [
      ["no consent header", {}],
      ["consented, built-in demo case", { "x-vm-consent": "audio", "x-vm-case": "deal" }],
      ["consented, other built-in demo", { "x-vm-consent": "audio", "x-vm-case": "health" }],
      ["consented, workspace case", { "x-vm-consent": "audio", "x-vm-case": "ws:owner-case-1" }],
      ["consented, unknown case", { "x-vm-consent": "audio", "x-vm-case": "nope" }],
      ["consented, no case at all", { "x-vm-consent": "audio" }],
    ];
    for (const [label, headers] of variants) {
      const { status, body } = await clip(headers);
      assert.equal(status, 503, `${label}: refused`);
      assert.equal(body.fallback, true, `${label}: browser fallback signalled`);
    }
    assert.equal(providerCalls, 0, "no provider call in demo scope");
  } finally {
    if (prev === undefined) delete process.env.VM_SEMANTIC_AUDIENCE;
    else process.env.VM_SEMANTIC_AUDIENCE = prev;
    await new Promise((r) => srv6.close(() => r()));
  }
});
