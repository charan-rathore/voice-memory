// Bounded whole-context reading with a separate relevance/entailment audit.
// Opt-in rollout only. A cited claim is not accepted merely for its numbers.
import { validateEvidence } from "../../dist/engine.mjs";
import { createHash } from "node:crypto";
import { documentScope } from "../document-scope.mjs";
import {
  createDecomposition,
  createDocumentQuestionPlan,
} from "../question-decomposition.mjs";
import {
  validateDocumentResponse,
  validateDocumentAudit,
} from "../document-response.mjs";
export const DOCUMENT_CONTEXT_LIMIT = 90000;
export async function readDocumentQuestion({
  question,
  bundle,
  gemini,
  consent,
  ip,
  decomposition = createDecomposition({ question }),
  sourceGeneration = 0,
  isCurrent = () => true,
  validate = (ev) => validateEvidence(ev, bundle),
}) {
  if (
    !consent ||
    !gemini?.enabled?.() ||
    !gemini.documentRead ||
    !gemini.documentAudit
  )
    return null;
  const sources = (bundle.sources ?? []).filter((s) => s.text.trim());
  if (!sources.length) return null;
  // Never silently truncate context and report a whole-document answer.
  if (sources.reduce((n, s) => n + s.text.length, 0) > DOCUMENT_CONTEXT_LIMIT)
    return {
      text: "This document set exceeds the current reasoning context limit. I cannot yet give a complete answer across all of it.",
      verdict: "UNKNOWN",
      citations: [],
      field: null,
      origin: "document-limit",
    };
  const documents = sources.map((s, i) => ({
    index: i,
    sourceId: s.id,
    title: s.title,
    text: s.text,
  }));
  const fingerprint = () =>
    createHash("sha256")
      .update(
        JSON.stringify(
          (bundle.sources ?? [])
            .filter((s) => s.text.trim())
            .map((s) => [s.id, s.hash, s.text]),
        ),
      )
      .digest("hex");
  const sourceFingerprint = fingerprint();
  const current = () =>
    isCurrent() === true && fingerprint() === sourceFingerprint;
  if (!current()) return null;
  const scope = documentScope({
    corpusId: sourceFingerprint,
    generation: sourceGeneration,
  });
  if (decomposition.originalQuestion !== question) return null;
  const requestPlan = createDocumentQuestionPlan({ decomposition, scope });
  if (!requestPlan.coverageEstablished || !requestPlan.requirements.length)
    return {
      text: "I could not establish complete coverage of that question. Its interpretation remains unresolved, so I have not sent these documents for model reading.",
      verdict: "UNKNOWN",
      citations: [],
      field: null,
      origin: "document-unqualified-question",
      requestPlan,
      reason: "decomposition_not_qualified",
    };
  let plan;
  try {
    plan = validateDocumentResponse(
      await gemini.documentRead(requestPlan, documents, { ip }),
      { requestPlan, scope },
    );
  } catch {
    return null;
  }
  // Both blind source reads are candidates, never authorities. Keep the union
  // of their distinct claims only when immutable request/outcome identities
  // agree. Every retained claim still faces the exact source and owner gate
  // below, followed by the separate full-document entailment audit.
  let independentPlan = null;
  if (
    decomposition.provenance === "source-exact-blind-model-reconstruction-v1"
  ) {
    if (!gemini.documentCoverage || !current()) return null;
    try {
      independentPlan = validateDocumentResponse(
        await gemini.documentCoverage(requestPlan, documents, { ip }),
        { requestPlan, scope },
      );
      const merged = reconcileDocumentProposals(plan, independentPlan);
      if (!merged || !current()) return null;
      plan = merged;
    } catch {
      return null;
    }
  }
  const statements = [],
    citations = [];
  for (const part of plan.requirements) {
    if (
      typeof part.text !== "string" ||
      !part.text.trim() ||
      !["answered", "not_established", "clarify"].includes(part.status)
    )
      return null;
    if (part.status !== "answered") {
      if ((part.claims ?? []).length) return null;
      statements.push({
        requirementId: part.id,
        request: part.text,
        status: part.status,
        text: "I could not establish this requirement from the supplied evidence.",
        evidence: [],
      });
      continue;
    }
    if (
      !Array.isArray(part.claims) ||
      !part.claims.length ||
      part.claims.length > 12
    )
      return null;
    for (const c of part.claims) {
      if (
        typeof c.statement !== "string" ||
        !c.statement.trim() ||
        !Array.isArray(c.evidence) ||
        !c.evidence.length ||
        c.evidence.length > 8
      )
        return null;
      const evidence = [];
      for (const ref of c.evidence) {
        const src = sources[ref.document];
        if (
          !Number.isInteger(ref.document) ||
          !src ||
          typeof ref.quote !== "string" ||
          ref.quote.length < 8
        )
          return null;
        if (ref.sourceId !== undefined && ref.sourceId !== src.id) return null;
        const positioned = ref.start !== undefined || ref.end !== undefined;
        const start = positioned ? ref.start : src.text.indexOf(ref.quote);
        const end = positioned ? ref.end : start + ref.quote.length;
        if (
          !Number.isInteger(start) ||
          !Number.isInteger(end) ||
          start < 0 ||
          end <= start ||
          end > src.text.length ||
          src.text.slice(start, end) !== ref.quote
        )
          return null;
        // Repeated text is safe only with an explicit exact source span.
        // Legacy unique quotes remain supported, never first-hit attribution.
        if (!positioned && src.text.lastIndexOf(ref.quote) !== start)
          return null;
        const ev = {
          sourceId: src.id,
          title: src.title,
          hash: src.hash,
          start,
          end,
          quote: ref.quote,
        };
        try {
          if (!validate(ev)) return null;
        } catch {
          return null;
        }
        evidence.push(ev);
        citations.push(ev);
      }
      statements.push({
        requirementId: part.id,
        request: part.text,
        status: "answered",
        text: c.statement,
        evidence,
      });
    }
  }
  if (!current()) return null;
  const audit = await gemini.documentAudit(requestPlan, plan, statements, {
    ip,
    documents,
    independentPlan,
  });
  // Model audit is fallible. Fail closed on missing/partial judgments, preserve
  // this limitation in evaluation; do not call it a mathematical proof.
  if (
    !validateDocumentAudit(audit, {
      requestPlan,
      statements,
      independentPlan,
    }) ||
    !current()
  )
    return null;
  return {
    text: plan.requirements
      .map((r) => {
        const answer = statements
          .filter((s) => s.requirementId === r.id)
          .map((s) => s.text)
          .join(" ");
        return r.status === "answered" ? answer : `${r.text.trim()} ${answer}`;
      })
      .join("\n\n"),
    verdict: citations.length
      ? plan.requirements.every((r) => r.status === "answered")
        ? "DOCUMENT_ANSWER"
        : "PARTIAL_DOCUMENT"
      : plan.requirements.some((r) => r.status === "clarify")
        ? "CLARIFY"
        : "UNKNOWN",
    requestPlan,
    coverageEstablished: requestPlan.coverageEstablished,
    outcomes: plan.requirements.map((r) => ({
      requirementId: r.id,
      status: r.status,
    })),
    citations,
    field: null,
    origin: "document-model-audited",
    limitations: [
      "Model entailment audit is fallible; source verification is exact.",
    ],
  };
}

