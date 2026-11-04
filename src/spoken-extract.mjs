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
export const terms = (s) =>
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

// The clause that carries a governing-body decision verb; a polar ask's
// named target must bind here, not merely somewhere in the unit or the
// enclosing evidence container.
const DECISION_VERB_RE =
  /\b(?:approved|refused|rejected|deferred|ratified|adopted)\b/i;
export function decisionClauseOf(text) {
  const clauses = mainClause(text).split(/[,;:]\s*|\s+-\s+/);
  return clauses.find((c) => DECISION_VERB_RE.test(c)) ?? null;
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
  scoringQuestion = null,
) {
  if (!isQuestion(question)) return null;
  if (
    !result?.supported ||
    result.refused ||
    result.unresolved ||
    !result.evidence?.length
  )
    return null;
  // When the engine grounded its evidence through a disclosed query
  // expansion/rephrase (result.queryTransform), passage scoring uses that
  // same disclosed vocabulary; every question-shape gate below (decision
  // words, time asks, plural and named-target binding) still reads the
  // caller's original question.
  const q = new Set(terms(scoringQuestion ?? question));
  if (!q.size) return null;
  // A polar decision word in the question ("were the applications
  // APPROVED?") is the point of the question: a unit stating that decision
  // beats a same-score agenda header that merely names the subject.
  const qDecision = question.match(
    /\b(approved?|rejected?|refused?|signed|agreed|declared?|finali[sz]ed|ratified|adopted)\b/i,
  );
  const decisionRe = qDecision
    ? new RegExp(qDecision[1].replace(/e?d$/, ""), "i")
    : null;
  let best = null;
  for (const ev of result.evidence) {
    for (const u of units(ev.quote)) {
      // Only the main clause asserts: "readiness is targeted for 22 November,
      // provided data access arrives on time" says nothing about whether data
      // access IS on time. Words inside a conditional clause do not count.
      const main = mainClause(u.text);
      // A modal conditional ("the panel WOULD approve IF ...") states no
      // decision; it never answers a decision ask.
      if (
        decisionRe &&
        /\b(?:would|could|might|may|shall)\b[^.\n]{0,25}\b(?:approv|agree|sign|accept|refus|reject)/i.test(
          main,
        )
      )
        continue;
      const ut = new Set(terms(main));
      let score = 0;
      for (const t of q) {
        if (ut.has(t)) {
          score++;
          continue;
        }
        // Stem-level match: the question's "declare" binds the record's
        // "declared" - word-form differences must not lose the answering
        // passage to a name-dense attendance list.
        if (
          t.length >= 4 &&
          [...ut].some(
            (w) =>
              w.length >= 4 &&
              (w.startsWith(t.slice(0, 6)) || t.startsWith(w.slice(0, 6))),
          )
        )
          score++;
      }
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
  // A time ask is answered by a DATED record only: quoting an undated
  // related sentence ("finance had not yet signed off") is not a timing.
  if (
    /\b(?:when|what (?:time|date|day)|which day)\b/i.test(question) &&
    !/\d/.test(best.unit.text)
  )
    return null;
  // A plural ask ("were the planning APPLICATIONS approved?") must not be
  // answered by one item's decision as if it covered all. Decisions are
  // main-clause governing-body resolutions in EITHER polarity; mixed
  // outcomes are enumerated, never flattened. A conditional ("would
  // approve IF ...") states no decision.
  const decidedRe =
    /\b(?:the )?(?:committee|board|panel)\s+(?:unanimously )?(?:approved|refused|rejected|deferred|ratified|adopted)\b/i;
  if (
    decisionRe &&
    /\b(?:applications|items|decisions|requests|sites|depots)\b/i.test(question)
  ) {
    const seen = new Map();
    for (const ev of result.evidence)
      for (const u of units(ev.quote)) {
        const main = mainClause(u.text);
        if (!decidedRe.test(main)) continue;
        const key = main
          .replace(/^[\s\d.]+/, "")
          .replace(/\s+/g, " ")
          .trim()
          .toLowerCase();
        if (!seen.has(key))
          seen.set(key, {
            text: main
              .replace(/^[\s\d.]+/, "")
              .replace(/\s+/g, " ")
              .trim(),
            ev,
            count: 0,
          });
        seen.get(key).count++;
      }
    const distinct = [...seen.values()];
    const total = distinct.reduce((n, d) => n + d.count, 0);
    const polarity = (t) =>
      /\b(?:refused|rejected|deferred)\b/i.test(t) ? "refused" : "approved";
    if (distinct.length) {
      const polarities = new Set(distinct.map((d) => polarity(d.text)));
      if (polarities.size > 1) {
        // Mixed outcomes: enumerate, never claim a blanket result.
        const body = distinct
          .map(
            (d) =>
              `${d.text.replace(/[.;:,]?$/, ".")}${d.count > 1 ? ` (${d.count} items)` : ""}`,
          )
          .join(" ");
        return {
          spoken: `The decisions are mixed: ${body}`,
          verdict: "QUOTED",
          citations: distinct.map((d) => d.ev),
        };
      }
      if (distinct.length === 1 && total > 1)
        return {
          spoken: `${distinct[0].text.replace(/[.;:,]?$/, ".")} The minutes record that decision for each of the ${total} applications separately.`,
          verdict: "QUOTED",
          citations: [distinct[0].ev],
        };
      // One decision only: say it is one, not all.
      return {
        spoken: `${distinct[0].text.replace(/[.;:,]?$/, ".")} Only one decision is recorded in these documents.`,
        verdict: "QUOTED",
        citations: [distinct[0].ev],
      };
    }
    return null;
  }
  // A singular polar ask naming a target ("was Carrbridge approved?",
  // lowercase ASR too) must bind THAT target: another item's decision is
  // never evidence for it. A word is a target when the documents use it as
  // a proper name (capitalized) - generic field nouns never bind.
  if (decisionRe) {
    const cand = question.match(
      /\b(?:was|did|is|were|has|have)\s+(?:the\s+)?([a-zA-Z0-9][a-zA-Z0-9-]*)\b/i,
    )?.[1];
    const GENERIC =
      /^(?:the|this|that|application|item|fee|deadline|payment|invoice|bill|contract|agreement|proposal|budget|report|plan|request|decision|minutes|meeting)$/i;
    if (cand && !GENERIC.test(cand)) {
      const capForm = cand[0].toUpperCase() + cand.slice(1);
      const proper = new RegExp(`\\b${capForm}\\b`);
      const ci = new RegExp(`\\b${cand}\\b`, "i");
      // Any non-generic asked token the documents carry binds: a polar
      // ask's target must sit in the cited decision clause. Capitalization
      // is not required from either side - an all-lowercase OCR scan
      // cannot show it and a lowercase ASR ask cannot mark it - and a
      // generic field noun never binds (stoplist above). A target absent
      // from the decision clause abstains (safe direction).
      void proper;
      const named = bundle.sources.some((src) =>
        ci.test(String(src.text ?? "")),
      );
      if (named) {
        // Bind the target to ITS OWN governing-body decision. Minutes name
        // the application in an agenda line ("Agenda Item 5 ... New build at
        // Anagach.") while the decision clause says only "the application",
        // so each decision unit carries the NEAREST PRECEDING naming line in
        // its evidence as its antecedent. A decision recorded for another
        // item is never evidence for this target; when no decision names
        // the target (directly or via its antecedent), abstain.
        const namingLine = (t) =>
          /\bagenda item\b|\bapplication\s+\d|\bnew build\b|\bsite at\b|\bproposal\s+for\b/i.test(
            t,
          );
        const decisions = [];
        for (const ev of result.evidence) {
          let nameLine = "";
          for (const u of units(ev.quote)) {
            if (namingLine(u.text)) {
              nameLine = u.text;
              continue;
            }
            const main = mainClause(u.text);
            if (!decidedRe.test(main)) continue;
            // A modal conditional ("would approve IF ...") states no
            // decision.
            if (
              /\b(?:would|could|might|may|shall)\b[^.\n]{0,25}\b(?:approv|agree|sign|accept|refus|reject)/i.test(
                main,
              )
            )
              continue;
            decisions.push({ u, ev, nameLine });
            // An antecedent binds ONE decision: a later decision with no
            // fresh naming line belongs to something else (unnamed), never
            // to the same item.
            nameLine = "";
          }
        }
        const mine = decisions.filter(
          (d) => ci.test(d.u.text) || (d.nameLine && ci.test(d.nameLine)),
        );
        if (!mine.length) {
          // No governing-body decision names the target. A rejection
          // sentence naming it answers the polar ask directly, from the
          // same engine-validated evidence; anything else abstains rather
          // than quote another item's decision.
          for (const ev of result.evidence)
            for (const u of units(ev.quote)) {
              if (
                /\b(?:rejected|turned down|declined|refused)\b/i.test(u.text) &&
                ci.test(u.text)
              )
                return {
                  spoken: `No. ${u.text.replace(/\s+/g, " ").replace(/[.;:,]?$/, ".")} That's from ${shortTitle(ev.title)}.`,
                  verdict: "QUOTED",
                  citations: [ev],
                };
            }
          return null;
        }
        best = {
          score: best.score,
          unit: mine[mine.length - 1].u,
          ev: mine[mine.length - 1].ev,
        };
      }
    }
    // One quoted unit carrying BOTH outcomes is ambiguous for a polar ask:
    // abstain rather than let one polarity speak for the whole.
    const mainBest = mainClause(best.unit.text);
    const hasAppr =
      /\b(?:committee|board|panel)\s+(?:unanimously )?(?:approved|ratified|adopted)\b/i.test(
        mainBest,
      );
    const hasRef =
      /\b(?:committee|board|panel)\s+(?:unanimously )?(?:refused|rejected|deferred)\b/i.test(
        mainBest,
      );
    if (hasAppr && hasRef) return null;
  }
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
