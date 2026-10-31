// Encrypted at-rest persistence for ONE owner's workspace: the document
// library (originals + parsed canonical documents) and episodic memory.
//
//  - AES-256-GCM, a fresh 96-bit IV per write, authenticated: a tampered or
//    wrong-key file fails to load (it is never half-read).
//  - The key comes from VM_STORE_KEY (64 hex chars). VM_DATA_DIR without a
//    valid key refuses to start: nothing is ever written in plaintext.
//  - File name is a hash of the namespace; writes are atomic (tmp + rename).
//  - Deleting documents, forgetting memory or resetting deletes the data.
//
// Where it is durable depends on the disk: on Render's free tier the disk is
// ephemeral (lost on redeploy/restart), so this gives restart-survival only
// with a persistent disk. No compliance is claimed.
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import path from "node:path";

const MAGIC = Buffer.from("VMS1");
export const MAX_SNAPSHOT_BYTES = 64 * 1024 * 1024;

export function createStore({ dir, keyHex }) {
  if (!dir) return null;
  if (!/^[0-9a-f]{64}$/i.test(keyHex ?? ""))
    throw Error(
      "VM_DATA_DIR requires VM_STORE_KEY: 64 hex characters (256-bit). Refusing to store data unencrypted.",
    );
  const key = Buffer.from(keyHex, "hex");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const fileOf = (ns) =>
    path.join(
      dir,
      createHash("sha256")
        .update("vm-ns:" + ns)
        .digest("hex")
        .slice(0, 32) + ".vms",
    );

  return {
    save(ns, value) {
      const plain = Buffer.from(JSON.stringify(value), "utf8");
      if (plain.length > MAX_SNAPSHOT_BYTES)
        throw Error("Workspace snapshot exceeds the storage limit.");
      const iv = randomBytes(12);
      const c = createCipheriv("aes-256-gcm", key, iv);
      c.setAAD(Buffer.from(ns));
      const body = Buffer.concat([c.update(plain), c.final()]);
      const out = Buffer.concat([MAGIC, iv, c.getAuthTag(), body]);
      const f = fileOf(ns);
      const tmp = f + "." + randomBytes(4).toString("hex") + ".tmp";
      writeFileSync(tmp, out, { mode: 0o600 });
      renameSync(tmp, f);
    },
    load(ns) {
      const f = fileOf(ns);
      if (!existsSync(f)) return null;
      const buf = readFileSync(f);
      if (!buf.subarray(0, 4).equals(MAGIC))
        throw Error("Not a workspace snapshot.");
      const d = createDecipheriv("aes-256-gcm", key, buf.subarray(4, 16));
      d.setAAD(Buffer.from(ns));
      d.setAuthTag(buf.subarray(16, 32));
      const plain = Buffer.concat([d.update(buf.subarray(32)), d.final()]);
      return JSON.parse(plain.toString("utf8"));
    },
    remove(ns) {
      rmSync(fileOf(ns), { force: true });
    },
    fileOf,
  };
}

/** What is persisted for a workspace (never the voice grant or caches). */
export function snapshotOf(s) {
  return {
    v: 1,
    savedAt: new Date().toISOString(),
    library: (s.library ?? [])
      .filter((e) => e.doc && ["ready", "needs_review"].includes(e.status))
      .map((e) => ({
        id: e.id,
        filename: e.filename,
        title: e.title,
        kind: e.kind,
        bytes: e.bytes,
        status: e.status,
        included: e.included,
        review: e.review ?? [],
        original: e.original
          ? Buffer.from(e.original).toString("base64")
          : null,
        doc: e.doc,
        createdAt: e.createdAt,
      })),
    memory: s.memory
      ? { episodes: s.memory.episodes, seq: s.memory.seq }
      : null,
  };
}

/** Restore a snapshot into a fresh session object (library + memory). */
export function restoreInto(s, snap) {
  if (!snap || snap.v !== 1) return false;
  s.library = snap.library.map((e) => ({
    ...e,
    original: e.original ? Buffer.from(e.original, "base64") : null,
    error: null,
    updatedAt: Date.now(),
    timings: {},
  }));
  if (snap.memory && s.memory) {
    s.memory.episodes = snap.memory.episodes ?? [];
    s.memory.seq = snap.memory.seq ?? s.memory.episodes.length;
  }
  return true;
}
