// Shared provider-free admission contract. Candidate producers and renderers
// cannot certify themselves. This module does not parse natural language.
import { validateRequirementOutcomes } from "./question-plan.mjs";
const freeze = (x) => {
  if (x && typeof x === "object") {
    Object.values(x).forEach(freeze);
    Object.freeze(x);
  }
  return x;
};
const unresolved = (plan, reason, outcomes = []) =>
  freeze({
    questionPlanKey: plan.key,
    sourceGeneration: plan.sourceGeneration,
    status: reason === "interpretation_unresolved" ? "clarify" : "unresolved",
    userReady: false,
    reason,
    outcomes,
  });

export async function admitAnswer({
  plan,
  draft,
  bundle,
  verifyEvidence,
  verifyDeterministic,
}) {
  if (!plan?.key || !Array.isArray(plan.requirements))
    throw Error("A caller-owned question plan is required.");
  if (
    plan.sourceGeneration === null ||
    plan.sourceGeneration === undefined ||
    draft?.questionPlanKey !== plan.key ||
    draft?.sourceGeneration !== plan.sourceGeneration
  )
    return unresolved(plan, "stale_or_wrong_request");
  try {
    validateRequirementOutcomes(draft.outcomes, plan);
  } catch {
    return unresolved(plan, "invalid_requirement_coverage");
  }
  // Lossless preservation and outcome cardinality do not prove that an
  // opaque compound request was decomposed or answered completely.
  if (
    plan.coverageEstablished !== true ||
    plan.semanticQualification === "unresolved"
  )
    return unresolved(plan, "interpretation_unresolved");
  const outcomes = [];
  for (const item of draft.outcomes) {
    const requirement = plan.requirements.find(
      (r) => r.id === item.requirementId,
    );
    if (item.status !== "answered") {
      // A producer's uncertain outcome is not proof of source absence.
      outcomes.push({
        requirementId: requirement.id,
        status: item.status,
        claims: [],
        reason: "producer_uncertainty",
      });
      continue;
    }
    const claims = [];
    for (const proposed of item.claims) {
      // Clone before each check so a callback cannot alter a previously
      // inspected candidate. These callbacks are server-owned, never fields
      // in a provider result or request body.
      const claim = freeze(structuredClone(proposed));
      let evidence, certificate;
      try {
        evidence = await verifyEvidence?.({ plan, requirement, claim, bundle });
        if (evidence?.ok === true)
          certificate = await verifyDeterministic?.({
            plan,
            requirement,
            claim,
            bundle,
          });
      } catch {
        certificate = null;
      }
      if (
        evidence?.ok !== true ||
        certificate?.ok !== true ||
        certificate.requirementId !== requirement.id ||
        certificate.questionPlanKey !== plan.key ||
        certificate.sourceGeneration !== plan.sourceGeneration
      )
        continue;
      claims.push({
        ...claim,
        admission: "deterministic_verified",
        certificate: structuredClone(certificate),
      });
    }
    // A partial claim set cannot dress itself as the complete requirement.
    const complete = claims.length === item.claims.length && claims.length > 0;
    outcomes.push({
      requirementId: requirement.id,
      status: complete ? "answered" : "not_established",
      claims: complete ? claims : [],
      reason: complete ? null : "claim_not_admitted",
    });
  }
  const count = outcomes.filter((x) => x.status === "answered").length;
  return freeze({
    questionPlanKey: plan.key,
    sourceGeneration: plan.sourceGeneration,
    status:
      count === outcomes.length
        ? "answered"
        : count
          ? "partial"
          : outcomes.some((x) => x.status === "clarify")
            ? "clarify"
            : "unresolved",
    userReady: count > 0,
    complete: count === outcomes.length,
    outcomes,
    limitations: [
      "Deterministic certificates prove only their defined source-backed operations. General semantic interpretation is not qualified by this contract.",
    ],
  });
}
