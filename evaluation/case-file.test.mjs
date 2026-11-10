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

test("hospital selected-context regression: frozen questions with explicit HLG-P1047 selection", async () => {
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
            body: JSON.stringify({
              case: ws.id,
              question: q.ask,
              // Explicit API-context regression, not an existing screen selection.
              // Frozen question expectations are exercised under this context.
              patient: q.patient ?? "HLG-P1047",
            }),
          })
        ).json();
        const text = a.final?.text ?? a.lead?.text ?? "";
        const ok =
          (q.want ?? []).every((w) => new RegExp(w, "i").test(text)) &&
          !(q.never ?? []).some((w) => new RegExp(w, "i").test(text));
        if (!ok) misses.push(`${file}: ${q.ask} -> ${text.slice(0, 200)}`);
      }
    assert.deepEqual(misses, []);
    // A manually reviewed post-exposure contract, not an independent holdout.
    // Preserve frozen questions and original forbidden strings; require a
    // positive source answer, an explicit identity clarification, an advice
    // decline, or a bounded out-of-scope/social response for every question.
    const contract = JSON.parse(
      readFileSync(here("case-file/unselected-contract.json"), "utf8"),
    );
    let reviewed = 0;
    for (const [si, [, qs]] of SETS.entries())
      for (const [qi, q] of qs.entries()) {
        const expectation = contract.sets[si].questions[qi];
        assert.equal(expectation.ask, q.ask);
        const a = await (
          await fetch(base + "/ask", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ case: ws.id, question: q.ask }),
          })
        ).json();
        for (const never of [...(q.never ?? []), ...(expectation.never ?? [])])
          assert.doesNotMatch(a.final.text, new RegExp(never, "i"), q.ask);
        if (expectation.outcome === "clarify_identity") {
          assert.equal(a.final.verdict, "AMBIGUOUS_PATIENT", q.ask);
          assert.deepEqual(a.final.citations, [], q.ask);
          assert.match(a.final.text, /HLG-P1047/, q.ask);
          assert.match(a.final.text, /HLG-P1048/, q.ask);
          assert.equal(a.visual?.focus, "patients", q.ask);
          assert.ok(
            (a.evidence ?? []).every((e) => e.contextOnly),
            q.ask,
          );
        } else if (expectation.outcome === "answer_from_record") {
          assert.notEqual(a.final.verdict, "AMBIGUOUS_PATIENT", q.ask);
          assert.ok(a.final.citations.length, q.ask);
          for (const want of [...(q.want ?? []), ...(expectation.want ?? [])])
            assert.match(a.final.text, new RegExp(want, "i"), q.ask);
        } else if (expectation.outcome === "decline_advice") {
          assert.equal(a.final.verdict, "DECLINE_ADVICE", q.ask);
          assert.match(a.final.text, /doctor/i, q.ask);
          assert.doesNotMatch(
            a.final.text,
            /corrected to 50|medicines.*recorded/i,
            q.ask,
          );
        } else if (expectation.outcome === "out_of_scope")
          assert.equal(a.final.verdict, "UNKNOWN", q.ask);
        else assert.equal(a.final.verdict, "HELP", q.ask);
        reviewed++;
      }
    assert.equal(reviewed, 69);
  } finally {
    await new Promise((r) => srv.close(r));
    if (prev === undefined) delete process.env.VM_PUBLIC_ASK_PER_MIN;
    else process.env.VM_PUBLIC_ASK_PER_MIN = prev;
  }
});

// The HbA1c abstention names the other person's value, but its diagnostic
// evidence must excerpt the record that value belongs to - before the
// display trim, the quote led with 355 characters of an unrelated record,
// reading as if the stranger's HbA1c were part of the answer's basis.
test("hospital case file: evidence excerpts start at the record they quote", async () => {
  const prev = process.env.VM_PUBLIC_ASK_PER_MIN;
  process.env.VM_PUBLIC_ASK_PER_MIN = "100000";
  const srv = createLocalServer({ port: 0 });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${srv.address().port}/api/public`;
  try {
    const ws = await (
      await fetch(base + "/workspace", { method: "POST" })
    ).json();
    await fetch(`${base}/workspace/${ws.id}/upload`, {
      method: "POST",
      headers: {
        "x-file-name": "harborline-adversarial.pdf",
        "content-type": "application/octet-stream",
      },
      body: PDF,
    });
    for (let i = 0; i < 600; i++) {
      const st = await (await fetch(`${base}/workspace/${ws.id}`)).json();
      if (
        st.documents.every((d) => ["ready", "needs_review"].includes(d.status))
      )
        break;
      await new Promise((r) => setTimeout(r, 100));
    }
    const a = await (
      await fetch(base + "/ask", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          case: ws.id,
          question: "What is Maya's HbA1c?",
        }),
      })
    ).json();
    for (const ev of a.evidence ?? []) {
      const head = (ev.quote ?? "").slice(0, 300).toLowerCase();
      if (!ev.contextOnly)
        assert.ok(
          head.includes("maya") || head.includes("hba1c"),
          `supporting evidence leads with unrelated text: ${(ev.quote ?? "").slice(0, 120)}`,
        );
      // Newly retained nonclinical packet records are allowed only as
      // explicit context, with their own source-owned boundaries.
      if (!head.includes("maya") && !head.includes("hba1c")) {
        assert.equal(ev.contextOnly, true);
        assert.equal(ev.binding, "record-span");
        assert.ok(ev.start >= ev.record.start && ev.end <= ev.record.end);
      }
      // offsets stay exact against the source: the quote is the slice
      assert.equal(
        ev.end - ev.start,
        ev.quote.length,
        "evidence offsets no longer match the quote after trimming",
      );
    }
  } finally {
    await new Promise((r) => srv.close(r));
    if (prev === undefined) delete process.env.VM_PUBLIC_ASK_PER_MIN;
    else process.env.VM_PUBLIC_ASK_PER_MIN = prev;
  }
});
