import { createHash } from "node:crypto";

// Bump when projection rules change so already-open clients rebuild even
// when canonical source text is unchanged.
const PROJECTION_VERSION = "document-graph/2";

const displayLabel = (value) => {
  const text = String(value);
  return text.length > 160 ? text.slice(0, 157) + "…" : text;
};

function sectionBoundaries(source) {
  const boundaries = [{ start: 0, label: displayLabel(source.title) }];
  let fence = null,
    offset = 0;
  for (const line of source.text.split("\n")) {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      if (
        marker &&
        marker[1][0] === fence.character &&
        marker[1].length >= fence.length &&
        !marker[2].trim()
      )
        fence = null;
    } else if (marker && !(marker[1][0] === "`" && marker[2].includes("`"))) {
      fence = { character: marker[1][0], length: marker[1].length };
    } else {
      const heading = /^ {0,3}#{1,6}[ \t]+(.+)$/.exec(line);
      const label = heading?.[1].replace(/[ \t]+#+[ \t]*$/, "").trim();
      if (label) {
        if (offset === 0) boundaries[0].label = displayLabel(label);
        else boundaries.push({ start: offset, label: displayLabel(label) });
      }
    }
    offset += line.length + 1;
  }
  return boundaries;
}

// Structural links only: sections and passages share the retrieval engine's
// canonical source and anchors. Containment/sequence never assert causality.
export function documentGraph(
  bundle,
  { maxChunks = 240, maxSections = 120 } = {},
) {
  const nodes = new Map();
  const edges = [];
  const omittedSections = new Set();
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
      label: displayLabel(source.title),
    });
    const boundaries = sectionBoundaries(source);
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
      const enclosing = sections.find(
        (section) =>
          anchor.start >= section.start && anchor.start < section.end,
      );
      nodes.set(id, {
        id,
        kind: "chunk",
        label: enclosing
          ? `${enclosing.label} · passage ${row.chunk.ordinal + 1}`
          : `Passage ${row.chunk.ordinal + 1}`,
        ordinal: row.chunk.ordinal,
        provisional: !!source.provisional,
        evidence: { sourceId: source.id, ...anchor, quote, hash: source.hash },
      });
      link(documentId, id, "contains passage");
      for (const section of sections) {
        if (anchor.start >= section.end || anchor.end <= section.start)
          continue;
        if (!nodes.has(section.id)) {
          if (sectionsShown >= maxSections) {
            omittedSections.add(section.id);
            continue;
          }
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
        JSON.stringify([
          PROJECTION_VERSION,
          maxChunks,
          maxSections,
          bundle.sources.map((s) => [s.id, s.hash, s.provisional ?? false]),
        ]),
      )
      .digest("hex"),
    nodes: [...nodes.values()],
    edges,
    coverage: {
      anchoredChunks: anchored,
      shownChunks: shown,
      omittedChunks: anchored - shown,
      shownSections: sectionsShown,
      omittedSections: omittedSections.size,
      limited: anchored > shown || omittedSections.size > 0,
    },
  };
}
