// Bounded whole-context reading with a separate relevance/entailment audit.
// Opt-in rollout only. A cited claim is not accepted merely for its numbers.
import { validateEvidence } from "../../dist/engine.mjs";
export const DOCUMENT_CONTEXT_LIMIT = 90000;
export async function readDocumentQuestion({
  question,
  bundle,
  gemini,
  consent,
  ip,
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
    title: s.title,
    text: s.text,
  }));
  const plan = await gemini.documentRead(question, documents, { ip });
  if (
    !plan ||
    plan.question !== question ||
    !Array.isArray(plan.parts) ||
    !plan.parts.length ||
    plan.parts.length > 12
  )
    return null;
  const statements = [],
    citations = [];
  for (const part of plan.parts) {
    if (
      typeof part.request !== "string" ||
      !part.request.trim() ||
      !["answered", "not_established"].includes(part.status)
    )
      return null;
    if (part.status === "not_established") {
      if ((part.claims ?? []).length) return null;
      statements.push({
        request: part.request,
        status: part.status,
        text: String(
          part.reason ?? "The supplied documents do not establish this part.",
        ),
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
        if (!src || typeof ref.quote !== "string" || ref.quote.length < 8)
          return null;
        const start = src.text.indexOf(ref.quote);
        // Repeated quotations require a more specific quote, never first-hit attribution.
        if (start < 0 || src.text.lastIndexOf(ref.quote) !== start) return null;
        const ev = {
          sourceId: src.id,
          title: src.title,
          hash: src.hash,
          start,
          end: start + ref.quote.length,
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
        request: part.request,
        status: "answered",
        text: c.statement,
        evidence,
      });
    }
  }
  const audit = await gemini.documentAudit(question, plan, statements, {
    ip,
    documents,
  });
  // Model audit is fallible. Fail closed on missing/partial judgments, preserve
  // this limitation in evaluation; do not call it a mathematical proof.
  if (
    audit?.question !== question ||
    audit.complete !== true ||
    audit.relevant !== true ||
    audit.supported !== true ||
    !Array.isArray(audit.items) ||
    audit.items.length !== statements.length ||
    audit.items.some((v, i) => v.index !== i || v.accept !== true)
  )
    return null;
  return {
    text: statements.map((s) => `${s.request}: ${s.text}`).join("\n\n"),
    verdict: citations.length ? "DOCUMENT_ANSWER" : "NOT_IN_DOCUMENTS",
    citations,
    field: null,
    origin: "document-model-audited",
    limitations: [
      "Model entailment audit is fallible; source verification is exact.",
    ],
  };
}
