// The adversarial hospital file must stay answered: every question from the
// file and every held-out trick question, through the public API.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createLocalServer } from "../src/server.mjs";

const here = (p) => new URL(p, import.meta.url);
const PDF = readFileSync(here("case-file/harborline-adversarial.pdf"));
const SETS = [
  "case-file/questions.json",
  "case-file/questions-holdout.json",
].map((f) => [f, JSON.parse(readFileSync(here(f), "utf8"))]);

test("hospital case file: every question and trick question answered from the records", async () => {
  const prev = process.env.VM_PUBLIC_ASK_PER_MIN;
  process.env.VM_PUBLIC_ASK_PER_MIN = "100000";
  const srv = createLocalServer({ port: 0 });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${srv.address().port}/api/public`;
  try {
    const ws = await (
      await fetch(base + "/workspace", { method: "POST" })
    ).json();
    const up = await fetch(`${base}/workspace/${ws.id}/upload`, {
      method: "POST",
      headers: {
        "x-file-name": "harborline-adversarial.pdf",
        "content-type": "application/octet-stream",
      },
      body: PDF,
    });
    assert.equal(up.status, 202);
    for (let i = 0; i < 600; i++) {
      const st = await (await fetch(`${base}/workspace/${ws.id}`)).json();
      if (
        st.documents.every((d) => ["ready", "needs_review"].includes(d.status))
      )
        break;
      await new Promise((r) => setTimeout(r, 100));
    }
    const misses = [];
    for (const [file, qs] of SETS)
      for (const q of qs) {
        const a = await (
          await fetch(base + "/ask", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ case: ws.id, question: q.ask }),
          })
        ).json();
        const text = a.final?.text ?? a.lead?.text ?? "";
        const ok =
          (q.want ?? []).every((w) => new RegExp(w, "i").test(text)) &&
          !(q.never ?? []).some((w) => new RegExp(w, "i").test(text));
        if (!ok) misses.push(`${file}: ${q.ask} -> ${text.slice(0, 200)}`);
      }
    assert.deepEqual(misses, []);
  } finally {
    await new Promise((r) => srv.close(r));
    if (prev === undefined) delete process.env.VM_PUBLIC_ASK_PER_MIN;
    else process.env.VM_PUBLIC_ASK_PER_MIN = prev;
  }
});