// Structural reconciliation does not certify meaning. It prevents one source
// read from silently discarding an alternative found by the other. Conflicting
// outcomes fail closed; contradictory affirmative claims remain visible to the
// final audit rather than being selected by majority or first-match order.
export function reconcileDocumentProposals(primary, independent) {
  if (
    primary.question !== independent.question ||
    primary.questionPlanKey !== independent.questionPlanKey ||
    primary.scopeKey !== independent.scopeKey ||
    primary.requirements.length !== independent.requirements.length
  )
    return null;
  const merged = structuredClone(primary);
  for (const r of merged.requirements) {
    const other = independent.requirements.find((x) => x.id === r.id);
    if (
      !other ||
      other.text !== r.text ||
      other.status !== r.status ||
      JSON.stringify(other.owners) !== JSON.stringify(r.owners)
    )
      return null;
    if (r.status !== "answered") continue;
    // Choose an existing, source-supported wording only when its evidence
    // contains all support used by the other read. This is source coverage,
    // not meaning equivalence: the final audit still judges every independent
    // claim against the selected wording and can reject it.
    const covers = (a, b) =>
      b.claims.every((claim) =>
        claim.evidence.every((ref) =>
          a.claims.some((candidate) =>
            candidate.evidence.some(
              (ev) =>
                ev.document === ref.document &&
                ev.sourceId === ref.sourceId &&
                typeof ev.quote === "string" &&
                typeof ref.quote === "string" &&
                ev.quote.includes(ref.quote),
            ),
          ),
        ),
      );
    if (covers(r, other)) continue;
    if (covers(other, r)) {
      r.claims = structuredClone(other.claims);
      continue;
    }
    const key = (claim) => JSON.stringify([claim.statement, claim.evidence]);
    const seen = new Set(r.claims.map(key));
    for (const claim of other.claims) {
      if (!seen.has(key(claim))) {
        r.claims.push(structuredClone(claim));
        seen.add(key(claim));
      }
    }
    if (r.claims.length > 12) return null;
  }
  return merged;
}
