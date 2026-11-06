/** Exact, source-bound identifier lookup. Labels and values are never inferred
 * from unrelated numbers, document titles, adjacent records or instructions. */
type Source = { id: string; title: string; text: string; hash: string };
type Span = { start: number; end: number; text: string };
export type IdentifierRequest = {
  field: string;
  qualifiers: string[];
  subject: string;
  label: string;
};
export type IdentifierFact = {
  source: Source;
  start: number;
  end: number;
  value: string;
  spoken: string;
};
const fields =
  /\b(permit|licen[cs]e|certificate|reference|serial|part|registration|tracking|booking|reservation|account|policy|ticket|application)\s+(?:numbers?|codes?|ids?|identifiers?|no\.?)(?=\s|[?.!]|$)/i;
const qualifiers = new Set(
  "parking entry booking operating safety work building residence driving driver export import medical insurance purchase sales tax business vehicle customer annual temporary permanent".split(
    " ",
  ),
);
const stop = new Set(
  "what what's which is are the a an give me show tell provide list please".split(
    " ",
  ),
);
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const normalized = (s: string) =>
  s
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[’]/g, "'")
    .replace(/\s+/g, " ")
    .trim();
const canonical = (s: string) => s.toLowerCase().replace("licence", "license");
export function identifierRequest(question: string): IdentifierRequest | null {
  question = question.replace(/[’]/g, "'");
  if (
    !/^\s*(?:what(?:'s| is| are)|which(?: is| are)?|give(?: me)?|show(?: me)?|tell me|provide|list)\b/i.test(
      question,
    )
  )
    return null;
  const match = fields.exec(question);
  if (!match) return null;
  if (
    /\b(?:cost|price|fees?|status|approval|expiry|expiration|validity|format|length|checksum)\b/i.test(
      question.slice(0, match.index),
    )
  )
    return null;

  const tail = question
    .slice(match.index + match[0].length)
    .replace(/[?.!]+$/, "")
    .trim();
  if (tail && !/^for\s+(?:the\s+)?[\w '-]+$/i.test(tail)) return null;
  const words = question
    .slice(0, match.index)
    .trim()
    .split(/\s+/)
    .filter((w) => !stop.has(normalized(w)));
  const modifiers: string[] = [];
  while (words.length && qualifiers.has(normalized(words.at(-1)!)))
    modifiers.unshift(normalized(words.pop()!));
  const subject = [...words, tail.replace(/^for\s+(?:the\s+)?/i, "")]
    .filter(Boolean)
    .join(" ")
    .trim()
    .replace(/'s$/i, "");
  if (/\b(?:and|or|not|without)\b/i.test(subject)) return null;
  const field = canonical(match[1]);
  return {
    field,
    qualifiers: modifiers,
    subject,
    label: [...modifiers, field, "number"].join(" "),
  };
}
const cache = new WeakMap<
  Source,
  { text: string; lines: Span[]; clauses: Span[]; context: Span | null }
>();
function parts(source: Source) {
  const old = cache.get(source);
  if (old?.text === source.text) return old;
  const lines: Span[] = [],
    clauses: Span[] = [];
  let fence: { character: string; length: number } | null = null;
  for (const line of source.text.matchAll(/[^\n]+/g)) {
    const row = {
      start: line.index!,
      end: line.index! + line[0].length,
      text: line[0],
    };
    const marker = /^\s*(`{3,}|~{3,})(.*)$/.exec(row.text);
    if (marker) {
      if (!fence) fence = { character: marker[1][0], length: marker[1].length };
      else if (
        marker[1][0] === fence.character &&
        marker[1].length >= fence.length &&
        !marker[2].trim()
      )
        fence = null;
      lines.push({ ...row, text: "" });
      continue;
    }
    if (fence) continue;
    lines.push(row);
    let offset = 0;
    for (const piece of line[0].split(/(?<=[.!?;])\s+/)) {
      const at = line[0].indexOf(piece, offset);
      offset = at + piece.length;
      clauses.push({
        start: row.start + at,
        end: row.start + offset,
        text: piece,
      });
    }
  }
  const context =
    lines
      .slice(0, 12)
      .find((line) =>
        /^\s*(?:#{1,6}\s*)?(?:status\s*:\s*)?(?:draft\b|preliminary\b|proposed document\b|template\b|example\b|sample\b)/i.test(
          line.text,
        ),
      ) ?? null;
  const indexed = { text: source.text, lines, clauses, context };
  cache.set(source, indexed);
  return indexed;
}
function labelPattern(request: IdentifierRequest) {
  const noun =
    request.field === "license" ? "licen[cs]es?" : escape(request.field) + "s?";
  return (
    [...request.qualifiers.map(escape), noun].join("\\s+") +
    "(?:\\s+(?:numbers?|codes?|ids?|identifiers?|no\\.?))?"
  );
}
function valueOf(raw: string): string | null {
  const value = raw.trim().replace(/[.,;]+$/, "");
  if (
    /^(?:(?:is|has been)\s+)?(?:not (?:yet )?assigned|unassigned|not available|unknown|pending assignment|none)(?:[.!]|$)/i.test(
      value,
    )
  )
    return value;
  if (/\b(?:example|sample|placeholder|template|format)\b/i.test(value))
    return null;
  const first = /^["'`]?([^\s,"'`!?;]+)["'`]?/.exec(value)?.[1];
  if (!first || !/^[a-z0-9][a-z0-9._/-]*$/i.test(first) || !/\d/.test(first))
    return null;
  return first;
}
const subjectMatches = (request: IdentifierRequest, value: string) =>
  !request.subject || normalized(value) === normalized(request.subject);
/** Returns null for other question types; an empty/ambiguous result never
 * licenses a fallback to a different identifier field. */
export function lookupIdentifier(question: string, sources: Source[]) {
  const request = identifierRequest(question);
  if (!request) return null;
  const facts: IdentifierFact[] = [];
  let overflow = false;
  const add = (
    source: Source,
    span: Span,
    value: string,
    spoken = span.text,
  ) => {
    if (
      facts.some(
        (f) =>
          f.source === source &&
          f.start === span.start &&
          f.end === span.end &&
          f.value === value,
      )
    )
      return;
    const context = parts(source).context;
    if (context && context.start < span.start) {
      if (/\b(?:template|example|sample)\b/i.test(context.text)) return;
      spoken = `Source context: ${context.text.replace(/^\s*#+\s*/, "")}\n${spoken}`;
      span = {
        start: context.start,
        end: span.end,
        text: source.text.slice(context.start, span.end),
      };
    }
    if (span.end - span.start > 8192) {
      overflow = true;
      return;
    }
    if (facts.length >= 32) {
      overflow = true;
      return;
    }
    facts.push({ source, start: span.start, end: span.end, value, spoken });
  };
  const label = labelPattern(request),
    subject = escape(request.subject).replace(/\s+/g, "\\s+");
  const relation = "(?:is|was|remains|:|=)";
  const before = request.subject
    ? `\\b${subject}(?:'s)?\\s+(?:(?:device|session|project|unit)\\s+)?(?:(?:has|holds|uses)\\s+)?${label}`
    : `\\b${label}`;
  const after = request.subject
    ? `\\b${label}\\s+for\\s+(?:the\\s+)?${subject}`
    : before;
  const bindings = [...new Set([before, after])].map(
    (p) => new RegExp(`${p}\\s*(?:${relation}\\s*)?(.+)$`, "i"),
  );
  const headerLabel = new RegExp(`^${label}$`, "i");
  for (const source of sources) {
    const { lines, clauses } = parts(source);
    for (const clause of clauses) {
      if (
        /[?]/.test(clause.text) ||
        /\b(?:example|sample|placeholder|template|format)\b/i.test(
          clause.text,
        ) ||
        /^\s*(?:>|["'`]|please\b|print\b|assign\b|ensure\b|set\b)/i.test(
          clause.text,
        )
      )
        continue;
      for (const binding of bindings) {
        const match = binding.exec(clause.text);
        if (!match) continue;
        const value = valueOf(match[1]);
        if (value) add(source, clause, value);
      }
    }
    // Pipe-delimited tables: header selects the field column; entity cells
    // select the record. Adjacent columns and rows never supply the value.
    let table: {
      header: Span;
      field: number;
      entity: number;
      columns: number;
    } | null = null;
    const cells = (text: string) =>
      text
        .trim()
        .replace(/^\||\|$/g, "")
        .split("|")
        .map((x) => x.trim());
    for (const line of lines) {
      if (!line.text.includes("|")) {
        table = null;
        continue;
      }
      if (line.text.includes("\\|")) {
        if (table) overflow = true;
        table = null;
        continue;
      }
      const row = cells(line.text),
        matching = row.flatMap((c, i) => (headerLabel.test(c) ? [i] : [])),
        field = matching[0] ?? -1;
      if (matching.length > 1) {
        overflow = true;
        table = null;
        continue;
      }
      if (field >= 0) {
        table = {
          header: line,
          field,
          entity: row.findIndex((c) =>
            /^(?:entity|subject|session|project|name|device)$/i.test(c),
          ),
          columns: row.length,
        };
        continue;
      }
      if (!table || row.every((c) => /^:?-+:?$/.test(c))) continue;
      if (row.length !== table.columns) {
        if (!request.subject || row.some((c) => subjectMatches(request, c)))
          overflow = true;
        continue;
      }
      if (
        request.subject &&
        (table.entity < 0 || !subjectMatches(request, row[table.entity]))
      )
        continue;
      const value = valueOf(row[table.field]);
      if (!value) continue;
      const span = {
        start: table.header.start,
        end: line.end,
        text: source.text.slice(table.header.start, line.end),
      };
      const owner = table.entity >= 0 ? row[table.entity] : "";
      add(
        source,
        span,
        value,
        [owner, `${cells(table.header.text)[table.field]}: ${row[table.field]}`]
          .filter(Boolean)
          .join(" — "),
      );
    }
    // Explicit key/value records; a new entity or blank line closes scope.
    let record: { start: number; entity: string } | null = null,
      pending: Span | null = null;
    const recordField = new RegExp(`^\\s*${label}\\s*:\\s*(.*)$`, "i");
    let previousEnd = 0;
    for (const line of lines) {
      if (!line.text.trim()) {
        record = null;
        pending = null;
        previousEnd = line.end;
        continue;
      }
      if (source.text.slice(previousEnd, line.start).includes("\n\n")) {
        record = null;
        pending = null;
      }
      previousEnd = line.end;
      const owner =
        /^\s*(?:Entity|Subject|Session|Project|Name|Device)\s*:\s*(.+)$/i.exec(
          line.text,
        );
      if (owner) {
        record = { start: line.start, entity: owner[1].trim() };
        pending = null;
        continue;
      }
      if (!record || !subjectMatches(request, record.entity)) continue;
      const field = recordField.exec(line.text);
      if (field) {
        pending = field[1].trim() ? null : line;
        const value = valueOf(field[1]);
        if (value)
          add(
            source,
            {
              start: record.start,
              end: line.end,
              text: source.text.slice(record.start, line.end),
            },
            value,
            `${record.entity} — ${line.text.trim()}`,
          );
        continue;
      }
      if (pending) {
        const value = valueOf(line.text);
        if (value)
          add(
            source,
            {
              start: record.start,
              end: line.end,
              text: source.text.slice(record.start, line.end),
            },
            value,
            `${record.entity} — ${pending.text.trim()} ${line.text.trim()}`,
          );
        pending = null;
      }
    }
  }
  const values = new Set(facts.map((f) => f.value.trim()));
  return {
    request,
    facts,
    ambiguous: overflow || values.size > 1,
    supported: !overflow && values.size === 1,
  };
}
