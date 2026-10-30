// Consolidated RED controls (ground truth fixed 2026-10-30, before repair):
// reviewer adversarial findings A/B/D/E/F/G + owner C1/C8/C9 + 55k boundary.
// SAFE outcomes defined per case; run: node evaluation/control-suite3.mjs
import { importBundle, answer } from "../dist/engine.mjs";

const doc = (title, body) => ({ title, text: body });
let pass = 0,
  fail = 0;
const run = (name, docs, q, judge) => {
  const r = answer(q, importBundle(docs));
  const ans = r.answer || "";
  const ok = judge(r, ans);
  if (ok) {
    pass++;
    console.log("PASS " + name);
  } else {
    fail++;
    console.log(
      "FAIL " +
        name +
        " :: " +
        JSON.stringify({
          refused: r.refused,
          status: r.evidenceStatus,
          ans: ans.replace(/\n/g, " ").slice(0, 170),
        }),
    );
  }
};
const noApprovedRecord = (r, ans) =>
  !/approved record/i.test(ans) &&
  (/not established|unresolved|competing|no supported/i.test(ans) || r.refused);

// A-family: negation and rescission must never yield an approved record.
run(
  "A1-never-approved",
  [
    doc(
      "Bluebird_Proposal.md",
      "# Bluebird Proposal\nDate: 2026-09-04\nAuthor: Demo\n\nThe fee is $45,000 for the pilot. The fee was never approved by the committee and everyone agreed on that point.\n",
    ),
  ],
  "What fee did we finally agree to?",
  noApprovedRecord,
);
run(
  "A1b-never-approved-same-clause",
  [
    doc(
      "Bluebird_Proposal.md",
      "# Bluebird Proposal\nDate: 2026-09-04\nAuthor: Demo\n\nThe fee of $45,000 was never approved by the committee.\n",
    ),
  ],
  "What fee did we finally agree to?",
  noApprovedRecord,
);
run(
  "A2-no-longer-approved",
  [
    doc(
      "Bluebird_Proposal.md",
      "# Bluebird Proposal\nDate: 2026-09-04\nAuthor: Demo\n\nThe fee is $45,000. This fee is no longer approved after the committee review we agreed to hold.\n",
    ),
  ],
  "What fee did we finally agree to?",
  noApprovedRecord,
);
run(
  "A2b-no-longer-approved-same-clause",
  [
    doc(
      "Bluebird_Proposal.md",
      "# Bluebird Proposal\nDate: 2026-09-04\nAuthor: Demo\n\nThe fee of $45,000 is no longer approved by the committee.\n",
    ),
  ],
  "What fee did we finally agree to?",
  noApprovedRecord,
);
run(
  "A3-approved-then-rescinded",
  [
    doc(
      "Bluebird_Proposal.md",
      "# Bluebird Proposal\nDate: 2026-09-04\nAuthor: Demo\n\nThe fee of $45,000 was approved, but the committee later rescinded it entirely.\n",
    ),
  ],
  "What fee did we finally agree to?",
  noApprovedRecord,
);
run(
  "A4-approval-withdrawn",
  [
    doc(
      "Bluebird_Proposal.md",
      "# Bluebird Proposal\nDate: 2026-09-04\nAuthor: Demo\n\nThe fee of $45,000 approval was withdrawn after the dispute.\n",
    ),
  ],
  "What fee did we finally agree to?",
  noApprovedRecord,
);

// B: undated revision must not demote a dated claim to sole current.
run(
  "B-undated-revision-demotes-dated",
  [
    doc(
      "Bluebird_Proposal.md",
      "# Bluebird Proposal\nDate: 2026-10-20\nAuthor: Demo\n\nThe fee is $50,000 for the engagement.\n",
    ),
    doc(
      "Bluebird_Update.md",
      "# Bluebird Update\nAuthor: Demo\n\nRevised fee: $45,000 for the engagement.\n",
    ),
  ],
  "What is the fee for Bluebird?",
  (r, ans) => !/current record \$45,000/.test(ans),
);

