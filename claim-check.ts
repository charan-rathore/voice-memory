/** Narrow claim-to-source/state checks for the voice demo.
 *
 * Deterministic field extraction over exact original lines. Every claim keeps
 * a provable quote (validated like other evidence). A claim has a field, a
 * normalized value, a status from its own sentence, and whether its line
 * signals supersession of earlier records. Used to stop three failure modes:
 * presenting a superseded value as current, presenting proposed/discussed as
 * agreed, and treating a condition as an answer to a timing/who question.
 */
export type ClaimField =
  | "fee"
  | "paymentSplit"
  | "deadline"
  | "signoffWho"
  | "signoffTiming"
  | "launchApproval";
export type ClaimStatus =
  | "proposed"
  | "discussed"
  | "requested"
  | "internal-target"
  | "approved"
  | "unresolved";

export type Claim = {
  field: ClaimField;
  value: string;
  status: ClaimStatus;
  supersedes: boolean;
  sourceId: string;
  title: string;
  hash: string;
  start: number;
  end: number;
  firstLine: number;
  lastLine: number;
  quote: string;
  docDate: string;
  /** Distinctive entity phrases from the filename and H1 heading only
   * (never the author line, which is shared across documents). */
  scopeEntities: string[];
};

function statusOf(line: string): ClaimStatus {
  if (
    /pending|outstanding|not recorded|not approved|not yet|open decision|has not been approved|no [^.;]{0,40}has been approved|nothing (was|is) approved|no decision (was )?taken|not [^.;]{0,20}(approved|signed|countersign|confirmed)/i.test(
      line,
    )
  )
    return "unresolved";
  if (/subject to|provided that|conditional|only when/i.test(line))
    return "proposed";
  // Approval wording is authoritative over revision/proposal wording in the
  // same sentence; check it BEFORE propos|revis.
  if (/approved|signed|countersign|confirmed/i.test(line)) return "approved";
  if (/internal (delivery )?target|targeted for/i.test(line))
    return "internal-target";
  if (/propos|revis|offer\b/i.test(line)) return "proposed";
  if (/asks|requested|retain/i.test(line)) return "requested";
  return "discussed";
}

/** Which claim fields a question asks about. Narrow on purpose. */
export function questionFields(q: string): ClaimField[] {
  const out = new Set<ClaimField>();
  if (
    /\bfee|invoic|how much|cost|bill|charg|money|commercial|paid|pay\b/i.test(q)
  )
    out.add("fee");
  if (
    /payment|split|upfront|installment|bill|commercial|money|paid|pay\b/i.test(
      q,
    )
  )
    out.add("paymentSplit");
  if (/deadline|due date|pilot date|when is the pilot/i.test(q))
    out.add("deadline");
  if (/sign-?off|signoff|signed off|signing off/i.test(q)) {
    if (/\bwhen|timing|expected|date\b/i.test(q)) out.add("signoffTiming");
    else out.add("signoffWho");
  }
  if (/launch/i.test(q) && /approv|authoriz|signed off|sign-?off|who/i.test(q))
    out.add("launchApproval");
  return [...out];
}

const GENERIC_HEADING_WORDS = new Set(
  `proposal proposals note notes revision memo memorandum kickoff committee steering client email extract action log update delivery project commercial internal signed amendment budget final engagement pilot plan report summary minutes brief document file page draft version md txt author date type title subject approved approval terms record records discussion meeting first second later new original current`.split(
    /\s+/,
  ),
);

/**
 * Distinctive entity phrases from the filename and H1 heading, in original
 * case: maximal runs of capitalized, non-generic words ("Bluebird Logistics",
 * "Meridian Advisory"). Unigram token overlap is not identity: a shared
 * company or brand word must not link two different engagements.
 */
