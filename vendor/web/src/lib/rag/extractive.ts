import { QUERY_STOPWORDS, tokenize } from './text';
import type { RetrievedChunk } from './types';

/** Select source paragraphs, without inventing an answer when no model is configured. */
export function extractiveAnswer(question: string, chunks: RetrievedChunk[]): string {
  const terms = new Set(tokenize(question).filter(t => !QUERY_STOPWORDS.has(t)));
  const extracts = chunks.slice(0, 3).map((chunk, index) => {
    // PDF text often lands one visual line per blank-line-separated block, so a
    // wrapped sentence becomes several small "paragraphs". Keep the unfiltered
    // list: a selected passage that ends mid-sentence is extended with the
    // blocks that continue it (they are legitimately short on their own).
    const raw = chunk.text.split(/\n\s*\n/).map((text, order) => ({
      text: text.trim(), order,
      score: new Set(tokenize(text).filter(t => terms.has(t))).size,
    })).filter(p => p.text.length > 0 && !p.text.includes('```'));
    const paragraphs = raw.filter(p => p.text.length > 35);
    const selected = paragraphs.sort((a,b) => b.score-a.score || a.order-b.order).slice(0, 2).sort((a,b) => a.order-b.order);
    const taken = new Set(selected.map(s => s.order));
    for (const sel of selected) {
      while (!/[.!?\u201d\u2019:)'"\]]$/.test(sel.text)) {
        const nxt = raw.find(p => p.order === sel.order + 1 && !taken.has(p.order));
        if (!nxt || sel.text.length + nxt.text.length > 480) break;
        taken.add(nxt.order);
        sel.text = sel.text + ' ' + nxt.text;
        sel.order = nxt.order;
      }
    }
    // A PDF text layer can carry a wrapped line twice (once full-width, once
    // clipped); drop a passage whose opening already appears in another one.
    const kept = selected.filter((s, i) => !selected.some((o, j) => j !== i && o.text.includes(s.text.slice(0, 40))));
    if (kept.length) selected.length = 0, selected.push(...kept);
    const text = (selected.map(p => p.text).join('\n\n') || chunk.text).replace(/`/g, '').replace(/^#{1,6}\s+/gm, '').trim();
    const clipped = text.length > 700 ? `${text.slice(0, 700).replace(/\s+\S*$/, '')}…` : text;
    return `${clipped}\n[Source ${index + 1}]`;
  });
  return 'Relevant source excerpts\n\n' + extracts.join('\n\n') + '\n\nThese are retrieved passages, not a generated recommendation. Add a model in Settings to reason across them.';
}
