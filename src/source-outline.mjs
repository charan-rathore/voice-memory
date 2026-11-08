// Exact source headings as a reading aid, never a generated summary or proof
// of full-source coverage. No contract-specific probes and no model calls.
export function sourceOutline(bundle, validate) {
  const headings = [],
    citations = [];
  for (const source of bundle.sources ?? []) {
    let offset = 0;
    for (const line of source.text.split("\n")) {
      const start = offset;
      offset += line.length + 1;
      // Only explicitly marked Markdown headings, not guessed capitalized prose.
      const m = /^#{1,6}\s+(.+?)\s*$/.exec(line);
      if (!m || line.length > 240) continue;
      const ev = {
        sourceId: source.id,
        title: source.title,
        hash: source.hash,
        start,
        end: start + line.length,
        quote: line,
      };
      try {
        if (!validate(ev)) continue;
      } catch {
        continue;
      }
      headings.push({ sourceTitle: source.title, heading: m[1], citation: ev });
      citations.push(ev);
      if (headings.length >= 12) break;
    }
    if (headings.length >= 12) break;
  }
  if (!headings.length) return null;
  return {
    text:
      "I have not established a complete summary. These are printed source headings you can use to choose what to inspect:\n" +
      headings
        .map((x, i) => `${i + 1}. ${x.sourceTitle}: ${x.heading}`)
        .join("; "),
    verdict: "SOURCE_OUTLINE",
    field: null,
    citations,
    origin: "source-heading-outline",
    limitations: [
      "Printed headings only, not a summary or a complete inventory of source facts.",
    ],
  };
}