// D: first cadence token must not win over the token bound to "report".
run(
  "D-cadence-first-token",
  [
    doc(
      "Meridian_Minutes.md",
      "# Meridian Minutes\nDate: 2026-10-01\nAuthor: Demo\n\nThe board confirmed the monthly summary of the weekly report for the steering group.\n",
    ),
  ],
  "Is monthly reporting confirmed?",
  (r, ans) => !/approved record monthly/i.test(ans),
);

// E: approved scope for a different phase must not displace pilot scope.
run(
  "E-phase-crossed-scope",
  [
    doc(
      "Northstar_Proposal.md",
      "# Northstar Proposal\nDate: 2026-09-04\nAuthor: Demo\n\nWorking scope is two regions (North and South) for the first phase of the pilot.\n",
    ),
    doc(
      "Northstar_Board.md",
      "# Northstar Board\nDate: 2026-10-15\nAuthor: Demo\n\nThe board confirmed five regions for the 2027 national expansion planning.\n",
    ),
  ],
  "Which regions are in scope for the pilot?",
  (r, ans) =>
    (!/approved record five|current record five/i.test(ans) &&
      /two regions/i.test(ans + (r.partialNotice || ""))) ||
    r.refused,
);

// E2: a rejected option must not become a claim.
run(
  "E2-rejected-scope-option",
  [
    doc(
      "Northstar_Proposal.md",
      "# Northstar Proposal\nDate: 2026-09-04\nAuthor: Demo\n\nWorking scope is two regions (North and South) for the first phase.\n",
    ),
    doc(
      "Northstar_Minutes.md",
      "# Northstar Minutes\nDate: 2026-10-15\nAuthor: Demo\n\nThe committee rejected the option of five regions for the pilot.\n",
    ),
  ],
  "Which regions are in scope for the pilot?",
  (r, ans) => !/approved record five|current record five/i.test(ans),
);

// F1: keyword overlap on an unrelated excerpt must not answer a quantitative fact.
run(
  "F1-quantitative-without-quantity",
  [
    doc(
      "Northstar_Proposal.md",
      "# Northstar Proposal\nDate: 2026-09-04\nAuthor: Demo\n\nThe Northstar pilot scope is two regions for the first phase.\n",
    ),
    doc(
      "Northstar_Kickoff.md",
      "# Northstar Kickoff\nDate: 2026-09-11\nAuthor: Demo\n\nKickoff notes for the Northstar pilot team.\n",
    ),
    doc(
      "Northstar_Social.md",
      "# Northstar Social\nDate: 2026-10-01\nAuthor: Demo\n\nThe yearly Northstar picnic was revenue-neutral thanks to sponsorship.\n",
    ),
  ],
  "What is Northstar's annual revenue?",
  (r) => r.refused,
);

// F2: a question naming a foreign entity must not be answered from other-entity docs.
run(
  "F2-foreign-entity-excerpts",
  [
    doc(
      "Northstar_Proposal.md",
      "# Northstar Proposal\nDate: 2026-09-04\nAuthor: Demo\n\nThe Northstar onboarding workshop is Thursday at the client site.\n",
    ),
    doc(
      "Northstar_Kickoff.md",
      "# Northstar Kickoff\nDate: 2026-09-11\nAuthor: Demo\n\nKickoff notes for Northstar pilot logistics and access.\n",
    ),
    doc(
      "Northstar_Action_Log.md",
      "# Northstar Action Log\nDate: 2026-10-09\nAuthor: Demo\n\nAction items for the Northstar pilot team.\n",
    ),
    doc(
      "Falstaff_Agreement.md",
      "# Falstaff Agreement\nDate: 2026-10-01\nAuthor: Demo\n\nFalstaff Retail signed the framework agreement last week.\n",
    ),
  ],
  "When is Falstaff's onboarding workshop?",
  (r) => r.refused,
);

