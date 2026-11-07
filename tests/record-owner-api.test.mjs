import { test } from "node:test";
import assert from "node:assert/strict";
import { createLocalServer } from "../src/server.mjs";
process.env.VM_DENSE = "off";
process.env.VM_GEMINI = "off";
process.env.VM_COUNTERS_ALLOW_FILE = "on";
test("record ownership clarification and refusal survive normalized cache replay", async () => {
  const server = createLocalServer({ port: 0 });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}/api/public`;
  try {
    const ws = await (
      await fetch(base + "/workspace", { method: "POST" })
    ).json();
    for (const [id, value] of [
      ["SYN-281", 100],
      ["SYN-392", 200],
    ])
      assert.equal(
        (
          await fetch(`${base}/workspace/${ws.id}/upload`, {
            method: "POST",
            headers: { "x-file-name": id + ".txt" },
            body: Buffer.from(
              `BILLING SUMMARY\nPatient name: Mira Sen\nPatient ID: ${id}\nTotal charges: USD ${value}.00`,
            ),
          })
        ).status,
        202,
      );
    let ready = false;
    for (let i = 0; i < 200; i++) {
      const s = await (await fetch(`${base}/workspace/${ws.id}`)).json();
      if (
        s.documents.length === 2 &&
        s.documents.every((d) => ["ready", "needs_review"].includes(d.status))
      ) {
        ready = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.ok(ready);
    async function ask(question) {
      for (let i = 0; i < 50; i++) {
        const a = await (
          await fetch(base + "/ask", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ case: ws.id, question, semantic: false }),
          })
        ).json();
        if (!a.error) return a;
        await new Promise((r) => setTimeout(r, 20));
      }
      assert.fail("answer never ready");
    }
    for (const q of [
      "what were mira sen total charges?",
      "WHAT WERE MIRA SEN TOTAL CHARGES?",
    ]) {
      const a = await ask(q);
      assert.match(a.lead.text, /Which patient do you mean/);
      assert.doesNotMatch(a.lead.text, /USD|100|200/);
      assert.equal(a.lead.citations.length, 2);
    }
    const a = await ask("What were SYN-999 total charges?");
    assert.equal(a.lead.verdict, "UNBOUND_OWNER");
    assert.equal(a.lead.citations.length, 0);
    assert.doesNotMatch(a.lead.text, /USD|100|200/);
    const known = await ask("What were SYN-392 total charges?");
    assert.match(known.lead.text, /200/);
    assert.doesNotMatch(known.lead.text, /100/);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test("known exact opaque owners remain separate across separators and zero lengths", async () => {
  const server = createLocalServer({ port: 0 });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}/api/public`;
  try {
    for (const ids of [
      ["QZ_7", "QZ_0007"],
      ["QZ-7", "QZ-0007"],
      ["SYN-17", "SYN-00017"],
    ]) {
      const ws = await (
        await fetch(base + "/workspace", { method: "POST" })
      ).json();
      for (const [i, id] of ids.entries())
        await fetch(`${base}/workspace/${ws.id}/upload`, {
          method: "POST",
          headers: { "x-file-name": id + ".txt" },
          body: Buffer.from(
            `BILLING SUMMARY\nPatient name: Kavya Rao\nPatient ID: ${id}\nTotal charges: USD ${i ? 259 : 137}.00`,
          ),
        });
      for (let n = 0; n < 200; n++) {
        const st = await (await fetch(`${base}/workspace/${ws.id}`)).json();
        if (
          st.documents.length === 2 &&
          st.documents.every((d) => d.status === "ready")
        )
          break;
        await new Promise((r) => setTimeout(r, 20));
      }
      for (const q of [
        "what were kavya rao total charges?",
        "WHAT WERE KAVYA RAO TOTAL CHARGES?",
      ]) {
        let a;
        for (let n = 0; n < 40; n++) {
          a = await (
            await fetch(base + "/ask", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                case: ws.id,
                question: q,
                semantic: false,
              }),
            })
          ).json();
          if (!a.error) break;
          await new Promise((r) => setTimeout(r, 20));
        }
        assert.equal(a.lead.verdict, "AMBIGUOUS_PATIENT");
        for (const id of ids) assert.ok(a.lead.text.includes(id));
        assert.doesNotMatch(a.lead.text, /137|259/);
      }
      for (const i of [1, 0, 1]) {
        let a;
        for (let n = 0; n < 40; n++) {
          a = await (
            await fetch(base + "/ask", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                case: ws.id,
                question: `What were ${ids[i]} total charges?`,
                semantic: false,
              }),
            })
          ).json();
          if (!a.error) break;
          await new Promise((r) => setTimeout(r, 20));
        }
        assert.match(a.lead.text, new RegExp(String(i ? 259 : 137)));
        assert.doesNotMatch(a.lead.text, new RegExp(String(i ? 137 : 259)));
        assert.ok(
          a.lead.citations.every((c) =>
            c.location.focus.text.join(" ").includes(ids[i]),
          ),
        );
      }
    }
  } finally {
    await new Promise((r) => server.close(r));
  }
});
