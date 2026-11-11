// Restart, redeploy and failure behaviour of persisted caller memory, with
// REAL server processes (`node server.mjs`), not in-process instances.
//
//  1. a fictional caller's preference survives SIGTERM + restart
//  2. a "redeploy" (new process, new commit id, same disk) keeps it
//  3. another caller and another tenant see nothing
//  4. a deleted preference stays deleted across a restart
//  5. a wrong VM_STORE_KEY: caller memory refuses (503), the file is untouched
//  6. a broken disk with VM_CALLER_REQUIRE_DURABLE=on: caller memory stays OFF
//  7. caller files live in <VM_DATA_DIR>/callers, apart from owner snapshots
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const root = new URL("..", import.meta.url).pathname;
const dataDir = mkdtempSync(path.join(tmpdir(), "vm-restart-"));
const KEY = "5a".repeat(32);

async function boot(extra = {}) {
  const port = 5400 + Math.floor(Math.random() * 400);
  const env = { PATH: process.env.PATH, HOME: process.env.HOME };
  Object.assign(env, {
    PORT: String(port),
    VM_DENSE: "off",
    VM_GEMINI: "off",
    VM_RSS_WATCHDOG: "off",
    VM_CALLER_DEMO: "on",
    VM_CALLER_REQUIRE_DURABLE: "on",
    VM_DATA_DIR: dataDir,
    VM_STORE_KEY: KEY,
    ...extra,
  });
  for (const [k, v] of Object.entries(env)) if (v === null) delete env[k];
  const child = spawn(process.execPath, ["server.mjs"], {
    cwd: root,
    env,
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (d) => (stderr += d));
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 150; i++) {
    const h = await fetch(base + "/healthz")
      .then((r) => r.json())
      .catch(() => null);
    if (h?.ok) {
      // Wait for the demo cases so answers resolve.
      await fetch(base + "/api/public/status").catch(() => null);
      return { child, base, health: h, stderr: () => stderr };
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  child.kill("SIGKILL");
  throw Error("server did not start: " + stderr.slice(-600));
}
const stop = (s) =>
  new Promise((r) => {
    s.child.once("exit", r);
    s.child.kill("SIGTERM");
  });

function client(base) {
  let cookie = "";
  const req = async (method, p, body) => {
    const res = await fetch(base + "/api/public/caller" + p, {
      method,
      headers: {
        "content-type": "application/json",
        origin: base,
        ...(cookie ? { cookie } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const set = res.headers.get("set-cookie");
    if (set) cookie = set.split(";")[0];
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };
  return {
    req,
    async start(persona) {
      const a = await req("POST", "/demo-assertion", { persona });
      if (a.status !== 200) return a;
      return req("POST", "/start", {
        assertion: a.body.assertion,
        case: "deal",
      });
    },
    say: (utterance) => req("POST", "/turn", { utterance }),
  };
}

test(
  "persisted caller memory across real process restarts, redeploys and failures",
  { timeout: 180_000 },
  async () => {
    // 1. Create
    let s = await boot({ VM_COMMIT: "deploy-1" });
    assert.deepEqual(
      {
        enabled: s.health.callerMemory.enabled,
        storage: s.health.callerMemory.storage,
      },
      { enabled: true, storage: "durable" },
    );
    let c = client(s.base);
    assert.equal((await c.start("asha")).status, 200);
    const m = await c.say("Please remember that I prefer Hinglish");
    assert.equal(m.body.memory.preferences.language.value, "hinglish");
    await stop(s);

    // 7. Layout: caller files only under callers/, none at the owner level.
    assert.ok(existsSync(path.join(dataDir, "callers")));
    assert.equal(
      readdirSync(dataDir).filter((f) => f.endsWith(".vms")).length,
      0,
    );
    const callerFiles = () =>
      readdirSync(path.join(dataDir, "callers")).filter((f) =>
        f.endsWith(".vms"),
      );
    assert.equal(callerFiles().length, 1);
    const bytes = readFileSync(path.join(dataDir, "callers", callerFiles()[0]));
    assert.equal(bytes.includes(Buffer.from("hinglish")), false);

    // 2. Restart + redeploy (new process, new commit id, same disk)
    for (const commit of ["deploy-1", "deploy-2"]) {
      s = await boot({ VM_COMMIT: commit });
      assert.equal(s.health.commit, commit);
      c = client(s.base);
      const back = await c.start("asha");
      assert.equal(back.status, 200);
      assert.equal(
        back.body.preferences.language.value,
        "hinglish",
        `recovered after ${commit}`,
      );
      // 3. Another caller sees nothing.
      const r = await client(s.base).start("ravi");
      assert.deepEqual(r.body.preferences, {});
      await stop(s);
    }

    // 5. Wrong key: refused, file untouched, not a "new caller".
    const before = readFileSync(
      path.join(dataDir, "callers", callerFiles()[0]),
    );
    s = await boot({ VM_STORE_KEY: "6b".repeat(32) });
    c = client(s.base);
    const wrong = await c.start("asha");
    assert.equal(wrong.status, 503, JSON.stringify(wrong.body));
    assert.equal(wrong.body.code, "unavailable");
    await stop(s);
    assert.ok(
      readFileSync(path.join(dataDir, "callers", callerFiles()[0])).equals(
        before,
      ),
    );

    // 4. Delete, restart, still deleted.
    s = await boot();
    c = client(s.base);
    await c.start("asha");
    const f = await c.say("Forget my language preference");
    assert.equal(f.body.op, "forget_preference");
    await stop(s);
    s = await boot();
    c = client(s.base);
    const gone = await c.start("asha");
    assert.deepEqual(gone.body.preferences, {}, "stays deleted");
    await stop(s);

    // 6a. Broken disk (VM_DATA_DIR is a file): the whole server refuses to
    // start (the owner store fails closed first). Nothing answers.
    const notADir = path.join(dataDir, "not-a-dir");
    writeFileSync(notADir, "x");
    await assert.rejects(
      boot({ VM_DATA_DIR: notADir }),
      /server did not start[\s\S]*EEXIST/,
    );
    // 6b. Only the callers directory is broken: the server runs, caller
    // memory stays OFF (never memory-only), and /healthz says why.
    const other = mkdtempSync(path.join(tmpdir(), "vm-restart-b-"));
    writeFileSync(path.join(other, "callers"), "x");
    s = await boot({ VM_DATA_DIR: other });
    assert.equal(s.health.callerMemory.enabled, false);
    assert.equal(s.health.callerMemory.storage, "unavailable");
    assert.match(s.health.callerMemory.reason, /self-test failed/);
    assert.equal(
      JSON.stringify(s.health).includes(other),
      false,
      "no paths in health",
    );
    assert.notEqual(
      (await client(s.base).req("POST", "/demo-assertion", { persona: "asha" }))
        .status,
      200,
    );
    await stop(s);

    // Durable required but no disk configured: off, never memory-only.
    s = await boot({ VM_DATA_DIR: null, VM_STORE_KEY: null });
    assert.deepEqual(
      {
        enabled: s.health.callerMemory.enabled,
        storage: s.health.callerMemory.storage,
      },
      { enabled: false, storage: "memory-only" },
    );
    await stop(s);
  },
);