// G: claims verdict must not render alongside a retrieval-refusal tail.
run(
  "G-no-contradictory-composition",
  [
    doc(
      "Bluebird_Proposal.md",
      "# Bluebird Proposal\nDate: 2026-09-04\nAuthor: Demo\n\nThe fee is $45,000 and the committee approved it unanimously.\n",
    ),
  ],
  "What is the total commercial consideration?",
  (r, ans) =>
    !(
      /approved record/i.test(ans) &&
      /could not find supporting passages/i.test(ans)
    ),
);

// C7v control (must STAY safe): exclusive entities never cross-supersede.
run(
  "C7v-exclusive-entities-no-cross",
  [
    doc(
      "Meridian_Bluebird_Proposal.md",
      "# Meridian Bluebird Proposal\nDate: 2026-09-01\nAuthor: Demo\n\nThe fee is $40,000 for the Bluebird engagement.\n",
    ),
    doc(
      "Meridian_Falstaff_Revision.md",
      "# Meridian Falstaff Revision\nDate: 2026-09-10\nAuthor: Demo\n\nRevised fee: $45,000 for the Falstaff engagement.\n",
    ),
  ],
  "What is the fee?",
  (r, ans) => r.refused || /competing|unresolved/i.test(ans),
);

// 55k boundary: excerpt-only answers on one large doc need evidence-shape guards.
{
  const big =
    "# Internal Action Log - Northstar Pilot\nDate: 2026-10-09\nAuthor: Meridian PMO\n\n1. Working scope is two regions (North and South) for the first phase.\n2. Open decision: final payment schedule.\n" +
    "Status note: integration and data mapping work continues on plan.\n".repeat(
      900,
    );
  const docs = [doc("07_Internal_Action_Log.md", big)];
  run(
    "L1-large-doc-unanswerable-id",
    docs,
    "What does security ticket SEC-999999 approve?",
    (r) => r.refused,
  );
  run(
    "L2-large-doc-unanswerable-quantitative",
    docs,
    "What is Northstar's annual revenue?",
    (r) => r.refused,
  );
}
// N-batch (reviewer retest 2026-10-30): ground truth fixed before repair.
// N2: an approved claim must survive a rejected NEIGHBOR on the same line.
run(
  "N2-approved-with-rejected-neighbor",
  [
    doc(
      "Bluebird_Minutes.md",
      "# Bluebird Minutes\nDate: 2026-09-04\nAuthor: Demo\n\nThe fee of $45,000 was approved; the hiring plan was rejected.\n",
    ),
  ],
  "What fee did we finally agree to?",
  (r, ans) => /approved record \$45,000/i.test(ans),
);
// N4: phase-less scope question over a two-phase corpus: pilot claims primary,
// expansion disclosed as separate-phase or flagged; never the current verdict.
run(
  "N4-phaseless-question",
  [
    doc(
      "Northstar_Proposal.md",
      "# Northstar Proposal\nDate: 2026-09-04\nAuthor: Demo\n\nWorking scope is two regions (North and South) for the first phase of the pilot.\n",
    ),
    doc(
      "Northstar_Board.md",
      "# Northstar Board\nDate: 2026-10-15\nAuthor: Demo\n\nThe board confirmed five regions for the 2027 national expansion planning.\n",
    ),
  ],
  "Which regions are in scope?",
  (r, ans) =>
    !/approved record five|current record five/i.test(ans) &&
    (/two regions/i.test(ans) || r.refused),
);
// N5: replacement direction - "weekly digest replaced the monthly report"
// makes weekly current; monthly must not render as the current record.
run(
  "N5-weekly-replaced-monthly",
  [
    doc(
      "Meridian_Minutes.md",
      "# Meridian Minutes\nDate: 2026-10-01\nAuthor: Demo\n\nThe weekly digest replaced the monthly report for the steering group.\n",
    ),
  ],
  "Is monthly reporting confirmed?",
  (r, ans) => !/current record monthly|approved record monthly/i.test(ans),
);
// N6: quantity shaped evidence for the WRONG metric must not answer.
run(
  "N6-wrong-metric-quantity",
  [
    doc(
      "Northstar_Update.md",
      "# Northstar Update\nDate: 2026-10-01\nAuthor: Demo\n\nNorthstar's marketing spend was $2,000,000 last year and revenue was discussed at length.\n",
    ),
  ],
  "What is Northstar's annual revenue?",
  (r) => r.refused,
);

