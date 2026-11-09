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
  const first = sourceExactRequirements(
    question,
    await gemini.questionRequirements(question, { ip, pass: "proposal" }),
  );
  if (!first || !isCurrent()) return null;
  // Deliberately do not send the first proposal into the second call.
  const second = sourceExactRequirements(
    question,
    await gemini.questionRequirements(question, { ip, pass: "reconstruction" }),
  );
  if (
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
