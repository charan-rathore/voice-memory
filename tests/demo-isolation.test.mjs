// Public demo isolation (Workstream B, P0). Two unrelated visitors who both
// pick "Asha" must never see each other's memory; the demo signer can never
// open a real tenant's caller; real assertions never open the demo route.
// Runs real server processes on one shared durable store (restart included).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createCallerIdentity } from "../memory/caller-identity.mjs";

const root = new URL("..", import.meta.url).pathname;
const dataDir = mkdtempSync(path.join(tmpdir(), "vm-demo-iso-"));
const STORE_KEY = "3c".repeat(32);
const REAL = {
  apiKey: "4d".repeat(32),
  voiceKey: "voice-key-real-tenant-0123456789",
  caller: "5e".repeat(32),
};
const TENANTS = JSON.stringify({
  "meridian-support": {
    apiKey: REAL.apiKey,
    voiceKey: REAL.voiceKey,
    cases: ["deal"],
    callerKeys: { k1: REAL.caller },
  },
});

async function boot(extra = {}) {
  const port = 5600 + Math.floor(Math.random() * 300);
  const env = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    PORT: String(port),
    VM_DENSE: "off",
    VM_GEMINI: "off",
    VM_RSS_WATCHDOG: "off",
    VM_CALLER_DEMO: "on",
    VM_CALLER_REQUIRE_DURABLE: "on",
    VM_DATA_DIR: dataDir,
    VM_STORE_KEY: STORE_KEY,
    VM_TENANTS: TENANTS,
    ...extra,
  };
  const child = spawn(process.execPath, ["server.mjs"], {
    cwd: root,
    env,
    stdio: ["ignore", "ignore", "pipe"],
  });
  let err = "";
  child.stderr.on("data", (d) => (err += d));
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 150; i++) {
    if (
      await fetch(base + "/healthz")
        .then((r) => r.ok)
        .catch(() => false)
    ) {
      await fetch(base + "/api/public/status").catch(() => null);
      return { child, base, err: () => err };
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  child.kill("SIGKILL");
  throw Error("server did not start: " + err.slice(-400));
}
const stop = (s) =>
  new Promise((r) => (s.child.once("exit", r), s.child.kill("SIGTERM")));

// One browser: its own cookie jar (all cookies the server sets).
function browser(base) {
  const jar = new Map();
  const req = async (method, p, body) => {
    const res = await fetch(base + "/api/public/caller" + p, {
      method,
      headers: {
        "content-type": "application/json",
        origin: base,
        ...(jar.size
          ? { cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; ") }
          : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    for (const c of res.headers.getSetCookie?.() ?? []) {
      const [kv] = c.split(";");
      const i = kv.indexOf("=");
      const k = kv.slice(0, i);
      const v = kv.slice(i + 1);
      if (!v || /Max-Age=0/i.test(c)) jar.delete(k);
      else jar.set(k, v);
    }
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };
  return {
    jar,
    req,
    rebase(b) {
      base = b;
    },
    async start(persona) {
      const a = await req("POST", "/demo-assertion", { persona });
      if (a.status !== 200) return a;
      return req("POST", "/start", {
        assertion: a.body.assertion,
        case: "deal",
      });
    },
    say: (u) => req("POST", "/turn", { utterance: u }),
  };
}

test(
  "two visitors, one persona name: zero leakage, across restart; finite retention",
  { timeout: 180_000 },
  async () => {
    let s = await boot();
    const A = browser(s.base);
    const B = browser(s.base);

    assert.equal((await A.start("asha")).status, 200);
    await A.say(
      "Please remember that I prefer Hinglish, and remember this conversation for next time.",
    );
    await A.say("Was the revised fee approved?");

    // Browser B picks the same persona: sees nothing of A's.
    const b1 = await B.start("asha");
    assert.equal(b1.status, 200);
    assert.deepEqual(b1.body.preferences, {}, "B must not see A's Asha");
    assert.equal(b1.body.rechecked.length, 0);
    // Within A, Ravi is separate from Asha.
    const ar = await A.start("ravi");
    assert.deepEqual(ar.body.preferences, {});

    // B cannot use A's assertion (bound to A's visitor namespace) ...
    const aAssert = (
      await A.req("POST", "/demo-assertion", { persona: "asha" })
    ).body.assertion;
    const stolen = await B.req("POST", "/start", {
      assertion: aAssert,
      case: "deal",
    });
    assert.equal(stolen.status, 403, JSON.stringify(stolen.body));
    // ... nor forge a visitor cookie.
    const F = browser(s.base);
    F.jar.set("vm_demo", "0".repeat(32) + "." + "A".repeat(43));
    const forged = await F.start("asha");
    assert.equal(forged.status, 200);
    assert.deepEqual(
      forged.body.preferences,
      {},
      "a forged cookie is replaced, never trusted",
    );

    // A real tenant's caller assertion never opens the public demo route.
    const real = createCallerIdentity({
      keys: {
        "meridian-support_k1": {
          secret: REAL.caller,
          tenant: "meridian-support",
        },
      },
    });
    const r = await browser(s.base).req("POST", "/start", {
      assertion: real.issue({
        kid: "meridian-support_k1",
        tenant: "meridian-support",
        sub: "acct-NS-1042",
        amr: "otp",
      }),
      case: "deal",
    });
    assert.equal(r.status, 403);

    // Restart: A's Asha survives (same browser), B still sees nothing.
    await stop(s);
    s = await boot();
    A.rebase(s.base);
    B.rebase(s.base);
    const a2 = await A.start("asha");
    assert.equal(
      a2.body.preferences.language?.value,
      "hinglish",
      "A's demo state survives restart",
    );
    assert.equal(a2.body.rechecked[0]?.label, "the fee");
    assert.deepEqual((await B.start("asha")).body.preferences, {});

    // Demo memory lives apart from real tenants' memory.
    assert.ok(
      readdirSync(path.join(dataDir, "callers-demo")).some((f) =>
        f.endsWith(".vms"),
      ),
    );

    // Deletion is per visitor.
    await A.say("Forget everything");
    assert.deepEqual((await A.start("asha")).body.preferences, {});
    await stop(s);

    // Retention: files untouched for longer than the demo retention are swept at startup.
    const old = (Date.now() - 8 * 24 * 3600 * 1000) / 1000;
    const C = browser((s = await boot()).base);
    await C.start("asha");
    await C.say("Please remember that I prefer Hindi");
    await stop(s);
    for (const f of readdirSync(path.join(dataDir, "callers-demo")))
      utimesSync(path.join(dataDir, "callers-demo", f), old, old);
    s = await boot();
    C.rebase(s.base);
    assert.deepEqual(
      (await C.start("asha")).body.preferences,
      {},
      "expired demo memory is gone",
    );
    await stop(s);
  },
);
