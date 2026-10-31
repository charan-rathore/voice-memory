// Recall-recovery regressions (2026-10-31): a positive result on the WRONG
// document must not end the search when a disclosed expansion bridge lands
// on the corpus's own vocabulary. Original query still wins; the bridge is
// shown in the UI as an applied transform.
import test from "node:test";
import assert from "node:assert/strict";
import { importBundle, answer } from "../dist/engine.mjs";
import { buildCorpus } from "./retrieval-bench.mjs";

const docs = await buildCorpus();
const pdfBundle = importBundle(
  docs.filter((d) => !/^\d\d_/.test(d.title)),
);
const mdBundle = importBundle(
  docs.filter((d) => d.title.endsWith(".md") && /^\d\d_/.test(d.title)),
);

test("metric question recovers through a disclosed bridge (thyroid -> TSH)", () => {
  const r = answer("What is my thyroid hormone level?", pdfBundle);
  assert.equal(r.supported, true, r.answer);
  assert.match(r.answer, /TSH/);
  assert.match(r.answer, /mIU\/L/);
  assert.ok(
    r.queryTransform?.applied?.some((t) => t.from === "thyroid" && t.to === "tsh"),
    "the applied bridge is disclosed",
  );
});

test("paraphrase bridge recovers the dropped-region record (country -> regions, dropped -> narrow)", () => {
  const r = answer(
    "Which part of the country was dropped from the pilot?",
    mdBundle,
  );
  assert.equal(r.supported, true, r.answer);
  assert.match(r.answer, /narrow the pilot from three regions to two regions/);
});
