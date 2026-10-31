// Encrypted owner-workspace persistence: survives a restart, is ciphertext on
// disk, needs the right key, and is deleted by reset. Local single-user mode
// (no public host), where the machine's workspace is the owner's.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { readdirSync as rd } from "node:fs";
import { createLocalServer } from "./server.mjs";

const corpus = new URL("./corpus-md/", import.meta.url).pathname;
const DOCS = rd(corpus)
  .filter((f) => f.endsWith(".md"))
  .sort()
  .map((f) => ({ title: f, text: readFileSync(corpus + f, "utf8") }));

async function boot(env) {
  const saved = {};
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    const server = createLocalServer({ port: 0 });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const session = async () => {
      const s = await fetch(base + "/api/session");
      const cookie = s.headers.get("set-cookie").split(";")[0];
      const { csrf } = await s.json();
      const h = {
        cookie,
        origin: base,
        "x-csrf-token": csrf,
        "content-type": "application/json",
      };
      return {
        post: (p, b) =>
          fetch(base + "/api/" + p, {
            method: "POST",
            headers: h,
            body: JSON.stringify(b),
          }).then((r) => r.json()),
        get: (p) =>
          fetch(base + "/api/" + p, { headers: { cookie } }).then((r) =>
            r.json(),
          ),
      };
    };
    return {
      session,
      close: () =>
        new Promise((r) => {
          server.close(r);
          server.closeAllConnections?.();
        }),
    };
  } finally {
    for (const [k, v] of Object.entries(saved))
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
  }
}
const settle = () => new Promise((r) => setTimeout(r, 450));

test("workspace survives a restart, encrypted at rest; reset deletes it", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "vm-store-"));
  const key = randomBytes(32).toString("hex");
  const env = { VM_DATA_DIR: dir, VM_STORE_KEY: key };
  const a = await boot(env);
  const s1 = await a.session();
  await s1.post("import", { documents: DOCS });
  const first = await s1.post("query", {
    question: "What fee did we finally agree on?",
  });
  await settle();
  await a.close();
  const files = readdirSync(dir).filter((f) => f.endsWith(".vms"));
  assert.equal(files.length, 1);
  const raw = readFileSync(path.join(dir, files[0]));
  assert.ok(
    !raw.includes(Buffer.from("Northstar")) &&
      !raw.includes(Buffer.from("42,000")),
    "no plaintext on disk",
  );

  const b = await boot(env); // restart
  const s2 = await b.session();
  const mem = await s2.get("memory");
  assert.equal(mem.episodes.length, 1, "episodic memory restored");
  const again = await s2.post("query", {
    question: "What fee did we finally agree on?",
  });
  assert.equal(
    again.lead?.spoken ?? again.lead?.text,
    first.lead?.spoken ?? first.lead?.text,
    "same answer from restored documents",
  );
  await s2.post("reset", {});
  await settle();
  assert.equal(
    readdirSync(dir).filter((f) => f.endsWith(".vms")).length,
    0,
    "reset deletes the stored workspace",
  );
  await b.close();
});

test("a wrong key restores nothing (and never crashes the server)", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "vm-store-"));
  const a = await boot({
    VM_DATA_DIR: dir,
    VM_STORE_KEY: randomBytes(32).toString("hex"),
  });
  await (await a.session()).post("import", { documents: DOCS });
  await settle();
  await a.close();
  const b = await boot({
    VM_DATA_DIR: dir,
    VM_STORE_KEY: randomBytes(32).toString("hex"),
  });
  const s = await b.session();
  const lib = await s.get("library");
  assert.equal((lib.documents ?? lib.entries ?? lib).length ?? 0, 0);
  await b.close();
});

test("VM_DATA_DIR without a 256-bit key refuses to start", async () => {
  await assert.rejects(
    boot({
      VM_DATA_DIR: mkdtempSync(path.join(tmpdir(), "vm-store-")),
      VM_STORE_KEY: undefined,
    }),
    /VM_STORE_KEY/,
  );
});
