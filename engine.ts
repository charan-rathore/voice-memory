import { contextReview } from "./context";
import { expandQuery, type QueryTransform } from "./query-expand";
import {
  extractClaims,
  questionFields,
  resolveClaims,
  type Claim,
  scopeEntitiesOf,
} from "./claim-check";

// Re-exported for the spoken renderer layer (spoken.mjs): the claim graph is
// the renderer's only source of facts. Additive; no behaviour change.
export { extractClaims, questionFields, resolveClaims };

export type QueryTransformInfo = {
  original: string;
  expanded: string;
  applied: QueryTransform[];
} | null;
export type RetrievalStagesInfo = {
  keyword: Array<{ title: string; score: number; rank: number }>;
  evidenceNote: string;
  candidateCount: number;
} | null;
import { createHash, randomUUID } from "node:crypto";
import { parseText } from "./vendor/memorable/src/import/text/parse-text";
import {
  retrieveFromRows,
  type SearchRow,
  type RetrieveResult,
} from "./vendor/web/src/lib/rag/retrieve-core";
import { chunkDocument } from "./vendor/web/src/lib/rag/chunking";
import { extractiveAnswer } from "./vendor/web/src/lib/rag/extractive";

const hash = (s: string) => createHash("sha256").update(s).digest("hex");
// Per-document text cap. Matches the ingestion pipeline's canonical-text limit
// (ingest/errors.mjs LIMITS.maxTextChars) so a parsed PDF is never truncated.
export const MAX_DOC_CHARS = 250000;

// Exact source span for a chunk, resolved at index time. Chunks after the
// first carry an overlap tail and table chunks may carry a repeated header,
// so the chunk text is often NOT a verbatim substring of the source. The
// chunk's own core (the chunk minus up to k leading lines) is, and searching
// from just after the previous chunk's anchor resolves repeated text (page
// boilerplate, repeated headings) to the right occurrence instead of failing
// closed. No anchor -> the chunk can never be cited (still fail-closed).
function anchorChunk(
  src: string,
  chunk: string,
  from: number,
): { start: number; end: number } | null {
  const lines = chunk.split("\n");
  for (let k = 0; k < Math.min(lines.length, 8); k++) {
    const core = lines.slice(k).join("\n").trim();
    if (core.length < 20 && k > 0) break;
    const at = src.indexOf(core, from);
    if (at >= 0) return { start: at, end: at + core.length };
  }
  return null;
}

