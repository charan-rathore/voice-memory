// Provider-independent evidence boundary for general document reasoning.
// This is preparation, not a language model or a claim-entailment proof.
// Unknown ownership is never upgraded by proximity or geometric overlap.
import { createHash } from "node:crypto";
const hash = (x) => createHash("sha256").update(x).digest("hex");
const freeze = (x) => {
  if (x && typeof x === "object") {
    Object.values(x).forEach(freeze);
    Object.freeze(x);
  }
  return x;
};
const unique = (xs) => [...new Set(xs)];

/** A scope is made from verified bindings, never inferred by this module.
 * A planner can name missing requested entities, but cannot erase them.
 */
export function documentScope({
  corpusId,
  generation,
  owners = [],
  requested = [],
  missing = [],
  ambiguous = false,
  temporal = null,
}) {
  if (!corpusId || !Number.isInteger(generation) || generation < 0)
    throw Error("A document scope needs corpus and generation identity.");
  for (const xs of [owners, requested, missing])
    if (!Array.isArray(xs) || xs.some((x) => typeof x !== "string" || !x))
      throw Error("Scope identifiers must be nonempty strings.");
  const bound = unique(owners).sort();
  const absent = unique(missing).sort();
  if (bound.some((x) => absent.includes(x)))
    throw Error("A requested entity cannot be both bound and missing.");
  const value = {
    version: 1,
    corpusId,
    generation,
    owners: bound,
    requested: unique(requested).sort(),
    missing: absent,
    state: ambiguous ? "ambiguous" : absent.length ? "partial" : "resolved",
    temporal,
  };
  return freeze({ ...value, key: hash(JSON.stringify(value)) });
}

/** Immutable page/record boundaries supplied by an extractor. A fact must
 * fit entirely inside one explicit owner boundary to support an owner claim.
 * Mere overlap can be retained as context, never as owner evidence.
 */
export function evidencePermission(scope, evidence, records) {
  if (scope.state === "ambiguous")
    return { allowed: false, reason: "ambiguous_scope" };
  if (
    !evidence ||
    !Number.isInteger(evidence.start) ||
    !Number.isInteger(evidence.end) ||
    evidence.start < 0 ||
    evidence.end <= evidence.start
  )
    return { allowed: false, reason: "invalid_span" };
  const hits = records.filter(
    (r) =>
      r.sourceId === evidence.sourceId &&
      r.start <= evidence.start &&
      evidence.end <= r.end,
  );
  if (hits.length !== 1)
    return {
      allowed: false,
      reason: hits.length ? "overlapping_boundaries" : "no_containing_record",
    };
  const record = hits[0];
  if (!scope.owners.length) {
    // General documents can support source facts without inventing a person.
    return { allowed: true, owner: record.owner ?? null, recordId: record.id };
  }
  if (!record.owner) return { allowed: false, reason: "unknown_owner" };
  if (!scope.owners.includes(record.owner))
    return { allowed: false, reason: "outside_scope" };
  if (evidence.owner && evidence.owner !== record.owner)
    return { allowed: false, reason: "owner_conflict" };
  return { allowed: true, owner: record.owner, recordId: record.id };
}

/** Check a provider's proposed plan against caller-owned requested units.
 * The planner cannot silently omit Carol, remove a condition, or change time.
 */
export function validateDocumentPlan(plan, { scope, question, requirements }) {
  if (!plan || plan.scopeKey !== scope.key || plan.question !== question)
    throw Error("The plan changed the question or request scope.");
  const expected = requirements.map((r) => r.id).sort();
  const actual = (plan.requirements ?? []).map((r) => r.id).sort();
  if (
    new Set(expected).size !== expected.length ||
    JSON.stringify(expected) !== JSON.stringify(actual)
  )
    throw Error(
      "The plan must preserve every requested subquestion exactly once.",
    );
  for (const r of plan.requirements)
    if (
      !requirements.some(
        (x) =>
          x.id === r.id &&
          x.text === r.text &&
          JSON.stringify(x.owners ?? []) === JSON.stringify(r.owners ?? []),
      )
    )
      throw Error("The plan changed a requested subquestion or its owners.");
  return freeze(structuredClone(plan));
}

/** Structural validation only. A source quote can be verified mechanically;
 * a synthesis requires a separate semantic/entailment check and is NEVER
 * promoted to verified just because its words have citations.
 */
export function inspectReasoningDraft(
  draft,
  { scope, requirements, sources, records },
) {
  if (draft?.scopeKey !== scope.key)
    throw Error("Reasoning escaped request scope.");
  const outcomes = [];
  const seen = new Set();
  for (const item of draft.outcomes ?? []) {
    const requirement = requirements.find((r) => r.id === item.requirementId);
    if (!requirement || seen.has(item.requirementId))
      throw Error("Unknown or repeated requested subquestion.");
    seen.add(item.requirementId);
    if (item.status === "not_established") {
      if ((item.claims ?? []).length)
        throw Error("An unknown outcome cannot contain claims.");
      outcomes.push({
        requirementId: item.requirementId,
        status: "not_established",
        reason: item.reason ?? null,
      });
      continue;
    }
    const claims = [];
    for (const claim of item.claims ?? []) {
      const citations = claim.citations ?? [];
      if (!citations.length)
        throw Error("Every proposed claim needs original-source evidence.");
      for (const c of citations) {
        const src = sources.find((s) => s.id === c.sourceId);
        if (!src || src.text.slice(c.start, c.end) !== c.quote)
          throw Error("Citation does not match the original source.");
        const p = evidencePermission(scope, c, records);
        if (!p.allowed)
          throw Error(`Citation cannot support this scope: ${p.reason}`);
        if (
          (requirement.owners ?? []).length &&
          !requirement.owners.includes(p.owner)
        )
          throw Error("Citation is for the wrong requested entity.");
      }
      const direct =
        claim.kind === "quotation" &&
        citations.some((c) => c.quote === claim.text);
      claims.push({
        ...claim,
        verification: direct
          ? "exact_quotation_only"
          : "requires_entailment_check",
      });
    }
    outcomes.push({
      requirementId: item.requirementId,
      status: claims.length ? "proposed" : "not_established",
      claims,
    });
  }
  const missing = requirements.filter((r) => !seen.has(r.id)).map((r) => r.id);
  return freeze({
    scopeKey: scope.key,
    complete: !missing.length,
    missing,
    outcomes,
    userReady: false,
    note: "Structural checks are not demonstrated document understanding.",
  });
}
