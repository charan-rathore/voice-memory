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
/** Who issued the claim's status: an internal function (finance, security,
 * legal, delivery), the client/customer, a governing body (committee,
 * steering, board), both parties mutually, or unspecified. An internal
 * approval is not client acceptance; a body's approval of one subject is not
 * its approval of another. */
export type ClaimAuthority =
  | "internal"
  | "client"
  | "body"
  | "mutual"
  | "unspecified";

export type Claim = {
  phase?: "pilot" | "expansion" | null;
  /** Four-digit year stated on the claim's own line, when present. Phase
   * buckets ("expansion") are not identity: the year distinguishes them. */
  year?: string;
  field: ClaimField;
  value: string;
  status: ClaimStatus;
  supersedes: boolean;
  /** The claim's own wording declares it superseded ("the earlier fee
   * proposal is superseded"): demoted regardless of date guards. */
  supersededByWording?: boolean;
  broadCitation?: boolean;
  authority?: ClaimAuthority;
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
    /pending|outstanding|not recorded|not approved|not yet|open decision|has not been approved|no [^.;]{0,40}has been approved|nothing (was|is) (approved|agreed)|no decision (was )?taken|no vote or agreement|not [^.;]{0,20}(approved|signed|countersign|confirmed|accepted|agreed|authorized|executed)|no\s+(signed|countersigned|executed)\s|\bno\s+(?:[a-z-]+\s+){0,2}[a-z-]*(?:signed|countersigned|executed)\b|does not (constitute|establish)|does not mean [^.;]{0,50}(accept|sign|approv|agree)|has not accepted|not been accepted/i.test(
      line,
    )
  )
    return "unresolved";
  if (/subject to|provided that|conditional|only when/i.test(line))
    return "proposed";
  // Approval wording is authoritative over revision/proposal wording in the
  // same sentence; check it BEFORE propos|revis. A modal "accept" states
  // capability or willingness ("we can accept delivery"), never approval.
  const acceptVerb =
    /\baccept(?:s|ed)?\b/i.test(line) &&
    !/\b(?:can|could|may|might|shall|should|will|would|must|willing|ready|prepared|able)\s+(?:to\s+)?(?:[a-z-]+\s+){0,2}accept(?:s|ed)?\b/i.test(
      line,
    );
  if (
    /\bapprov(?:e|es|ed)\b|\bsigned\b|\bsigns\b|countersign|confirmed|\bagreed\b|\bauthoriz(?:e|es|ed)\b/i.test(
      line,
    ) ||
    acceptVerb
  )
    return "approved";
  if (
    /internal (delivery )?target|targeted for|\binternal(?:ly)?(?:\s+[a-z-]+){0,2}\s+target\b/i.test(
      line,
    )
  )
    return "internal-target";
  if (/propos|revis|offer\b|floated|suggested|draft\b/i.test(line))
    return "proposed";
  if (/asks|requested|retain/i.test(line)) return "requested";
  return "discussed";
}

/** The authority behind a status-bearing clause. Client verbs bind tighter
 * than an internal mention elsewhere in the clause ("internal finance
 * approval does not mean the client accepted it" is a CLIENT-side record). */
export function authorityOf(clause: string): ClaimAuthority {
  if (/both parties|mutually/i.test(clause)) return "mutual";
  if (
    (/\b(?:customer|client)\s+(?:has|have|had|did|does|will|would|not|accepted|accepts|signed|signs|rejected|rejects|approved|approves)\b/i.test(
      clause,
    ) ||
      /\b(?:customer|client)(?:'s|')\s+(?:acceptance|approval|sign-?off|signature|rejection)\b/i.test(
        clause,
      )) &&
    !/client liaison|customer liaison/i.test(clause)
  )
    return "client";
  if (/\b(?:committee|steering|board)\b/i.test(clause)) return "body";
  if (
    /\binternal(?:ly)?\b|\b(?:finance|security|legal|engineering|delivery|pmo)\s+(?:team\s+)?(?:approv|sign|target|request|reject)/i.test(
      clause,
    )
  )
    return "internal";
  return "unspecified";
}

