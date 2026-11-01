import test from "node:test";
import assert from "node:assert/strict";
import { createAnswerCache, normalizeQuestion } from "../src/cache.mjs";
import { createLocalServer } from "../src/server.mjs";

test("normalization: case, spacing and trailing punctuation only", () => {
  assert.equal(
    normalizeQuestion("  What   was the FEE?? "),
    "what was the fee",
  );
  assert.equal(normalizeQuestion("मेरा TSH कितना है?"), "मेरा tsh कितना है");
  assert.notEqual(
    normalizeQuestion("fee 42"),
    normalizeQuestion("fee 24"),
    "content is never normalized away",
  );
});

test("LRU eviction, TTL expiry and hit/miss accounting", async () => {
  let t = 0;
  const c = createAnswerCache({ max: 2, ttlMs: 100, now: () => t });
  const calls = [];
  const get = (k) => c.resolve(k, () => (calls.push(k), { k }));
  assert.equal((await get("a")).cache, "miss");
  assert.equal((await get("a")).cache, "hit");
  await get("b");
  await get("a"); // a becomes most recent
  await get("c"); // evicts b (least recent)
  assert.equal((await get("a")).cache, "hit");
  assert.equal((await get("b")).cache, "miss", "b was evicted");
  t = 1000;
  assert.equal((await get("a")).cache, "miss", "expired");
  assert.deepEqual(c.stats.evictions >= 1, true);
});

test("concurrent identical misses share one computation", async () => {
  const c = createAnswerCache();
  let runs = 0;
  const slow = () => new Promise((r) => setTimeout(() => r({ v: ++runs }), 30));
  const all = await Promise.all(
    Array.from({ length: 20 }, () => c.resolve("k", slow)),
  );
  assert.equal(runs, 1);
  assert.equal(all.filter((x) => x.cache === "coalesced").length, 19);
  assert.ok(all.every((x) => x.json === all[0].json));
});

test("a failed computation is not cached", async () => {
  const c = createAnswerCache();
  await assert.rejects(
    c.resolve("k", () => {
      throw Error("boom");
    }),
  );
  assert.equal((await c.resolve("k", () => ({ ok: 1 }))).cache, "miss");
});

async function boot() {
  const server = createLocalServer({ port: 0 });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const session = async () => {
    const s = await fetch(base + "/api/session");
    const cookie = s.headers.get("set-cookie").split(";")[0];
    const { csrf } = await s.json();
    const post = (p, b) =>
      fetch(base + "/api/" + p, {
        method: "POST",
        headers: {
          cookie,
          origin: base,
          "x-csrf-token": csrf,
          "content-type": "application/json",
        },
        body: JSON.stringify(b),
      }).then((r) => r.json());
    return { post };
  };
  return { base, session, close: () => new Promise((r) => server.close(r)) };
}
const DOCS = [
  {
    title: "a.md",
    text: "# Pilot\n\nThe pilot fee of $42,000 is proposed and finance approval is pending. Maya owns the review.",
  },
];
const strip = (o) => {
  // Per-request metadata (cache outcome, timing, episodic-memory id) is not
  // part of the answer.
  const { cache, latencyMs, episode, ...rest } = o;
  return rest;
};

test("server: cached answer equals the computed one; upload/import invalidates; sessions never share", async () => {
  const app = await boot();
  try {
    const a = await app.session();
    await a.post("import", { documents: DOCS });
    const q = { question: "Who owns the review?" };
    const first = await a.post("query", q);
    const second = await a.post("query", {
      question: "  who owns the REVIEW ",
    });
    assert.equal(first.cache, "miss");
    assert.equal(second.cache, "hit");
    assert.deepEqual(strip(second), strip(first));
    // Re-import builds a new index scope: no stale answer survives.
    await a.post("import", {
      documents: [
        {
          title: "b.md",
          text: "# Other\n\nNothing about reviews here, only the delivery schedule for October.",
        },
      ],
    });
    const after = await a.post("query", q);
    assert.equal(after.cache, "miss");
    assert.notDeepEqual(strip(after), strip(first));
    // Another session with the same documents computes its own answer.
    const b = await app.session();
    await b.post("import", { documents: DOCS });
    assert.equal((await b.post("query", q)).cache, "miss");
  } finally {
    await app.close();
  }
});

test("server: concurrent identical questions coalesce; /healthz is public and data-free", async () => {
  const app = await boot();
  try {
    const a = await app.session();
    await a.post("import", { documents: DOCS });
    const res = await Promise.all(
      Array.from({ length: 25 }, () =>
        a.post("query", { question: "What fee is proposed?", context: null }),
      ),
    );
    assert.equal(res.filter((r) => r.cache === "miss").length, 1);
    assert.ok(
      res.every(
        (r) => JSON.stringify(strip(r)) === JSON.stringify(strip(res[0])),
      ),
    );
    const h = await fetch(app.base + "/healthz").then((r) => r.json());
    assert.equal(h.ok, true);
    assert.ok(h.cache.hits + h.cache.coalesced >= 24);
    assert.doesNotMatch(
      JSON.stringify(h),
      /fee|Maya|pilot/i,
      "health output carries no document data",
    );
  } finally {
    await app.close();
  }
});