export function importBundle(docs: Array<{ title: string; text: string }>) {
  if (!Array.isArray(docs) || !docs.length || docs.length > 10)
    throw Error("Add between 1 and 10 text documents.");
  const scope = "voice-" + randomUUID();
  const sources = docs.map((d) => {
    if (
      typeof d.title !== "string" ||
      typeof d.text !== "string" ||
      d.text.length < 40 ||
      d.text.length > MAX_DOC_CHARS ||
      d.title.length > 160
    )
      throw Error(
        "Each document needs a title and 40-250,000 characters of text.",
      );
    const text = d.text.replace(/\r\n?/g, "\n");
    const memory = parseText({ text, label: d.title });
    if (!memory.ok) throw Error("memoRABLE could not import this document.");
    return {
      id: randomUUID(),
      title: d.title,
      text,
      hash: hash(text),
      memory: memory.value,
    };
  });
  const anchors = new Map<string, { start: number; end: number }>();
  let unanchored = 0;
  const rows: SearchRow[] = sources.flatMap((s) => {
    let cursor = 0;
    return chunkDocument(s.text)
      .map((c) => {
        const id = randomUUID();
        const a = anchorChunk(s.text, c.text, cursor);
        if (a) {
          anchors.set(id, a);
          cursor = a.start + 1;
        } else unanchored++;
        return { c, id };
      })
      .map(({ c, id }) => ({
        title: s.title,
        slug: s.id,
        indexedAt: null,
        corpusId: scope,
        chunk: {
          id,
          document_id: s.id,
          ordinal: c.ordinal,
          text: c.text,
          token_count: c.tokenCount,
          heading: c.heading,
          embedding: null,
          embedding_model: null,
          content_hash: hash(c.text),
          created_at: new Date().toISOString(),
          filepath: null,
          language: null,
          symbol: null,
          chunk_kind: "prose",
          corpus_id: scope,
        },
      }));
  });
  return { scope, sources, rows, anchors, unanchored };
}
// Benchmark hook (evaluation/retrieval-bench.mjs): the raw keyword ranking
// the answer path starts from, before any claim logic or fallback. Additive;
// the answer path does not use it.
export function retrieveChunks(
  query: string,
  bundle: ReturnType<typeof importBundle>,
  topK = 3,
) {
  const r = retrieveFromRows({
    query,
    queryVector: null,
    mode: "keyword",
    topK,
    embeddingModel: null,
    rows: bundle.rows,
    storage: {
      backend: "ephemeral",
      durable: false,
      denseAvailable: false,
      warning: null,
    },
    corpusScope: { kind: "corpus", corpusId: bundle.scope },
  });
  return r.chunks.map((c) => ({
    title: c.title,
    text: c.text,
    rank: c.rank,
    score: c.score,
  }));
}
export function validateEvidence(
  c: any,
  bundle: ReturnType<typeof importBundle>,
) {
  const source = bundle.sources.find((s) => s.id === c.sourceId);
  if (
    !source ||
    source.hash !== c.hash ||
    hash(source.text) !== c.hash ||
    !Number.isInteger(c.start) ||
    !Number.isInteger(c.end) ||
    c.start < 0 ||
    c.end <= c.start ||
    c.end > source.text.length ||
    source.text.slice(c.start, c.end) !== c.quote
  )
    throw Error("Source evidence does not match its original.");
  return true;
}
export function answer(
  question: string,
  bundle: ReturnType<typeof importBundle>,
) {
  if (
    typeof question !== "string" ||
    !question.trim() ||
    question.length > 4000
  )
    throw Error("Ask a question of 1-4,000 characters.");
  const start = performance.now();
  const retrieve = (query: string) =>
    retrieveFromRows({
      query,
      queryVector: null,
      mode: "keyword",
      topK: 3,
      embeddingModel: null,
      rows: bundle.rows,
      storage: {
        backend: "ephemeral",
        durable: false,
        denseAvailable: false,
        warning: null,
      },
      corpusScope: { kind: "corpus", corpusId: bundle.scope },
    });
  // Original query wins. Expansion is a disclosed recall-recovery fallback,
  // only attempted when the untouched question grounds nothing.
  const fields = questionFields(question);
  let found = retrieve(question);
  let expansionUsed: ReturnType<typeof expandQuery> | null = null;
  if (found.evidence !== "positive") {
    const expansion = expandQuery(question);
    if (expansion.applied.length) {
      const widened = retrieve(expansion.expanded);
      if (widened.evidence === "positive") {
        found = widened;
        expansionUsed = expansion;
      }
    }
  }
  // Second disclosed recall-recovery fallback for questions the claim layer
  // does not cover: an entity-grounded rephrase (question content terms + the
  // engagement's primary entity) retries retrieval, and the retry is used only
  // when the question's own content terms are all present in the retrieved
  // chunks. Questions about facts the corpus does not contain keep the
  // original refusal; the retry can never manufacture evidence for them.
  // It runs only when retrieval found NOTHING relevant (negative): an
  // ambiguous result means competing passages exist, and a rephrase must
  // never adjudicate between them.
  let rephraseUsed: {
    original: string;
    rephrased: string;
    entity: string;
  } | null = null;
  if (found.evidence === "negative_not_found" && fields.length === 0) {
    const entities = new Map<string, { text: string; docs: number }>();
    for (const s of bundle.sources) {
      const h1 =
        s.text.split("\n").find((l: string) => l.startsWith("#")) ?? "";
      for (const e of scopeEntitiesOf(s.title, h1.replace(/^#+\s*/, ""))) {
        const cur = entities.get(e);
        entities.set(e, { text: e, docs: (cur?.docs ?? 0) + 1 });
      }
    }
    const primary = [...entities.values()].sort((a, b) => b.docs - a.docs)[0];
    const STOP = new Set(
      "which what are is the in for of did we our does do can i my there any this that when who how has have had was were will would should could been being be to a an and or on at by with from as it its if not no yes so but me us them they he she you your their his her".split(
        " ",
      ),
    );
    const contentTerms = [
      ...new Set(
        (question.toLowerCase().match(/[a-z]{3,}/g) ?? []).filter(
          (t) => !STOP.has(t) && !entities.has(t),
        ),
      ),
    ];
    if (primary && contentTerms.length) {
      const rephrased = [...contentTerms, primary.text].join(" ");
      const retry = retrieve(rephrased);
      if (retry.evidence === "positive") {
        const chunkText = retry.chunks
          .map((c) => c.text.toLowerCase())
          .join("\n");
        const covered = contentTerms.every((t) =>
          new RegExp(`\\b${t}\\b`, "i").test(chunkText),
        );
        if (covered) {
          found = retry;
          rephraseUsed = {
            original: question,
            rephrased,
            entity: primary.text,
          };
        }
      }
    }
  }
  const result = answerFromRetrieval(
    question,
    bundle,
    found,
    { actualMode: "keyword", embeddingModel: null },
    start,
  );
  // Narrow claim-to-source/state repair: stop stale positives, distinguish
  // proposed/discussed from agreed, and refuse timing questions answered only
  // by a condition.
  let claimsVerdict = false;
  if (fields.length) {
    const allClaims = extractClaims(bundle, fields);
    allClaims.forEach((c) => validateEvidence(c, bundle));
    // Phase isolation for scope claims: an approved 2027-expansion scope is
    // reported as a separate-phase record, never as the answer to a pilot
    // question, and it never supersedes pilot-phase records.
    const qPhase =
      /expansion|national\b|\b20\d{2}\b|phase\s*(2|two|ii)\b/i.test(question)
        ? "expansion"
        : /\bpilot\b|first phase|phase\s*(1|one)\b/i.test(question)
          ? "pilot"
          : null;
    const offPhase = qPhase
      ? allClaims.filter(
          (c) => c.field === "scope" && c.phase && c.phase !== qPhase,
        )
      : (() => {
          // Phase-less question: when both pilot and expansion scope exist,
          // the expansion claims are a separate phase, not current scope.
          const scopeClaims = allClaims.filter((c) => c.field === "scope");
          return scopeClaims.some((c) => c.phase === "pilot")
            ? scopeClaims.filter((c) => c.phase === "expansion")
            : [];
        })();
    // Year binding: a question naming a year resolves scope claims carrying
    // that year; claims of another stated year are a separate period, never
    // the answer, and a neighbor year can never win by default.
    const qYear = question.match(/\b(20\d{2})\b/)?.[1] ?? null;
    const offYear = qYear
      ? allClaims.filter(
          (c) =>
            c.field === "scope" &&
            (!c.year || c.year !== qYear) &&
            !offPhase.includes(c),
        )
      : [];
    // Entity scoping: a question naming an engagement entity resolves only
    // claims whose documents share it; documents with an established but
    // foreign entity drop out, entity-less documents stay (caution).
    const GENERIC_Q = new Set(
      "what which when where who whose why how is are was were can could does do did the a an in on at for to of as it this that i we my our has have had first second phase pilot regions region scope areas cover weekly daily monthly reporting report fee payment deadline signoff launch january february march april may june july august september october november december north south east west".split(
        " ",
      ),
    );
    const qEnts = (question.match(/\b[A-Z][a-zA-Z]+\b/g) ?? [])
      .map((w) => w.toLowerCase())
      .filter((w) => w.length > 2 && !GENERIC_Q.has(w));
    const entTokOf = (c: Claim) =>
      new Set(
        (c.scopeEntities ?? [])
          .flatMap((e) => e.split(" "))
          .map((t) => t.toLowerCase())
          .filter((t) => t.length > 2),
      );
    let claims =
      offPhase.length || offYear.length
        ? allClaims.filter((c) => !offPhase.includes(c) && !offYear.includes(c))
        : allClaims;
    if (qEnts.length) {
      claims = claims.filter((c) => {
        const toks = entTokOf(c);
        if (toks.size === 0) return true; // unestablished: stays (caution)
        return qEnts.some((e) => toks.has(e));
      });
    }
    const { active, superseded, approved } = resolveClaims(claims);
    const claimInfo = (c: Claim) =>
      `${c.value} (${c.title}${c.docDate ? ", " + c.docDate : ""}; status: ${c.status})`;
    const phaseNote = offPhase.length
      ? " Separate-phase record(s): " +
        [
          ...new Map(
            offPhase.map((c) => [c.value + "|" + c.title, claimInfo(c)]),
          ).values(),
        ].join("; ") +
        "."
      : "";
    const noteOf = (list: Claim[], label: string) =>
      list.length
        ? " " +
          label +
          ": " +
          [
            ...new Map(
              list.map((c) => [c.value + "|" + c.title, claimInfo(c)]),
            ).values(),
          ].join("; ") +
          "."
        : "";
    const yearNote =
      noteOf(
        offYear.filter((c) => c.year),
        "Separate-period record(s)",
      ) +
      noteOf(
        offYear.filter((c) => !c.year),
        "Undated-period record(s)",
      );
    if (
      qYear &&
      fields.includes("scope") &&
      offYear.length &&
      !claims.some((c) => c.field === "scope")
    ) {
      // The question asserts a period no claim is bound to: a yearless or
      // other-year record must not fill it implicitly - say so and disclose.
      result.refused = true;
      result.supported = false;
      result.unresolved = false;
      result.evidence = [];
      result.reviewEvidence =
        offYear as unknown as typeof result.reviewEvidence;
      result.evidenceStatus = "insufficient";
      result.answer =
        `The documents do not tie a region scope to ${qYear}: no record states a region count for that year.` +
        yearNote;
      result.spoken = result.answer;
    } else if (
      fields.includes("signoffTiming") &&
      !claims.some((c) => c.field === "signoffTiming")
    ) {
      const conditions = claims.filter((c) => c.field === "signoffWho");
      result.refused = true;
      result.supported = false;
      result.unresolved = false;
      result.evidence = [];
      result.reviewEvidence =
        conditions as unknown as typeof result.reviewEvidence;
      result.evidenceStatus = "insufficient";
      result.answer =
        "The record mentions sign-off only as a condition; no timing for sign-off is established in these documents." +
        (conditions.length
          ? " Related condition: " +
            conditions.map((c) => `"${c.quote}" (${c.title})`).join("; ")
          : "");
      result.spoken = result.answer;
    } else {
      const GENERIC_TOK = new Set([
        "proposal",
        "notes",
        "kickoff",
        "pilot",
        "log",
        "internal",
        "action",
        "update",
        "updates",
        "minutes",
        "plan",
        "client",
        "memo",
        "revision",
        "steering",
        "agreement",
        "board",
        "weekly",
        "report",
        "reporting",
        "summary",
        "retail",
      ]);
      const shareTok = (a: Claim, b: Claim) => {
        const tok = (c: Claim) =>
          (c.scopeEntities ?? [])
            .flatMap((e) => e.split(" "))
            .map((t) => t.toLowerCase())
            .filter((t) => t.length > 2 && !GENERIC_TOK.has(t));
        const A = new Set(tok(a));
        for (const t of tok(b)) if (A.has(t)) return true;
        return false;
      };
      // Number words and digits are the same count: "8 regions" and "eight
      // regions" must agree, never compete. Display values stay as written.
      const NUMWORD: Record<string, string> = {
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
      const normValue = (v: string) =>
        v
          .toLowerCase()
          .replace(
            /\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b/g,
            (w) => NUMWORD[w],
          );
      const conflicts: string[] = [];
      const histories: string[] = [];
      const approvedNotes: string[] = [];
      for (const [field, list] of active) {
        const appr = (approved.get(field) ?? []).filter((c) =>
          list.includes(c),
        );
        const apprValues = [...new Set(appr.map((c) => normValue(c.value)))];
        // Only an ESTABLISHED foreign engagement conflicts: a claim whose
        // document names distinctive entities sharing none with the approved
        // record. Entity-less claims cannot establish foreign-ness.
        const crossEngagementConflict =
          apprValues.length === 1 &&
          list.some((c) => {
            if (normValue(c.value) === apprValues[0] || shareTok(appr[0], c))
              return false;
            return (c.scopeEntities ?? []).some(
              (e) =>
                e.split(" ").filter((t) => t.length > 2 && !GENERIC_TOK.has(t))
                  .length > 0,
            );
          });
        if (apprValues.length === 1 && !crossEngagementConflict) {
          // An explicitly approved record is authoritative over proposals and
          // discussion; newer non-approved records are named but cannot displace it.
          // Non-authoritative context records must belong to the approved
          // record's own engagement: an unrelated document that merely shares
          // a keyword (a newsletter's "weekly report") is not context.
          // Keep same-engagement and entity-less records; drop only records
          // with an established FOREIGN entity (distinctive tokens, none
          // shared with the approved record's engagement).
          const others = list.filter((c) => {
            if (c.status === "approved") return false;
            if (shareTok(appr[0], c)) return true;
            const foreign = (c.scopeEntities ?? []).some(
              (e) =>
                e.split(" ").filter((t) => t.length > 2 && !GENERIC_TOK.has(t))
                  .length > 0,
            );
            return !foreign;
          });
          approvedNotes.push(
            `${field}: approved record ${claimInfo(appr[0])}` +
              (others.length
                ? "; non-authoritative record(s): " +
                  [
                    ...new Map(
                      others.map((c) => [
                        c.value + "|" + c.title,
                        claimInfo(c),
                      ]),
                    ).values(),
                  ].join("; ")
                : ""),
          );
          continue;
        }
        const values = [...new Set(list.map((c) => normValue(c.value)))];
        if (apprValues.length > 1 || values.length > 1) {
          conflicts.push(`${field}: ` + list.map(claimInfo).join(" vs "));
        } else if (values.length === 1) {
          const sup = superseded.filter((c) => c.field === field);
          // The current record of a value is its newest dated claim:
          // extraction order never silently outranks recency.
          const cur = [...list].sort((a, b) =>
            (b.docDate || "").localeCompare(a.docDate || ""),
          )[0];
          if (cur.status !== "approved") {
            const seen = new Set<string>();
            const supInfo = sup
              .filter((c) => {
                const k = c.value + "|" + c.title;
                if (seen.has(k)) return false;
                seen.add(k);
                return true;
              })
              .map(claimInfo)
              .join("; ");
            histories.push(
              `${field}: current record ${claimInfo(cur)} - status ${cur.status}; approval is not established by this check` +
                (sup.length
                  ? "; earlier superseded record(s): " + supInfo
                  : ""),
            );
          }
        }
      }
      if (conflicts.length) {
        claimsVerdict = true;
        result.unresolved = true;
        result.supported = false;
        result.partial = false;
        result.partialNotice = null;
        result.reviewEvidence =
          claims as unknown as typeof result.reviewEvidence;
        const supInfo2 = [
          ...new Map(
            superseded.map((c) => [c.field + c.value + c.title, claimInfo(c)]),
          ).values(),
        ].join("; ");
        result.answer =
          "The record contains unresolved competing statements. " +
          conflicts.map((c) => "Competing records - " + c).join(" ") +
          (supInfo2 ? " Superseded record(s): " + supInfo2 + "." : "") +
          " No supported current answer is available until these are reconciled.";
        result.spoken = result.answer;
      } else if (histories.length) {
        claimsVerdict = true;
        // Compose from claims only: no raw excerpt may follow that reasserts a
        // superseded value as current or a proposed value as agreed.
        const currentQuotes = [...active.values()]
          .flat()
          .filter(
            (c, i, arr) => arr.findIndex((x) => x.quote === c.quote) === i,
          )
          .map((c) => `"${c.quote}" (${c.title})`)
          .join("; ");
        result.refused = false;
        result.supported = true;
        result.unresolved = false;
        result.partial = true;
        result.partialNotice = histories.join(" ") + phaseNote + yearNote;
        result.evidence = claims as unknown as typeof result.evidence;
        result.answer =
          "Record status: " +
          histories.join(" ") +
          phaseNote +
          yearNote +
          (currentQuotes ? "\nCurrent record: " + currentQuotes : "");
        result.spoken = result.answer.replace(/\n/g, " ");
      } else if (approvedNotes.length) {
        claimsVerdict = true;
        // A claims-derived definitive verdict owns the flags: do not leave a
        // stale retrieval-level refusal attached to a supported answer. A
        // retrieval refusal tail is never appended to a claims verdict - the
        // verdict carries its own provenance.
        const retrievalTail = result.refused ? "" : "\n\n" + result.answer;
        result.refused = false;
        result.supported = true;
        result.unresolved = false;
        result.partial = false;
        result.partialNotice = null;
        result.answer =
          "Record status: " +
          approvedNotes.join(" ") +
          phaseNote +
          yearNote +
          retrievalTail;
        result.spoken =
          "Record status: " +
          approvedNotes.join(" ") +
          " The cited passages are on screen.";
      }
      // A who-question about sign-off is scoped to what the record states:
      // a named team and a condition, never a named approver or a completed act.
      if (fields.includes("signoffWho") && result.supported) {
        const who = claims.filter((c) => c.field === "signoffWho");
        if (who.length) {
          const named = [...new Set(who.map((c) => c.value))].join(" and ");
          result.answer =
            `The record states the terms are subject to ${named} sign-off - a named team and a condition, not a named approver, and not evidence that sign-off has occurred. ` +
            `Source: "${who[0].quote}" (${who[0].title}).`;
          result.partial = false;
          result.partialNotice = null;
          result.spoken = result.answer;
        }
      }
    }
  }
  // Honest-response guard for excerpt-only positives (no claims verdict):
  // an excerpt dump is not an answer when it cannot contain the asked fact -
  // a specific artifact ID absent from the evidence, a quantity the evidence
  // does not contain, or an entity the question names that appears nowhere in
  // the evidence. Shared retrieval core untouched; this is demo-layer only.
  if (!claimsVerdict && result.supported && result.evidence?.length) {
    const exText = result.evidence
      .map((e) => (e as { quote?: string }).quote ?? "")
      .join("\n")
      .toLowerCase();
    const ids = question.match(/\b[A-Z]{2,}-\d+\b/g) ?? [];
    const idMiss = ids.some((id) => !exText.includes(id.toLowerCase()));
    // "Was the budget approved?" asks about a status, not a quantity: the
    // quantity gate applies only when no status verb is the thing asked.
    const statusQ =
      /^\s*(?:was|were|is|are|has|have|had|did|does|do)\b[^?]*\b(?:approv\w*|sign\w*|confirm\w*|finali[sz]\w*|reject\w*|agreed|accepted|cleared|released)\b/i.test(
        question,
      ) && !/\bhow (?:much|many)\b/i.test(question);
    const quantitative =
      !statusQ &&
      /\brevenue|budget|turnover|profit|margin|sales|price|amount|how much|how many\b/i.test(
        question,
      );
    // A bare year is not a quantity: require currency, percent, scale, a
    // comma-grouped number, or a bare 5+ digit figure that is not a year.
    const hasQuantity =
      /[$€£₹]\s?\d|\d[\d,]*\s*%|\b(?!19\d{2}\b|20\d{2}\b)\d{5,}\b|\b\d{1,3}(?:,\d{3})+\b|\b\d+(?:\.\d+)?\s*(?:million|billion|thousand|lakh|crore)\b/i.test(
        exText,
      );
    const metricQ = question.match(
      /\b(revenue|budget|turnover|profit|margin|sales|cost|price|amount)\b/i,
    );
    let quantOk = hasQuantity;
    // "How many <things>": a small count is still a count. Accept a plain
    // number only when it directly precedes the asked head noun in the
    // evidence ("recorded 81 open items"); a year, an ID or a number attached
    // to some other noun never answers it.
    const countQ =
      /\bhow many\s+((?:[a-z-]+\s+){0,3}?[a-z-]+?)(?:\s+(?:did|do|does|are|is|were|was|has|have|had|will|can|could|should|would|in|on|for|at|of)\b|[?.!]|$)/i.exec(
        question,
      );
    if (quantitative && !hasQuantity && countQ && !metricQ) {
      const head = countQ[1].trim().split(/\s+/).pop()!.toLowerCase();
      const stem = head.replace(/(es|s)$/, "");
      if (stem.length >= 3)
        quantOk = new RegExp(
          `\\b(?!(?:19|20)\\d{2}\\b)\\d{1,4}(?:\\.\\d+)?\\s+(?:[a-z-]+\\s+){0,2}${stem.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\w*\\b`,
          "i",
        ).test(exText);
    }
    if (quantitative && hasQuantity && metricQ) {
      // The asked metric must own the quantity: the nearest metric noun to
      // the left of a quantity in its sentence must be that metric, so
      // "marketing spend was $2,000,000" never answers a revenue question.
      const asked = metricQ[1].toLowerCase();
      quantOk = false;
      for (const sentence of exText.split(/[.!?\n]/)) {
        for (const q of sentence.matchAll(
          /[$€£₹]\s?\d[\d,]*|\b(?!19\d{2}\b|20\d{2}\b)\d{5,}\b|\b\d{1,3}(?:,\d{3})+\b|\b\d+(?:\.\d+)?\s*(?:million|billion|thousand|lakh|crore)\b/gi,
        )) {
          const left = sentence.slice(0, q.index);
          const nouns = [
            ...left.matchAll(
              /(revenue|budget|turnover|profit|margin|sales|cost|price|amount|spend|fee|charge)/gi,
            ),
          ];
          if (
            nouns.length &&
            nouns[nouns.length - 1][1].toLowerCase() === asked
          ) {
            quantOk = true;
            break;
          }
        }
        if (quantOk) break;
      }
    }
    const QSTOP = new Set(
      "what which when where who whose why how is are was were can could does do did the a an in on at for to of as it this that i we my our has have had january february march april may june july august september october november december north south east west".split(
        " ",
      ),
    );
    const qEnts = (question.match(/\b[A-Z][a-zA-Z]+\b/g) ?? [])
      .map((w) => w.toLowerCase())
      .filter((w) => w.length > 2 && !QSTOP.has(w));
    const entMiss = qEnts.some((e) => !exText.includes(e));
    if (idMiss || (quantitative && !quantOk) || entMiss) {
      result.reviewEvidence =
        result.evidence as unknown as typeof result.reviewEvidence;
      result.evidence = [];
      result.refused = true;
      result.supported = false;
      result.unresolved = result.evidenceStatus === "ambiguous";
      result.evidenceStatus = "insufficient";
      result.partial = false;
      result.partialNotice = null;
      result.answer =
        "The documents do not establish an answer to this question: the closest passages do not contain the asked fact. They are on screen for review.";
      result.spoken = result.answer;
    }
  }
  result.queryTransform = expansionUsed
    ? {
        original: expansionUsed.original,
        expanded: expansionUsed.expanded,
        applied: expansionUsed.applied,
      }
    : rephraseUsed
      ? {
          original: rephraseUsed.original,
          expanded: rephraseUsed.rephrased,
          applied: [
            {
              from: rephraseUsed.original,
              to: rephraseUsed.rephrased,
              kind: "dictionary" as const,
            },
          ],
        }
      : null;
  result.retrievalStages = {
    keyword: found.stages.keyword.map((r) => ({
      title: r.title,
      score: r.score,
      rank: r.rank,
    })),
    evidenceNote: found.evidenceNote,
    candidateCount: found.candidateCount,
  };
  // A refusal or unresolved verdict never carries a partial notice: the
  // notice speaks of cited passages, and a refused answer cites none.
  if (result.refused || result.unresolved) {
    result.partial = false;
    result.partialNotice = null;
  }
  return result;
}
export function answerFromRetrieval(
  question: string,
  bundle: ReturnType<typeof importBundle>,
  found: RetrieveResult,
  expected: {
    actualMode: "keyword" | "dense" | "hybrid";
    embeddingModel: string | null;
  },
  start = performance.now(),
) {
  if (
    !found ||
    !Array.isArray(found.chunks) ||
    found.actualMode !== expected.actualMode ||
    !["keyword", "dense", "hybrid"].includes(expected.actualMode) ||
    (expected.actualMode !== "keyword" && !expected.embeddingModel)
  )
    throw Error("Retrieval mode contract mismatch.");
  if (
    !["positive", "negative_not_found", "insufficient", "ambiguous"].includes(
      found.evidence,
    )
  )
    throw Error("Retrieval evidence contract mismatch.");
  if (found.corpusScope !== "corpus" || found.corpusId !== bundle.scope)
    throw Error("Retrieval corpus contract mismatch.");
  for (const chunk of found.chunks) {
    if (
      chunk.corpusId !== bundle.scope ||
      (expected.actualMode !== "keyword" &&
        chunk.embeddingModel !== expected.embeddingModel)
    )
      throw Error("Retrieval corpus/model contract mismatch.");
  }
  const cited = new Set<string>();
  const evidence = found.chunks.flatMap((chunk) => {
    const source = bundle.sources.find((s) => s.id === chunk.documentId);
    if (!source) return [];
    // Index-time anchor first (exact span, repeat-safe). Bundles built
    // without anchors keep the original unique-substring rule.
    const anchor = bundle.anchors?.get(chunk.chunkId);
    let offset: number;
    let end: number;
    if (anchor) {
      offset = anchor.start;
      end = anchor.end;
    } else {
      offset = source.text.indexOf(chunk.text);
      if (offset < 0 || source.text.indexOf(chunk.text, offset + 1) !== -1)
        return [];
      end = offset + chunk.text.length;
    }
    const c = {
      sourceId: source.id,
      title: source.title,
      hash: source.hash,
      start: offset,
      end,
      firstLine: source.text.slice(0, offset).split("\n").length,
      lastLine: source.text.slice(0, end).split("\n").length,
      quote: source.text.slice(offset, end),
    };
    validateEvidence(c, bundle);
    cited.add(chunk.chunkId);
    return [c];
  });
  const chunks = found.chunks.filter((c) => cited.has(c.chunkId));
  const refused = found.evidence !== "positive" || !chunks.length;
  const review = contextReview(bundle, validateEvidence);
  return {
    question,
    context: review,
    answer:
      found.evidence === "ambiguous"
        ? "Several passages are relevant, but this question remains unresolved. Review the original passages; no supported answer or draft is available."
        : refused
          ? "I could not find supporting passages in these documents."
          : extractiveAnswer(question, chunks).replace(
              " Add a model in Settings to reason across them.",
              "",
            ),
    evidence: refused ? [] : evidence,
    reviewEvidence: found.evidence === "ambiguous" ? evidence : [],
    supported: !refused,
    unresolved: found.evidence === "ambiguous",
    refused,
    evidenceStatus: found.evidence,
    actualMode: found.actualMode,
    embeddingModel: expected.embeddingModel,
    corpusId: bundle.scope,
    generation: false,
    mode: `Local ${found.actualMode} retrieval + source excerpts. No generated synthesis.`,
    latencyMs: Math.round(performance.now() - start),
    partial: !refused && review.reviewNeeded,
    partialNotice:
      !refused && review.reviewNeeded
        ? "Partial: cited passages are real evidence, but the record contains unresolved, conditional or conflicting statements on related points. Review the open items before treating this as settled."
        : null,
    queryTransform: null as QueryTransformInfo,
    retrievalStages: null as RetrievalStagesInfo,
    // Text composed to be spoken aloud by the voice adapter, when claim-level
    // logic rewrote the answer. Null means the adapter's generic wrapper is
    // appropriate. Spoken output must carry the same safeguards as the
    // written answer: record status first, conflicts named, no silent
    // recency-as-authority.
    spoken: null as string | null,
  };
}
export function draft(
  result: ReturnType<typeof answer>,
  bundle: ReturnType<typeof importBundle>,
) {
  if (result.refused || result.unresolved || !result.evidence.length)
    throw Error(
      "Find supporting, reconciled evidence before creating a draft.",
    );
  result.evidence.forEach((c) => validateEvidence(c, bundle));
  const review = contextReview(bundle, validateEvidence);
  const refs = new Map<string, number>();
  const quote = (e: any) => {
    validateEvidence(e, bundle);
    const key = e.sourceId + ":" + e.start;
    if (!refs.has(key)) refs.set(key, refs.size + 1);
    return `"${e.quote}" [${refs.get(key)}: ${e.title}, line ${e.firstLine}]`;
  };
  const section = (name: string, items: any[]) =>
    items.length ? name + "\n" + items.map(quote).join("\n") + "\n\n" : "";
  const body =
    "Hi,\n\nBefore our next conversation, I would like to align on: " +
    result.question +
    "\n\n" +
    section(
      "Changes mentioned in the record (not independently confirmed as current)",
      review.groups.changes,
    ) +
    section("Open items that need an update", review.groups.open) +
    section("Conditions that must not be dropped", review.groups.conditions) +
    section(
      "Decision statements to reconcile (includes proposals and refusals)",
      review.groups.decisions,
    ) +
    (refs.size ? "" : section("Relevant source evidence", result.evidence)) +
    "Could you confirm which decision statements are current and authoritative, and the owner and next update for each unresolved item? If a later decision superseded one above, please point us to that record.\n\n" +
    "Suggested next step for review: reconcile any conflicting decision statements and satisfy the recorded conditions before communicating an unconditional commitment.\n\nThanks";
  return {
    subject:
      "Confirm decisions and open items: " + result.question.slice(0, 90),
    body,
    notice:
      "Rule-based review draft across all imported documents. May include off-topic signals. Check relevance, chronology, authority and recipients. Nothing sent.",
  };
}
