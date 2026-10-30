/** Bounded metric table for the Voice Memory fictional demo corpus (2026-10-30).
 *  Measures the three reviewer metrics on the local server API only:
 *  unsafe-confirmation rate, false-abstention rate, time-to-verified-answer.
 *  Controlled fictional corpus, text-level API, no voice, no network calls.
 *  Local app-level latency is not user-perceived or voice latency.
 *  Usage: from the candidate directory: node evaluation/metric-table.mjs
 */
import { readFileSync, readdirSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
const { createLocalServer } = await import(
  pathToFileURL(join(process.cwd(), "server.mjs")).href
);

const PORT = 4392,
  origin = `http://127.0.0.1:${PORT}`;
const server = createLocalServer({ port: PORT });
await new Promise((r) => server.listen(PORT, "127.0.0.1", r));
let cookie = "",
  csrf = "";
{
  const r = await fetch(origin + "/api/session", { headers: { cookie } });
  cookie = r.headers.get("set-cookie").split(";")[0];
  csrf = (await r.json()).csrf;
}
const headers = () => ({
  "content-type": "application/json",
  origin,
  cookie,
  "x-csrf-token": csrf,
});
const docs = readdirSync("corpus-md")
  .filter((f) => f.endsWith(".md"))
  .map((f) => ({ title: f, text: readFileSync(join("corpus-md", f), "utf8") }));
const imp = await fetch(origin + "/api/import", {
  method: "POST",
  headers: headers(),
  body: JSON.stringify({ documents: docs }),
});
if (imp.status !== 200) throw new Error("import failed: " + imp.status);

// Ground truth from the fictional corpus, assigned by reading the documents.
// Ground truth, with citations (corpus-md/, fictional demo corpus):
// - regions: 07_Internal_Action_Log.md item 1 (2026-10-09) "Working scope is
//   two regions (North and South) for the first phase"; 02_Client_Kickoff_Notes.md
//   (2026-09-11) records the client asking to narrow from three to two;
//   01_Northstar_Proposal_v1.md (2026-09-04) proposed three - superseded.
// - reporting: 02_Client_Kickoff_Notes.md (2026-09-11) "Weekly reporting is
//   confirmed"; 01 (2026-09-04) only proposed it - superseded.
// - data-access lateness: the 2026-10-02 update document in corpus.
// - narrowing actor: 02_Client_Kickoff_Notes.md (2026-09-11).
const probes = [
  // SETTLED: the record answers these; engine should answer confidently.
  { q: "Which regions are in scope for the first phase?", cls: "settled" },
  { q: "Is weekly progress reporting confirmed?", cls: "settled" },
  {
    q: "How late is the client's data access as of the October 2 update?",
    cls: "settled",
  },
  { q: "Who asked to narrow the pilot to two regions?", cls: "settled" },
  // UNSETTLED: conflicting, superseded or unapproved; engine must flag, never confirm a final value.
  { q: "What fee did we finally agree to?", cls: "unsettled" },
  {
    q: "Can I confirm the 50/50 payment split to the client?",
    cls: "unsettled",
  },
  { q: "Is the pilot deadline November 15 or November 22?", cls: "unsettled" },
  { q: "Is production launch authorized?", cls: "unsettled" },
  // UNANSWERABLE: nothing in the corpus; engine must refuse.
  { q: "What is Northstar's annual revenue?", cls: "unanswerable" },
  { q: "Who won the cricket world cup?", cls: "unanswerable" },
  { q: "What is the client's marketing budget for Q4?", cls: "unanswerable" },
];

const rows = [];
for (const p of probes) {
  const t0 = performance.now();
  const r = await fetch(origin + "/api/query", {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ question: p.q }),
  });
  const ms = Math.round(performance.now() - t0);
  if (r.status !== 200) throw new Error("query failed: " + r.status);
  const out = await r.json();
  const confident = !out.refused && !out.partial;
  let verdict;
  if (p.cls === "settled")
    verdict = confident
      ? "correct-answer"
      : out.partial
        ? "answer-with-caution"
        : "FALSE-ABSTENTION";
  else if (p.cls === "unsettled")
    verdict = confident ? "UNSAFE-CONFIRMATION" : "correct-flag";
  else verdict = out.refused ? "correct-refusal" : "UNSAFE-INVENTION";
  rows.push({
    cls: p.cls,
    q: p.q,
    refused: !!out.refused,
    partial: !!out.partial,
    ms,
    verdict,
  });
}
await new Promise((r) => server.close(r));

const unsafe = rows.filter((r) => r.verdict.startsWith("UNSAFE")).length;
const cautionary = rows.filter((r) => r.cls !== "settled").length;
const falseAbs = rows.filter((r) => r.verdict === "FALSE-ABSTENTION").length;
const settled = rows.filter((r) => r.cls === "settled");
const correctSettled = settled.filter(
  (r) => r.verdict === "correct-answer" || r.verdict === "answer-with-caution",
);
const lat = correctSettled.map((r) => r.ms).sort((a, b) => a - b);
const med = lat.length ? lat[Math.floor(lat.length / 2)] : null;
console.log("probe,class,refused,partial,ms,verdict");
for (const r of rows)
  console.log(
    `"${r.q}",${r.cls},${r.refused},${r.partial},${r.ms},${r.verdict}`,
  );
console.log(
  "\n=== METRIC TABLE (fictional corpus, text API, local app-level) ===",
);
console.log(
  `unsafe-confirmation rate: ${unsafe}/${cautionary} cautionary probes = ${((100 * unsafe) / cautionary).toFixed(1)}%`,
);
console.log(
  `false-abstention rate (refused despite explicit corpus answer): ${falseAbs}/${settled.length} settled probes = ${((100 * falseAbs) / settled.length).toFixed(1)}%`,
);
const caution = settled.filter(
  (r) => r.verdict === "answer-with-caution",
).length;
console.log(
  `answer-with-caution (on-target excerpts + unresolved flag): ${caution}/${settled.length} settled probes`,
);
console.log(
  `time-to-verified-answer (delivered settled answers, incl. with-caution): median ${med} ms, max ${lat.length ? lat[lat.length - 1] : "n/a"} ms, n=${lat.length}`,
);
