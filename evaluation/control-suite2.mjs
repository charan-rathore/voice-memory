// Controls C7-C10: cross-engagement isolation, misleading keyword overlap,
// authority wording, renamed-entity binding. Ground truth fixed 2026-10-30
// BEFORE any code change; run against the frozen build (dist d15ca22a).
import { readFileSync, readdirSync } from "node:fs";
import { importBundle, answer } from "../dist/engine.mjs";

const base = readdirSync("examples/corpus-md")
  .filter((f) => f.endsWith(".md"))
  .map((f) => ({ title: f, text: readFileSync("examples/corpus-md/" + f, "utf8") }));

let pass = 0,
  fail = 0;
const check = (name, cond, detail) => {
  if (cond) {
    pass++;
    console.log("PASS " + name);
  } else {
    fail++;
    console.log("FAIL " + name + " :: " + detail);
  }
};

const meridianDocs = [
  {
    title: "M1_Meridian_Proposal.md",
    text: "# Meridian Analytics Pilot Proposal\nDate: 2026-09-05\nAuthor: Priya Sharma\n\n1. The Meridian pilot scope is four regions (East, West, North, South) across retail stores.\n2. The proposed engagement fee is $90,000.\n",
  },
  {
    title: "M2_Meridian_Kickoff_Notes.md",
    text: "# Meridian Kickoff Notes\nDate: 2026-09-20\nAuthor: Priya Sharma\n\n1. Meridian confirmed the pilot covers four regions (East, West, North, South) for the first phase.\n2. Weekly reporting for Meridian is still under discussion.\n",
  },
];

// C7: cross-engagement isolation. Meridian's four regions must not be
// superseded or contaminated by Northstar's narrowing to two; a Meridian
// question must not return the Northstar value as current.
{
  const docs = [...base, ...meridianDocs];
  const r = answer(
    "Which regions are in scope for the Meridian pilot?",
    importBundle(docs),
  );
  const ans = r.answer || "";
  check(
    "C7a Meridian question does not return Northstar's two regions as current",
    !/current[^.]*two regions|two regions[^.]*current/i.test(ans),
    JSON.stringify({ refused: r.refused, ans: ans.slice(0, 200) }),
  );
  check(
    "C7b Meridian four regions surfaced",
    !r.refused && /four regions/i.test(ans),
    JSON.stringify({ refused: r.refused, ans: ans.slice(0, 200) }),
  );
  const rn = answer(
    "Which regions are in scope for the first phase?",
    importBundle(docs),
  );
  // Honest outcomes for an entity-less question on a two-engagement corpus:
  // resolve the Northstar two regions, or flag competing records. The
  // Meridian four must never be rendered as the current/approved verdict.
  check(
    "C7c entity-less scope question: two regions or flagged competition",
    (!rn.refused && /two regions/i.test(rn.answer || "")) ||
      (rn.refused &&
        /competing|unresolved/i.test(rn.answer || "") &&
        !/current record four|approved record four/i.test(rn.answer || "")),
    JSON.stringify({
      refused: rn.refused,
      ans: (rn.answer || "").slice(0, 200),
    }),
  );
}

// C8: misleading keyword overlap - an unrelated "weekly report" (newsletter)
// must not become evidence for the engagement's reporting confirmation.
{
  const docs = [
    ...base,
    {
      title: "N1_Marketing_Newsletter.md",
      text: "# Marketing Newsletter Plan\nDate: 2026-10-01\nAuthor: Priya Sharma\n\n1. The weekly report for the newsletter covers brand highlights and social metrics.\n2. Newsletter cadence is weekly.\n",
    },
  ];
  const r = answer(
    "Is weekly progress reporting confirmed?",
    importBundle(docs),
  );
  const ans =
    (r.answer || "") +
    " " +
    (r.evidence || []).map((e) => e.title || "").join(" ");
  check(
    "C8 newsletter doc not cited as reporting-confirmation evidence",
    !/Newsletter/i.test(ans),
    JSON.stringify({ refused: r.refused, ans: ans.slice(0, 240) }),
  );
}

// C9: authority wording - the working-scope answer must not upgrade
// "Working scope" wording into client-approved/final authority.
{
  const r = answer(
    "Which regions are in scope for the first phase?",
    importBundle(base),
  );
  const ans = r.answer || "";
  check(
    "C9 scope answer carries caution, no approval upgrade",
    !/approved record|client-approved|final scope/i.test(ans) &&
      /not established|discussed|caution|status/i.test(ans),
    JSON.stringify({ ans: ans.slice(0, 240) }),
  );
}

// C10: renamed-entity binding - renaming Northstar to Zorax everywhere must
// preserve supersession (three regions shown superseded by two).
{
  const docs = base.map((d) => ({
    title: d.title.replace(/Northstar/g, "Zorax"),
    text: d.text.replace(/Northstar/g, "Zorax"),
  }));
  const r = answer(
    "Which regions are in scope for the first phase?",
    importBundle(docs),
  );
  const ans = r.answer || "";
  check(
    "C10 renamed entity keeps supersession of three-region record",
    !r.refused && /two regions/i.test(ans) && /superseded/i.test(ans),
    JSON.stringify({ refused: r.refused, ans: ans.slice(0, 240) }),
  );
}
console.log(`=== CONTROLS2: ${pass} pass, ${fail} fail ===`);
process.exit(fail ? 1 : 0);
