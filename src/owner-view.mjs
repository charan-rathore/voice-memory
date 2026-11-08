// An owner view is a private derived index. Excluded text is blanked without
// moving offsets. Internal hashes describe that view, never the original.
// Before a citation leaves the view, rebind it to the original source and
// require both exact quote equality and a fully contained owner boundary.
import { importBundle, validateEvidence } from "../dist/engine.mjs";
import { subjectOf } from "../clinical/observations.mjs";
import { recordSubject } from "../clinical/answer.mjs";
const views = new WeakMap();
export function ownerView(original, owner) {
  if (!owner) return original;
  let cache = views.get(original);
  if (!cache) views.set(original, (cache = new Map()));
  if (cache.has(owner)) return cache.get(owner);
  const ranges = (original.sourceRecords ?? []).filter(
    (r) =>
      (r.meta?.patient?.id || r.meta?.patient?.name) &&
      subjectOf({ ...r, segment: r.span?.start }) === owner,
  );
  const docs = original.sources.map((s) => {
    const rs = ranges
      .filter((r) => r.sourceId === s.id)
      .map((r) => r.span)
      .sort((a, b) => a.start - b.start);
    let at = 0,
      text = "";
    for (const r of rs) {
      if (r.start < at) throw Error("Overlapping owner ranges");
      text +=
        s.text.slice(at, r.start).replace(/[^\r\n]/g, " ") +
        s.text.slice(r.start, r.end);
      at = r.end;
    }
    text += s.text.slice(at).replace(/[^\r\n]/g, " ");
    return { id: s.id, title: rs.length ? s.title : "Excluded record", text };
  });
  const indexed = importBundle(docs, { scope: original.scope });
  const idMap = new Map(
    indexed.sources.map((s, i) => [s.id, original.sources[i].id]),
  );
  const view = {
    ...original,
    ...indexed,
    sources: indexed.sources.map((s) => ({ ...s, id: idMap.get(s.id) })),
    rows: indexed.rows.map((r) => ({
      ...r,
      slug: idMap.get(r.slug),
      chunk: { ...r.chunk, document_id: idMap.get(r.chunk.document_id) },
    })),
    clinical: (original.clinical ?? []).filter((r) => subjectOf(r) === owner),
    sourceRecords: ranges,
    records: (original.records ?? []).map((e) => ({
      ...e,
      records: e.records.filter((r) => recordSubject(e, r) === owner),
    })),
    // Never let an original full-document locator perform fresh inference.
    locateEvidence: original.locateEvidence,
  };
  cache.set(owner, view);
  return view;
}
export function originalCitation(ev, original, view, allowed) {
  if (!ev || !allowed(ev)) return null;
  const source = original.sources.find((s) => s.id === ev.sourceId);
  const derived = view.sources.find((s) => s.id === ev.sourceId);
  if (
    !source ||
    !derived ||
    (ev.hash !== source.hash && ev.hash !== derived.hash)
  )
    return null;
  const rebound = { ...ev, hash: source.hash };
  try {
    return validateEvidence(rebound, original) ? rebound : null;
  } catch {
    return null;
  }
}