// N4x family (RED 2026-10-30): number-word extraction gaps and missing year
// binding must never let a neighbor claim win silently. 2027 and 2028 both
// tag "expansion"; the year, not the phase bucket, is the identity.
const boardFive2027 = doc(
  "Northstar_Board.md",
  "# Northstar Board\nDate: 2026-10-15\nAuthor: Demo\n\nThe board confirmed five regions for the 2027 national expansion planning.\n",
);
const councilEight2028 = doc(
  "Northstar_Council.md",
  "# Northstar Council\nDate: 2026-10-20\nAuthor: Demo\n\nThe council approved eight regions for the 2028 international expansion.\n",
);
const pilotTwo = doc(
  "Northstar_Proposal.md",
  "# Northstar Proposal\nDate: 2026-09-04\nAuthor: Demo\n\nWorking scope is two regions (North and South) for the first phase of the pilot.\n",
);
// N4b: two expansion scopes, no pilot, phase-less question - no silent default.
run(
  "N4b-two-expansions-no-pilot",
  [boardFive2027, councilEight2028],
  "Which regions are in scope?",
  (r, ans) => r.unresolved === true || r.refused === true,
);
// N4c: same, reversed document dates - recency must not pick a winner either.
run(
  "N4c-two-expansions-swapped-dates",
  [
    doc(
      "Northstar_Council.md",
      "# Northstar Council\nDate: 2026-10-15\nAuthor: Demo\n\nThe council approved eight regions for the 2028 international expansion.\n",
    ),
    doc(
      "Northstar_Board.md",
      "# Northstar Board\nDate: 2026-10-20\nAuthor: Demo\n\nThe board confirmed five regions for the 2027 national expansion planning.\n",
    ),
  ],
  "Which regions are in scope?",
  (r, ans) => r.unresolved === true || r.refused === true,
);
// N4d: pilot plus two expansions - pilot stays primary, BOTH expansions noted.
run(
  "N4d-pilot-plus-two-expansions",
  [pilotTwo, boardFive2027, councilEight2028],
  "Which regions are in scope?",
  (r, ans) =>
    r.unresolved !== true &&
    /current record two regions/i.test(ans) &&
    /five regions/i.test(ans) &&
    /eight regions|8 regions/i.test(ans) &&
    !/approved record five regions/i.test(ans),
);
// N4e: explicit 2028 question must answer the 2028 record, never the 2027 one.
run(
  "N4e-explicit-2028-question",
  [boardFive2027, councilEight2028],
  "Which regions are in the 2028 expansion scope?",
  (r, ans) =>
    /approved record (eight|8) regions/i.test(ans) &&
    !/approved record five regions/i.test(ans),
);
// N4e2: explicit 2027 question must answer the 2027 record, never the 2028 one.
run(
  "N4e2-explicit-2027-question",
  [boardFive2027, councilEight2028],
  "Which regions are in the 2027 expansion scope?",
  (r, ans) =>
    /approved record five regions/i.test(ans) &&
    !/approved record (eight|8) regions/i.test(ans),
);
// N4f: digit form, explicit 2028 question - year binding answers 8.
run(
  "N4f-digit8-explicit-2028",
  [
    boardFive2027,
    doc(
      "Northstar_Council.md",
      "# Northstar Council\nDate: 2026-10-20\nAuthor: Demo\n\nThe council approved 8 regions for the 2028 international expansion.\n",
    ),
  ],
  "Which regions are in the 2028 expansion scope?",
  (r, ans) =>
    /approved record (eight|8) regions/i.test(ans) &&
    !/approved record five regions/i.test(ans),
);
// N4h: word-form six must extract like any count.
run(
  "N4h-word-six-extraction",
  [
    doc(
      "Northstar_Board.md",
      "# Northstar Board\nDate: 2026-10-15\nAuthor: Demo\n\nThe board confirmed six regions for the 2027 national expansion planning.\n",
    ),
  ],
  "Which regions are in the 2027 expansion scope?",
  (r, ans) => /approved record six regions/i.test(ans),
);
// N4i: digit and word forms of the SAME count agree - no spurious conflict.
run(
  "N4i-digit-word-agree",
  [
    doc(
      "Northstar_Board.md",
      "# Northstar Board\nDate: 2026-10-15\nAuthor: Demo\n\nThe board confirmed 8 regions for the 2028 international expansion.\n",
    ),
    doc(
      "Northstar_Council.md",
      "# Northstar Council\nDate: 2026-10-20\nAuthor: Demo\n\nThe council approved eight regions for the 2028 international expansion.\n",
    ),
  ],
  "Which regions are in the 2028 expansion scope?",
  (r, ans) => r.unresolved !== true && /(eight|8) regions/i.test(ans),
);
// N4j: an un-normalizable count fails CLOSED - it competes, so the visible
// neighbor can never win by default.
run(
  "N4j-unknown-count-fail-closed",
  [
    boardFive2027,
    doc(
      "Northstar_Council.md",
      "# Northstar Council\nDate: 2026-10-20\nAuthor: Demo\n\nThe council approved several regions for the 2029 international expansion.\n",
    ),
  ],
  "Which regions are in scope?",
  (r, ans) => r.unresolved === true || r.refused === true,
);

