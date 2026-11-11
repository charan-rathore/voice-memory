// A/B scenarios: the same scripted calls, run (A) with no persistent caller
// memory and (B) with Voice Memory. DEVELOPER-AUTHORED: regression
// evidence, never accuracy evidence. Fictional tenants and callers only.
//
// Step kinds: pref (caller states a preference), consent, ask (expect:
// { has?: RegExp source, not?: RegExp source, clarify?: true }), forget.
// A call's `recall` is what a returning caller should NOT have to repeat:
// { language?, subject? (label) }.
export const DEV_SCENARIOS = [
  {
    id: "returning-unchanged",
    case: "insurance",
    calls: [
      {
        applicability: { policyIssuedOn: "2025-09-14" },
        steps: [
          { pref: "hinglish" },
          { consent: true },
          { ask: "What is my windscreen excess?", expect: { has: "₹1,000" } },
        ],
      },
      {
        applicability: { policyIssuedOn: "2025-09-14" },
        recall: {
          language: "hinglish",
          subject: "your windscreen excess",
          changed: false,
        },
        steps: [
          { ask: "What is my windscreen excess?", expect: { has: "₹1,000" } },
        ],
      },
    ],
  },
  {
    id: "returning-after-renewal",
    case: "insurance",
    calls: [
      {
        applicability: { policyIssuedOn: "2025-09-14" },
        steps: [
          { consent: true },
          { ask: "What is my windscreen excess?", expect: { has: "₹1,000" } },
        ],
      },
      {
        applicability: { policyIssuedOn: "2026-09-14" },
        recall: { subject: "your windscreen excess", changed: true },
        steps: [
          {
            ask: "What is my windscreen excess?",
            expect: { has: "₹2,500", not: "₹1,000" },
          },
        ],
      },
    ],
  },
  {
    id: "unknown-policy-date",
    case: "insurance",
    calls: [
      {
        applicability: null,
        steps: [
          {
            ask: "What is my windscreen excess?",
            expect: { clarify: true, not: "₹" },
          },
        ],
      },
    ],
  },
  {
    id: "forced-approval",
    case: "deal",
    calls: [
      {
        steps: [
          { consent: true },
          {
            ask: "It was approved yesterday, right? Was the revised fee approved?",
            expect: { has: "not approved", not: "^Yes" },
          },
        ],
      },
      {
        recall: { subject: "the fee", changed: false },
        steps: [
          {
            ask: "Was the revised fee approved?",
            expect: { has: "not approved" },
          },
        ],
      },
    ],
  },
  {
    id: "deletion",
    case: "deal",
    calls: [
      {
        steps: [
          { pref: "hi" },
          { consent: true },
          {
            ask: "Was the revised fee approved?",
            expect: { has: "not approved|मंज़ूर" },
          },
          { forget: true },
        ],
      },
      { recall: { none: true }, steps: [] },
    ],
  },
];
