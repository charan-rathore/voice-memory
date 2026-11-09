// Lossless caller-owned decomposition contract, NOT a language parser.
// Only server-owned upstream resolvers can supply segments. Model proposals
// alone and request-body fields are not trusted decomposition authority.
// The optional production interpreter separately reconstructs and source-checks
// two blind proposals before this contract derives caller-span IDs.
import { createHash } from "node:crypto";
const hash = (x) =>
  createHash("sha256").update(JSON.stringify(x)).digest("hex");
const freeze = (x) => {
  if (x && typeof x === "object") {
    Object.values(x).forEach(freeze);
    Object.freeze(x);
  }
  return x;
};
export function createDecomposition({
  question,
  segments = null,
  provenance = "opaque-lossless",
}) {
  if (typeof question !== "string" || !question.trim())
    throw Error("An original question is required.");
  if (!segments) {
    segments = [
      {
        kind: "unresolved",
        start: 0,
        end: question.length,
        reason: "decomposition_not_qualified",
      },
    ];
    provenance = "opaque-lossless";
  }
  if (!Array.isArray(segments))
    throw Error("Decomposition segments are required.");
  let cursor = 0;
  const requirements = [],
    unresolved = [],
    rawSpans = [];
  for (const segment of segments) {
    const { kind, start, end } = segment;
    if (
      !Number.isInteger(start) ||
      !Number.isInteger(end) ||
      start !== cursor ||
      end <= start ||
      end > question.length
    )
      throw Error(
        "Decomposition spans must cover the original in contiguous order.",
      );
    const raw = question.slice(start, end);
    const value = { kind, start, end, raw };
    rawSpans.push(value);
    if (kind === "requirement")
      requirements.push({
        id: `r-${hash([question, start, end]).slice(0, 16)}`,
        text: raw,
        owners: [],
        start,
        end,
      });
    else if (kind === "unresolved")
      unresolved.push({
        ...value,
        reason: segment.reason ?? "unresolved_interpretation",
      });
    else if (kind !== "glue")
      throw Error("Unknown decomposition segment kind.");
    cursor = end;
  }
  if (cursor !== question.length)
    throw Error("Decomposition lost part of the original question.");
  const complete =
    provenance !== "opaque-lossless" &&
    !unresolved.length &&
    !!requirements.length;
  const value = {
    version: 1,
    originalQuestion: question,
    provenance,
    requirements,
    unresolved,
    rawSpans,
    coverageEstablished: complete,
    state: complete ? "complete" : requirements.length ? "partial" : "opaque",
  };
  return freeze({ ...value, key: hash(value) });
}
export function createDocumentQuestionPlan({ decomposition, scope }) {
  if (!scope?.key || !Number.isInteger(scope.generation))
    throw Error("A source-bound document scope is required.");
  const value = {
    version: 1,
    originalQuestion: decomposition.originalQuestion,
    scopeKey: scope.key,
    sourceGeneration: scope.generation,
    requirements: decomposition.requirements.map((r) => ({
      ...r,
      owners: [...r.owners],
    })),
    rawSpans: decomposition.rawSpans,
    coverageEstablished: decomposition.coverageEstablished,
    decompositionState: decomposition.state,
    unresolved: decomposition.unresolved,
  };
  return freeze({
    ...value,
    key: hash([scope.key, scope.generation, decomposition.key, value]),
  });
}
