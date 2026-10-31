// The landing page shows saved engine answers while the free host wakes up,
// and its hero quotes one answer. Keep both true: every saved answer must
// equal what the public API computes today, and the hero's numbers and source
// line must be the engine's.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { createLocalServer } from "../server.mjs";

const sandbox = { window: {} };
vm.runInNewContext(
  readFileSync(new URL("../site/snapshot.js", import.meta.url), "utf8"),
  sandbox,
);
const snap = JSON.parse(JSON.stringify(sandbox.window.VM_SNAPSHOT));

test("every saved landing answer equals the engine's current answer", async () => {
  const srv = createLocalServer({ port: 0 });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  await srv.loadPublicCases();
  const base = `http://127.0.0.1:${srv.address().port}/api/public`;
  try {
    const keys = Object.keys(snap.answers);
    assert.ok(keys.length >= 8, "snapshot has the suggested questions");
    for (const k of keys) {
      const [c, ...rest] = k.split("|");
      const q = rest.join("|");
      const live = await (
        await fetch(base + "/ask", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ case: c, question: q }),
        })
      ).json();
      const saved = snap.answers[k];
      assert.equal(saved.lead?.text, live.lead?.text, k);
      assert.equal(saved.lead?.verdict, live.lead?.verdict, k);
      assert.deepEqual(
        (saved.lead?.citations ?? []).map((x) => x.quote),
        (live.lead?.citations ?? []).map((x) => x.quote),
        k,
      );
    }
  } finally {
    srv.close();
  }
});

test("the hero quotes the engine and the amended report verbatim", () => {
  const html = readFileSync(
    new URL("../site/index.html", import.meta.url),
    "utf8",
  );
  const ferritin = snap.answers["health|What is SYN-0001's ferritin result?"];
  assert.match(
    ferritin.lead.text,
    /corrected from 5 to 50, and I'm using the corrected value/,
  );
  assert.match(
    html,
    /corrected from 5 to 50, and I'm using the corrected\s+value/,
  );
  assert.match(
    html,
    /Amended 15 October 2026: ferritin result corrected from 5 to 50/,
  );
  const amended = readFileSync(
    new URL("../clinical/fixtures/build.mjs", import.meta.url),
    "utf8",
  );
  assert.match(
    amended,
    /Amended 15 October 2026: ferritin result corrected from 5 to 50 \(transcription error\)\./,
  );
});
