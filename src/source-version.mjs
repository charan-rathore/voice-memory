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
