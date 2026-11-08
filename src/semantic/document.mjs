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
  const audit = await gemini.documentAudit(requestPlan, plan, statements, {
    ip,
    documents,
  });
  // Model audit is fallible. Fail closed on missing/partial judgments, preserve
  // this limitation in evaluation; do not call it a mathematical proof.
  if (!validateDocumentAudit(audit, { requestPlan, statements }) || !current())
    return null;
  return {
    text: statements.map((s) => `${s.request}: ${s.text}`).join("\n\n"),
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
