import { contextReview } from "./context";
import { expandQuery, type QueryTransform } from "./query-expand";
import {
  extractClaims,
  questionFields,
  resolveClaims,
  type Claim,
} from "./claim-check";

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
import { parseText } from "../../../memorable/src/import/text/parse-text";
import {
  retrieveFromRows,
  type SearchRow,
  type RetrieveResult,
} from "../../web/src/lib/rag/retrieve-core";
import { chunkDocument } from "../../web/src/lib/rag/chunking";
import { extractiveAnswer } from "../../web/src/lib/rag/extractive";

const hash = (s: string) => createHash("sha256").update(s).digest("hex");
export function importBundle(docs: Array<{ title: string; text: string }>) {
  if (!Array.isArray(docs) || !docs.length || docs.length > 10)
    throw Error("Add between 1 and 10 text documents.");
  const scope = "voice-" + randomUUID();
  const sources = docs.map((d) => {
    if (
      typeof d.title !== "string" ||
      typeof d.text !== "string" ||
      d.text.length < 40 ||
      d.text.length > 60000 ||
      d.title.length > 160
    )
      throw Error(
        "Each document needs a title and 40-60,000 characters of text.",
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
  const rows: SearchRow[] = sources.flatMap((s) =>
    chunkDocument(s.text).map((c) => ({
      title: s.title,
      slug: s.id,
      indexedAt: null,
      corpusId: scope,
      chunk: {
        id: randomUUID(),
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
    })),
  );
  return { scope, sources, rows };
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
  const fields = questionFields(question);
  if (fields.length) {
    const claims = extractClaims(bundle, fields);
    claims.forEach((c) => validateEvidence(c, bundle));
    const { active, superseded, approved } = resolveClaims(claims);
    const claimInfo = (c: Claim) =>
      `${c.value} (${c.title}${c.docDate ? ", " + c.docDate : ""}; status: ${c.status})`;
    if (
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
      const conflicts: string[] = [];
      const histories: string[] = [];
      const approvedNotes: string[] = [];
      for (const [field, list] of active) {
        const appr = (approved.get(field) ?? []).filter((c) =>
          list.includes(c),
        );
        const apprValues = [...new Set(appr.map((c) => c.value))];
        if (apprValues.length === 1) {
          // An explicitly approved record is authoritative over proposals and
          // discussion; newer non-approved records are named but cannot displace it.
          const others = list.filter((c) => c.status !== "approved");
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
        const values = [...new Set(list.map((c) => c.value))];
        if (apprValues.length > 1 || values.length > 1) {
          conflicts.push(`${field}: ` + list.map(claimInfo).join(" vs "));
        } else if (values.length === 1) {
          const sup = superseded.filter((c) => c.field === field);
          const cur = list[0];
          if (sup.length && cur.status !== "approved") {
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
              `${field}: current record ${claimInfo(cur)} - status ${cur.status}; approval is not established by this check; earlier superseded record(s): ` +
                supInfo,
            );
          }
        }
      }
      if (conflicts.length) {
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
        result.partialNotice = histories.join(" ");
        result.evidence = claims as unknown as typeof result.evidence;
        result.answer =
          "Record status: " +
          histories.join(" ") +
          (currentQuotes ? "\nCurrent record: " + currentQuotes : "");
        result.spoken = result.answer.replace(/\n/g, " ");
      } else if (approvedNotes.length) {
        // A claims-derived definitive verdict owns the flags: do not leave a
        // stale retrieval-level refusal attached to a supported answer.
        result.refused = false;
        result.supported = true;
        result.unresolved = false;
        result.partial = false;
        result.partialNotice = null;
        result.answer =
          "Record status: " + approvedNotes.join(" ") + "\n\n" + result.answer;
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
  result.queryTransform = expansionUsed;
  result.queryTransform = expansionUsed
    ? {
        original: expansionUsed.original,
        expanded: expansionUsed.expanded,
        applied: expansionUsed.applied,
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
  const evidence = found.chunks.flatMap((chunk) => {
    const source = bundle.sources.find((s) => s.id === chunk.documentId);
    if (!source) return [];
    const offset = source.text.indexOf(chunk.text);
    if (offset < 0 || source.text.indexOf(chunk.text, offset + 1) !== -1)
      return [];
    const c = {
      sourceId: source.id,
      title: source.title,
      hash: source.hash,
      start: offset,
      end: offset + chunk.text.length,
      firstLine: source.text.slice(0, offset).split("\n").length,
      lastLine: source.text.slice(0, offset + chunk.text.length).split("\n")
        .length,
      quote: chunk.text,
    };
    validateEvidence(c, bundle);
    return [c];
  });
  const chunks = found.chunks.filter((c) =>
    evidence.some((e) => e.sourceId === c.documentId && e.quote === c.text),
  );
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
