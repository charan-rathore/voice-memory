import { createHash } from "node:crypto";

// Structural links only: sections and passages share the retrieval engine's
// canonical source and anchors. Containment/sequence never assert causality.
export function documentGraph(
  bundle,
  { maxChunks = 240, maxSections = 120 } = {},
) {
  const nodes = new Map();
  const edges = [];
  let shown = 0,
    sectionsShown = 0,
    anchored = 0;
  const link = (from, to, kind) =>
    edges.push({ id: `${from}->${to}:${kind}`, from, to, kind });
  for (const source of bundle.sources) {
    const documentId = `doc:${source.id}`;
    nodes.set(documentId, {
      id: documentId,
      kind: "document",
      label: source.title,
    });
    const headings = [...source.text.matchAll(/^ {0,3}#{1,6}[ \t]+(.+)$/gm)];
    const boundaries = [{ start: 0, label: source.title }];
    for (const h of headings) {
      if (h.index === 0) boundaries[0].label = h[1].trim();
      else boundaries.push({ start: h.index, label: h[1].trim() });
    }
    const sections = boundaries.map((b, i) => ({
      ...b,
      end: boundaries[i + 1]?.start ?? source.text.length,
      id: `section:${source.id}:${b.start}`,
    }));
    let previous = null;
    for (const row of bundle.rows.filter(
      (r) => r.chunk.document_id === source.id,
    )) {
      const anchor = bundle.anchors.get(row.chunk.id);
      if (
        !anchor ||
        anchor.start < 0 ||
        anchor.end > source.text.length ||
        anchor.end <= anchor.start
      )
        continue;
      anchored++;
      if (shown >= maxChunks) continue;
      shown++;
      const id = `chunk:${row.chunk.id}`;
      const quote = source.text.slice(anchor.start, anchor.end);
      nodes.set(id, {
        id,
        kind: "chunk",
        label: row.chunk.heading || `Passage ${row.chunk.ordinal + 1}`,
        ordinal: row.chunk.ordinal,
        provisional: !!source.provisional,
        evidence: { sourceId: source.id, ...anchor, quote, hash: source.hash },
      });
      link(documentId, id, "contains passage");
      for (const section of sections) {
        if (anchor.start >= section.end || anchor.end <= section.start)
          continue;
        if (!nodes.has(section.id)) {
          if (sectionsShown >= maxSections) continue;
          sectionsShown++;
          nodes.set(section.id, {
            id: section.id,
            kind: "section",
            label: section.label,
            sourceId: source.id,
            start: section.start,
            end: section.end,
          });
          link(documentId, section.id, "contains section");
        }
        link(section.id, id, "overlaps passage");
      }
      if (previous) link(previous, id, "next in document");
      previous = id;
    }
  }
  return {
    generation: createHash("sha256")
      .update(
        JSON.stringify(
          bundle.sources.map((s) => [s.id, s.hash, s.provisional ?? false]),
        ),
      )
      .digest("hex"),
    nodes: [...nodes.values()],
    edges,
    coverage: {
      anchoredChunks: anchored,
      shownChunks: shown,
      omittedChunks: anchored - shown,
      shownSections: sectionsShown,
      limited: anchored > shown || sectionsShown >= maxSections,
    },
  };
}
