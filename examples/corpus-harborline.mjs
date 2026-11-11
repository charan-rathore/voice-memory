// Fictional motor-insurance policy wording in two versions, for the first
// commercial example. Harborline Assurance, its products, people and
// figures are invented. No real insurer's terms are reproduced.
//
// Which version applies is NOT "the latest one": it depends on the date the
// customer's policy was issued. A caller on a 2025 policy and a caller on a
// 2026 policy can ask the same question and both get a correct, different
// answer.

export const HARBORLINE_EFFECTIVE = Object.freeze({
  // Policies issued before this date use the 2025 wording.
  v2026From: "2026-04-01",
});

const header = (v, date) =>
  `Issuer: Harborline Assurance (fictional). Product: DriveSure Motor Policy. Wording version: ${v}. Effective for policies issued ${date}.`;

export const HARBORLINE_2025 = [
  {
    title: "01_DriveSure_Wording_2025.md",
    text: `# DriveSure Motor Policy - Policy Wording 2025
${header("2025.1", "from 1 April 2025 to 31 March 2026")}


1. The windscreen excess is ₹1,000 per claim.

2. Windscreen claims do not need pre-approval.

3. Roadside assistance is included at no extra cost.

4. The no-claim bonus is protected after one claim per policy year.`,
  },
  {
    title: "02_DriveSure_Claims_Guide_2025.md",
    text: `# DriveSure Claims Guide 2025
${header("2025.1", "from 1 April 2025 to 31 March 2026")}


1. A windscreen claim is settled within 7 working days of the invoice.

2. Claims can be reported by phone or in the app.`,
  },
];

export const HARBORLINE_2026 = [
  {
    title: "01_DriveSure_Wording_2026.md",
    text: `# DriveSure Motor Policy - Policy Wording 2026
${header("2026.1", "on or after 1 April 2026")}


1. The windscreen excess is ₹2,500 per claim.

2. Windscreen claims need pre-approval before the repair.

3. Roadside assistance is an optional add-on.

4. The no-claim bonus is protected after one claim per policy year.`,
  },
  {
    title: "02_DriveSure_Claims_Guide_2026.md",
    text: `# DriveSure Claims Guide 2026
${header("2026.1", "on or after 1 April 2026")}


1. A windscreen claim is settled within 5 working days of the invoice.

2. Claims can be reported by phone or in the app.`,
  },
];
