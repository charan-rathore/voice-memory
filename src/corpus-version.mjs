import { createHash } from "node:crypto";

// A label for the exact ordered, indexed document set, not an external
// revision number or a promise that a connected source was checked. Access
// boundaries live elsewhere: never use this content digest as a capability.
// Exclude per-import scope/IDs so importing identical content stays identical.
export function corpusVersion(bundle) {
  return createHash("sha256")
    .update(
      JSON.stringify((bundle?.sources ?? []).map((s) => [s.title, s.hash])),
    )
    .digest("hex");
}

// Only version hashes, no document text. Per authenticated conversation and
// scope; a shared credential with no call ID is deliberately untrackable.
export function createCorpusHistory({
  now = Date.now,
  ttlMs = 120000,
  max = 512,
} = {}) {
  const versions = new Map();
  return {
    compare(key, bundle) {
      const version = corpusVersion(bundle);
      const previous = key ? versions.get(key) : null;
      return {
        version,
        changedSinceLastAnswer:
          !!previous &&
          previous.expires > now() &&
          previous.version !== version,
      };
    },
    commit(key, corpus) {
      if (!key) return;
      for (const [k, v] of versions) if (v.expires <= now()) versions.delete(k);
      versions.delete(key);
      versions.set(key, { version: corpus.version, expires: now() + ttlMs });
      while (versions.size > max) versions.delete(versions.keys().next().value);
    },
    forget(key) {
      versions.delete(key);
    },
  };
}
