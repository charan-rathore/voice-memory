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
  | "signedAgreement"
  | "signoffTiming"
  | "launchApproval"
  | "scope"
  | "reporting";
export type ClaimStatus =
  | "proposed"
  | "discussed"
  | "requested"
  | "internal-target"
  | "approved"
  | "unresolved";

export type Claim = {
  phase?: "pilot" | "expansion" | null;
  /** Four-digit year stated on the claim's own line, when present. Phase
   * buckets ("expansion") are not identity: the year distinguishes them. */
  year?: string;
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
    /pending|outstanding|not recorded|not approved|not yet|open decision|has not been approved|no [^.;]{0,40}has been approved|nothing (was|is) approved|no decision (was )?taken|not [^.;]{0,20}(approved|signed|countersign|confirmed)|no\s+(signed|countersigned|executed)\s/i.test(
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
    /\bfee|retainer|\brate\b|\bprice|invoic|how much|cost|bill|charg|money|commercial|paid|pay\b/i.test(
      q,
    )
  )
    out.add("fee");
  if (
    /payment|split|upfront|installment|bill|commercial|money|paid|pay\b/i.test(
      q,
    )
  )
    out.add("paymentSplit");
  if (
    /deadline|due date|pilot date|when is the pilot|go-?live|going live|launch date|when (?:do|will|are) we (?:go|launch)/i.test(
      q,
    )
  )
    out.add("deadline");
  // Agreement-existence questions ("is there a signed agreement?") are their
  // own field: a recorded negative fact answers them verbatim, and fee or
  // payment-split claims must not compete over them.
  if (
    /(signed|countersigned|executed)\b[^?]{0,40}\b(agreement|contract|statement of work)\b|\b(agreement|contract|statement of work)\b[^?]{0,40}\b(signed|countersigned|executed)\b|\bsigned anything\b|\bsigned (?:it|the deal)\b|\b(?:contract|agreement) in place\b/i.test(
      q,
    )
  )
    out.add("signedAgreement");
  if (/sign[- ]?off|signed off|signing off/i.test(q)) {
    if (/\bwhen|timing|expected|date\b/i.test(q)) out.add("signoffTiming");
    else out.add("signoffWho");
  }
  if (/launch/i.test(q) && /approv|authoriz|signed off|sign-?off|who/i.test(q))
    out.add("launchApproval");
  if (/\bregion|\bscope\b|\bareas?\b|\bcover(?:s|age|ed|ing)?\b/i.test(q))
    out.add("scope");
  if (
    /\b(?:weekly|daily|biweekly|fortnightly|cadence|progress report|reporting|status update|status reports?)/i.test(
      q,
    )
  )
    out.add("reporting");
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
export function scopeEntitiesOf(title: string, h1: string): string[] {
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
const FIELD_NOUN: Record<ClaimField, RegExp> = {
  fee: /\bfee\b|retainer|\$\d|price|cost|charge/i,
  paymentSplit: /payment|split|installment|upfront/i,
  deadline: /deadline|date|timeline|go-?live/i,
  signoffWho: /sign/i,
  signoffTiming: /sign/i,
  signedAgreement: /agreement|contract/i,
  launchApproval: /launch/i,
  scope: /region|scope/i,
  reporting: /report|digest|cadence/i,
};
const NEG_RE =
  /never approved|no longer approved|not approved|rescinded?|withdrawn|withdrew|revoked|rejected/gi;
/** A negation/rescission applies to a claim only when its own clause names
 * the claim's object (field noun or value), or a rescission verb refers back
 * with a pronoun ("rescinded it entirely"). */
const negationBinds = (
  field: ClaimField,
  value: string,
  line: string,
): boolean => {
  NEG_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = NEG_RE.exec(line))) {
    const negClause = clauseAround(line, m.index);
    const bare = value.replace(/[$%,\s]/g, "");
    if (
      FIELD_NOUN[field].test(negClause) ||
      negClause.toLowerCase().includes(value.toLowerCase()) ||
      (bare.length > 1 && negClause.replace(/[$%,\s]/g, "").includes(bare)) ||
      (/rescind|withdraw|revoke|never approved|no longer approved|not approved/i.test(
        m[0],
      ) &&
        /\b(it|this|that)\b/i.test(negClause))
    )
      return true;
  }
  return false;
};

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
    // An executed agreement: its header type says so, or it records its own
    // countersignature and that it is in force (and never "not signed").
    const docExecuted =
      /Type:\s*(?:signed|executed|countersigned)\b/i.test(source.text) ||
      (/\b(?:was|were|has been)\s+(?:counter)?signed by both parties\b/i.test(
        source.text,
      ) &&
        /\bin force\b/i.test(source.text) &&
        !/\bnot (?:been )?(?:counter)?signed\b/i.test(source.text));
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
        let status = statusOf(clause);
        // Document authority: inside an executed agreement, a plain
        // statement of terms ("for a monthly retainer of $9,500") IS the
        // agreed term. Only "discussed" is upgraded; proposals, conditions
        // and negations keep their own wording's status.
        if (docExecuted && status === "discussed") status = "approved";
        // Negation or rescission colors the claim only when it binds to the
        // claim's own object: "the fee was never approved" negates the fee;
        // "the fee was approved; the hiring plan was rejected" does not.
        if (negationBinds(field, value, line)) status = "unresolved";
        // An unresolved/open-decision line that merely REFERENCES a revision
        // never supersedes anything; neither does a line listing alternatives.
        const supersedes =
          /revis|supersed|replaces|narrow/i.test(clause) &&
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
        if (/\bfee\b|\bretainer\b/i.test(window)) push("fee", m[0], m.index);
      }
      // Two percentages in one payment sentence that sum to 100 are a
      // split, however the stages are named ("upfront", "on signature",
      // "on signing", "on launch").
      const pct = line.match(/(\d{1,2})%[^.\n]*?(\d{1,2})%/);
      const split =
        (pct && Number(pct[1]) + Number(pct[2]) === 100 ? pct : null) ||
        line.match(/(\d{1,2})\s*\/\s*(\d{1,2})/);
      if (split && /payment|upfront|schedule|split/i.test(line))
        push("paymentSplit", `${split[1]}/${split[2]}`, split.index);
      // Any calendar date bound to a deadline / go-live noun in its own
      // sentence. A date that is the due date of some OTHER deliverable
      // ("submit a revised go-live plan by 30 September") is not a deadline
      // claim: a plan/submission/reply noun between cue and date breaks it.
      for (const dm of line.matchAll(
        /\b(\d{1,2}\s+(?:January|February|March|April|May|June|July|August|September|October|November|December)(?:\s+20\d{2})?)\b/gi,
      )) {
        const at = dm.index ?? 0;
        const sentStart = Math.max(line.lastIndexOf(". ", at) + 1, 0);
        const sentEndIdx = line.indexOf(". ", at);
        const sentence = line.slice(
          sentStart,
          sentEndIdx < 0 ? line.length : sentEndIdx,
        );
        if (
          !/\b(?:deadline|(?:delivery|internal|pilot) target|targeted for|readiness|go-?live|launch date|due date)\b/i.test(
            sentence,
          )
        )
          continue;
        const before = line.slice(sentStart, at);
        if (
          /\b(plan|submit|submission|reply|respond|report)\b[^.]*$/i.test(
            before,
          )
        )
          continue;
        if (
          /\b(countersigned|signed|dated|reported)\s+(?:by [^.]{0,40}\s+)?on\s*$/i.test(
            before,
          )
        )
          continue;
        push("deadline", dm[1], at);
      }
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
      // Recorded agreement-existence facts: "No signed commercial agreement
      // exists for the revised terms" is itself the answer to an
      // agreement-existence question.
      const ag = line.match(
        /\bno\s+(?:signed|countersigned|executed)\s+(?:[a-z-]+\s+){0,3}(?:agreement|contract)\b[^.;]*/i,
      );
      if (ag) push("signedAgreement", ag[0].trim(), ag.index ?? 0);
      // Positive executed-agreement facts: "was countersigned by both
      // parties", "has been signed by". The line itself is the evidence.
      const signedPos = line.match(
        /\b(?:was|were|has been|have been)\s+(?:counter)?signed\s+by\b[^.;]*|\bcountersigned by both parties\b[^.;]*/i,
      );
      if (!ag && signedPos)
        push("signedAgreement", "signed", signedPos.index ?? 0);
      // Region-count claims: a narrowing "from A to B" line records only B
      // as the current claim; A stays recorded by the original document. A
      // rejected option is not a claim at all. Scope claims carry their phase
      // so an approved 2027-expansion scope can never displace pilot scope.
      // Scope work only on region lines: the 55k-doc cost stays flat.
      if (/regions?\b/i.test(line)) {
        const scopePhase =
          /expansion|national\b|\b20\d{2}\b|phase\s*(2|two|ii)\b/i.test(line)
            ? ("expansion" as const)
            : /\bpilot\b|first phase|phase\s*(1|one)\b/i.test(line)
              ? ("pilot" as const)
              : null;
        const lineYear = line.match(/\b(20\d{2})\b/)?.[1];
        const pushScope = (value: string, idx: number) => {
          if (scopeRejected(value)) return;
          const before = claims.length;
          push("scope", value, idx);
          if (claims.length > before) {
            claims[claims.length - 1].phase = scopePhase;
            if (lineYear) claims[claims.length - 1].year = lineYear;
          }
        };
        // A rejection skips only the claim it binds to, never a neighbor.
        const scopeRejected = (value: string): boolean => {
          const R = /reject\w*|rule out|ruled out|declined/gi;
          let m: RegExpExecArray | null;
          while ((m = R.exec(line))) {
            const cl = clauseAround(line, m.index);
            if (
              /region|scope/i.test(cl) ||
              cl.toLowerCase().includes(value.toLowerCase())
            )
              return true;
          }
          return false;
        };
        {
          const narrowing = line.match(
            /narrow[^.]*?\bto\s+(\w+)\s+regions?\s*(\([^)]*\))?/i,
          );
          if (narrowing) {
            pushScope(
              `${narrowing[1]} regions${narrowing[2] ?? ""}`,
              narrowing.index ?? 0,
            );
          } else {
            const before = claims.length;
            for (const m of line.matchAll(
              /\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+(?:retail\s+)?regions?\s*(\([^)]*\))?/gi,
            )) {
              pushScope(`${m[1]} regions${m[2] ?? ""}`, m.index);
            }
            if (claims.length === before) {
              // Incomplete extraction fails CLOSED: a scope assertion whose
              // count token we cannot normalize is still recorded raw, so it
              // competes instead of vanishing and letting a neighbor win.
              const raw = line.match(
                /\b([a-z]+)\s+(?:retail\s+)?regions?\s*(\([^)]*\))?/i,
              );
              const RAW_STOP = new Set(
                "the a an all these those both some many any our their its few more other each every which that this no".split(
                  " ",
                ),
              );
              if (
                raw &&
                !RAW_STOP.has(raw[1].toLowerCase()) &&
                /confirm|approv|agree|decid|narrow|cover|expan|pilot|scope|phase/i.test(
                  line,
                )
              )
                pushScope(
                  `${raw[1].toLowerCase()} regions${raw[2] ?? ""}`,
                  raw.index ?? 0,
                );
            }
          }
        }
      }
      // Reporting-cadence claims normalize to the cadence token so a
      // proposal's "weekly progress reporting" and a later "weekly reporting
      // is confirmed" resolve as records about the same commitment.
      // The cadence token must modify the report itself: "monthly summary of
      // the weekly report" is a WEEKLY report summarized monthly. Replacement
      // direction is honored: "weekly digest replaced the monthly report"
      // makes weekly current and the replaced cadence is not a live claim.
      const CAD = "weekly|daily|biweekly|monthly";
      const fwd = line.match(
        new RegExp(
          `\\b(${CAD})\\b[^.]{0,50}?\\breplac\\w+[^.]{0,50}?\\b(${CAD})\\s+(?:progress\\s+)?report`,
          "i",
        ),
      );
      const rev = line.match(
        new RegExp(
          `\\b(${CAD})\\s+(?:progress\\s+)?report\\b[^.]{0,50}?\\breplac\\w+\\s+by\\b[^.]{0,50}?\\b(${CAD})\\b`,
          "i",
        ),
      );
      const replacedCad = fwd
        ? fwd[2].toLowerCase()
        : rev
          ? rev[1].toLowerCase()
          : null;
      const replacingCad = fwd ? fwd[1] : rev ? rev[2] : null;
      if (replacingCad)
        push("reporting", replacingCad.toLowerCase(), (fwd ?? rev)!.index ?? 0);
      for (const m of line.matchAll(
        /\b(weekly|daily|biweekly|monthly)\s+(?:progress\s+)?report/gi,
      )) {
        if (replacedCad && m[1].toLowerCase() === replacedCad) continue;
        push("reporting", m[1].toLowerCase(), m.index);
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
      // An undated revision supersedes nothing: recency unestablished means
      // the records compete; it never silently demotes a dated record.
      if (!supDate) continue;
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
