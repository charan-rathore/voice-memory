// Requested-field support for extractive fallback answers. A topical exact
// quote is not enough to label an absent role, identifier type or quantity
// supported. This does not derive record ownership or promote inference.
type Field =
  | "receiver"
  | "tracking"
  | "weight"
  | "dispatched"
  | "units"
  | "items"
  | "packages"
  | "cartons";
function requested(question: string): Field | null {
  if (/\b(?:tracking|carrier\s+(?:reference|number|code))\b/i.test(question))
    return "tracking";
  if (
    /\b(?:who\b[^?]*(?:receiv\w*|recipient|delivered to)|recipient|receiver)\b/i.test(
      question,
    )
  )
    return "receiver";
  if (/\b(?:weight|how heavy)\b/i.test(question)) return "weight";
  if (/\bdispatched\s+quantity\b/i.test(question)) return "dispatched";
  const m = /\b(units|items|packages|cartons)\b/i.exec(question);
  return m ? (m[1].toLowerCase() as Field) : null;
}
// A single-field matcher cannot certify a coordinated whole request. This
// does not parse conjunctions into requirements or decide whether coordination
// belongs to a name. Preserve that uncertainty instead of dropping its tail.
export function requestedCoverage(
  question: string,
): "not_applicable" | "single_field_only" | "coordination_unresolved" {
  if (requested(question) === null) return "not_applicable";
  return /\b(?:and|or|also|plus)\b|[;&]/i.test(question)
    ? "coordination_unresolved"
    : "single_field_only";
}
const absent =
  /^(?:not\b|no\b|none\b|unknown\b|unassigned\b|pending\b|tbd\b|n\/?a\b|unavailable\b|not recorded\b)/i;
