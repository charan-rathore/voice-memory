import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseBuffer } from "../ingest/parse.mjs";
import { shutdownOcr } from "../ingest/ocr.mjs";
import { ingestFile } from "../ingest/index.mjs";
for (const name of ["printed.png", "printed.jpg"])
  test(
    name + " must request cross-file OCR admission exactly once",
    async () => {
      let admissions = 0;
      try {
        const result = await parseBuffer(
          readFileSync(
            new URL("../ingest/fixtures/files/" + name, import.meta.url),
          ),
          name,
          {
            waitForOcr: async () => {
              admissions++;
            },
          },
        );
        assert.equal(admissions, 1);
        assert.ok(result.doc.text.length > 40);
      } finally {
        await shutdownOcr();
      }
    },
  );
test("final ingestion resolution follows OCR cleanup and parse worker termination", async () => {
  const events = [];
  const r = await ingestFile(
    readFileSync(
      new URL("../ingest/fixtures/files/printed.png", import.meta.url),
    ),
    "printed.png",
    { onEvent: (e) => events.push(e.k) },
  );
  events.push("resolved");
  assert.ok(r.ok);
  assert.ok(events.includes("ocr-engine-stopped"));
  assert.ok(events.includes("parser-worker-stopped"));
  assert.ok(
    events.indexOf("ocr-engine-stopped") <
      events.indexOf("parser-worker-stopped"),
  );
  assert.ok(
    events.indexOf("parser-worker-stopped") < events.indexOf("resolved"),
  );
});
