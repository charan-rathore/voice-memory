// End to end: upload synthetic lab reports, ask on screen and through the
// voice endpoint, and require the same sentence with located row citations.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createLocalServer } from "../server.mjs";

const FIX = (f) =>
  readFileSync(new URL("./fixtures/files/" + f, import.meta.url));
const FIXED = "c".repeat(64);

test("lab comparison: screen lead and voice say the same thing, citing the rows", async () => {
  const saved = {
    cap: process.env.VM_VOICE_CAPABILITY,
    exp: process.env.VM_VOICE_HARD_EXPIRES_AT,
  };
  process.env.VM_VOICE_CAPABILITY = FIXED;
  process.env.VM_VOICE_HARD_EXPIRES_AT = String(Date.now() + 3600000);
  const server = createLocalServer({ port: 0 });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const s = await fetch(base + "/api/session");
    const cookie = s.headers.get("set-cookie").split(";")[0];
    const { csrf } = await s.json();
    const h = { cookie, origin: base, "x-csrf-token": csrf };
    for (const f of [
      "a-2026-09.pdf",
      "a-2026-10-prelim.pdf",
      "a-2026-10-amended.pdf",
    ])
      assert.equal(
        (
          await fetch(base + "/api/upload", {
            method: "POST",
            headers: {
              ...h,
              "content-type": "application/octet-stream",
              "x-file-name": f,
            },
            body: FIX(f),
          })
        ).status,
        202,
      );
    for (let i = 0; ; i++) {
      const lib = await (
        await fetch(base + "/api/library", { headers: { cookie } })
      ).json();
      if (lib.documents.every((d) => d.status === "ready")) break;
      assert.ok(i < 300, "library settles");
      await new Promise((r) => setTimeout(r, 100));
    }
    const q = "Did my ferritin change since the last report?";
    const r = await (
      await fetch(base + "/api/query", {
        method: "POST",
        headers: { ...h, "content-type": "application/json" },
        body: JSON.stringify({ question: q }),
      })
    ).json();
    assert.equal(r.lead.verdict, "COMPARED");
    assert.match(
      r.lead.text,
      /^Ferritin for Test Person A went from 0\.5 ng\/mL on 3 September 2026 to 50 ng\/mL on 12 October 2026: the later result is higher\. The 12 October 2026 result was amended from 5 to 50; this uses the amended value\./,
    );
    assert.ok(
      r.lead.citations.length >= 3,
      "current, previous and superseded rows cited",
    );
    assert.ok(
      r.lead.citations.every(
        (c) => c.location?.pages?.[0] === 1 && /\| Ferritin \|/.test(c.quote),
      ),
    );

    assert.equal(
      (
        await fetch(base + "/api/voice/start", {
          method: "POST",
          headers: { ...h, "content-type": "application/json" },
          body: "{}",
        })
      ).status,
      200,
    );
    const v = await fetch(base + "/v1/chat/completions", {
      method: "POST",
      headers: {
        authorization: "Bearer " + FIXED,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        stream: true,
        messages: [{ role: "user", content: q }],
      }),
    });
    const spoken = (await v.text())
      .split("\n")
      .filter((l) => l.startsWith("data: {"))
      .map((l) => JSON.parse(l.slice(6)).choices[0].delta.content ?? "")
      .join("");
    assert.equal(spoken.trim(), r.lead.text);
  } finally {
    await new Promise((r) => server.close(r));
    for (const [k, v] of [
      ["VM_VOICE_CAPABILITY", saved.cap],
      ["VM_VOICE_HARD_EXPIRES_AT", saved.exp],
    ])
      v === undefined ? delete process.env[k] : (process.env[k] = v);
  }
});
