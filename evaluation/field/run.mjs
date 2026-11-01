// Field test: real, public sample reports uploaded through the same HTTP
// path a visitor uses, asked questions written by reading each document.
// Scores the on-screen lead: right (matches), wrong (answers but does not
// match, or answers an unanswerable question), abstain (no lead).
//
//   node evaluation/field/fetch.mjs            # downloads the samples (git-ignored)
//   node evaluation/field/run.mjs [dir]        # default evaluation/field/files
//
// Set VM_DENSE_CACHE / VM_MEMORY_LIMIT_MB to include the embedding model.
import { readFileSync, existsSync } from "node:fs";
import { createLocalServer } from "../../src/server.mjs";

const dir = process.argv[2] ?? new URL("./files/", import.meta.url).pathname;
const Q = JSON.parse(
  readFileSync(new URL("./questions.json", import.meta.url), "utf8"),
);
const re = (s) => {
  const ci = s.startsWith("(?i)");
  return new RegExp(ci ? s.slice(4) : s, ci ? "is" : "s");
};

const server = createLocalServer({ port: 0 });
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;
const tally = { right: 0, wrong: 0, abstain: 0, unansRight: 0, unansWrong: 0 };
const rows = [];
for (const [file, qs] of Object.entries(Q.docs)) {
  const path = `${dir.replace(/\/$/, "")}/${file}`;
  if (!existsSync(path)) {
    console.log(`skip ${file} (not downloaded)`);
    continue;
  }
  const ws = await (
    await fetch(base + "/api/public/workspace", { method: "POST" })
  ).json();
  await fetch(`${base}/api/public/workspace/${ws.id}/upload`, {
    method: "POST",
    headers: {
      "x-file-name": encodeURIComponent(file),
      "content-type": "application/octet-stream",
    },
    body: readFileSync(path),
  });
  for (let i = 0; i < 900; i++) {
    const st = await (
      await fetch(`${base}/api/public/workspace/${ws.id}`)
    ).json();
    if (
      st.documents?.every((d) =>
        ["ready", "needs_review", "failed"].includes(d.status),
      )
    )
      break;
    await new Promise((r) => setTimeout(r, 200));
  }
  if (process.env.VM_DENSE_CACHE)
    await new Promise((r) => setTimeout(r, 15000));
  for (const { q, expect } of qs) {
    const b = await (
      await fetch(base + "/api/public/ask", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ case: ws.id, question: q }),
      })
    ).json();
    const lead = b.lead?.text ?? null;
    const none = !lead || b.lead.verdict === "NOT_IN_REPORT";
    let outcome;
    if (expect === null) outcome = none ? "unansRight" : "unansWrong";
    else outcome = none ? "abstain" : re(expect).test(lead) ? "right" : "wrong";
    tally[outcome]++;
    rows.push({ file, q, outcome, lead: lead?.slice(0, 160) ?? null });
  }
}
server.close();
for (const r of rows)
  if (r.outcome !== "right" && r.outcome !== "unansRight")
    console.log(
      `${r.outcome.padEnd(10)} ${r.file.slice(0, 30)} | ${r.q} | ${r.lead}`,
    );
const answerable = tally.right + tally.wrong + tally.abstain;
const unans = tally.unansRight + tally.unansWrong;
console.log(
  JSON.stringify(
    {
      ...tally,
      answerable,
      unanswerable: unans,
      accuracy: +(tally.right / answerable).toFixed(3),
      wrongRate: +(tally.wrong / answerable).toFixed(3),
      unanswerableRefused: +(tally.unansRight / (unans || 1)).toFixed(3),
    },
    null,
    2,
  ),
);
process.exit(0);
