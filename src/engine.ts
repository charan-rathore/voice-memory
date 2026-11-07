import { lookupIdentifier } from "./identifier-support";
export { identifierRequest, lookupIdentifier } from "./identifier-support";
export { explicitRecordRequest } from "./requested-support";
import {
  missingRequestedSupport,
  requestedSupportSpans,
  explicitRequestedRoots,
  explicitRecordRequest,
} from "./requested-support";
import { contextReview } from "./context";
import {
  expandQuery,
  equivalentRewrite,
  type QueryTransform,
} from "./query-expand";
import { lineOf } from "./line-index";
export { lineOf, lineIndexCacheStats } from "./line-index";
import {
  extractClaims,
  questionFields,
  resolveClaims,
  countKeyOf,
  authorityOf,
  type Claim,
  scopeEntitiesOf,
} from "./claim-check";

// Re-exported for the spoken renderer layer (spoken.mjs): the claim graph is
// the renderer's only source of facts. Additive; no behaviour change.
export {
  extractClaims,
  questionFields,
  resolveClaims,
  authorityOf,
  retrieveIndexStats,
};

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
import { parseText } from "../vendor/memorable/src/import/text/parse-text";
import {
  retrieveIndexStats,
  retrieveFromRows,
  type SearchRow,
  type RetrieveResult,
} from "../vendor/web/src/lib/rag/retrieve-core";
import { chunkDocument } from "../vendor/web/src/lib/rag/chunking";
import { extractiveAnswer } from "../vendor/web/src/lib/rag/extractive";

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

