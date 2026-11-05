// First-principles checks on the vendored IntelliRAG retrieval core.
import { test } from "node:test";
import assert from "node:assert/strict";
import { importBundle, answer } from "../dist/engine.mjs";

test("Indic words stay whole: a Hindi query does not match on stray consonants", () => {
  // Two documents share consonants but no words. Before: tokens were single
  // consonants ("ह", "म", ...) and the unrelated document matched.
  const b = importBundle([
    {
      title: "hb.md",
      text: "# रिपोर्ट\n\nहीमोग्लोबिन का स्तर 12.1 है। यह जांच 4 सितंबर को हुई थी, और यह लैब रिपोर्ट है।",
    },
    {
      title: "other.md",
      text: "# नोट\n\nमरीज़ ने सुबह हल्का नाश्ता लिया और फिर टहलने गए। मौसम ठंडा था और हवा तेज़ थी।",
    },
  ]);
  const r = answer("हीमोग्लोबिन कितना है", b);
  const titles = [...r.evidence, ...r.reviewEvidence].map((e) => e.title);
  assert.ok(titles.includes("hb.md"), "finds the haemoglobin report");
  assert.ok(
    !titles.includes("other.md"),
    `unrelated note matched on consonants: ${titles}`,
  );
});

test("BM25 index is built once per corpus, not per query", async () => {
  const { retrieveIndexStats } = await import("../dist/engine.mjs");
  const docs = Array.from({ length: 10 }, (_, i) => ({
    title: `d${i}.md`,
    text: `# Doc ${i}\n\nThe fee for workstream ${i} is $${1000 + i}. Reporting is weekly for item ${i}.`,
  }));
  const b = importBundle(docs);
  const before = retrieveIndexStats().builds;
  for (let i = 0; i < 25; i++)
    answer(`What is the fee for workstream ${i}?`, b);
  assert.equal(retrieveIndexStats().builds - before, 1);
});

test("corpus word statistics are built once per corpus and invalidated with the index", async () => {
  // RED on main: buildIdf/corpusVocab ran on every retrieval call (no
  // statsBuilds counter existed; ~half of query CPU on a large document).
  const { retrieveIndexStats } = await import("../dist/engine.mjs");
  const docs = Array.from({ length: 8 }, (_, i) => ({
    title: `s${i}.md`,
    text: `# Note ${i}\n\nThe invoice for service ${i} totals $${2000 + i}. Payment is due monthly.`,
  }));
  const b = importBundle(docs);
  const s0 = retrieveIndexStats();
  for (let i = 0; i < 12; i++)
    answer(`What does the invoice for service ${i} total?`, b);
  const s1 = retrieveIndexStats();
  assert.equal(
    s1.statsBuilds - s0.statsBuilds,
    1,
    "built once for 12 questions",
  );
  assert.ok(s1.statsHits - s0.statsHits >= 11, "later questions reuse it");

  // In-place amendment of one chunk (new text and content hash) on the SAME
  // rows array must rebuild both the index and the word statistics.
  const row = b.rows[3];
  row.chunk.text = row.chunk.text.replace(
    "Payment is due monthly.",
    "Payment is due by zymurgy transfer.",
  );
  row.chunk.content_hash = "amended-" + row.chunk.content_hash;
  const r = answer("Which payment uses zymurgy transfer?", b);
  const s2 = retrieveIndexStats();
  assert.equal(
    s2.statsBuilds - s1.statsBuilds,
    1,
    "amendment invalidates the statistics",
  );
  assert.equal(
    s2.builds - s1.builds,
    1,
    "and the index, by the same fingerprint",
  );
  const ids = [...r.evidence, ...r.reviewEvidence].map((e) => e.title);
  assert.ok(ids.includes("s3.md"), `the amended word is findable: ${ids}`);

  // A different bundle (upload, delete or workspace change) never shares them.
  const b2 = importBundle(docs.slice(0, 4));
  answer("What does the invoice for service 1 total?", b2);
  assert.equal(retrieveIndexStats().statsBuilds - s2.statsBuilds, 1);
});
