// Model-reviewed question interpretation, not a deterministic language proof.
// The model cannot author a caller's request identity or declare itself complete.
// Two blind reconstructions must partition the unchanged question identically;
// every non-whitespace character stays in a requirement. The full original
// remains available to the document reader and separate answer audit.
import { createDecomposition } from "../question-decomposition.mjs";

export function sourceExactRequirements(question, proposal) {
  if (
    proposal?.question !== question ||
    !Array.isArray(proposal.requirements) ||
    !proposal.requirements.length ||
    proposal.requirements.length > 16
  )
    return null;
  const segments = [];
  let cursor = 0;
  for (const item of proposal.requirements) {
    if (typeof item !== "string" || !item.trim()) return null;
    const text = item.trim();
    const start = cursor;
    while (/\s/u.test(question[cursor] ?? "") && cursor < question.length)
      cursor++;
    if (!question.startsWith(text, cursor)) return null;
    cursor += text.length;
    segments.push({ kind: "requirement", start, end: cursor });
  }
  if (question.slice(cursor).trim()) return null;
  segments[segments.length - 1].end = question.length;
  return segments;
}

export async function understandDocumentQuestion({
  question,
  gemini,
  ip,
  isCurrent = () => true,
}) {
  if (!gemini?.questionRequirements || !isCurrent()) return null;
  // Two blind reconstructions. Neither sees the other, so they overlap (one
  // round trip, not two); both must still partition the unchanged question
  // identically. Currency is rechecked between the launches so a second
  // provider call never starts after the source has been invalidated; a
  // change that lands while both calls are in flight is caught by the
  // post-await check below.
  const proposalP = gemini.questionRequirements(question, {
    ip,
    pass: "proposal",
  });
  if (!isCurrent()) {
    proposalP.catch(() => {});
    return null;
  }
  const reconstructionP = gemini.questionRequirements(question, {
    ip,
    pass: "reconstruction",
  });
  const [proposal, reconstruction] = await Promise.all([
    proposalP,
    reconstructionP,
  ]);
  const first = sourceExactRequirements(question, proposal);
  const second = sourceExactRequirements(question, reconstruction);
  if (
    !first ||
    !second ||
    !isCurrent() ||
    JSON.stringify(first) !== JSON.stringify(second)
  )
    return null;
  return createDecomposition({
    question,
    segments: first,
    provenance: "source-exact-blind-model-reconstruction-v1",
  });
}