// Workspaces hold up to 10 documents (library.mjs); the built-in voice corpus
// of every fictional case holds 11, so the engine's own bound is 16.
export function importBundle(
  docs: Array<{ id?: string; title: string; text: string }>,
  options: { scope?: string } = {},
) {
  if (!Array.isArray(docs) || !docs.length || docs.length > 16)
    throw Error("Add between 1 and 16 text documents.");
  if (
    options.scope !== undefined &&
    (typeof options.scope !== "string" ||
      !options.scope ||
      options.scope.length > 256)
  )
    throw Error(
      "A stable workspace scope must be a nonempty string of up to 256 characters.",
    );
  const scope = options.scope ?? "voice-" + randomUUID();
  const documentIds = new Set<string>();
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
    const stableId = options.scope !== undefined ? d.id : undefined;
    if (stableId !== undefined) {
      if (
        typeof stableId !== "string" ||
        !stableId ||
        documentIds.has(stableId)
      )
        throw Error(
          "Stable document IDs must be nonempty and unique within a workspace.",
        );
      documentIds.add(stableId);
    }
    const text = d.text.replace(/\r\n?/g, "\n");
    const memory = parseText({ text, label: d.title });
    if (!memory.ok) throw Error("memoRABLE could not import this document.");
    return {
      id: stableId ? hash(`${scope}\0${stableId}`) : randomUUID(),
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
    const occurrences = new Map<string, number>();
    return chunkDocument(s.text)
      .map((c) => {
        const contentKey = hash(c.text);
        const occurrence = occurrences.get(contentKey) ?? 0;
        occurrences.set(contentKey, occurrence + 1);
        const id = hash(`${s.id}\0${contentKey}\0${occurrence}`);
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
export { retrieveFromRows };
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
// Integrity digest of a source's CURRENT text, memoized per source object.
// validateEvidence runs for every candidate claim, and re-hashing the whole
// source each time was ~78% of answer time on a 240k-character document
// (~1.8 s per answer in a 2 vCPU sandbox). The memo is valid only while
// source.text is the same string: strings are immutable, so any change to
// the text is a new string, and a new string is hashed again. The check
// still compares the digest of the text as it is now with the citation.
const SOURCE_DIGESTS = new WeakMap<object, { text: string; digest: string }>();
const digestStats = { computed: 0, reused: 0 };
export function evidenceDigestStats() {
  return { ...digestStats };
}
function currentDigest(source: { text: string }) {
  const hit = SOURCE_DIGESTS.get(source);
  if (hit && hit.text === source.text) {
    digestStats.reused++;
    return hit.digest;
  }
  digestStats.computed++;
  const digest = hash(source.text);
  SOURCE_DIGESTS.set(source, { text: source.text, digest });
  return digest;
}
export function validateEvidence(
  c: any,
  bundle: ReturnType<typeof importBundle>,
) {
  const source = bundle.sources.find((s) => s.id === c.sourceId);
  if (
    !source ||
    source.hash !== c.hash ||
    currentDigest(source) !== c.hash ||
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
// Claim-derived evidence must satisfy the same exact-citation rule as chunk
// evidence: a quote that appears more than once in its source is not an
// exact citation. Identical repeated assertions collapse to one entry; a
// non-unique quote's span extends to sentence boundaries until it is unique
// (full source text is the final bound) - a repeated span is never presented
// as a pinpoint citation.
function uniqueClaimEvidence(
  claims: Claim[],
  bundle: ReturnType<typeof importBundle>,
): Claim[] {
  const out: Claim[] = [];
  const seen = new Set<string>();
  for (const c of claims) {
    const source = bundle.sources.find((s) => s.id === c.sourceId);
    if (!source) continue;
    const key = `${c.sourceId}|${c.field}|${c.value}|${c.status}|${c.quote
      .trim()
      .replace(/[.!?\s]+$/, "")
      .toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (source.text.indexOf(c.quote) === source.text.lastIndexOf(c.quote)) {
      out.push(c);
      continue;
    }
    let start = c.start;
    let end = c.end;
    let guard = 0;
    while (
      (start > 0 || end < source.text.length) &&
      guard++ < 10000 &&
      source.text.indexOf(source.text.slice(start, end)) !==
        source.text.lastIndexOf(source.text.slice(start, end))
    ) {
      if (start > 0) {
        const prev = source.text.lastIndexOf(". ", Math.max(0, start - 2));
        start = prev >= 0 ? prev + 2 : 0;
      }
      if (end < source.text.length) {
        const next = source.text.indexOf(". ", end);
        end = next >= 0 ? next + 1 : source.text.length;
      }
    }
    // A span widened past the claim's own sentence is a broad citation: it
    // proves the source, not a pinpoint location. Mark it so renderers never
    // present it as a pinpoint quote.
    out.push({
      ...c,
      start,
      end,
      quote: source.text.slice(start, end),
      broadCitation: true,
    } as Claim);
  }
  return out;
}

export function answer(
  question: string,
  bundle: ReturnType<typeof importBundle>,
  dense?: {
    queryVector: number[] | null;
    model: string;
    available: boolean;
  } | null,
) {
  if (
    typeof question !== "string" ||
    !question.trim() ||
    question.length > 4000
  )
    throw Error("Ask a question of 1-4,000 characters.");
  const start = performance.now();
  const primaryDense =
    dense && dense.queryVector && dense.available ? dense : null;
  const retrieve = (query: string) => {
    const useDense = primaryDense && query === question;
    return retrieveFromRows({
      query,
      queryVector: useDense ? primaryDense.queryVector : null,
      mode: useDense ? "hybrid" : "keyword",
      topK: 3,
      embeddingModel: useDense ? primaryDense.model : null,
      rows: bundle.rows,
      storage: {
        backend: "ephemeral",
        durable: false,
        denseAvailable: !!primaryDense,
        warning: null,
      },
      corpusScope: { kind: "corpus", corpusId: bundle.scope },
    });
  };
  // Original query wins. Expansion is a disclosed recall-recovery fallback,
  // only attempted when the untouched question grounds nothing.
  const fields = questionFields(question);
  let found = retrieve(question);
  const identifier = explicitRecordRequest(question, bundle.sources)
    ? null
    : lookupIdentifier(question, bundle.sources);
  if (identifier) {
    // Identifier values use exact declarative/record bindings, not relevance
    // scores or another field's nearby number. Keep canonical source spans.
    const result = answerFromRetrieval(
      question,
      bundle,
      found,
      {
        actualMode: found.actualMode,
        embeddingModel:
          found.actualMode === "keyword" ? null : (dense?.model ?? null),
      },
      start,
    );
    const bound = identifier.facts.map((fact) => {
      const source = bundle.sources.find((s) => s.id === fact.source.id);
      if (!source)
        throw Error("Identifier source does not match its original document.");
      return {
        sourceId: source.id,
        title: source.title,
        hash: source.hash,
        start: fact.start,
        end: fact.end,
        firstLine: lineOf(source.text, fact.start),
        lastLine: lineOf(source.text, fact.end),
        quote: source.text.slice(fact.start, fact.end),
      };
    });
    bound.forEach((e) => validateEvidence(e, bundle));
    result.reviewEvidence = identifier.supported
      ? []
      : bound.length
        ? bound
        : result.evidence;
    result.evidence = identifier.supported ? bound : [];
    result.supported = identifier.supported;
    result.refused = !identifier.supported;
    result.unresolved = identifier.ambiguous;
    result.evidenceStatus = identifier.supported
      ? "positive"
      : identifier.ambiguous
        ? "ambiguous"
        : "insufficient";
    result.answer = identifier.supported
      ? [...new Set(identifier.facts.map((f) => f.spoken))].join("\n")
      : identifier.ambiguous
        ? "The requested identifier is unresolved in these documents. Review the source records."
        : "I couldn't bind the requested identifier to this subject in these documents.";
    result.spoken = result.answer;
    result.partial = identifier.supported && result.context.reviewNeeded;
    if (!result.partial) result.partialNotice = null;
    result.mode = "Local source-bound identifier lookup with exact citations.";
    result.latencyMs = Math.round(performance.now() - start);
    return result;
  }

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
    // Appending keeps the caller's own word ("retained"), which the
    // evidence gate then counts as uncovered when the record only says
    // "retention". For a verified query-equivalent phrase only, retry once
    // with the record's term in place of the caller's. Disclosed like any
    // expansion; thresholds unchanged.
    const rewrite = expansionUsed ? null : equivalentRewrite(question);
    if (rewrite) {
      const swapped = retrieve(rewrite.expanded);
      if (swapped.evidence === "positive") {
        found = swapped;
        expansionUsed = rewrite;
      }
    }
  }
  // A positive result can still be the WRONG document: when the asked
  // metric's head word is absent from the retrieved text but a disclosed
  // expansion bridge lands on vocabulary the corpus actually uses
  // ("thyroid ... level" -> "tsh"), retry once with the expanded query and
  // keep it only when it retrieves positive text that carries the bridged
  // term. Original query still wins; this fires only when the original's
  // passages cannot contain the asked metric at all.
  if (!expansionUsed && found.evidence === "positive") {
    const mf =
      /\b([a-z][a-z-]{4,})\s+(?:level|count|reading|result|rate)\b/i.exec(
        question,
      );
    if (mf) {
      const foundText = found.chunks
        .map((c) => c.text)
        .join("\n")
        .toLowerCase();
      if (!foundText.includes(mf[1].toLowerCase())) {
        const expansion = expandQuery(question);
        const bridges = expansion.applied
          .flatMap((t) => t.to.toLowerCase().split(/\s+/))
          .filter((t) => t.length > 2);
        if (bridges.length) {
          const widened = retrieve(expansion.expanded);
          const wText = widened.chunks
            .map((c) => c.text)
            .join("\n")
            .toLowerCase();
          if (
            widened.evidence === "positive" &&
            bridges.some((b) => wText.includes(b))
          ) {
            found = widened;
            expansionUsed = expansion;
          }
        }
      }
    }
  }
  // Authority-scoped temporal questions ("according to our team", "our
  // internal deadline"): a positive answer drawn only from a counterparty
  // proposal must not silence the team's own record. Widen once with
  // disclosed team vocabulary and merge any additional records into the
  // pack so the claims layer can render competing statuses. Original query
  // still wins: existing chunks keep their rank; widened records only ADD
  // missing evidence.
  if (
    !expansionUsed &&
    found.evidence === "positive" &&
    /\b(?:our|my)\s+team\b|\bour\s+internal\b|\binternally\b/i.test(question) &&
    /\bwhen\b|\bdeadline\b|\bdue\b|\bready\b|\bexpected\b/i.test(question)
  ) {
    const widenedQuery = `${question} team internal delivery update target`;
    const widened = retrieve(widenedQuery);
    if (widened.evidence === "positive") {
      const seen = new Set(found.chunks.map((c) => `${c.title}|${c.text}`));
      const extra = widened.chunks.filter(
        (c) => !seen.has(`${c.title}|${c.text}`),
      );
      if (extra.length) {
        found = { ...found, chunks: [...found.chunks, ...extra] };
        expansionUsed = {
          original: question,
          expanded: widenedQuery,
          applied: [
            {
              from: "authority scope",
              to: "team internal delivery update target",
              kind: "dictionary",
            },
          ],
        };
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
  // When a disclosed expansion/rephrase grounded the chunks, passage-level
  // selection scores against that same disclosed vocabulary; otherwise an
  // expanded retrieval can surface the right chunk yet excerpt its head
  // instead of the matching sentence. Original query unchanged everywhere
  // else (claims fields, refusal wording, queryTransform disclosure).
  const result = answerFromRetrieval(
    question,
    bundle,
    found,
    {
      actualMode: found.actualMode,
      embeddingModel:
        found.actualMode === "keyword" ? null : (dense?.model ?? null),
    },
    start,
    expansionUsed?.expanded ?? rephraseUsed?.rephrased ?? undefined,
  );
  // Narrow claim-to-source/state repair: stop stale positives, distinguish
  // proposed/discussed from agreed, and refuse timing questions answered only
  // by a condition.
  let claimsVerdict = false;
  if (fields.length) {
    const extractedClaims = extractClaims(bundle, [
      ...new Set([...fields, "signedAgreement" as const]),
    ]);
    // Agreement-existence negatives feed the unsigned qualifier only; they
    // join the verdict pool when the question itself asks about agreements.
    const agNegClaims = extractedClaims.filter(
      (c) => c.field === "signedAgreement" && c.status === "unresolved",
    );
    const allClaims = fields.includes("signedAgreement")
      ? extractedClaims
      : extractedClaims.filter((c) => c.field !== "signedAgreement");
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
    // Subject anchoring: a claims verdict answers only about the subject the
    // question actually names. Field vocabulary and generic tokens are not
    // subjects. When NO surviving claim mentions any asked subject, the
    // claims layer stays silent and the excerpt path (with its honest-
    // response guard) decides - a claims verdict must never answer a
    // neighboring question ("solar array funding" is not the renewal fee).
    const FIELD_TOKEN = new Set(
      "fee fees invoice invoiced invoicing cost costs bill billed billing charg charge charged charging money commercial commercials paid pay payment payments split upfront installment installments deadline due pilot signoff launch approve approved approval authorize authorized authorization region regions scope area areas cover covers covered weekly daily biweekly monthly cadence progress report reporting status update current record records ask asked asking funding funded finance financed financing amount amounts price prices value values discount discounts structure terms revised final agree agreed proposal propose proposed quote quoted sign signing signed off timing expected date change changed discuss discussed decided decide decision steering committee board group team customer client legal finance internal original initially opening earlier previously history historical contract contracts addendum addenda signature signatory".split(
        " ",
      ),
    );
    // Pronouns, adverbs and degree words carry no subject either; without
    // this list "How will we bill them?" anchors on "them" and every plain
    // paraphrase would fall silent.
    const FILLER_Q = new Set(
      "anyone anybody someone somebody everyone everybody anything something nothing them they their theirs there here himself herself itself myself ourselves yourself finally currently initially originally now yet still already just really actually ever never always often much many more most less least very only even also back again once twice about into over under with without from this that these those what which when where whom whose while does doing done have having had been being were will would shall should may might must latest newest".split(
        " ",
      ),
    );
    // Tokenize on hyphens too: a hyphenated compound carries its parts'
    // vocabulary, so "status-update" is the field words "status update",
    // not an unmatched subject that silences the claims layer.
    const qSubjects = (
      question.toLowerCase().match(/\b[a-z]{4,}\b/g) ?? []
    ).filter(
      (t) => !GENERIC_Q.has(t) && !FIELD_TOKEN.has(t) && !FILLER_Q.has(t),
    );
    if (qSubjects.length && claims.length) {
      const anchored = claims.some((c) => {
        const hay =
          `${c.quote} ${c.title} ${(c.scopeEntities ?? []).join(" ")}`.toLowerCase();
        return qSubjects.some((s) => hay.includes(s));
      });
      if (!anchored) claims = [];
    }
    // A when-question asks for a date: a claims verdict whose cited records
    // contain no full date cannot answer it, whatever status they carry.
    if (/^\s*when\b/i.test(question) && claims.length) {
      // A when-question can be answered by a calendar date OR a relative
      // deadline ("within 45 days", "no later than 1 March"); only a claims
      // set with no temporal marker at all cannot answer it.
      const TEMPORAL =
        /\b\d{1,2}(?:st|nd|rd|th)?\s+(?:january|february|march|april|may|june|july|august|september|october|november|december)\b|\b(?:january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{1,2}|\b\d{4}-\d{2}-\d{2}\b|\b(?:within|no later than|by|every|per|each)\b[^.\n]{0,30}?\b\d+\s*(?:days?|weeks?|months?|hours?|years?)\b|\b\d+\s*(?:business )?(?:days?|weeks?|months?|hours?|years?)\b|\b(?:daily|weekly|biweekly|monthly|quarterly|annually|yearly)\b/i;
      if (!claims.some((c) => TEMPORAL.test(c.quote))) claims = [];
    }
    const { active, superseded, approved } = resolveClaims(claims);
    // "approval-limited-*" claims are negation records for actor-scoped
    // verdicts, never candidate VALUES in conflicts or history lists.
    const isLimitClaim = (c: Claim) => /^approval-limited-/.test(c.value);
    const claimInfo = (c: Claim) =>
      `${c.value} (${c.title}${c.docDate ? ", " + c.docDate : ""}; status: ${c.status}${
        c.authority && c.authority !== "unspecified"
          ? "; authority: " + c.authority
          : ""
      })`;
    const valueKey = (c: Claim) =>
      c.field === "scope"
        ? (countKeyOf(c.value) ?? c.value.toLowerCase().replace(/\s+/g, " "))
        : c.value.toLowerCase().replace(/\s+/g, " ");

    // Actor-scoped approval questions ("Did steering approve the fee?"): the
    // verdict comes from claims carrying THAT authority. Another authority's
    // approval of the same field, or the actor's approval of another field,
    // never answers it.
    const actorM = question.match(
      /\b(steering|committee|board|customer|client|finance|legal)\b/i,
    );
    const yesNoQ =
      /^(?:did|has|have|was|were|is|are|does|do)\b[^?]*\b(approv|accept|sign|agree|authoriz)/i.test(
        question,
      );
    if (actorM && yesNoQ) {
      const actor = /steering|committee|board/i.test(actorM[1])
        ? "body"
        : /customer|client/i.test(actorM[1])
          ? "client"
          : "internal";
      const relevant = claims.filter((c) => fields.includes(c.field));
      const actorClaims = relevant.filter(
        (c) => (c.authority ?? "unspecified") === actor,
      );
      const actorApproved = actorClaims.filter(
        (c) => c.status === "approved" && !isLimitClaim(c),
      );
      if (!actorApproved.length) {
        let negs = actorClaims.filter((c) => c.status === "unresolved");
        // Sign-off/signature asks with no actor claims: a recorded negative
        // agreement-existence fact on the client side is the answer.
        if (
          !negs.length &&
          (fields.includes("signoffWho") ||
            fields.includes("signedAgreement") ||
            fields.includes("signoffTiming"))
        )
          negs = claims.filter(
            (c) =>
              c.field === "signedAgreement" &&
              c.status === "unresolved" &&
              (actor !== "client" || /client|customer/i.test(c.value)),
          );
        const didApprove = claims.filter(
          (c) =>
            (c.authority ?? "unspecified") === actor &&
            c.status === "approved" &&
            !isLimitClaim(c) &&
            !fields.includes(c.field),
        );
        const otherApproved = fields
          .flatMap((f) => approved.get(f) ?? [])
          .filter((c) => !isLimitClaim(c));
        if (negs.length || didApprove.length) {
          claimsVerdict = true;
          result.refused = false;
          result.supported = true;
          result.unresolved = false;
          result.partial = false;
          result.partialNotice = null;
          result.evidenceStatus = "positive";
          result.evidence = uniqueClaimEvidence(
            [...negs, ...didApprove, ...otherApproved.slice(0, 1)],
            bundle,
          ) as unknown as typeof result.evidence;
          const negTxt = negs.length
            ? ` The record states: "${negs[0].quote}" (${negs[0].title}${negs[0].docDate ? ", " + negs[0].docDate : ""}).`
            : ` No ${actorM[1].toLowerCase()} approval of the asked item is recorded.`;
          const scopeTxt = didApprove.length
            ? ` ${actorM[1][0].toUpperCase() + actorM[1].slice(1).toLowerCase()} approval is recorded for ${[...new Set(didApprove.map((c) => c.field))].join(" and ")} only.`
            : "";
          const otherTxt = otherApproved.length
            ? ` The recorded approval here is ${otherApproved[0].authority ?? "unspecified"}: "${otherApproved[0].quote}" (${otherApproved[0].title}${otherApproved[0].docDate ? ", " + otherApproved[0].docDate : ""}).`
            : "";
          result.answer = "No." + negTxt + scopeTxt + otherTxt;
          result.spoken = result.answer;
        }
      }
    }

    // History intent ("What was the original fee?", "the revised fee in
    // August"): answer from the record's own chronology - earliest record or
    // the asked month's records - with status and supersession attached.
    const MONTH_NAMES =
      "january|february|march|april|may|june|july|august|september|october|november|december";
    const histAsk =
      /\b(original|originally|initial|initially|opening|earlier|previously|at the very beginning|first proposed|first propos)\b/i.test(
        question,
      );
    const monthAsk = question.match(
      new RegExp("\\b(" + MONTH_NAMES + ")\\b", "i"),
    );
    if (!claimsVerdict && (histAsk || monthAsk) && fields.length) {
      const pool: Claim[] = [[...active.values()].flat(), ...superseded].flat();
      const fieldClaims = pool.filter(
        (c) => fields.includes(c.field) && !isLimitClaim(c),
      );
      if (fieldClaims.length) {
        let chosen: Claim[] = [];
        let lead = "";
        if (monthAsk) {
          const mi = MONTH_NAMES.split("|").indexOf(monthAsk[1].toLowerCase());
          const monthNum = String(mi + 1).padStart(2, "0");
          // Year binding: an explicit year in the question wins; otherwise,
          // when records span years, the latest year's records answer and the
          // answer names the year - a hardcoded year never silently selects.
          const askYear = question.match(/\b(20\d{2})\b/)?.[1] ?? null;
          const inMonth = fieldClaims.filter(
            (c) =>
              c.docDate?.slice(5, 7) === monthNum &&
              (!askYear || c.docDate.startsWith(askYear)),
          );
          const years = [
            ...new Set(inMonth.map((c) => c.docDate!.slice(0, 4))),
          ].sort();
          const yearUsed = askYear ?? years[years.length - 1] ?? null;
          chosen = yearUsed
            ? inMonth.filter((c) => c.docDate!.startsWith(yearUsed))
            : [];
          lead = chosen.length
            ? `Records from ${monthAsk[1][0].toUpperCase() + monthAsk[1].slice(1).toLowerCase()}${yearUsed ? " " + yearUsed : ""}`
            : "";
        }
        if (!chosen.length && histAsk) {
          const sorted = [...fieldClaims].sort((a, b) =>
            (a.docDate || "").localeCompare(b.docDate || ""),
          );
          const firstKey = valueKey(sorted[0]);
          chosen = sorted.filter((c) => valueKey(c) === firstKey);
          lead = "The earliest record";
        }
        if (chosen.length) {
          claimsVerdict = true;
          const latest = [...fieldClaims].sort((a, b) =>
            (b.docDate || "").localeCompare(a.docDate || ""),
          )[0];
          const chosenKey = valueKey(chosen[0]);
          const laterNote =
            valueKey(latest) !== chosenKey
              ? ` Later record: ${claimInfo(latest)}.`
              : "";
          claimsVerdict = true;
          result.refused = false;
          result.supported = true;
          result.unresolved = false;
          result.partial = false;
          result.partialNotice = null;
          result.evidenceStatus = "positive";
          result.evidence = uniqueClaimEvidence(
            chosen,
            bundle,
          ) as unknown as typeof result.evidence;
          result.answer =
            `${lead}: ` +
            chosen
              .map(
                (c) =>
                  `${claimInfo(c)} - "${c.quote}" (${c.title}${c.docDate ? ", " + c.docDate : ""})`,
              )
              .join("; ") +
            "." +
            laterNote;
          result.spoken = result.answer;
        }
      }
    }
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
    if (claimsVerdict) {
      // An actor-scoped or history verdict above already owns the result.
    } else if (
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
    } else if (
      fields.includes("signedAgreement") &&
      claims.some((c) => c.field === "signedAgreement")
    ) {
      // Agreement-existence question with a recorded negative fact on file:
      // the record's own statement IS the answer. Surface it verbatim with
      // provenance; never infer later execution, and never let fee or
      // payment-split claims compete over a question they do not answer.
      claimsVerdict = true;
      const recorded = claims.filter((c) => c.field === "signedAgreement");
      result.refused = false;
      result.supported = true;
      result.unresolved = false;
      result.partial = false;
      result.partialNotice = null;
      result.evidenceStatus = "positive";
      result.evidence = uniqueClaimEvidence(
        recorded,
        bundle,
      ) as unknown as typeof result.evidence;
      result.answer =
        "The record states: " +
        recorded
          .map(
            (c) =>
              `"${c.quote}" (${c.title}${c.docDate ? ", " + c.docDate : ""})`,
          )
          .join("; ") +
        ". No signed agreement is on record for the revised terms; these documents do not establish that one was later executed.";
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
      const agNeg = agNegClaims;
      const clientQualifier = (field: string, list: Claim[]) => {
        let out = "";
        const clientNeg = list.filter(
          (c) => c.authority === "client" && c.status === "unresolved",
        );
        if (clientNeg.length)
          out += `; client acceptance: not recorded - "${clientNeg[0].quote}" (${clientNeg[0].title}${clientNeg[0].docDate ? ", " + clientNeg[0].docDate : ""})`;
        if (
          (field === "fee" || field === "paymentSplit") &&
          agNeg.length &&
          !/unsigned|not signed|no signed/i.test(out)
        )
          out += `; no client-signed agreement is on record - "${agNeg[0].quote}" (${agNeg[0].title}${agNeg[0].docDate ? ", " + agNeg[0].docDate : ""})`;
        return out;
      };
      for (const [field, rawList] of active) {
        const list = rawList.filter((c) => !isLimitClaim(c));
        if (!list.length) continue;
        const apprAll = (approved.get(field) ?? []).filter(
          (c) => list.includes(c) && !isLimitClaim(c),
        );
        // Prefer the most informative written form of an approved value
        // (a named list over a bare count).
        const appr = [...apprAll].sort(
          (a, b) =>
            Number(/\band\b/.test(b.value)) - Number(/\band\b/.test(a.value)),
        );
        const apprValues = [...new Set(appr.map((c) => valueKey(c)))];
        // Only an ESTABLISHED foreign engagement conflicts: a claim whose
        // document names distinctive entities sharing none with the approved
        // record. Entity-less claims cannot establish foreign-ness.
        const crossEngagementConflict =
          apprValues.length === 1 &&
          list.some((c) => {
            if (valueKey(c) === apprValues[0] || shareTok(appr[0], c))
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
                : "") +
              clientQualifier(field, list),
          );
          continue;
        }
        const values = [...new Set(list.map((c) => valueKey(c)))];
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
                  : "") +
                clientQualifier(field, list),
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
        result.evidence = uniqueClaimEvidence(
          claims,
          bundle,
        ) as unknown as typeof result.evidence;
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
      // Billing-generic asks ("amount", "cost", "price", "fee", "charge")
      // are also owned by invoice phrasing that never names a metric noun:
      // "Invoice total due: 18,500 INR" answers an amount question even
      // though its only quantity-owners are "total"/"due". Strict metrics
      // (revenue, budget, margin, ...) keep the exact-noun rule, so
      // "marketing spend was $2,000,000" still never answers revenue.
      const BILLING_GENERIC = new Set([
        "amount",
        "cost",
        "price",
        "fee",
        "charge",
      ]);
      const billingOwner = BILLING_GENERIC.has(asked);
      quantOk = false;
      for (const sentence of exText.split(/[.!?\n]/)) {
        for (const q of sentence.matchAll(
          /[$€£₹]\s?\d[\d,]*|\b(?!19\d{2}\b|20\d{2}\b)\d{5,}\b|\b\d{1,3}(?:,\d{3})+\b|\b\d+(?:\.\d+)?\s*(?:million|billion|thousand|lakh|crore)\b/gi,
        )) {
          const left = sentence.slice(0, q.index);
          const nouns = [
            ...left.matchAll(
              /(revenue|budget|turnover|profit|margin|sales|cost|price|amount|spend|fee|charge|total|due|balance|payable|invoice|bill)/gi,
            ),
          ];
          if (
            nouns.length &&
            (nouns[nouns.length - 1][1].toLowerCase() === asked ||
              (billingOwner &&
                /^(total|due|balance|payable|invoice|bill)$/i.test(
                  nouns[nouns.length - 1][1],
                )))
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
    // Asked-attribute shapes: a passage dump that cannot contain the asked
    // field at all is not an answer, however topical the passages are.
    // Mirrors the credential/date/commercial guards in the shared retrieval
    // core, kept demo-layer only.
    const contactQ = /\b(phone|mobile|contact number|e-?mail address)\b/i.test(
      question,
    );
    const phoneCand = exText.match(/\+?\d[\d\s().-]{6,}\d/g) ?? [];
    const contactMiss =
      contactQ &&
      !phoneCand.some(
        (m) =>
          !/^\d{4}-\d{2}-\d{2}$/.test(m.trim()) &&
          m.replace(/\D/g, "").length >= 7,
      ) &&
      !/[\w.+-]+@[\w-]+\.[\w.]+/.test(exText);
    const serialMiss =
      /\b(serial|part|registration|reference) (number|no|code)\b/i.test(
        question,
      ) &&
      !/\b(?=[a-z0-9-]*\d)(?=[a-z0-9-]*[a-z])[a-z0-9-]{4,}\b/i.test(exText);
    const whenMiss =
      /^\s*when\b/i.test(question) &&
      !/\b\d{1,2}(?:st|nd|rd|th)?\s+(?:january|february|march|april|may|june|july|august|september|october|november|december)\b|\b(?:january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{1,2}|\b\d{4}-\d{2}-\d{2}\b|\b\d+\s*(?:business )?(?:days?|weeks?|months?|hours?|years?)\b|\b(?:daily|weekly|biweekly|monthly|quarterly|annually|yearly)\b/i.test(
        exText,
      );
    const metricField =
      /\b([a-z][a-z-]{4,})\s+(?:level|count|reading|result|rate)\b/i.exec(
        question,
      );
    // A disclosed expansion bridge covers the asked metric when the bridged
    // term is what the evidence actually carries ("thyroid ... level" ->
    // "tsh"): the transform is shown in the UI, so the answer never pretends
    // the asked word itself was found.
    const bridgedHits = (expansionUsed?.applied ?? []).some((t) =>
      t.to
        .toLowerCase()
        .split(/\s+/)
        .some((tok) => tok.length > 2 && exText.includes(tok)),
    );
    const metricMiss =
      metricField != null &&
      !exText.includes(metricField[1].toLowerCase()) &&
      !bridgedHits;
    const askedFieldWord =
      /\b(penalty|penalties|severance|liquidated damages|fine|fines)\b/i;
    const fieldWordMiss =
      askedFieldWord.test(question) && !askedFieldWord.test(exText);
    const vendorClass = /\b(vendor|supplier|contractor|manufacturer)\b/i;
    const vendorMiss =
      /\bwhich (vendor|supplier|contractor|manufacturer)\b/i.test(question) &&
      !vendorClass.test(exText);
    if (
      idMiss ||
      (quantitative && !quantOk) ||
      entMiss ||
      contactMiss ||
      serialMiss ||
      whenMiss ||
      metricMiss ||
      fieldWordMiss ||
      vendorMiss
    ) {
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
  if (!claimsVerdict) constrainRequestedEvidence(question, bundle, result);
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
// Shared post-retrieval policy: validate/narrow existing evidence only. This
// never promotes an insufficient external retrieval result to an answer.
export function constrainRequestedEvidence(
  question: string,
  bundle: ReturnType<typeof importBundle>,
  result: ReturnType<typeof answerFromRetrieval>,
) {
  result.requestedChecked = requestedSupportSpans(question, "") !== null;
  if (!result.requestedChecked) return result;
  const roots = bundle.sources.flatMap((source) =>
    explicitRequestedRoots(source.text),
  );
  if (
    result.supported &&
    missingRequestedSupport(
      question,
      result.evidence.map((e) => e.quote),
      roots,
    )
  ) {
    result.reviewEvidence =
      result.evidence as unknown as typeof result.reviewEvidence;
    result.evidence = [];
    result.refused = true;
    result.supported = false;
    result.unresolved = false;
    result.evidenceStatus = "insufficient";
    result.partial = false;
    result.partialNotice = null;
    result.answer =
      "The documents do not establish an answer to this question: the closest passages do not contain the asked fact. They are on screen for review.";
    result.spoken = result.answer;
  }
  // A requested-record support check must constrain the actual evidence that
  // downstream text and voice consumers receive, not merely its boolean status.
  if (result.supported && result.evidence.length) {
    const ranges = result.evidence.map((ev) => ({
      ev,
      spans: requestedSupportSpans(question, ev.quote, roots),
    }));
    if (ranges.some((r) => r.spans !== null)) {
      const narrowed = ranges.flatMap(({ ev, spans }) =>
        (spans ?? []).map((span) => {
          const source = bundle.sources.find((s) => s.id === ev.sourceId)!;
          const start = ev.start + span.start,
            end = ev.start + span.end;
          const exact = {
            ...ev,
            start,
            end,
            quote: source.text.slice(start, end),
            firstLine: lineOf(source.text, start),
            lastLine: lineOf(source.text, end),
          };
          validateEvidence(exact, bundle);
          return exact;
        }),
      );
      if (narrowed.length) {
        result.evidence = narrowed;
        result.requestedScoped = true;
        result.answer =
          "Relevant source excerpts\n\n" +
          narrowed.map((e) => e.quote + "\n[" + e.title + "]").join("\n\n") +
          "\n\nThese are retrieved passages, not a generated recommendation.";
      }
    }
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
  scoringQuestion?: string,
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
      firstLine: lineOf(source.text, offset),
      lastLine: lineOf(source.text, end),
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
          : extractiveAnswer(scoringQuestion ?? question, chunks).replace(
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
    requestedScoped: false,
    requestedChecked: false,
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