// P4 family (RED 2026-10-30, reviewer adv8): a query-asserted period cannot be
// implicitly filled from a yearless claim or the document date. Fail closed
// with explicit uncertainty; preserve unqualified and dated-positive cases.
const councilYearlessEight = doc(
  "Northstar_Council.md",
  "# Northstar Council\nDate: 2026-10-20\nAuthor: Demo\n\nThe council approved eight regions for the international expansion.\n",
);
// P4a: yearless claim alone, explicit 2028 question - no approved verdict.
run(
  "P4a-yearless-claim-explicit-2028",
  [councilYearlessEight],
  "Which regions are in the 2028 expansion scope?",
  (r, ans) =>
    !/approved record/i.test(ans) &&
    (r.refused === true || r.unresolved === true) &&
    /eight regions/i.test(ans),
);
// P4b: yearless claim plus other-year claim - neither may win for 2028.
run(
  "P4b-yearless-plus-2027-explicit-2028",
  [boardFive2027, councilYearlessEight],
  "Which regions are in the 2028 expansion scope?",
  (r, ans) =>
    !/approved record/i.test(ans) &&
    (r.refused === true || r.unresolved === true),
);
// P4c: unqualified question - the yearless claim still answers.
run(
  "P4c-yearless-claim-unqualified-question",
  [councilYearlessEight],
  "Which regions are in scope?",
  (r, ans) => /approved record eight regions/i.test(ans),
);
// P4d: dated 2028 claim wins the verdict; the yearless one is disclosed.
run(
  "P4d-dated-2028-plus-yearless",
  [
    councilYearlessEight,
    doc(
      "Northstar_Board.md",
      "# Northstar Board\nDate: 2026-10-15\nAuthor: Demo\n\nThe board confirmed eight regions for the 2028 international expansion.\n",
    ),
  ],
  "Which regions are in the 2028 expansion scope?",
  (r, ans) => /approved record eight regions/i.test(ans),
);
console.log(`=== CONTROLS3: ${pass} pass, ${fail} fail ===`);
process.exit(fail ? 1 : 0);
