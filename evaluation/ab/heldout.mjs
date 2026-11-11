// HELD-OUT A/B scenarios. Frozen before any tuning on this release
// (SHA-256 recorded in evaluation/ab/README.md and checked by the test).
// Do not edit to make a run pass; add new cases to a NEW held-out file.
// Still developer-authored: not independent accuracy evidence.
export const HELDOUT_SCENARIOS = [
  {
    id: "ho-preapproval-returning",
    case: "insurance",
    calls: [
      { applicability: { policyIssuedOn: "2026-05-02" }, steps: [{ pref: "en" }, { consent: true }, { ask: "Do windscreen claims need pre-approval?", expect: { has: "pre-approval" } }] },
      { applicability: { policyIssuedOn: "2026-05-02" }, recall: { language: "en", subject: "windscreen pre-approval", changed: false }, steps: [{ ask: "Do windscreen claims need pre-approval?", expect: { has: "pre-approval" } }] },
    ],
  },
  {
    id: "ho-invalid-date",
    case: "insurance",
    calls: [{ applicability: { policyIssuedOn: "2026-02-30" }, steps: [{ ask: "What is my windscreen excess?", expect: { clarify: true, not: "₹" } }] }],
  },
  {
    id: "ho-contradictory-account",
    case: "insurance",
    calls: [{ applicability: { policyIssuedOn: "2025-07-01", wordingVersion: "2026.1" }, steps: [{ ask: "What is my windscreen excess?", expect: { clarify: true, not: "₹" } }] }],
  },
  {
    id: "ho-hinglish-question",
    case: "insurance",
    calls: [{ applicability: { policyIssuedOn: "2025-10-10" }, steps: [{ ask: "Mera windscreen excess kitna hai?", expect: { has: "₹1,000" } }] }],
  },
  {
    id: "ho-settlement-renewal",
    case: "insurance",
    calls: [
      { applicability: { policyIssuedOn: "2025-12-01" }, steps: [{ consent: true }, { ask: "How long does a windscreen claim take to settle?", expect: { has: "7 working days" } }] },
      { applicability: { policyIssuedOn: "2026-12-01" }, recall: { subject: "claim settlement time", changed: true }, steps: [{ ask: "How long does a windscreen claim take to settle?", expect: { has: "5 working days" } }] },
    ],
  },
];
