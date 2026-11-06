// Answer cache with request coalescing ("singleflight").
//
// Correctness comes from the key, not from invalidation bookkeeping:
//   key = caller snapshot identity + context + language + normalized question
// The server includes both the workspace scope and a per-bundle generation.
// A stable workspace scope alone cannot invalidate answers after an upload.
// Rebuilding the index changes the generation, while different workspaces
// remain isolated. Old entries age out of the bounded LRU. Values are stored
// serialized, so no caller can mutate a shared object.
//
// Coalescing: concurrent misses for the same key share one computation.
export function normalizeQuestion(q) {
  return String(q ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[\s?.!।]+$/u, "")
    .trim();
}

export function createAnswerCache({
  max = 1000,
  ttlMs = 15 * 60 * 1000,
  now = Date.now,
} = {}) {
  const store = new Map(); // key -> { json, at } in LRU order (oldest first)
  const inflight = new Map(); // key -> Promise<json>
  const stats = { hits: 0, misses: 0, coalesced: 0, evictions: 0 };

  const fresh = (e) => e && now() - e.at < ttlMs;
  function touch(key, e) {
    store.delete(key);
    store.set(key, e);
  }
  function put(key, json) {
    store.set(key, { json, at: now() });
    while (store.size > max) {
      store.delete(store.keys().next().value);
      stats.evictions++;
    }
  }

  return {
    stats,
    get size() {
      return store.size;
    },
    key: (scope, question, ctx = "", lang = "") =>
      `${scope}\u0000${ctx}\u0000${lang}\u0000${normalizeQuestion(question)}`,
    /**
     * Return the cached JSON for `key`, or compute it once. `compute` may be
     * sync or async and must return a JSON-serializable value.
     * @returns {Promise<{json: string, cache: "hit"|"miss"|"coalesced"}>}
     */
    async resolve(key, compute) {
      const e = store.get(key);
      if (fresh(e)) {
        stats.hits++;
        touch(key, e);
        return { json: e.json, cache: "hit" };
      }
      if (inflight.has(key)) {
        stats.coalesced++;
        return { json: await inflight.get(key), cache: "coalesced" };
      }
      stats.misses++;
      const p = (async () => JSON.stringify(await compute()))();
      inflight.set(key, p);
      try {
        const json = await p;
        put(key, json);
        return { json, cache: "miss" };
      } finally {
        inflight.delete(key);
      }
    },
    clear() {
      store.clear();
    },
  };
}