/** Which claim fields a question asks about. Narrow on purpose. */
export function questionFields(q: string): ClaimField[] {
  const out = new Set<ClaimField>();
  // "invoice" is deliberately absent: an invoice/bill question is about a
  // billing document the corpus may not hold, and must never alias to the
  // engagement fee (a fee is not an issued invoice).
  if (
    /\bfee|retainer|\brate\b|\bprice|how much|cost|charg|money|commercial|paid|pay\b/i.test(
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
    /deadline|due date|pilot date|when is the pilot|go-?live|going live|launch date|launch target|readiness target|operational target|when (?:do|will|are) we (?:go|launch)/i.test(
      q,
    )
  )
    out.add("deadline");
  // Agreement-existence questions ("is there a signed agreement?") are their
  // own field: a recorded negative fact answers them verbatim, and fee or
  // payment-split claims must not compete over them.
  if (
    /(signed|countersigned|executed)\b[^?]{0,40}\b(agreement|contract|statement of work|addendum)\b|\b(agreement|contract|statement of work|addendum)\b[^?]{0,40}\b(signed|countersigned|executed)\b|\bsigned anything\b|\bsigned (?:it|the deal)\b|\b(?:contract|agreement|addendum) in place\b/i.test(
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
  if (
    /\bregions?\b|\bscope\b|\bareas?\b|\bsites?\b|\bdepots?\b|\bstores?\b|\blocations?\b|\bcover(?:s|age|ed|ing)?\b/i.test(
      q,
    )
  )
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

/** Split a transcript/minutes line into utterances: sentence boundaries and
 * speaker-turn starts. Offsets map back to the source text. */
function utterancesOf(line: string): Array<{ text: string; at: number }> {
  const out: Array<{ text: string; at: number }> = [];
  const re = /(?<=[.!?])\s+(?=[A-Z(])/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line))) {
    out.push({ text: line.slice(last, m.index), at: last });
    last = m.index + m[0].length;
  }
  out.push({ text: line.slice(last), at: last });
  return out.filter((u) => u.text.trim());
}

/** A quoted or transcripted QUESTION is never assertion evidence: it records
 * what someone asked, not what the record states. */
function isQuestionUtterance(text: string): boolean {
  const stripped = text
    .replace(/^\s*[A-Z][A-Za-z.'-]*(?:\s+\([a-z][a-z ]+\))?:\s*/, "")
    .trim();
  if (/\?\s*$/.test(stripped)) return true;
  return /^(?:who|what|when|where|which|whose|why|how|is|are|was|were|do|does|did|has|have|had|can|could|would|should|shall|may)\b[^.]*$/i.test(
    stripped,
  );
}

const MONTHS =
  "January|February|March|April|May|June|July|August|September|October|November|December";
const MONTH_ABBR: Record<string, string> = {
  jan: "01",
  feb: "02",
  mar: "03",
  apr: "04",
  may: "05",
  jun: "06",
  jul: "07",
  aug: "08",
  sep: "09",
  oct: "10",
  nov: "11",
  dec: "12",
};
/** Amounts in symbol or ISO-code form: $42,000 / USD 72,000 / 18,500 INR. */
const AMOUNT_RE =
  /(?:[$€£₹]\s?\d(?:[\d,]*\d)?(?:\.\d+)?|\b(?:USD|EUR|GBP|INR|AUD|CAD|NZD|SGD|AED|CHF|JPY)\s?[$€£₹]?\s?\d(?:[\d,]*\d)?(?:\.\d+)?|\b\d(?:[\d,]*\d)?(?:\.\d+)?\s?(?:USD|EUR|GBP|INR|AUD|CAD|NZD|SGD|AED|CHF|JPY)\b)/g;
/** Scope units a meeting can count: not only "regions". */
const UNIT =
  "(?:retail\\s+)?(?:regions?|sites?|depots?|stores?|locations?|branches?|markets?|countries|offices?|warehouses?|areas?)";
const UNIT_RE = new RegExp("\\b" + UNIT + "\\b", "i");
const NUMWORD_RE =
  "\\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve";

/** Section date headers give per-claim as-of dates inside ONE multi-meeting
 * document (transcripts, minutes, decision logs): "… | 2026-08-05" header
 * lines and "AUG 05 2026 - KICKOFF" banners. Document "Date:" author lines
 * are not section headers. */
const DATE_RES_HOISTED = [
  new RegExp("\\b(\\d{1,2}\\s+(?:" + MONTHS + ")(?:\\s+20\\d{2})?)\\b", "gi"),
  new RegExp("\\b((?:" + MONTHS + ")\\s+\\d{1,2}(?:,\\s*20\\d{2})?)\\b", "gi"),
];

const BARE_DATE_LINE_RE =
  /^\s*(?:[-=*_\s]|SECTION|MINUTES|MEETING|PAGE)*\s*20\d{2}-\d{2}-\d{2}\s*(?:[-=*_\s]|SECTION|MINUTES|MEETING|PAGE)*\s*$/i;

function sectionDateOf(line: string): string | null {
  if (/\bDate:\s*20\d{2}/.test(line)) return null;
  if (line.length > 160) return null;
  // An ISO date marks a section only in header structure: a pipe-separated
  // banner ("Title | Minutes | 2026-08-05") or a bare date line. A date
  // inside a content sentence ("Deadline is 2026-09-01.") is content - it
  // never dates the claims that follow it.
  const iso = line.match(/\b(20\d{2}-\d{2}-\d{2})\b/);
  if (iso && (line.includes("|") || BARE_DATE_LINE_RE.test(line)))
    return iso[1];
  const mon = line.match(
    /^\s*(?:[A-Z][A-Z ]{2,30}?\s+)?(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+(\d{1,2})(?:,)?\s+(20\d{2})\b/i,
  );
  if (mon)
    return (
      mon[3] +
      "-" +
      MONTH_ABBR[mon[1].slice(0, 3).toLowerCase()] +
      "-" +
      mon[2].padStart(2, "0")
    );
  return null;
}

export function extractClaims(
  bundle: {
    sources: Array<{ id: string; title: string; text: string; hash: string }>;
  },
  fields: ClaimField[],
): Claim[] {
  let claims: Claim[] = [];
  for (const source of bundle.sources) {
    const dateMatch = source.text.match(/Date:\s*([0-9-]+)/);
    const docDateHeader = dateMatch ? dateMatch[1] : "";
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
    let sectionDate: string | null = null;
    for (const line of source.text.split("\n")) {
      const lineStart = offset;
      offset += line.length + 1;
      const sd = sectionDateOf(line);
      if (sd) sectionDate = sd;
      const docDate = sectionDate ?? docDateHeader;
      if (!line.trim() || line.startsWith("#")) continue;
      // ALL-CAPS banner/title lines ("HARBOR WAREHOUSE ROBOTICS PILOT") are
      // document chrome, not assertions: they mint no claims.
      if (!/[a-z]/.test(line)) continue;
      for (const utt of utterancesOf(line)) {
        // List furniture ("1. ") is not content: the cited span starts at
        // the assertion itself, keeping quote/start honest for display and
        // evidence validation alike.
        const seg = utt.text.replace(/^\s*\d+\.\s+/, "");
        const start = lineStart + utt.at + (utt.text.length - seg.length);
        if (!seg || isQuestionUtterance(seg)) continue;
        const base = {
          sourceId: source.id,
          title: source.title,
          hash: source.hash,
          start,
          end: start + seg.length,
          firstLine: source.text.slice(0, start).split("\n").length,
          lastLine: source.text.slice(0, start).split("\n").length,
          quote: seg,
          docDate,
          scopeEntities,
        };
        const push = (
          field: ClaimField,
          value: string,
          anchorIdx = 0,
          force?: {
            status?: ClaimStatus;
            authority?: ClaimAuthority;
            supersedes?: boolean;
          },
        ) => {
          if (!fields.includes(field)) return;
          // Status and supersession wording bind to the clause that contains
          // the claim's own anchor: "the fee is $45,000, and the hiring plan
          // was approved" is an approved HIRING PLAN, not an approved fee.
          const clause = clauseAround(seg, anchorIdx);
          let status = force?.status ?? statusOf(clause);
          // Document authority: inside an executed agreement, a plain
          // statement of terms ("for a monthly retainer of $9,500") IS the
          // agreed term. Only "discussed" is upgraded; proposals, conditions
          // and negations keep their own wording's status.
          if (docExecuted && status === "discussed") status = "approved";
          // Negation or rescission colors the claim only when it binds to the
          // claim's own object: "the fee was never approved" negates the fee;
          // "the fee was approved; the hiring plan was rejected" does not.
          if (negationBinds(field, value, seg)) status = "unresolved";
          // A record whose own wording declares it superseded ("the earlier
          // USD 58,000 fee proposal is superseded") demotes ITSELF and its
          // value siblings; it never supersedes others.
          // The wording binds to the claim's own clause only: "...is
          // superseded; the fee is USD 45,000" demotes the old value, never
          // the new record minted from the next clause.
          const supersededByWording =
            /\b(?:is|was|stands)\s+(?:now\s+)?superseded\b/i.test(clause);
          // An unresolved/open-decision line that merely REFERENCES a revision
          // never supersedes anything; neither does a line listing alternatives.
          const supersedes =
            force?.supersedes ??
            (/revis|supersed|replaces|narrow|instead of|\bcurrent\b/i.test(
              clause,
            ) &&
              !supersededByWording &&
              status !== "unresolved" &&
              !/\bvs\b|open decision|disput/i.test(clause));
          claims.push({
            field,
            value,
            status,
            supersedes,
            supersededByWording,
            authority: force?.authority ?? authorityOf(clause),
            ...base,
          });
        };
        // A governing body's approval limited to named subjects: "Committee
        // approval applies to scope, NOT the fee or the payment terms" records
        // an unresolved, authority-scoped claim for each negated subject.
        const lim = seg.match(
          /\bapproval applies to\s+([^.,;]+?),?\s+NOT\s+(?:the\s+)?([^.;]+)/i,
        );
        if (lim) {
          const auth: ClaimAuthority = /committee|steering|board/i.test(seg)
            ? "body"
            : /client|customer/i.test(seg)
              ? "client"
              : "internal";
          const negated = lim[2];
          const LIMITED: Array<[RegExp, ClaimField]> = [
            [/fee|commercial|price|cost|rate/i, "fee"],
            [/payment|split|installment|upfront/i, "paymentSplit"],
            [/scope|site|region|depot|store|location/i, "scope"],
            [/deadline|launch|date|go-?live|timeline/i, "deadline"],
            [/report|cadence/i, "reporting"],
          ];
          for (const [re, f] of LIMITED)
            if (re.test(negated))
              push(f, `approval-limited-${f}`, lim.index ?? 0, {
                status: "unresolved",
                authority: auth,
                supersedes: false,
              });
        }
        // A dollar/ISO-currency amount is an engagement-fee claim only when it
        // is bound to the fee object itself: an approved travel "payment" or
        // licensing "charge" is not an engagement fee, whatever its status.
        AMOUNT_RE.lastIndex = 0;
        for (const m of seg.matchAll(AMOUNT_RE)) {
          const window = seg.slice(
            Math.max(0, m.index - 45),
            m.index + m[0].length + 45,
          );
          if (
            /\bfee\b|\bretainer\b|\bcommercial (proposal|terms|offer)\b|\bfinance approval\b|\bprice\b|\bquote\b/i.test(
              window,
            )
          )
            push("fee", m[0], m.index);
        }
        // Two percentages in one payment sentence that sum to 100 are a
        // split, however the stages are named ("upfront", "on signature",
        // "on signing", "on launch") and whether % is a symbol or the word
        // "percent". A bare "30/70" split notation also counts.
        const pct =
          seg.match(/(\d{1,2})%[^.\n]*?(\d{1,2})%/) ||
          seg.match(
            /(\d{1,2})\s*percent\b[^.\n]{0,60}?\b(\d{1,2})\s*percent\b/i,
          );
        // A bare fraction is a payment split only with a payment cue AND a
        // 100-sum: "rollout plan covers 2/3 of the depots" and "phase 1/2
        // complete" are coverage/progress, never payment terms.
        const bare = seg.match(/\b(\d{1,2})\s*\/\s*(\d{1,2})\b/);
        const split =
          (pct && Number(pct[1]) + Number(pct[2]) === 100 ? pct : null) ||
          (bare && Number(bare[1]) + Number(bare[2]) === 100 ? bare : null);
        if (
          split &&
          /payment|upfront|installment|split|schedule|on signing|on signature|after acceptance|payable|invoice|billing/i.test(
            seg,
          )
        )
          push("paymentSplit", `${split[1]}/${split[2]}`, split.index);
        // Any calendar date bound to a deadline / go-live noun in its own
        // sentence, day-first ("15 November") or month-first ("November 15").
        // A date that is the due date of some OTHER deliverable ("submit a
        // revised go-live plan by 30 September") is not a deadline claim: a
        // plan/submission/reply noun between cue and date breaks it.
        const DATE_RES = DATE_RES_HOISTED;
        for (const DATE_RE of DATE_RES) {
          for (const dm of seg.matchAll(DATE_RE)) {
            const at = dm.index ?? 0;
            const sentStart = Math.max(seg.lastIndexOf(". ", at) + 1, 0);
            const sentEndIdx = seg.indexOf(". ", at);
            const sentence = seg.slice(
              sentStart,
              sentEndIdx < 0 ? seg.length : sentEndIdx,
            );
            if (
              !/\b(?:deadline|(?:delivery|internal|pilot|operational|readiness|launch|go-?live)\s+target|targeted for|readiness|go-?live|launch date|due date)\b/i.test(
                sentence,
              )
            )
              continue;
            const before = seg.slice(sentStart, at);
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
        }
        if (/sign-?off|signed off|signing off/i.test(seg)) {
          // Capture the actor, stopping before auxiliaries like "had not yet".
          const who = seg.match(
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
          const tm = seg.match(
            /\b\d{1,2}\s+(November|October|December)|date|by\s+\w+\s+\d/i,
          );
          if (tm) push("signoffTiming", "stated", tm.index);
        }
        // Recorded agreement-existence facts, positive or negative: "No signed
        // commercial agreement exists", "NO client-signed service agreement",
        // "No executed data processing addendum is present", "No signed
        // addendum is recorded" are themselves answers to existence questions.
        const agRaw = seg.match(
          /\bno\s+(?:[a-z-]+\s+){0,4}(?:agreement|contract|addendum)\b[^.;]*/i,
        );
        const ag = agRaw && /sign|execut/i.test(agRaw[0]) ? agRaw : null;
        if (ag) push("signedAgreement", ag[0].trim(), ag.index ?? 0);
        // "Circulating the proposal does not constitute agreement or a client
        // signature" is the same kind of recorded negative.
        const nc = seg.match(
          /\bdoes not constitute\b[^.;]{0,60}(?:agreement|signature|contract)[^.;]*/i,
        );
        if (!ag && nc) push("signedAgreement", nc[0].trim(), nc.index ?? 0);
        // Positive executed-agreement facts: "was countersigned by both
        // parties", "has been signed by". The line itself is the evidence.
        const signedPos = seg.match(
          /\b(?:was|were|has been|have been)\s+(?:counter)?signed\s+by\b[^.;]*|\bcountersigned by both parties\b[^.;]*/i,
        );
        if (!ag && signedPos)
          push("signedAgreement", "signed", signedPos.index ?? 0);
        // Scope claims: region/site/depot/store counts, named lists ("East and
        // West sites"), hyphenated counts ("four-site proposal"). A narrowing
        // "from A to B" records only B as the current claim; a rejected option
        // is not a claim at all. Scope claims carry their phase so an approved
        // 2027-expansion scope can never displace pilot scope.
        if (UNIT_RE.test(seg)) {
          const scopePhase =
            /expansion|national\b|\b20\d{2}\b|phase\s*(2|two|ii)\b/i.test(seg)
              ? ("expansion" as const)
              : /\bpilot\b|first phase|phase\s*(1|one)\b/i.test(seg)
                ? ("pilot" as const)
                : null;
          const lineYear = seg.match(/\b(20\d{2})\b/)?.[1];
          // A rejection skips only the claim it binds to, never a neighbor.
          const scopeRejected = (value: string): boolean => {
            const R = /reject\w*|rule out|ruled out|declined/gi;
            let m: RegExpExecArray | null;
            while ((m = R.exec(seg))) {
              const cl = clauseAround(seg, m.index);
              if (
                UNIT_RE.test(cl) ||
                /scope/i.test(cl) ||
                cl.toLowerCase().includes(value.toLowerCase())
              )
                return true;
            }
            return false;
          };
          const pushScope = (value: string, idx: number) => {
            if (scopeRejected(value)) return;
            const before = claims.length;
            push("scope", value, idx);
            if (claims.length > before) {
              claims[claims.length - 1].phase = scopePhase;
              if (lineYear) claims[claims.length - 1].year = lineYear;
            }
          };
          {
            const narrowing = seg.match(
              new RegExp(
                "narrow[^.]*?\\bto\\s+(\\w+)\\s+" + UNIT + "\\s*(\\([^)]*\\))?",
                "i",
              ),
            );
            if (narrowing) {
              pushScope(
                `${narrowing[1]} ${narrowing[0].match(new RegExp(UNIT, "i"))?.[0] ?? "sites"}${narrowing[2] ?? ""}`,
                narrowing.index ?? 0,
              );
            } else {
              const before = claims.length;
              // Hyphenated counts: "the original four-site proposal".
              for (const m of seg.matchAll(
                new RegExp("\\b(" + NUMWORD_RE + ")-(" + UNIT + ")\\b", "gi"),
              ))
                pushScope(`${m[1]} ${m[2]}`, m.index);
              // Named lists: "East and West sites", "North and Central depots".
              for (const m of seg.matchAll(
                new RegExp(
                  "\\b([A-Z][a-z]+(?:\\s+and\\s+[A-Z][a-z]+)+)\\s+(?:[a-z][a-z-]*\\s+){0,4}(" +
                    UNIT +
                    ")\\b",
                  "g",
                ),
              ))
                pushScope(`${m[1]} ${m[2]}`, m.index);
              // Counts with up to three modifiers: "Four customer support sites".
              for (const m of seg.matchAll(
                new RegExp(
                  "\\b(" +
                    NUMWORD_RE +
                    ")\\b((?:\\s+[a-z][a-z-]*){0,3})\\s+(" +
                    UNIT +
                    ")\\b(\\s*\\([^)]*\\))?",
                  "gi",
                ),
              )) {
                // "phase-one sites" is a phase label, not a count.
                const before = seg.slice(
                  Math.max(0, (m.index ?? 0) - 8),
                  m.index ?? 0,
                );
                if (/(?:^|[^a-z])phase-\s*$/i.test(before) || /-$/.test(before))
                  continue;
                pushScope(
                  `${m[1]}${m[2]} ${m[3]}${m[4] ?? ""}`
                    .replace(/\s+/g, " ")
                    .trim(),
                  m.index,
                );
              }
              if (claims.length === before) {
                // Incomplete extraction fails CLOSED: a scope assertion whose
                // count token we cannot normalize is still recorded raw, so it
                // competes instead of vanishing and letting a neighbor win.
                const raw = seg.match(
                  new RegExp(
                    "\\b([a-z]+)\\s+" + UNIT + "\\s*(\\([^)]*\\))?",
                    "i",
                  ),
                );
                const RAW_STOP = new Set(
                  "the a an all these those both some many any our their its few more other each every which that this no only".split(
                    " ",
                  ),
                );
                if (
                  raw &&
                  !RAW_STOP.has(raw[1].toLowerCase()) &&
                  /confirm|approv|agree|decid|narrow|cover|expan|pilot|scope|phase/i.test(
                    seg,
                  )
                )
                  pushScope(
                    `${raw[1].toLowerCase()} ${raw[0].split(/\s+/).slice(1).join(" ")}`.trim(),
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
        const fwd = seg.match(
          new RegExp(
            `\\b(${CAD})\\b[^.]{0,50}?\\breplac\\w+[^.]{0,50}?\\b(${CAD})\\s+(?:progress\\s+)?report`,
            "i",
          ),
        );
        const rev = seg.match(
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
          push(
            "reporting",
            replacingCad.toLowerCase(),
            (fwd ?? rev)!.index ?? 0,
          );
        for (const m of seg.matchAll(
          /\b(weekly|daily|biweekly|monthly)\s+(?:progress\s+)?report/gi,
        )) {
          if (replacedCad && m[1].toLowerCase() === replacedCad) continue;
          push("reporting", m[1].toLowerCase(), m.index);
        }
        const lm = seg.match(/production launch|launch authorization/i);
        if (lm) {
          push(
            "launchApproval",
            /not recorded|not approved|outstanding|no signed/i.test(seg)
              ? "none-recorded"
              : "recorded",
            lm.index,
          );
        }
      }
    }
  }
  // Exact-duplicate collapse: a source that repeats an identical assertion
  // (boilerplate, repeated passages) yields one claim, not one per copy -
  // the copies carry no additional information, and citation uniqueness is
  // handled at the evidence layer (engine uniqueClaimEvidence).
  const seen = new Set<string>();
  claims = claims.filter((c) => {
    const k = `${c.sourceId}|${c.field}|${c.value}|${c.status}|${c.quote
      .trim()
      .replace(/[.!?\s]+$/, "")
      .toLowerCase()}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return claims;
}

const NUMWORD_TO_DIGIT: Record<string, string> = {
  one: "1",
  two: "2",
  three: "3",
  four: "4",
  five: "5",
  six: "6",
  seven: "7",
  eight: "8",
  nine: "9",
  ten: "10",
  eleven: "11",
  twelve: "12",
};
export const canonClaimValue = (v: string) =>
  String(v ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9/]+/g, " ")
    .trim();
/** Comparison key for counted/named scope values: "Two site", "TWO SITES"
 * and "East and West sites" are one count of one unit; different counts or
 * units differ. Null when the value carries no countable unit. */
export const countKeyOf = (v: string): string | null => {
  const s = String(v ?? "").toLowerCase();
  const m = s.match(
    /\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b[\s-]?(?:[a-z-]+[\s-]){0,3}?(regions?|sites?|depots?|stores?|locations?|branches?|markets?|countries|offices?|warehouses?|areas?)\b/,
  );
  if (m) {
    const n = NUMWORD_TO_DIGIT[m[1]] ?? m[1];
    return n + " " + m[2].replace(/s$/, "");
  }
  const named = s.match(
    /\b([a-z]+(?:\s+and\s+[a-z]+)+)\s+(?:[a-z-]+\s+){0,4}?(regions?|sites?|depots?|stores?|locations?|branches?|markets?|countries|offices?|warehouses?|areas?)\b/,
  );
  if (named) {
    const n = named[1].split(/\s+and\s+/).length;
    return n + " " + named[2].replace(/s$/, "");
  }
  return null;
};

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
  // Field-noun binding: with no named entities to establish the engagement,
  // a superseding statement must name the field it governs ("the current
  // launch target", "the revised fee"). Without that binding the records
  // compete - one PDF can hold several engagements and an unbound "current"
  // must not silently demote another engagement's values.
  const FIELD_NOUNS: Record<string, RegExp> = {
    fee: /\bfee|price|rate|retainer|amount|cost\b/i,
    paymentSplit: /\bsplit|percent|payment|upfront\b/i,
    signedAgreement: /\bagreement|contract|signed\b/i,
    retention: /\bretention|retain|keep\b/i,
    scope: /\bscope|site|region|phase\b/i,
    deadline: /\btarget|deadline|launch|date|timeline\b/i,
    signedAddendum: /\baddendum|dpa|processing\b/i,
    signatory: /\bsignatory|signs|signature\b/i,
    invoice: /\binvoice\b/i,
    termination: /\bterminat|cancel|exit\b/i,
  };
  // Local scope signature: distinctive capitalized phrases in the claim's
  // own sentence ("Alpha workstream"), excluding speaker prefixes, dates and
  // generic business words. Two claims from one document whose sentences
  // name different workstreams are not the same engagement.
  const LOCAL_STOP =
    /^(the|this|that|internal|approved|approval|current|proposed|revised|committee|finance|legal|security|action|outcome|status|date|note|yes|no|not|steering|customer|client|project|pilot|meeting|transcript|fictional|evaluation|only)$/i;
  const MONTH_DAY =
    /^(january|february|march|april|may|june|july|august|september|october|november|december|monday|tuesday|wednesday|thursday|friday|saturday|sunday)$/i;
  const COMMON_WORD =
    /^(the|this|that|these|those|only|with|from|they|them|then|than|when|what|which|there|their|some|such|each|also|just|even|more|most|less|very|much|many|here|after|before|during|between|under|over|both|same|other|another|every|never|always|still|again|once|now|all|any|few|own|per|via|said|says|noted|confirmed|asked|raised|explained|questioned|sought|shared|seconded|welcomed|following|narrower|one|two|three|four|five|six)$/i;
  // Identity evidence: distinctive names in the claim's own sentence, minus
  // the claim's own value words (East/West in "East and West sites" are the
  // VALUE, not an engagement identity).
  const localScopeOf = (quote: string, value?: string): string[] => {
    const body = (quote ?? "").replace(
      /^\s*[A-Z][a-z]{1,20}(?:\s*\([^)]*\))?\s*:\s*/,
      "",
    ); // speaker prefix
    const out: string[] = [];
    for (const m of body.matchAll(
      /\b([A-Z][a-z]{2,}(?:\s+[a-z]{2,}){1,2})\b/g,
    )) {
      const phrase = m[1].toLowerCase();
      const words = phrase.split(/\s+/);
      if (words.some((w) => LOCAL_STOP.test(w) || MONTH_DAY.test(w))) continue;
      out.push(phrase);
    }
    // Single identity words ("Alpha", "Beta") and letter-labeled customers
    // ("Customer A") are engagement boundaries too.
    for (const m of body.matchAll(/\b([A-Z][a-z]{2,})\b/g)) {
      const w = m[1].toLowerCase();
      if (!LOCAL_STOP.test(w) && !MONTH_DAY.test(w) && !COMMON_WORD.test(w))
        out.push("id:" + w);
    }
    for (const m of body.matchAll(/\bcustomer\s+([A-Z])\b/gi))
      out.push("customer:" + m[1].toLowerCase());
    // Subject descriptor: the noun naming what the field value attaches to
    // ("hosting fee", "license fee") - distinct descriptors are distinct
    // subjects even without capitalized workstream names.
    const GENERIC_MOD =
      /^(operational|current|revised|proposed|internal|tentative|commercial|opening|pilot|upfront|lower|earlier|formal|original|annual|monthly|quarterly|standard|regular|final|initial|new|old|first|second)$/i;
    const dm =
      /\b([a-z][a-z-]{3,})\s+(?:fees?|retainer|price|rate|split|scope|retention|target|deadline)\b/i.exec(
        body,
      );
    if (
      dm &&
      !LOCAL_STOP.test(dm[1]) &&
      !MONTH_DAY.test(dm[1]) &&
      !GENERIC_MOD.test(dm[1])
    )
      out.push("desc:" + dm[1].toLowerCase());
    const valueWords = new Set(
      (value ?? "").toLowerCase().match(/[a-z]{3,}/g) ?? [],
    );
    return [
      ...new Set(
        out.filter((tok) => {
          const w = tok.replace(/^(id|desc|customer):/, "");
          return ![...valueWords].some((vw) => w.includes(vw));
        }),
      ),
    ];
  };
  const sharesEngagement = (a: Claim, b: Claim) => {
    // Entities come from the document title and H1. When both sides name
    // none, the only engagement evidence is the document itself plus the
    // superseding statement's own field binding - checked by the caller.
    if (!a.scopeEntities.length || !b.scopeEntities.length)
      return a.sourceId === b.sourceId;
    const shared = a.scopeEntities.some((e) => b.scopeEntities.includes(e));
    if (!shared) return false;
    const aOnly = a.scopeEntities.some((e) => !b.scopeEntities.includes(e));
    const bOnly = b.scopeEntities.some((e) => !a.scopeEntities.includes(e));
    return !(aOnly && bOnly);
  };
  const active = new Map<string, Claim[]>();
  for (const [field, list] of byField) {
    // Self-declared supersession ("the earlier USD 58,000 fee proposal is
    // superseded") demotes that record and every older-or-equal record of
    // the SAME value in the same engagement - it never promotes anything.
    for (const self of list.filter((c) => c.supersededByWording)) {
      const cSelf = canonClaimValue(self.value);
      const kSelf = countKeyOf(self.value);
      const dSelf = self.value.replace(/[^\d]/g, "");
      for (const c of list) {
        if (superseded.includes(c)) continue;
        if (c.docDate && self.docDate && c.docDate > self.docDate) continue;
        // Without a date pair, only same-document position establishes
        // "earlier": an undated record in another document may be LATER than
        // the supersession statement and is never silently demoted by it.
        if (!c.docDate || !self.docDate) {
          if (c.sourceId !== self.sourceId || c.start > self.start) continue;
        }
        if (c.sourceId !== self.sourceId && !sharesEngagement(self, c))
          continue;
        const sameValue =
          canonClaimValue(c.value) === cSelf ||
          (kSelf !== null && countKeyOf(c.value) === kSelf) ||
          (dSelf.length > 2 && c.value.replace(/[^\d]/g, "") === dSelf);
        if (sameValue) superseded.push(c);
      }
    }
    const superseding = list.filter((c) => c.supersedes);
    for (const sup of superseding) {
      const supDate = sup.docDate || null;
      // An undated revision supersedes nothing: recency unestablished means
      // the records compete; it never silently demotes a dated record.
      if (!supDate) continue;
      for (const c of list) {
        if (c === sup || c.supersedes) continue;
        if (!sharesEngagement(sup, c)) continue; // engagement not established
        // Empty-entity same-document path: hold ambiguity unless the
        // superseding sentence itself binds this field.
        if (sup.sourceId === c.sourceId && !sup.scopeEntities.length) {
          // Field binding required...
          if (!(FIELD_NOUNS[field] ?? /$^/).test(sup.quote ?? "")) continue;
          // ...and identity evidence must positively match. A specific
          // identity conflict (Alpha vs Beta) outranks a shared generic
          // noun; distinct subject descriptors with no identity either way
          // also compete; unknown scope never collapses.
          const supScope = localScopeOf(sup.quote ?? "", sup.value);
          const cScope = localScopeOf(c.quote ?? "", c.value);
          const idsOf = (t: string[]) =>
            t.filter((x) => !x.startsWith("desc:"));
          const descsOf = (t: string[]) =>
            t.filter((x) => x.startsWith("desc:"));
          const supIds = idsOf(supScope);
          const cIds = idsOf(cScope);
          // A specific identity CONFLICT (both sides carry distinct
          // identity tokens) outranks a shared generic noun. A one-sided
          // token is not a conflict: terse revisions legitimately carry
          // fewer names than the opening record they replace.
          if (
            supIds.length &&
            cIds.length &&
            !supIds.some((x) => cIds.includes(x))
          )
            continue;
          if (
            !supIds.length &&
            !cIds.length &&
            descsOf(supScope).length &&
            descsOf(cScope).length &&
            !descsOf(supScope).some((x) => descsOf(cScope).includes(x))
          )
            continue;
        }
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
