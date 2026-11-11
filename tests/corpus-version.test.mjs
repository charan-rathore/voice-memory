import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { corpusVersion, createCorpusHistory } from "../src/corpus-version.mjs";
import { createPublicApi, publicAnswer } from "../src/public-api.mjs";
import { importBundle } from "../dist/engine.mjs";
const bundle = (text = "Maya owns the security review.") =>
  importBundle([
    { title: "Review", text: text + " Pilot launch is proposed for Friday." },
  ]);

test("version labels change on title, order, add, removal and text, not scope or import UUID", () => {
  const a = bundle(),
    b = bundle();
  assert.notEqual(a.scope, b.scope);
  assert.notEqual(a.sources[0].id, b.sources[0].id);
  assert.equal(corpusVersion(a), corpusVersion(b));
  for (const mutate of [
    (x) => {
      x.sources[0].title = "Other";
    },
    (x) => {
      x.sources = [];
    },
    (x) => {
      x.sources.push({ ...x.sources[0] });
    },
    (x) => {
      x.sources[0].hash = "other";
    },
  ]) {
    const c = bundle();
    mutate(c);
    assert.notEqual(corpusVersion(a), corpusVersion(c));
  }
  const pair = importBundle([
    {
      title: "A",
      text: "Maya owns the security review. Pilot launch is proposed for Friday.",
    },
    {
      title: "B",
      text: "Nina owns the budget. Budget review must be completed before launch.",
    },
  ]);
  const before = corpusVersion(pair);
  pair.sources.reverse();
  assert.notEqual(corpusVersion(pair), before);
});

test("history is bounded, expires, and unknown calls never inherit a notice", () => {
  let clock = 0;
  const history = createCorpusHistory({ now: () => clock, ttlMs: 10, max: 2 });
  const first = bundle(),
    second = bundle("Nina owns the security review.");
  history.commit("a", history.compare("a", first));
  assert.equal(history.compare("a", second).changedSinceLastAnswer, true);
  assert.equal(history.compare("b", second).changedSinceLastAnswer, false);
  assert.equal(history.compare(null, second).changedSinceLastAnswer, false);
  history.commit("b", history.compare("b", first));
  history.commit("c", history.compare("c", first));
  assert.equal(history.compare("a", second).changedSinceLastAnswer, false);
  clock = 11;
  assert.equal(history.compare("b", second).changedSinceLastAnswer, false);
  history.forget("c");
  assert.equal(history.compare("c", second).changedSinceLastAnswer, false);
});

test("public citations keep old source identity without retaining the old original", () => {
  const citation = {
    sourceId: "old-id",
    hash: "old-hash",
    documentId: "old-upload",
    title: "Same title",
    quote: "Maya owns the security review.",
    start: 0,
    end: 30,
  };
  const old = publicAnswer({
    corpus: { version: "old-version" },
    lead: { text: "Maya", verdict: "QUOTED", citations: [citation] },
    evidence: [citation],
  });
  assert.equal(old.corpus.version, "old-version");
  assert.equal(old.lead.citations[0].hash, "old-hash");
  assert.equal(old.lead.citations[0].sourceId, "old-id");
  assert.equal(old.lead.citations[0].documentId, "old-upload");
  assert.equal(old.lead.citations[0].quote, citation.quote);
});

test("public HTTP: delayed old answer is rejected when the indexed bundle moves", async () => {
  const s = { bundle: bundle(), library: [] };
  let release, started;
  const gate = new Promise((r) => {
    release = r;
  });
  const entered = new Promise((r) => {
    started = r;
  });
  const api = createPublicApi({
    cases: { deal: s },
    resolve: async () => {
      started();
      await gate;
      return {
        lead: {
          text: "Maya owns the security review. Pilot launch is proposed for Friday.",
          verdict: "QUOTED",
          citations: [],
        },
      };
    },
    voiceState: () => ({}),
  });
  const server = createServer((req, res) => api(req, res));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    const pending = fetch(
      `http://127.0.0.1:${server.address().port}/api/public/ask`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          case: "deal",
          question: "Who owns the review?",
        }),
      },
    );
    await entered;
    s.bundle = bundle("Nina owns the security review.");
    release();
    const response = await pending;
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), {
      error: "Documents changed while answering; ask again.",
    });
  } finally {
    release();
    await new Promise((r) => server.close(r));
  }
});

test("historical episodes preserve the answered version and citation identity, not an old original", async () => {
  const { createMemory, recordTurn } = await import("../memory/memory.mjs");
  const mem = createMemory();
  const citation = {
    sourceId: "old-id",
    hash: "old-hash",
    title: "Review",
    start: 0,
    end: 4,
    quote: "Maya",
  };
  const ep = recordTurn(mem, {
    question: "Who owns it?",
    scope: "old-scope",
    corpus: { version: "old-version" },
    lead: { citations: [citation] },
  });
  assert.deepEqual(ep.corpus, { version: "old-version" });
  assert.deepEqual(ep.cited, [citation]);
  assert.equal(ep.original, undefined);
});
