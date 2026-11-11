// Caller memory must fail closed: a wrong key, a tampered file or a missing
// disk never reads as "a new caller", and never overwrites what it cannot read.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createStore } from "../memory/store.mjs";
import { createCallerIdentity } from "../memory/caller-identity.mjs";
import { createCallerMemory, CallerMemoryError } from "../memory/caller-memory.mjs";

const keys = { t1: "ab".repeat(32) };
const bind = (id, sub = "acct-NS-1042") =>
  id.verify(id.issue({ kid: "t1", tenant: "meridian-support", sub, amr: "otp" }));

test("wrong key: refused as unavailable, and the original file is untouched", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "vm-cm-key-"));
  const id = createCallerIdentity({ keys });
  createCallerMemory({ identity: id, store: createStore({ dir, keyHex: "11".repeat(32) }) })
    .rememberPreference(bind(id), { key: "language", value: "hinglish" });
  const [f] = readdirSync(dir).filter((x) => x.endsWith(".vms"));
  const before = readFileSync(path.join(dir, f));
  const wrong = createCallerMemory({ identity: id, store: createStore({ dir, keyHex: "99".repeat(32) }) });
  const b = bind(id);
  assert.throws(() => wrong.presentation(b), (e) => e instanceof CallerMemoryError && e.code === "unavailable");
  assert.throws(() => wrong.rememberPreference(b, { key: "language", value: "en" }), { code: "unavailable" });
  assert.ok(readFileSync(path.join(dir, f)).equals(before), "never overwritten");
  // The right key still reads it.
  const right = createCallerMemory({ identity: id, store: createStore({ dir, keyHex: "11".repeat(32) }) });
  assert.equal(right.presentation(bind(id)).lang, "hinglish");
});

test("tampered file: refused as unavailable, not treated as empty", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "vm-cm-tamper-"));
  const id = createCallerIdentity({ keys });
  const store = createStore({ dir, keyHex: "11".repeat(32) });
  createCallerMemory({ identity: id, store }).rememberPreference(bind(id), { key: "language", value: "hi" });
  const [f] = readdirSync(dir).filter((x) => x.endsWith(".vms"));
  const buf = readFileSync(path.join(dir, f));
  buf[buf.length - 1] ^= 0xff;
  writeFileSync(path.join(dir, f), buf);
  const mem = createCallerMemory({ identity: id, store });
  assert.throws(() => mem.list(bind(id)), { code: "unavailable" });
});

test("disk lost mid-life: writes and deletes refused as unavailable, nothing unsaved served", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "vm-cm-disk-"));
  const real = createStore({ dir, keyHex: "11".repeat(32) });
  let diskUp = true;
  const down = () => {
    if (!diskUp) throw Object.assign(Error("EIO"), { code: "EIO" });
  };
  const store = {
    save: (ns, v) => (down(), real.save(ns, v)),
    load: (ns) => (down(), real.load(ns)),
    remove: (ns) => (down(), real.remove(ns)),
  };
  const id = createCallerIdentity({ keys });
  const mem = createCallerMemory({ identity: id, store });
  const b = bind(id);
  mem.rememberPreference(b, { key: "language", value: "hi" });
  diskUp = false;
  assert.throws(() => mem.rememberPreference(b, { key: "language", value: "en" }), { code: "unavailable" });
  assert.throws(() => mem.presentation(b), { code: "unavailable" }, "the unsaved 'en' is not served");
  assert.throws(() => mem.forget(b, { all: true }), { code: "unavailable" });
  diskUp = true;
  assert.equal(mem.presentation(b).lang, "hi", "the last saved state");
});
