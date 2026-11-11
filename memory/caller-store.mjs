// Encrypted storage for caller memory, kept apart from the owner workspace
// store (memory/store.mjs) on purpose:
//
//  - its own directory: <VM_DATA_DIR>/callers
//  - its own key, derived from VM_STORE_KEY with HKDF-SHA256 and a fixed,
//    purpose-specific info string, so a caller file can never be decrypted
//    as an owner snapshot (or the reverse), even with a namespace mix-up
//  - a startup self-test (write, read back, delete a canary) so a missing,
//    read-only or wrong-key disk is found before any caller is answered
//
// Status is one of:
//   "durable"      encrypted on disk, self-test passed
//   "memory-only"  no VM_DATA_DIR: process memory, lost on restart
//   "unavailable"  configured but failing: caller memory must not run
import { hkdfSync, randomBytes } from "node:crypto";
import path from "node:path";
import { createStore } from "./store.mjs";

export const CALLER_KEY_INFO = "voice-memory/caller-memory/v1";

export function deriveCallerKeyHex(storeKeyHex) {
  if (!/^[0-9a-f]{64}$/i.test(storeKeyHex ?? "")) return null;
  return Buffer.from(
    hkdfSync("sha256", Buffer.from(storeKeyHex, "hex"), Buffer.alloc(0), CALLER_KEY_INFO, 32),
  ).toString("hex");
}

/**
 * @param {{ dataDir?: string|null, storeKeyHex?: string|null }} opts
 * @returns {{ store: ReturnType<typeof createStore>|null, status: string, reason: string|null, dir: string|null }}
 */
export function openCallerStore({ dataDir = null, storeKeyHex = null } = {}) {
  if (!dataDir) return { store: null, status: "memory-only", reason: null, dir: null };
  const keyHex = deriveCallerKeyHex(storeKeyHex);
  if (!keyHex)
    return { store: null, status: "unavailable", reason: "VM_STORE_KEY missing or not 64 hex", dir: null };
  const dir = path.join(dataDir, "callers");
  let store;
  try {
    store = createStore({ dir, keyHex });
    const ns = "caller:selftest:" + randomBytes(8).toString("hex");
    const probe = { at: Date.now(), n: randomBytes(8).toString("hex") };
    store.save(ns, probe);
    const back = store.load(ns);
    store.remove(ns);
    if (back?.n !== probe.n) throw Error("read-back mismatch");
  } catch (e) {
    return { store: null, status: "unavailable", reason: `self-test failed: ${e.code ?? e.message}`, dir };
  }
  return { store, status: "durable", reason: null, dir };
}
