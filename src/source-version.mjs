// Negative compatibility check only. This never establishes a current value
// or resolves an amendment chain. Explicitly historical wording cannot alone
// answer an explicitly current/latest request by lexical sentence selection.
export function historicalOnlyForCurrentRequest(question, text) {
  if (!/\b(current|currently|latest|now|today)\b/i.test(question)) return false;
  // A sentence explicitly contrasting the old and current states is not
  // historical-only. Its correctness still needs the caller's evidence gate.
  if (/\b(current|currently|latest|now|today)\b/i.test(text)) return false;
  return /\b(original|originally|previous|previously|earlier|formerly|superseded|obsolete|historical|replaced)\b/i.test(
    text,
  );
}

// The immutable version of a document scope: a digest of what the bundle
// holds (scope, and each source's id, hash and title). Two bundles with the
// same digest hold the same documents; any upload, removal or re-reading
// changes it. Answers, plans and conversation state carry this value so a
// consumer can tell which documents an answer was made against.
import { createHash } from "node:crypto";
export function sourceVersionOf(bundle) {
  if (!bundle || typeof bundle !== "object") return null;
  // Recomputed on every call: a workspace bundle can gain or lose a source
  // in place, and a memoised digest would then name the wrong documents.
  return createHash("sha256")
    .update(
      JSON.stringify([
        bundle.scope ?? null,
        ...(bundle.sources ?? []).map((s) => [
          s.id ?? null,
          s.hash ?? null,
          s.title ?? null,
          typeof s.text === "string" ? s.text.length : null,
        ]),
      ]),
    )
    .digest("hex")
    .slice(0, 16);
}
