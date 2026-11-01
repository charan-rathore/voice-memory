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
