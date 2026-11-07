// Bounded, local requested-relation lookup. Topic overlap cannot stand in for
// a requested actor/date, report cadence, or finance decision. No values are
// supplied by the query: only complete verbatim source assertions can answer.
type Kind = "requested-date" | "report-cadence" | "finance-decision";
type Source = { id: string; title: string; text: string; hash: string };
const date =
  /\b(?:\d{1,2}\s+(?:January|February|March|April|May|June|July|August|September|October|November|December)(?:\s+\d{4})?|\d{4}-\d{2}-\d{2})\b/i;
const cadence =
  /\b(?:daily|weekly|biweekly|fortnightly|monthly|quarterly|annually|every\s+\d+\s+(?:days?|weeks?|months?))\b/i;
const report = /\b(?:(?:progress|status)\s+)?report(?:s|ed|ing)?\b/i;
const finance = /\b(?:finance|financial|accountants?)\b/i;
const decision = /\b(?:approv(?:al|ed)|sign[- ]?off|signed off)\b/i;
const polar = /^\s*(?:is|are|was|were|has|have|had|did|does|do)\b/i;
const stop = new Set(
  "what which when how often frequency cadence is are was were has have had does do did the a an to of for by from in on with been be being it its this that our my their side s want wants wanted keep retain request requested asks ask client clients customer customers progress status report reports reported reporting deadline due date finance financial money commercial accountant accountants approval approved sign signed off sign-off signoff".split(
    " ",
  ),
);
function tokens(s: string): string[] {
  return s.toLowerCase().match(/[a-z0-9]+(?:[-_][a-z0-9]+)*/g) ?? [];
}
function request(q: string): Kind | null {
  // Multi-part, negative, temporal and instruction questions stay with the
  // established policies. This route does not resolve history or mutations.
  if (
    /\b(?:and|or|not|never|except|without|before|after|as of|why|who|when|mark|update|change)\b|n['’]t\b/i.test(
      q,
    )
  )
    return null;
  if (
    /\b(?:deadline|due date)\b/i.test(q) &&
    /\b(?:want|wants|keep|retain|request|requested|asks)\b/i.test(q) &&
    /\b(?:client|customer)\b/i.test(q)
  )
    return "requested-date";
  if (/\b(?:how often|frequency|cadence)\b/i.test(q) && report.test(q))
    return "report-cadence";
  if (
    polar.test(q) &&
    /\b(?:money|commercial|finance|financial|accountants?)\b/i.test(q) &&
    decision.test(q)
  )
    return "finance-decision";
  return null;
}
export function requestedFactSupport(question: string, sources: Source[]) {
  const kind = request(question);
  if (!kind) return null;
  // Unknown nouns/modifiers/names must bind literally in the assertion, not
  // in another document or a neighboring record. Never drop them as stopwords.
  const qualifiers = tokens(question).filter((t) => !stop.has(t));
  const actor = /\bcustomer\b/i.test(question)
    ? /\bcustomer\b/i
    : /\bclient\b/i;
  const candidates: Array<{
    source: Source;
    start: number;
    end: number;
    quote: string;
    priority: number;
    values: string[];
  }> = [];
  // Explicit cost bounds, independent of retrieval top-k and dense residency.
  // Over budget means no repair, never a partially scanned corpus verdict.
  if (
    sources.length > 16 ||
    sources.reduce((n, s) => n + s.text.length, 0) > 500_000
  )
    return { kind, spans: [], ambiguous: false };
  let overflow = false;
  for (const source of sources) {
    for (const line of source.text.matchAll(/[^\n]+/g)) {
      if (/^\s*(?:#|Author:|Type:|Date:)/i.test(line[0])) continue;
      // Preserve semicolon qualifiers ("confirmed; finance pending") and
      // conditions in the same sentence. Exact offsets survive list furniture.
      const text = line[0].replace(/^\s*(?:\d+\.\s+|[-*]\s+)?/, "");
      const base = line.index! + line[0].length - text.length;
      for (const m of text.matchAll(/[^.!?]+(?:[.!?]+(?=\s|$)|$)/g)) {
        const quote = m[0].trim();
        if (!quote) continue;
        const words = new Set(tokens(quote));
        if (qualifiers.some((t) => !words.has(t))) continue;
        // Questions, examples and hypothetical assertions are not decisions.
        if (
          /\?|\b(?:example|template|would|could|might|if|assuming)\b/i.test(
            quote,
          )
        )
          continue;
        let priority = 0;
        let values: string[] = [];
        if (kind === "requested-date") {
          if (!date.test(quote) || !/\b(?:deadline|due date)\b/i.test(quote))
            continue;
          // Actor must govern a request, not merely occur in a date sentence.
          const relation =
            /\b(client|customer)\s+(?:asks?\s+to|wants?\s+to|requests?)\s+(?:retain|keep)\b/i.exec(
              quote,
            );
          if (!relation || !actor.test(relation[1])) continue;
          const boundDate = new RegExp(
            `${date.source}\\s+(?:[a-z-]+\\s+){0,2}deadline|(?:deadline|due date)\\s*(?:(?:is|of|for)\\s+)?${date.source}`,
            "gi",
          );
          values = [...quote.matchAll(boundDate)].map((m) =>
            date.exec(m[0])![0].toLowerCase(),
          );
          if (!values.length) continue;
        } else if (kind === "report-cadence") {
          if (!report.test(quote) || !cadence.test(quote)) continue;
          // Frequency must modify reporting, not a meeting/billing cadence in
          // the same sentence. Keep the complete sentence, including status.
          const relation = new RegExp(
            `(?<before>${cadence.source})\\s+(?:progress\\s+|status\\s+)?report|report(?:s|ed|ing)?\\s+(?:is\\s+|occurs?\\s+)?(?<after>${cadence.source})`,
            "gi",
          );
          values = [...quote.matchAll(relation)].map((m) =>
            (m.groups!.before ?? m.groups!.after).toLowerCase(),
          );
          if (!values.length) continue;
          // Decision-bearing support leads a mere proposal; neither is turned
          // into an inferred CONFIRMED verdict by this extractive route.
          priority = /\b(?:confirmed|agreed|approved)\b/i.test(quote) ? 1 : 0;
        } else {
          if (!finance.test(quote) || !decision.test(quote)) continue;
          const party =
            /\b(client|customer|supplier|vendor|internal)\s+(?:finance|financial|accountants?)\b/i.exec(
              quote,
            )?.[1];
          if (
            /\b(?:client|customer)\b/i.test(question) &&
            party &&
            !actor.test(party)
          )
            continue;
          // Bind finance to its own approval/signoff. A draft fee, an unsigned
          // agreement, or a different party's approval is not finance signoff.
          const relation =
            /\b(?:finance|financial|accountants?)\s+(?:approval\s+(?:[^.;]{0,85})?\b(?:pending|outstanding|approved|granted|not recorded)|(?:(?:had|has|have|not|yet|already|formally)\s+)*(?:signed off|approved)\b)/i.exec(
              quote,
            );
          if (!relation) continue;
          if (
            /\b(?:money|commercial)\b/i.test(question) &&
            !/\b(?:fee|payment|commercial|terms|budget|schedule)\b/i.test(quote)
          )
            continue;
          values = [
            /\b(?:not|no|pending|outstanding)\b/i.test(relation[0])
              ? "not-established"
              : "recorded",
          ];
          if (
            /\b(?:propos\w*|draft|subject to|until|should|will|must)\b/i.test(
              quote,
            )
          )
            continue;
          priority = /\bapproval\b/i.test(quote) ? 1 : 0;
        }
        if (quote.length > 450 || quote.split(/\s+/).length > 55) {
          overflow = true;
          continue;
        }
        const start = base + m.index! + m[0].length - m[0].trimStart().length;
        candidates.push({
          source,
          start,
          end: start + quote.length,
          quote,
          priority,
          values,
        });
      }
    }
  }
  // Keep differing statements, including changed/conflicting support. Do not
  // use document recency as authority. Overflow refuses rather than truncates
  // contrary evidence or expands the ordinary retrieval top-k.
  const unique = [
    ...new Map(candidates.map((c) => [c.quote.toLowerCase(), c])).values(),
  ];
  unique.sort(
    (a, b) =>
      b.priority - a.priority ||
      a.source.title.localeCompare(b.source.title) ||
      a.start - b.start,
  );
  if (
    overflow ||
    unique.length > 3 ||
    unique.reduce((n, c) => n + c.quote.split(/\s+/).length, 0) > 110
  )
    return { kind, spans: [], ambiguous: false };
  const values = new Set(unique.flatMap((c) => c.values));
  return { kind, spans: unique, ambiguous: values.size > 1 };
}
