// Deterministic spoken answer for questions OUTSIDE the claim graph's
// commercial fields (fee, payment, scope, sign-off). Without this, every
// other question about an uploaded document was spoken as "I don't see that
// in these documents" even when the engine had cited evidence.
//
// Rules (no generation, no paraphrase of facts):
//  - only for interrogatives; commands ("mark it approved") never get here;
//  - only from evidence the engine already validated (exact source spans);
//  - the spoken content is ONE verbatim sentence or table row, chosen by
//    lexical overlap with the question, plus a short source tail;
//  - table rows are read with their column headers, comparators spoken as
//    words ("<0.05" -> "less than 0.05") so a value cannot change meaning;
//  - too little overlap, or an over-long sentence -> null (caller abstains
//    or points to the screen).

const STOP = new Set(
  "a an the and or but if then so of in on at to for from by with as is are was were be been being do does did has have had will would can could should shall may might must what which who whom whose when where why how this that these those it its it's i me my we our you your they them their there here not no yes any all some much many more most about into over under than too very just also only please tell say said".split(
    " ",
  ),
);
const terms = (s) =>
  (s.toLowerCase().match(/[a-z0-9][a-z0-9.\-/%<>]*/g) ?? [])
    .map((t) => t.replace(/[.\-/]+$/, ""))
    .filter((t) => t && !STOP.has(t))
    .map(stem);
// Light, deterministic stemming so "approved" meets "approval" and "signing"
// meets "signed". Numbers and short words are left alone.
function stem(t) {
  if (t.length <= 4 || /\d/.test(t)) return t;
  t = t.replace(/(ies|es|s)$/, (m) => (m === "ies" ? "y" : ""));
  if (t.length > 6) t = t.replace(/(ations?|ation|ing|ed|al)$/, "");
  return t;
}

export const isQuestion = (q) =>
  /\?\s*$/.test(q) ||
  /^\s*(what|which|who|whom|whose|when|where|why|how|is|are|was|were|do|does|did|has|have|had|can|could|will|would|should|any)\b/i.test(
    q,
  );

function units(quote) {
  const out = [];
  const lines = quote.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (!t) continue;
    if (/^\|.*\|$/.test(t)) {
      const sep = /^\|\s*:?-{3,}/;
      // Header rows (followed by the separator) are labels, never answers.
      if (!sep.test(t) && !sep.test((lines[i + 1] ?? "").trim()))
        out.push({ text: t, row: true });
      continue;
    }
    if (/^#{1,6}\s/.test(t)) continue; // headings are labels, not answers
    for (const s of t.match(/[^.!?]+(?:[.!?]+(?=\s|$)|$)/g) ?? [t])
      if (s.trim()) out.push({ text: s.trim(), row: false });
  }
  return out;
}

export function mainClause(text) {
  return text.replace(
    /[,;]?\s*\b(?:provided(?: that)?|if|unless|as long as|assuming|subject to|on condition that|only when)\b[^.;]*/gi,
    "",
  );
}

const cellsOf = (row) =>
  row
    .replace(/^\||\|$/g, "")
    .split("|")
    .map((c) => c.trim());

// Find the markdown table header above a row inside the source text.
function headerFor(srcText, rowText) {
  const at = srcText.indexOf(rowText);
  if (at < 0) return null;
  const before = srcText.slice(0, at).split("\n");
  for (let i = before.length - 1; i >= 1; i--) {
    if (/^\|\s*:?-{3,}/.test(before[i].trim()))
      return cellsOf(before[i - 1].trim());
    if (!/^\|.*\|$/.test(before[i].trim()) && before[i].trim()) return null;
  }
  return null;
}

const speakValue = (v) =>
  v
    .replace(/^<\s*/, "less than ")
    .replace(/^>\s*/, "greater than ")
    .replace(/^≤\s*/, "at most ")
    .replace(/^≥\s*/, "at least ");

function speakRow(row, header) {
  const cells = cellsOf(row);
  if (!header || header.length !== cells.length)
    return cells.filter(Boolean).map(speakValue).join(", ");
  const [label, ...rest] = cells;
  const parts = rest
    .map((c, i) =>
      c ? `${header[i + 1].toLowerCase()} ${speakValue(c)}` : null,
    )
    .filter(Boolean);
  return `${label}: ${parts.join(", ")}`;
}

const shortTitle = (t) =>
  t
    .replace(/\.(pdf|docx|md|markdown|txt|png|jpe?g)$/i, "")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/**
 * @param {string} question
 * @param {{supported:boolean, refused:boolean, unresolved:boolean, evidence:any[]}} result engine result
 * @param {{sources: Array<{id:string,title:string,text:string}>}} bundle
 * @param {(ev:any)=>{pages?:number[]}|null} [locateEvidence]
 */
export function extractiveSpoken(
  question,
  result,
  bundle,
  locateEvidence = () => null,
) {
  if (!isQuestion(question)) return null;
  if (
    !result?.supported ||
    result.refused ||
    result.unresolved ||
    !result.evidence?.length
  )
    return null;
  const q = new Set(terms(question));
  if (!q.size) return null;
  let best = null;
  for (const ev of result.evidence) {
    for (const u of units(ev.quote)) {
      // Only the main clause asserts: "readiness is targeted for 22 November,
      // provided data access arrives on time" says nothing about whether data
      // access IS on time. Words inside a conditional clause do not count.
      const ut = new Set(terms(mainClause(u.text)));
      let score = 0;
      for (const t of q) if (ut.has(t)) score++;
      // A table row is "about" its first cell: naming it is the strong signal.
      if (u.row) {
        const label = terms(cellsOf(u.text)[0] ?? "");
        if (label.length && label.every((t) => q.has(t))) score += 1;
      }
      // Prefer units that carry a number/date when the question asks for one.
      if (
        /\b(how many|how much|when|what (date|time|value|level|result)|which day)\b/i.test(
          question,
        ) &&
        /\d/.test(u.text)
      )
        score += 0.5;
      if (!best || score > best.score) best = { score, unit: u, ev };
    }
  }
  if (!best || best.score < Math.max(1, Math.ceil(q.size * 0.4))) return null;
  const src = bundle.sources.find((s) => s.id === best.ev.sourceId);
  let body = best.unit.row
    ? speakRow(best.unit.text, src ? headerFor(src.text, best.unit.text) : null)
    : best.unit.text;
  body = body.replace(/\s+/g, " ").trim();
  const words = body.split(" ").length;
  const loc = locateEvidence(best.ev);
  const page = loc?.pages?.length === 1 ? `, page ${loc.pages[0]}` : "";
  const ocr = loc?.methods?.includes("ocr")
    ? " It was read from a scan, so please check the number on screen."
    : "";
  if (words > 60)
    return {
      spoken: `The closest passage is long, so it's on screen: ${shortTitle(best.ev.title)}${page}.`,
      verdict: "QUOTED",
      citations: [best.ev],
    };
  return {
    spoken: `${body.replace(/[.;:,]?$/, ".")} That's from ${shortTitle(best.ev.title)}${page}.${ocr}`,
    verdict: "QUOTED",
    citations: [best.ev],
  };
}
