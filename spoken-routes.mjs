// Spoken routes that sit beside the claim graph. Each one answers a question
// shape the field renderer could not ("what's still open?", "what did the
// client ask in their email?", "is X on time?") and each one speaks only
// sentences that exist verbatim in a source, with an exact span the engine's
// validateEvidence() accepts. No route invents a value, a status or a reason.
import { validateEvidence } from "./dist/engine.mjs";

const MONTHS = [
  "January", "February", "March", "April", "May", "June", "July", "August",
  "September", "October", "November", "December",
];

/** Sentences of a source with exact offsets (numbered list markers kept out). */
export function sentencesOf(src) {
  const out = [];
  const text = src.text;
  let offset = 0;
  for (const line of text.split("\n")) {
    const lineStart = offset;
    offset += line.length + 1;
    if (!line.trim() || /^#|^(Author|Date):/i.test(line.trim())) continue;
    const body = line.replace(/^\s*\d+\.\s*/, "");
    const bodyStart = lineStart + (line.length - body.length);
    for (const m of body.matchAll(/[^.!?]+(?:[.!?]+(?=\s|$)|$)/g)) {
      const raw = m[0];
      const lead = raw.length - raw.trimStart().length;
      const s = raw.trim();
      if (!s) continue;
      const start = bodyStart + m.index + lead;
      out.push({ text: s, start, end: start + s.length });
    }
  }
  return out;
}

/** A validated citation for an exact sentence span. Throws if it is not. */
export function cite(src, sent) {
  const c = {
    sourceId: src.id,
    title: src.title,
    hash: src.hash,
    start: sent.start,
    end: sent.end,
    quote: src.text.slice(sent.start, sent.end),
    firstLine: src.text.slice(0, sent.start).split("\n").length,
    lastLine: src.text.slice(0, sent.end).split("\n").length,
    docDate: (src.text.match(/Date:\s*(\d{4}-\d{2}-\d{2})/) ?? [])[1] ?? null,
    status: "quoted",
  };
  validateEvidence(c, { sources: [src] });
  return c;
}

function speakDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || "");
  return m ? `${MONTHS[Number(m[2]) - 1]} ${Number(m[3])}` : "";
}