const labels: Record<Field, RegExp> = {
  receiver:
    /\b(?:receiver|recipient|received by|delivered to|signed for by)\s*(?::|=|-)?\s+(.+)$/i,
  tracking:
    /\b(?:tracking\s*(?:number|no\.?|code|id|reference)?|carrier\s+(?:reference|number|code))\s*(?::|=|-)?\s+(.+)$/i,
  weight:
    /\b(?:(?:shipment|shipping|parcel|package)\s+)?weight\s*(?::|=|-)?\s+(.+)$/i,
  dispatched:
    /\b(?:dispatched\s+quantity|quantity\s+dispatched)\s*(?::|=|-)?\s+(.+)$/i,
  units: /\bunits\s*(?::|=|-)?\s+(.+)$/i,
  items: /\bitems\s*(?::|=|-)?\s+(.+)$/i,
  packages: /\bpackages\s*(?::|=|-)?\s+(.+)$/i,
  cartons: /\bcartons\s*(?::|=|-)?\s+(.+)$/i,
};
function supported(field: Field, quote: string, question: string): boolean {
  for (const clause of quote.split(/[;\n]/)) {
    if (field === "tracking") {
      const carrierAsk = /\bcarrier\s+(?:reference|number|code)\b/i.test(
        question,
      );
      if (
        carrierAsk &&
        !/\bcarrier\s+(?:reference|number|code)\b/i.test(clause)
      )
        continue;
      if (!carrierAsk && !/\btracking\b/i.test(clause)) continue;
    }
    const match = labels[field].exec(clause.trim());
    const modifiers =
      field === "weight"
        ? (question.match(/\b(?:gross|net)\b/gi) ?? [])
        : !["receiver", "tracking", "weight"].includes(field)
          ? (question.match(
              /\b(?:open|closed|approved|dispatched|delivered|pending|overdue|received)\b/gi,
            ) ?? [])
          : [];
    if (modifiers.some((m) => !new RegExp(`\\b${m}\\b`, "i").test(clause)))
      continue;
    if (
      match &&
      !/\b(?:not|no|never|without|invalid|cancelled|unverified)\b/i.test(
        clause.slice(0, match.index),
      )
    ) {
      const value = match[1].trim();
      if (!value) continue;
      if (
        /^(?:not recorded|not specified|not assigned|none recorded|not available)[.!]?$/i.test(
          value,
        )
      )
        return true;
      if (absent.test(value)) continue;
      if (
        field === "receiver" &&
        /^[A-Za-z][A-Za-z ,.'-]{1,80}[.!]?$/i.test(value) &&
        !/\b(?:not|no|never|unknown|pending|unassigned|ready|manager|coordinator|sender|shipper|remains|confirmed|appointed|awaiting|cancelled|invalid|unverified|was|is|would|should|could|must|be|been)\b/i.test(
          value,
        )
      )
        if (!/\bwill\s+(?:be|receive|act|serve|become)\b/i.test(value))
          return true;
      if (
        field === "tracking" &&
        /^(?:[A-Za-z0-9][A-Za-z0-9_-]*\d[A-Za-z0-9_-]*|\d{3,})[.!]?$/i.test(
          value,
        )
      )
        return true;
      if (
        field === "weight" &&
        /^\d+(?:\.\d+)?\s*(?:kg|g|lb|lbs|oz|kilograms?|grams?|pounds?)\b[.!]?$/i.test(
          value,
        )
      ) {
        const asked =
          /\b(?:in|as)\s+(kg|g|lb|lbs|oz|kilograms?|grams?|pounds?)\b/i
            .exec(question)?.[1]
            ?.toLowerCase();
        const printed = /\b(kg|g|lb|lbs|oz|kilograms?|grams?|pounds?)\b/i
          .exec(value)?.[1]
          ?.toLowerCase();
        const norm = (u: string) =>
          ({
            kilogram: "kg",
            kilograms: "kg",
            gram: "g",
            grams: "g",
            pound: "lb",
            pounds: "lb",
            lbs: "lb",
          })[u] ?? u;
        if (!asked || (printed && norm(asked) === norm(printed))) return true;
      }
      if (
        !["receiver", "tracking", "weight"].includes(field) &&
        /^\d+(?:\.\d+)?(?:\s+(?:units?|items?|packages?|cartons?))?[.!]?$/i.test(
          value,
        )
      )
        return true;
    }
    // A single clause with multiple counts of the requested kind does not
    // establish which value belongs to the requested modifier. Keep it for
    // review instead of speaking both numbers as the requested answer.
    if (
      !["receiver", "tracking", "weight", "dispatched"].includes(field) &&
      [
        ...clause.matchAll(
          new RegExp(
            `\\b\\d+(?:\\.\\d+)?\\s+(?:[a-z-]+\\s+){0,2}${field}\\b`,
            "gi",
          ),
        ),
      ].length > 1
    )
      continue;
    // Natural count and delivery constructions preserve explicit label/value
    // relations without treating an unrelated internal reference as the value.
    if (
      !["receiver", "tracking", "weight", "dispatched"].includes(field) &&
      new RegExp(
        `\\b\\d+(?:\\.\\d+)?\\s+(?:[a-z-]+\\s+){0,2}${field}\\b`,
        "i",
      ).test(clause) &&
      !/\b(?:not|no|without)\b/i.test(clause)
    )
      return true;
  }
  return false;
}
const recordRoot =
  /\b(?:order|parcel|shipment|record)\s+(?:id\s*:?\s*)?([A-Z][A-Z0-9]*[-_]\d[A-Z0-9_-]*)/gi;
export function explicitRequestedRoots(text: string): string[] {
  return [...text.matchAll(recordRoot)].map((m) => m[1]);
}
// Only the explicit textual-record namespace opts into this route. Other
// identifier requests retain the existing qualified subject/field resolver.
export function explicitRecordRequest(
  question: string,
  sources: Array<{ text: string }>,
): boolean {
  if (requested(question) === null) return false;
  const roots = sources.flatMap((source) =>
    explicitRequestedRoots(source.text),
  );
  return roots.some((root) => {
    const prefix = root.split(/[-_]/)[0];
    return new RegExp(
      `(?:^|[^A-Za-z0-9_])${prefix}(?:[-_]|\\s+(?:dash\\s+)?)\\d[A-Za-z0-9_-]*(?:$|[^A-Za-z0-9_-])`,
      "i",
    ).test(question);
  });
}
// Exact half-open offsets into a supplied quote. Never collapse disjoint
// record blocks or fields into a minimum/maximum enclosing interval.
export function requestedSupportSpans(
  question: string,
  quote: string,
  rootUniverse?: string[],
): Array<{ start: number; end: number }> | null {
  const field = requested(question);
  if (field === null) return null;
  if (requestedCoverage(question) === "coordination_unresolved") return [];
  // A positive labelled fact cannot establish an excluded or negated role.
  // Negative relations are not inferred by this narrow extractive fallback.
  if (/\b(?:not|never|neither|without|except)\b|n['’]t\b/i.test(question))
    return [];
  const ids =
    question.match(
      /\b[A-Z][A-Z0-9]*(?:[-_]|\s+(?:dash\s+)?)\d[A-Z0-9_-]*\b/gi,
    ) ?? [];
  const idKey = (id: string) =>
    id
      .toLowerCase()
      .replace(/\s+dash\s+/g, "-")
      .replace(/[-_\s]+/g, "");
  // Only explicit textual root labels create blocks. This is not a resolver
  // for arbitrary layouts, namespaces, implicit records or physical ownership.
  const starts = [...quote.matchAll(recordRoot)];
  const universe = rootUniverse ?? starts.map((m) => m[1]);
  const resolved: string[] = [];
  for (const id of ids) {
    // Printed separators are identity. Only normalized space/dash speech
    // aliases may use separator-insensitive matching, and only if unique
    // among all printed roots in the bundle, not just this retrieved quote.
    if (/[-_]/.test(id)) {
      resolved.push(id);
      continue;
    }
    const aliases = [
      ...new Set(
        universe
          .filter((root) => idKey(root) === idKey(id))
          .map((root) => root.toLowerCase()),
      ),
    ];
    // Ordinary prose such as "unit 27" is not an identifier merely because
    // it is a word followed by digits. A normalized alias requires a known
    // printed root namespace. Unknown values within that namespace refuse.
    const prefix = id.replace(/\s+(?:dash\s+)?\d.*$/i, "").toLowerCase();
    if (
      !universe.some((root) => root.split(/[-_]/)[0].toLowerCase() === prefix)
    )
      continue;
    if (aliases.length !== 1) return [];
    resolved.push(aliases[0]);
  }
  let scopes: Array<{ start: number; end: number }> = [];
  if (!resolved.length) scopes = [{ start: 0, end: quote.length }];
  else if (starts.length)
    scopes = starts.flatMap((m, i) =>
      resolved.some((id) => id.toLowerCase() === m[1].toLowerCase())
        ? [{ start: m.index!, end: starts[i + 1]?.index ?? quote.length }]
        : [],
    );
  else if (
    resolved.every((id) =>
      new RegExp(
        `(?:^|[^A-Za-z0-9_-])${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:$|[^A-Za-z0-9_-])`,
        "i",
      ).test(quote),
    )
  )
    scopes = [{ start: 0, end: quote.length }];
  const out: Array<{ start: number; end: number }> = [];
  for (const scope of scopes) {
    const text = quote.slice(scope.start, scope.end);
    for (const part of text.matchAll(/[^;\n]+/g)) {
      const leading = part[0].length - part[0].trimStart().length;
      const clause = part[0].trim();
      if (clause && supported(field, clause, question))
        out.push({
          start: scope.start + part.index! + leading,
          end: scope.start + part.index! + leading + clause.length,
        });
    }
  }
  return out;
}
export function missingRequestedSupport(
  question: string,
  quotes: string[],
  rootUniverse?: string[],
): boolean {
  if (requested(question) === null) return false;
  return !quotes.some(
    (q) => requestedSupportSpans(question, q, rootUniverse)?.length,
  );
}
