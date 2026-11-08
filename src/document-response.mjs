// Strict provider-response shape. Structural coverage is separate from
// semantic entailment, and caller requirements are never model-authored.
import { validateDocumentPlan } from "./document-scope.mjs";
export function validateDocumentResponse(response, { requestPlan, scope }) {
  if (
    !requestPlan ||
    requestPlan.scopeKey !== scope.key ||
    requestPlan.sourceGeneration !== scope.generation
  )
    throw Error("Document request scope changed.");
  const checked = validateDocumentPlan(response, {
    scope,
    question: requestPlan.originalQuestion,
    requirements: requestPlan.requirements,
  });
  if (checked.questionPlanKey !== requestPlan.key)
    throw Error("Document response changed the request identity.");
  for (const item of checked.requirements) {
    if (!["answered", "not_established", "clarify"].includes(item.status))
      throw Error("Invalid requirement outcome.");
    if (item.status === "answered") {
      if (
        !Array.isArray(item.claims) ||
        !item.claims.length ||
        item.claims.length > 12
      )
        throw Error("An answer needs bounded proposed claims.");
    } else if (
      item.claims !== undefined &&
      (!Array.isArray(item.claims) || item.claims.length)
    )
      throw Error("An uncertain outcome cannot assert claims.");
  }
  return checked;
}

// Exactly one judgment for every statement, including uncertainty. An audit
// cannot omit a claim, duplicate another or relabel a requirement.
export function validateDocumentAudit(audit, { requestPlan, statements }) {
  if (
    audit?.questionPlanKey !== requestPlan.key ||
    audit.scopeKey !== requestPlan.scopeKey ||
    audit.question !== requestPlan.originalQuestion ||
    audit.complete !== true ||
    audit.relevant !== true ||
    audit.supported !== true ||
    !Array.isArray(audit.items) ||
    audit.items.length !== statements.length
  )
    return false;
  return audit.items.every(
    (v, i) =>
      v.index === i &&
      v.requirementId === statements[i].requirementId &&
      v.accept === true,
  );
}