/** "05_Harbor_Email.md" -> "the harbor email from September 23". */
export function docLabelOf(src) {
  const base = src.title
    .replace(/\.(md|markdown|txt|pdf|docx|png|jpe?g)$/i, "")
    .replace(/^\d+[_\s-]*/, "")
    .replace(/[_-]+/g, " ")
    .replace(/\bv\d+\b/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim()
    .toLowerCase();
  const date = speakDate((src.text.match(/Date:\s*(\d{4}-\d{2}-\d{2})/) ?? [])[1]);
  return `the ${base || "document"}${date ? ` from ${date}` : ""}`;
}

const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
const words = (s) => s.split(/\s+/).filter(Boolean).length;

// ---------------------------------------------------------------- open items
export const OPEN_ITEMS_RE =
  /\b(still open|open items?|open decisions?|what(?:'s| is) (?:still )?(?:open|pending|unresolved|outstanding)|unresolved|not (?:yet )?decided|what remains)\b/i;

/** "Open decision: X (detail); not resolved." -> one spoken list. */
export function openItems(bundle) {
  const found = [];
  for (const src of bundle.sources) {
    for (const s of sentencesOf(src)) {
      const m = /^Open decision:\s*(.+)$/i.exec(s.text);
      if (!m) continue;
      const topic = m[1]
        .split(/\s*\(|;/)[0]
        .replace(/[.,;:]+$/, "")
        .trim();
      if (topic) found.push({ topic, src, sent: s });
    }
  }
  if (!found.length) return null;
  const topics = found.map((f) => f.topic.replace(/^(?:the|a)\s+/i, ""));
  const list =
    topics.length === 1
      ? topics[0]
      : topics.slice(0, -1).join("; ") + "; and " + topics.at(-1);
  const sources = [...new Set(found.map((f) => f.src))];
  const spoken = `Still open, per ${docLabelOf(sources[0])}: ${list}.`;
  if (words(spoken) > 45) return null;
  return {
    spoken,
    verdict: "OPEN",
    intent: "OPEN_ITEMS",
    field: null,
    citations: found.map((f) => cite(f.src, f.sent)),
  };
}

// ------------------------------------------------------- named-document asks
// Document kinds a caller names out loud, mapped to words in a source's title
// or its "Type:" header. A question must name exactly one document for this
// route; two or more is ambiguous and goes back to the general path.
const DOC_KINDS = [
  [/\be-?mails?\b/i, /email/i],
  [/\bsteering\b/i, /steering/i],
  [/\bkick-?off\b/i, /kick-?off/i],
  [/\b(action|risk) log\b/i, /log/i],
  [/\bchange request\b|\bCR-?\d\b/i, /change request/i],
  [/\bstatement of work\b|\bSOW\b/i, /statement of work/i],
  [/\b(delivery|status) update\b/i, /update|status/i],
  [/\bhardware\b/i, /hardware/i],
  [/\b(ops|operations) review\b/i, /operations review|ops review/i],
  [/\brevision memo\b/i, /revision/i],
];
const ASK_Q = /\b(ask|asked|asking|want|wanted|requested|say|said|says|state|stated|mention|mentioned)\b|\brequest\b(?<!change request)/i;
const ASK_S = /\b(asks?|asked|requests?|requested|wants?|states?|stated)\b/i;

export function documentLookup(question, bundle) {
  if (!ASK_Q.test(question)) return null;
  const kinds = DOC_KINDS.filter(([q]) => q.test(question));
  if (kinds.length !== 1) return null;
  const [, titleRe] = kinds[0];
  const matches = bundle.sources.filter((s) => {
    const type = (s.text.match(/Type:\s*([^.\n]+)/) ?? [])[1] ?? "";
    return titleRe.test(s.title.replace(/_/g, " ")) || titleRe.test(type);
  });
  if (matches.length !== 1) return null;
  const src = matches[0];
  let picked = sentencesOf(src).filter((s) => ASK_S.test(s.text));
  if (!picked.length) return null;
  // Speak as many whole sentences as fit a short spoken turn.
  const chosen = [];
  for (const s of picked) {
    const next = [...chosen, s];
    if (words(next.map((x) => x.text).join(" ")) > 38) break;
    chosen.push(s);
  }
  if (!chosen.length) return null;
  picked = chosen;
  return {
    spoken: `${cap(docLabelOf(src))}: ${picked.map((s) => s.text).join(" ")}`,
    verdict: "QUOTED",
    intent: "DOC_LOOKUP",
    field: null,
    citations: picked.map((s) => cite(src, s)),
  };
}

// --------------------------------------------- causal "why" from the record
// The reason must be written down: the current claim's own sentence carries a
// causal lead-in ("Following the narrower scope, ..."), and the motivating
// record is an earlier sentence sharing that cause's stem. No lead-in -> null
// and the caller says the reason is not documented.
const CAUSE_RE = /\b(?:following|because of|because|due to|owing to|given|after|since|as a result of)\s+([^,;]+)/i;

export function documentedReason(current, bundle) {
  if (!current?.quote) return null;
  const cm = CAUSE_RE.exec(current.quote);
  if (!cm) return null;
  const cause = cm[1].trim().replace(/[.]+$/, "");
  const stems = (cause.toLowerCase().match(/[a-z]{5,}/g) ?? []).map((w) => w.slice(0, 5));
  if (!stems.length) return null;
  const curDate = current.docDate || "9999";
  let best = null;
  for (const src of bundle.sources) {
    const date = (src.text.match(/Date:\s*(\d{4}-\d{2}-\d{2})/) ?? [])[1] ?? "";
    if (src.id === current.sourceId || (date && date > curDate)) continue;
    for (const s of sentencesOf(src)) {
      const toks = (s.text.toLowerCase().match(/[a-z]{5,}/g) ?? []).map((w) => w.slice(0, 5));
      const hit = stems.filter((st) => toks.includes(st)).length;
      if (hit && (!best || hit > best.hit || (hit === best.hit && date < best.date)))
        best = { hit, src, s, date };
    }
  }
  const own = bundle.sources.find((s) => s.id === current.sourceId);
  const citations = [];
  if (own) {
    const ownSent = sentencesOf(own).find((s) => s.start <= current.start + 5 && s.end >= current.start && current.quote.includes(s.text.slice(0, 20)));
    if (ownSent) citations.push(cite(own, ownSent));
  }
  if (!best) {
    return citations.length
      ? { spoken: `${cap(own ? docLabelOf(own) : "the record")} ties the change to ${cause}.`, citations }
      : null;
  }
  citations.push(cite(best.src, best.s));
  const spoken = `${cap(own ? docLabelOf(own) : "the record")} ties it to ${cause}. Earlier, ${docLabelOf(best.src)} recorded: ${best.s.text}`;
  return words(spoken) <= 45 ? { spoken, citations } : { spoken: `${cap(own ? docLabelOf(own) : "the record")} ties the change to ${cause}.`, citations: citations.slice(0, 1) };
}

// ------------------------------------------------------------ subject binding
// A field question with an extra subject ("how much is the Dock E training
// change?") is about THAT subject. If no claim of the field mentions it, the
// field's figures must not answer it.
const GENERIC = new Set(
  "what which when where how much many does did is are was were the a an our we us they them their this that these those there still finally final current currently agreed agree approve approved signed sign locked confirm confirmed really actually exactly total amount figure number fee fees retainer price cost rate deadline date dates split payment payments schedule go-live live launch tell client clients about from with into said says say right okay going pilot project deal monthly weekly".split(
    " ",
  ),
);

export function unboundSubject(question, fieldClaims, bundle) {
  const corpus = bundle.sources.map((s) => s.text.toLowerCase()).join("\n");
  const quotes = fieldClaims.map((c) => c.quote.toLowerCase()).join("\n");
  const toks = (question.toLowerCase().match(/[a-z][a-z-]{2,}/g) ?? []).filter(
    (t) => !GENERIC.has(t),
  );
  const unbound = toks.filter(
    (t) => new RegExp(`\\b${t}\\b`).test(corpus) && !new RegExp(`\\b${t}\\b`).test(quotes),
  );
  return unbound.length ? unbound : null;
}

/** Best sentence mentioning every unbound subject word, prefer negatives. */
export function subjectSentence(unbound, bundle) {
  let best = null;
  for (const src of bundle.sources) {
    for (const s of sentencesOf(src)) {
      const low = s.text.toLowerCase();
      if (!unbound.every((t) => new RegExp(`\\b${t}\\b`).test(low))) continue;
      const neg = /\bno (?:amount|price|figure)\b|\bnothing agreed\b|\bnot agreed\b|\bno amount was agreed\b/i.test(s.text) ? 1 : 0;
      if (!best || neg > best.neg) best = { src, s, neg };
    }
  }
  if (!best) return null;
  return {
    spoken: `${cap(docLabelOf(best.src))}: ${best.s.text}`,
    verdict: best.neg ? "NO-RECORD" : "QUOTED",
    intent: "LOOKUP",
    field: null,
    citations: [cite(best.src, best.s)],
  };
}

// ------------------------------------------------------- explicit rejections
// "Did Harbor reject the change request?" A YES needs a sentence that states
// the rejection AND is about what was asked: it shares content words with the
// question, or names the identifier ("CR-1") of the document the question
// names. No such sentence -> null (the field path says "no record shows a
// rejection").
const REJ_S = /\b(rejected|turned down|declined|refused)\b/i;
const STOPQ = new Set("did does do was were is are the a an has have had they we our their it this that reject rejected rejection turn turned down decline declined refuse refused".split(" "));

export function rejectionLookup(question, bundle) {
  const qTok = (question.toLowerCase().match(/[a-z][a-z0-9-]{2,}/g) ?? []).filter((t) => !STOPQ.has(t));
  const named = DOC_KINDS.filter(([q]) => q.test(question)).map(([, t]) => t);
  const ids = new Set();
  for (const src of bundle.sources) {
    const head = src.text.split("\n")[0] + " " + src.title.replace(/_/g, " ");
    if (named.some((t) => t.test(head)))
      for (const m of head.matchAll(/\b([A-Z]{2,}-?\d+)\b/g)) ids.add(m[1].replace("-", "").toLowerCase());
  }
  let best = null;
  for (const src of bundle.sources)
    for (const s of sentencesOf(src)) {
      if (!REJ_S.test(s.text)) continue;
      const low = s.text.toLowerCase();
      let score = qTok.filter((t) => new RegExp(`\\b${t}\\b`).test(low)).length;
      for (const m of s.text.matchAll(/\b([A-Z]{2,}-?\d+)\b/g)) if (ids.has(m[1].replace("-", "").toLowerCase())) score += 2;
      if (score >= 2 && (!best || score > best.score)) best = { score, src, s };
    }
  if (!best) return null;
  return {
    spoken: `Yes. Per ${docLabelOf(best.src)}: ${best.s.text}`,
    verdict: "REJECTED-EXPLICIT",
    intent: "REJECTED",
    field: null,
    citations: [cite(best.src, best.s)],
  };
}
