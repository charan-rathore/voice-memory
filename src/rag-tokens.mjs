// Plain-JS port of the index tokenizer in vendor/web/src/lib/rag/text.ts
// (stopwords, tokenize, stemToken, contentTokens): the exact terms the BM25
// index is built from. Used to show visitors the real numbers their document
// becomes. tests/index-digest.test.mjs checks it token-for-token against the
// TypeScript source, so the two cannot drift apart silently.
// Synced with IntelliRAG main (token-marks.test.ts there): a word starts
// with a letter or digit and keeps its combining marks (\p{M}), so Indic
// vowel signs and viramas stay inside the word. Before, "हीमोग्लोबिन"
// tokenized as single consonants.
const TOKEN_PATTERN = /[\p{L}\p{N}][\p{L}\p{N}\p{M}]*/gu;

export const QUERY_STOPWORDS = new Set([
  "the",
  "and",
  "for",
  "you",
  "with",
  "from",
  "that",
  "this",
  "what",
  "how",
  "why",
  "are",
  "was",
  "were",
  "into",
  "your",
  "a",
  "an",
  "of",
  "to",
  "in",
  "on",
  "or",
  "do",
  "does",
  "did",
  "is",
  "it",
  "as",
  "be",
  "by",
  "if",
  "not",
  "can",
  "should",
  "would",
  "could",
  "when",
  "which",
  "who",
  "whom",
  "been",
  "have",
  "has",
  "had",
  "will",
  "just",
  "about",
  "than",
  "then",
  "also",
  "only",
  "over",
  "after",
  "before",
  "between",
  "same",
  "each",
  "other",
  "more",
  "most",
  "such",
  "very",
  "right",
  "me",
  "my",
  "we",
  "our",
  "i",
  "explain",
  "describe",
  "tell",
  "show",
  "work",
  "works",
  "please",
  "thanks",
]);

/** Shared ops vocabulary that must not let unrelated runbooks ride into context. */

export function tokenize(text) {
  // NFC first: decomposed input ("München" as u + combining diaeresis, the
  // NFD form PDF extractors and macOS emit) otherwise splits at the mark and
  // a composed-form query never matches it. Same word, same tokens.
  // Pure-ASCII text cannot change under NFC (every combining mark is
  // non-ASCII), so the common case skips the normalization scan.
  const prepared = /[\u0080-\uFFFF]/.test(text) ? text.normalize("NFC") : text;
  return prepared.toLowerCase().match(TOKEN_PATTERN) ?? [];
}

export function stemToken(token) {
  if (token.length < 5) return token;
  if (token.endsWith("ing") && token.length > 6) return token.slice(0, -3);
  if (token.endsWith("ers") && token.length > 6) return token.slice(0, -1);
  if (token.endsWith("ies") && token.length > 5)
    return `${token.slice(0, -3)}y`;
  if (token.endsWith("es") && token.length > 5) return token.slice(0, -2);
  if (token.endsWith("ed") && token.length > 5) {
    const minusD = token.slice(0, -1);
    // cached → cache, expired → expire; stamped → stamp
    if (minusD.endsWith("e")) return minusD;
    return token.slice(0, -2);
  }
  if (token.endsWith("s") && !token.endsWith("ss") && token.length > 4)
    return token.slice(0, -1);
  return token;
}

export function contentTokens(text) {
  return tokenize(text)
    .filter((t) => t.length > 1 && !QUERY_STOPWORDS.has(t))
    .map(stemToken);
}
