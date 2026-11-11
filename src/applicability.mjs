// Which document set applies to THIS caller. Used by the memory API and the
// voice resolver alike, so a typed and a spoken answer can never disagree.
//
// The deciding fact (here: the date the caller's policy was issued) comes
// from the tenant's verified account data on the call binding, never from
// what the caller says. When it is missing or unreadable, nothing is
// guessed: the caller is asked which policy they mean.
import { HARBORLINE_EFFECTIVE } from "../examples/corpus-harborline.mjs";

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * @param {{ case: string }} scope
 * @param {{ policyIssuedOn?: string } | null} applicability
 * @returns {{ case: string, applied: string|null, rule: string|null } | { clarify: string, rule: string }}
 */
export function applicableScope(scope, applicability = null) {
  if (scope?.case !== "insurance")
    return { case: scope?.case, applied: null, rule: null };
  const d = applicability?.policyIssuedOn;
  const rule = `Policies issued before ${HARBORLINE_EFFECTIVE.v2026From} use the 2025 wording; on or after, the 2026 wording.`;
  if (typeof d !== "string" || !DATE.test(d) || Number.isNaN(Date.parse(d)))
    return {
      clarify:
        "Your answer depends on when your DriveSure policy was issued, and I don't have that on this call. Which policy are you asking about?",
      rule,
    };
  const applied =
    d < HARBORLINE_EFFECTIVE.v2026From ? "insurance-2025" : "insurance-2026";
  return { case: applied, applied, rule };
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