function scopeEntitiesOf(title: string, h1: string): string[] {
  const out = new Set<string>();
  for (const text of [title, h1]) {
    const words = text.match(/[A-Za-z][A-Za-z'-]*/g) ?? [];
    let run: string[] = [];
    const flush = () => {
      if (run.length) out.add(run.join(" ").toLowerCase());
      run = [];
    };
    for (const w of words) {
      if (/^[A-Z]/.test(w) && !GENERIC_HEADING_WORDS.has(w.toLowerCase()))
        run.push(w);
      else flush();
    }
    flush();
  }
  return [...out];
}

/** The clause of a line that contains offset `idx`: approval or negation in
 * a different clause of the same sentence must not color this claim. */
function clauseAround(line: string, idx: number): string {
  const bounds = /;\s+|\.\s+|,\s+(?:and|but|while|whereas|although|though)\s+/g;
  let start = 0;
  let end = line.length;
  let m: RegExpExecArray | null;
  while ((m = bounds.exec(line))) {
    if (m.index >= idx) {
      end = m.index;
      break;
    }
    start = m.index + m[0].length;
  }
  return line.slice(start, end);
}

export function extractClaims(
  bundle: {
    sources: Array<{ id: string; title: string; text: string; hash: string }>;
  },
  fields: ClaimField[],
): Claim[] {
  const claims: Claim[] = [];
  for (const source of bundle.sources) {
    const dateMatch = source.text.match(/Date:\s*([0-9-]+)/);
    const docDate = dateMatch ? dateMatch[1] : "";
    // H1 heading only - never the Author line, which is shared across
    // engagements and would falsely mark everything as one engagement.
    const h1 =
      source.text
        .split("\n")
        .find((l) => l.startsWith("#"))
        ?.replace(/^#+\s*/, "") ?? "";
    const scopeEntities = scopeEntitiesOf(source.title, h1);
    let offset = 0;
    for (const line of source.text.split("\n")) {
      const start = offset;
      offset += line.length + 1;
      if (!line.trim() || line.startsWith("#")) continue;
      const base = {
        sourceId: source.id,
        title: source.title,
        hash: source.hash,
        start,
        end: start + line.length,
        firstLine: source.text.slice(0, start).split("\n").length,
        lastLine: source.text.slice(0, start).split("\n").length,
        quote: line,
        docDate,
        scopeEntities,
      };
      const push = (field: ClaimField, value: string, anchorIdx = 0) => {
        if (!fields.includes(field)) return;
        // Status and supersession wording bind to the clause that contains
        // the claim's own anchor: "the fee is $45,000, and the hiring plan
        // was approved" is an approved HIRING PLAN, not an approved fee.
        const clause = clauseAround(line, anchorIdx);
        const status = statusOf(clause);
        // An unresolved/open-decision line that merely REFERENCES a revision
        // never supersedes anything; neither does a line listing alternatives.
        const supersedes =
          /revis|supersed|replaces/i.test(clause) &&
          status !== "unresolved" &&
          !/\bvs\b|open decision|disput/i.test(clause);
        claims.push({ field, value, status, supersedes, ...base });
      };
      // A dollar amount is an engagement-fee claim only when it is bound to
      // the fee object itself: an approved travel "payment" or licensing
      // "charge" is not an engagement fee, whatever its approval status.
      for (const m of line.matchAll(/\$\d[\d,]*\d/g)) {
        const window = line.slice(
          Math.max(0, m.index - 45),
          m.index + m[0].length + 45,
        );
        if (/\bfee\b/i.test(window)) push("fee", m[0], m.index);
      }
      const split =
        line.match(/(\d{1,2})%[^.\n]*?upfront[^.\n]*?(\d{1,2})%/i) ||
        line.match(/(\d{1,2})\s*\/\s*(\d{1,2})/);
      if (split && /payment|upfront|schedule|split/i.test(line))
        push("paymentSplit", `${split[1]}/${split[2]}`, split.index);
      const dl = line.match(/\b(\d{1,2}\s+November(?:\s+2026)?)/i);
      if (dl && /deadline|target|date|readiness/i.test(line))
        push("deadline", dl[1], dl.index);
      if (/sign-?off|signed off|signing off/i.test(line)) {
        // Capture the actor, stopping before auxiliaries like "had not yet".
        const who = line.match(
          /([A-Za-z]+(?: [A-Za-z]+){0,3}?)\s+(?:(?:had|has|have|not|yet|already|formally|been)\s+)*sign(?:ed)?[- ]?off/i,
        );
        push(
          "signoffWho",
          who
            ? who[1]
                .trim()
                .toLowerCase()
                // strip leading filler so "noted that client finance had not
                // yet signed off" resolves to the same actor as "client
                // finance sign-off"
                .replace(
                  /^(?:to|of|for|by|the|a|an|that|subject|noted|noting|said|says|mentioned|asked|confirmed|whether)\s+/i,
                  "",
                )
                .replace(
                  /^(?:to|of|for|by|the|a|an|that|subject|noted|noting|said|says|mentioned|asked|confirmed|whether)\s+/i,
                  "",
                )
            : "unspecified",
          who?.index ?? 0,
        );
        const tm = line.match(
          /\b\d{1,2}\s+(November|October|December)|date|by\s+\w+\s+\d/i,
        );
        if (tm) push("signoffTiming", "stated", tm.index);
      }
      const lm = line.match(/production launch|launch authorization/i);
      if (lm) {
        push(
          "launchApproval",
          /not recorded|not approved|outstanding|no signed/i.test(line)
            ? "none-recorded"
            : "recorded",
          lm.index,
        );
      }
    }
  }
  return claims;
}

/** Resolve claims without letting deterministic recency become authority:
 * - supersession only when a record's own wording signals revision AND the
 *   records share a distinctive entity token (same engagement), never across
 *   unrelated documents;
 * - undated records stay active (missing dates never mean "older");
 * - an explicitly approved value wins over merely proposed/discussed records;
 *   multiple approved values in conflict stay conflicted.
 */
export function resolveClaims(claims: Claim[]): {
  active: Map<string, Claim[]>;
  superseded: Claim[];
  approved: Map<string, Claim[]>;
} {
  const superseded: Claim[] = [];
  const approved = new Map<string, Claim[]>();
  const byField = new Map<string, Claim[]>();
  for (const c of claims) {
    if (!byField.has(c.field)) byField.set(c.field, []);
    byField.get(c.field)!.push(c);
  }
  // Supersession requires an established shared engagement: BOTH records
  // must carry at least one common distinctive scope token. When identity
  // cannot be established (either side has none), never supersede - the safe
  // outcome is competing records, not silent demotion.
  // Identity is established only when the records share a distinctive
  // entity phrase AND at least one side names nothing distinctive the other
  // lacks. Two records that each name their own exclusive entity (Meridian's
  // Bluebird proposal vs Meridian's Falstaff revision) are NOT the same
  // engagement, and neither are namesakes sharing one word (Northstar Retail
  // vs Northstar Logistics). When identity cannot be established there is no
  // supersession - the records compete and the answer stays unresolved.
  const sharesEngagement = (a: Claim, b: Claim) => {
    if (!a.scopeEntities.length || !b.scopeEntities.length) return false;
    const shared = a.scopeEntities.some((e) => b.scopeEntities.includes(e));
    if (!shared) return false;
    const aOnly = a.scopeEntities.some((e) => !b.scopeEntities.includes(e));
    const bOnly = b.scopeEntities.some((e) => !a.scopeEntities.includes(e));
    return !(aOnly && bOnly);
  };
  const active = new Map<string, Claim[]>();
  for (const [field, list] of byField) {
    const superseding = list.filter((c) => c.supersedes);
    for (const sup of superseding) {
      const supDate = sup.docDate || null;
      for (const c of list) {
        if (c === sup || c.supersedes) continue;
        if (!sharesEngagement(sup, c)) continue; // engagement not established
        // Ambiguous attribution: a revision whose scope also matches another,
        // mutually exclusive engagement (shared letterhead, no client named)
        // cannot be attributed uniquely - it supersedes nothing and the
        // records compete instead.
        const ambiguous = list.some(
          (o) =>
            o !== c &&
            o !== sup &&
            sharesEngagement(sup, o) &&
            !sharesEngagement(c, o),
        );
        if (ambiguous) continue;
        if (supDate && c.docDate && c.docDate >= supDate) continue; // not older
        if (!c.docDate) continue; // undated records are never silently demoted
        superseded.push(c);
      }
    }
    const act = list.filter((c) => !superseded.includes(c));
    const appr = act.filter((c) => c.status === "approved");
    if (appr.length) approved.set(field, appr);
    active.set(field, act);
  }
  return { active, superseded, approved };
}
