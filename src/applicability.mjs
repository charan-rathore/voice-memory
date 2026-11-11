// Which document set applies to THIS caller. Used by the memory API and the
// voice resolver alike, so a typed and a spoken answer can never disagree.
//
// The deciding facts (policy issue date, optional wording version, held
// endorsements) come from the tenant's VERIFIED ACCOUNT DATA on the call
// binding (`applicability`, set by the tenant backend at /v1/calls) and are
// never taken from what the caller says. Missing, invalid or contradictory
// account data is a clarification: nothing is guessed.
import { HARBORLINE_EFFECTIVE } from "../examples/corpus-harborline.mjs";

/** Exact calendar date YYYY-MM-DD (rejects 2026-02-30, 2026-13-01, ...). */
export function isCalendarDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(typeof s === "string" ? s : "");
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = new Date(Date.UTC(y, mo - 1, d));
  return (
    t.getUTCFullYear() === y &&
    t.getUTCMonth() === mo - 1 &&
    t.getUTCDate() === d
  );
}

const WORDINGS = {
  "insurance-2025": {
    version: "2025.1",
    effectiveFrom: "2025-04-01",
    effectiveTo: "2026-03-31",
    endorsements: [],
  },
  "insurance-2026": {
    version: "2026.1",
    effectiveFrom: HARBORLINE_EFFECTIVE.v2026From,
    effectiveTo: null,
    endorsements: ["glass-shield"],
  },
};
const RULE = `Policies issued before ${HARBORLINE_EFFECTIVE.v2026From} use the 2025 wording; on or after, the 2026 wording. An endorsement applies only if the account holds it.`;
const ask = (why) => ({
  clarify: `Your answer depends on your DriveSure policy details, and ${why}. Which policy are you asking about?`,
  rule: RULE,
});

/**
 * @param {{ case: string }} scope
 * @param {{ policyIssuedOn?: string, wordingVersion?: string, endorsements?: string[] } | null} applicability
 */
export function applicableScope(scope, applicability = null) {
  if (scope?.case !== "insurance")
    return { case: scope?.case, applied: null, rule: null };
  const a = applicability ?? {};
  if (!a.policyIssuedOn)
    return ask("I don't have your policy's issue date on this call");
  if (!isCalendarDate(a.policyIssuedOn))
    return ask("the policy issue date on your account isn't a valid date");
  if (a.policyIssuedOn < WORDINGS["insurance-2025"].effectiveFrom)
    return ask("your policy predates the wordings I can check");
  const wording =
    a.policyIssuedOn < HARBORLINE_EFFECTIVE.v2026From
      ? "insurance-2025"
      : "insurance-2026";
  const w = WORDINGS[wording];
  // Contradictory account data: never pick a side.
  if (a.wordingVersion != null && a.wordingVersion !== w.version)
    return ask("your account's wording version doesn't match its issue date");
  const held = Array.isArray(a.endorsements)
    ? [...new Set(a.endorsements)].sort()
    : [];
  for (const e of held)
    if (!w.endorsements.includes(e))
      return ask(
        `an endorsement on your account doesn't exist for that wording`,
      );
  const applied = held.length ? `${wording}+${held.join("+")}` : wording;
  return {
    case: applied,
    applied,
    rule: RULE,
    effective: {
      wordingVersion: w.version,
      effectiveFrom: w.effectiveFrom,
      effectiveTo: w.effectiveTo,
      endorsements: held,
      source: "tenant_account",
    },
  };
}

/** Referent vocabulary for the policy, so recall can name what was asked. */
export const HARBORLINE_SUBJECTS = Object.freeze([
  {
    id: "policy.windscreen_excess",
    label: "your windscreen excess",
    aliases: ["windscreen excess", "excess"],
  },
  {
    id: "policy.windscreen_preapproval",
    label: "windscreen pre-approval",
    aliases: ["pre-approval", "preapproval", "pre approval"],
  },
  {
    id: "policy.roadside",
    label: "roadside assistance",
    aliases: ["roadside assistance", "roadside"],
  },
  {
    id: "policy.settlement",
    label: "claim settlement time",
    aliases: ["settle", "settled", "settlement"],
  },
]);

// Hinglish question forms the policy retrieval does not understand, mapped
// to the English question they ask. A closed list of whole-question
// patterns: the QUESTION is normalised, never the answer; an unmatched
// question stays as it was and may well be "not found".
const HINGLISH = [
  [
    /^(?:mera|meri|mere)\s+(.+?)\s+(?:kitna|kitni|kitne)\s+(?:hai|hain|h)\s*\??$/i,
    (m) => `What is my ${m[1]}?`,
  ],
  [
    /^(.+?)\s+claim\s+kitne\s+din\s+(?:mein|me|main)\s+settle\s+(?:hota|hoti|hoga|hogi)(?:\s+(?:hai|h))?\s*\??$/i,
    (m) => `How long does a ${m[1]} claim take to settle?`,
  ],
];
export function normaliseHinglishQuestion(q) {
  const s = String(q ?? "").trim();
  for (const [re, f] of HINGLISH) {
    const m = re.exec(s);
    if (m) return f(m).replace(/\s+/g, " ");
  }
  return null;
}
