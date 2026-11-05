import { cosineSimilarity, parseEmbedding } from "./text";
import {
  SCORE_SEMANTICS,
  type IdF,
  buildIdf,
  corpusVocab,
  expandQueryCues,
  payloadQuery,
  queryTerms,
  rerankCalibrated,
  retrievalQuery,
  rrfFuse,
  selectContext,
} from "./ranking";
import { classifyEvidence } from "./evidence";
import { BM25Index } from "./bm25";

// BM25 index cache. Building the index tokenizes every chunk, so rebuilding
// it per query made retrieval O(corpus) per question. The index is cached
// per rows array and scope, keyed by an FNV-1a fingerprint of the scoped
// chunk ids and content hashes: an array mutated in place, or a different
// scope, can never be served a stale index.
// The same entry also holds the corpus word statistics (IDF and vocabulary)
// that every query needs. They used to be rebuilt from the whole corpus on
// every call (about half of query CPU on a 240k-character document) even
// though the index beside them was cached. They share the index's key and
// fingerprint, so they are invalidated by exactly the same events: a new
// rows array (upload, delete, replace, workspace change) or any change to a
// scoped chunk's id, content hash or title (amendment, re-parse). The cached
// Map and Set are read-only downstream: no caller mutates them.
type CorpusEntry = { fp: number; index?: BM25Index; idf?: IdF; vocab?: Set<string> };
const INDEX_CACHE = new WeakMap<SearchRow[], Map<string, CorpusEntry>>();
const indexStats = { builds: 0, hits: 0, statsBuilds: 0, statsHits: 0, vectorParses: 0, vectorHits: 0 };
export function retrieveIndexStats() {
  return { ...indexStats };
}
function fingerprint(rows: SearchRow[]): number {
  let h = 0x811c9dc5;
  for (const r of rows) {
    const s = r.chunk.id + (r.chunk.content_hash ?? "") + r.title;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
  }
  return h >>> 0;
}
function corpusEntry(all: SearchRow[], scoped: SearchRow[], scopeKey: string): CorpusEntry {
  let byScope = INDEX_CACHE.get(all);
  if (!byScope) INDEX_CACHE.set(all, (byScope = new Map()));
  const fp = fingerprint(scoped);
  let entry = byScope.get(scopeKey);
  if (!entry || entry.fp !== fp) byScope.set(scopeKey, (entry = { fp }));
  return entry;
}
// Parsed vectors. Chunks keep their embedding as a JSON string (the stored
// and persisted form is unchanged); parsing it for every row on every query
// cost ~6 ms per pass at 129 chunks. The parsed Float32Array is cached per
// chunk object and is valid only while chunk.embedding is the same string,
// so a re-embed (new model, dtype or text) re-parses, and a deleted chunk
// releases its vector with the chunk (WeakMap). Float32Array is lossless
// here: the strings are written from the model's Float32Array output.
const VECTOR_CACHE = new WeakMap<object, { src: string; vec: Float32Array | null }>();
function vectorOf(chunk: { embedding: string | null }): Float32Array | null {
  const raw = chunk.embedding;
  if (!raw) return null;
  const hit = VECTOR_CACHE.get(chunk);
  if (hit && hit.src === raw) {
    indexStats.vectorHits++;
    return hit.vec;
  }
  indexStats.vectorParses++;
  const arr = parseEmbedding(raw);
  const vec = arr ? Float32Array.from(arr) : null;
  VECTOR_CACHE.set(chunk, { src: raw, vec });
  return vec;
}
const rowText = (r: SearchRow) => `${r.title}\n${r.chunk.text}`;
function indexFor(entry: CorpusEntry, scoped: SearchRow[]): BM25Index {
  if (entry.index) {
    indexStats.hits++;
    return entry.index;
  }
  indexStats.builds++;
  entry.index = new BM25Index(scoped.map((r) => ({ id: r.chunk.id, text: rowText(r) })));
  return entry.index;
}
function corpusStats(entry: CorpusEntry, scoped: SearchRow[]): { idf: IdF; vocab: Set<string> } {
  if (entry.idf && entry.vocab) {
    indexStats.statsHits++;
    return { idf: entry.idf, vocab: entry.vocab };
  }
  indexStats.statsBuilds++;
  const texts = scoped.map(rowText);
  entry.idf = buildIdf(texts);
  entry.vocab = corpusVocab(texts);
  return { idf: entry.idf, vocab: entry.vocab };
}
import { overlapTerms } from "./trace";
import type {
  ChunkKind,
  ChunkRow,
  DenseDiagnostics,
  EvidenceGate,
  EvidenceKind,
  RetrievalCandidate,
  RetrievalMode,
  RetrievedChunk,
  RetrievalTrace,
  StageRank,
  StorageStatus,
} from "./types";
import type { CorpusScope } from "./corpus-scope";
import { SEED_CORPUS_ID } from "./corpus-scope";
import { CONTEXT_TOKEN_BUDGET, EMBEDDING_MODEL } from "./types";

export type SearchRow = {
  chunk: ChunkRow;
  title: string;
  slug: string;
  indexedAt: string | null;
  corpusId: string;
};

function toRetrieved(
  chunkId: string,
  meta: Map<string, SearchRow>,
  score: number,
  rank: number,
  retriever: RetrievedChunk["retriever"],
): RetrievedChunk | null {
  const row = meta.get(chunkId);
  if (!row) return null;
  return {
    chunkId,
    documentId: row.chunk.document_id,
    slug: row.slug,
    title: row.title,
    text: row.chunk.text,
    heading: row.chunk.heading,
    score,
    rank,
    retriever,
    tokenCount: row.chunk.token_count,
    indexedAt: row.indexedAt,
    embeddingModel: row.chunk.embedding_model,
    filepath: row.chunk.filepath,
    language: row.chunk.language,
    symbol: row.chunk.symbol,
    chunkKind: (row.chunk.chunk_kind ?? "prose") as ChunkKind,
    corpusId: row.corpusId || row.chunk.corpus_id || SEED_CORPUS_ID,
  };
}

export type RetrieveResult = {
  chunks: RetrievedChunk[];
  candidates: RetrievalCandidate[];
  stages: {
    dense: StageRank[];
    keyword: StageRank[];
    fused: StageRank[];
    rerank: StageRank[];
  };
  trace: RetrievalTrace;
  denseMs: number;
  keywordMs: number;
  rerankMs: number;
  assembleMs: number;
  candidateCount: number;
  contextTokens: number;
  evidence: EvidenceKind;
  evidenceNote: string;
  evidenceGate: EvidenceGate;
  probe?: string;
  dense: DenseDiagnostics;
  actualMode: RetrievalMode;
  corpusId: string | null;
  corpusScope: "corpus" | "all";
};

function firstSlugRanks(chunks: RetrievedChunk[]): StageRank[] {
  const seen = new Set<string>();
  const out: StageRank[] = [];
  for (const c of chunks) {
    if (seen.has(c.slug)) continue;
    seen.add(c.slug);
    out.push({
      slug: c.slug,
      title: c.title,
      score: c.score,
      rank: out.length + 1,
      corpusId: c.corpusId,
    });
  }
  return out;
}

function rankMap(chunks: RetrievedChunk[]) {
  const map = new Map<string, number>();
  for (const c of chunks) {
    if (!map.has(c.chunkId)) map.set(c.chunkId, c.rank);
  }
  return map;
}

export function retrieveFromRows(opts: {
  query: string;
  queryVector: number[] | null;
  mode: RetrievalMode;
  topK: number;
  embeddingModel: string | null;
  rows: SearchRow[];
  storage: StorageStatus;
  preferredSlugs?: string[];
  graphPathCosts?: Map<string, number>;
  corpusScope?: CorpusScope;
}): RetrieveResult {
  const scope = opts.corpusScope ?? { kind: "corpus", corpusId: SEED_CORPUS_ID };
  const scopedRows =
    scope.kind === "all"
      ? opts.rows
      : opts.rows.filter((r) => (r.corpusId || r.chunk.corpus_id || SEED_CORPUS_ID) === scope.corpusId);
  const meta = new Map<string, SearchRow>();
  for (const row of scopedRows) meta.set(row.chunk.id, row);

  const corpus = corpusEntry(opts.rows, scopedRows, scope.kind === "all" ? "*" : scope.corpusId);
  const { idf, vocab } = corpusStats(corpus, scopedRows);
  const query = payloadQuery(opts.query);
  // Demo-tuned cue expansion is scoped to the seed corpus only; corpora the
  // user ingests (GitHub repos, uploads) must compete on their own text.
  const cues = scope.kind === "corpus" && scope.corpusId === SEED_CORPUS_ID ? expandQueryCues(query) : [];
  const terms = [...new Set([...queryTerms(query, vocab), ...cues])];
  const bm25Query = `${retrievalQuery(query, vocab)} ${cues.join(" ")}`.trim();

  const retrieveN = Math.min(80, Math.max(scopedRows.length, opts.topK * 4, 10));
  let dense: RetrievedChunk[] = [];
  let keyword: RetrievedChunk[] = [];
  const denseScores = new Map<string, number>();
  const keywordScores = new Map<string, number>();

  const expectedModel = opts.embeddingModel ?? EMBEDDING_MODEL;
  let compatible = 0;
  let modelMatch = true;

  const queryEmbeddingProduced = Boolean(opts.queryVector?.length);
  const denseWanted = opts.mode !== "keyword";
  let skippedReason: string | null = null;

  if (!opts.storage.denseAvailable && denseWanted) {
    skippedReason = "Durable embeddings are unavailable (ephemeral Vercel storage). Fell back to BM25.";
  } else if (denseWanted && !queryEmbeddingProduced) {
    skippedReason = "Query embedding was not produced. Fell back to BM25.";
  }

  const denseStart = performance.now();
  if (denseWanted && queryEmbeddingProduced && opts.storage.denseAvailable && opts.queryVector) {
    const scored: Array<{ id: string; score: number }> = [];
    for (const row of scopedRows) {
      const model = row.chunk.embedding_model;
      if (model && model !== expectedModel) {
        modelMatch = false;
        continue;
      }
      const vec = vectorOf(row.chunk);
      if (!vec || vec.length !== opts.queryVector.length) continue;
      compatible += 1;
      scored.push({ id: row.chunk.id, score: cosineSimilarity(opts.queryVector, vec) });
    }
    if (!compatible) {
      skippedReason =
        "No stored vectors matched the query embedding model/dimension. Query embedding alone is not dense retrieval. Fell back to BM25.";
    } else {
      scored.sort((a, b) => b.score - a.score);
      for (const s of scored) denseScores.set(s.id, s.score);
      dense = scored
        .slice(0, retrieveN)
        .map((s, i) => toRetrieved(s.id, meta, s.score, i + 1, "dense"))
        .filter((c): c is RetrievedChunk => Boolean(c));
    }
  }
  const denseMs = performance.now() - denseStart;

  const kwStart = performance.now();
  if (opts.mode !== "dense" || !dense.length) {
    const index = indexFor(corpus, scopedRows);
    const lexicalQuery = terms.join(" ") || bm25Query;
    const hits = index.search(lexicalQuery, retrieveN);
    for (const s of hits) keywordScores.set(s.id, s.score);
    keyword = hits
      .map((s, i) => toRetrieved(s.id, meta, s.score, i + 1, "keyword"))
      .filter((c): c is RetrievedChunk => Boolean(c));
    if (scopedRows.length <= 80) {
      for (const row of scopedRows) {
        if (keywordScores.has(row.chunk.id)) continue;
        keywordScores.set(row.chunk.id, 0);
        const extra = toRetrieved(row.chunk.id, meta, 0, keyword.length + 1, "keyword");
        if (extra) keyword.push(extra);
      }
    }
  }
  const keywordMs = performance.now() - kwStart;

  const useHybrid = Boolean(dense.length && keyword.length && opts.mode === "hybrid");
  const fusedPack = useHybrid ? rrfFuse(dense, keyword, retrieveN) : null;
  const fused =
    fusedPack?.fused ??
    (dense.length && opts.mode === "dense" ? dense : keyword.length ? keyword : dense);

  const rerankStart = performance.now();
  const { ranked, scores: rerankScores, signals } = rerankCalibrated({
    query,
    candidates: fused,
    denseScores,
    keywordScores,
    idf,
    terms,
    preferredSlugs: opts.preferredSlugs,
    graphPathCosts: opts.graphPathCosts,
  });
  const rerankMs = performance.now() - rerankStart;

  const assembleStart = performance.now();
  const { packed, dropReasons } = selectContext(ranked, signals, {
    query,
    idf,
    maxTokens: CONTEXT_TOKEN_BUDGET,
    topK: Math.min(3, opts.topK),
  });
  const assembleMs = performance.now() - assembleStart;

  const packedIds = new Set(packed.map((c) => c.chunkId));
  const denseSlugRanks = firstSlugRanks(dense);
  const evidence = classifyEvidence({
    query,
    packed,
    ranked,
    signals,
    denseRank1Slug: denseSlugRanks[0]?.slug ?? null,
  });
  const gatedPacked = evidence.kind === "insufficient" ? [] : packed;
  const gatedIds = new Set(gatedPacked.map((c) => c.chunkId));
  if (evidence.kind === "insufficient") {
    for (const c of packed) {
      if (!dropReasons.has(c.chunkId)) {
        dropReasons.set(c.chunkId, evidence.note);
      }
    }
  }

  const denseRanks = rankMap(dense);
  const keywordRanks = rankMap(keyword);
  const fusedRanks = rankMap(fused);

  const candidates: RetrievalCandidate[] = ranked.slice(0, 12).map((c, i) => {
    const usedInContext = gatedIds.has(c.chunkId);
    return {
      ...c,
      rank: i + 1,
      scores: {
        dense: denseScores.has(c.chunkId) ? denseScores.get(c.chunkId)! : null,
        keyword: keywordScores.has(c.chunkId) ? keywordScores.get(c.chunkId)! : null,
        hybrid: fusedPack?.scores.has(c.chunkId) ? fusedPack.scores.get(c.chunkId)! : null,
        rerank: rerankScores.get(c.chunkId) ?? c.score,
      },
      usedInContext,
      cited: false,
      overlapTerms: overlapTerms(opts.query, c.text),
      dropReason: usedInContext ? undefined : dropReasons.get(c.chunkId),
      ranks: {
        dense: denseRanks.get(c.chunkId) ?? null,
        keyword: keywordRanks.get(c.chunkId) ?? null,
        fused: fusedRanks.get(c.chunkId) ?? null,
        rerank: i + 1,
      },
    };
  });

  const denseDiag: DenseDiagnostics = {
    queryEmbeddingProduced,
    compatibleStoredVectors: compatible,
    denseCandidatesProduced: dense.length,
    embeddingModelMatch: modelMatch,
    embeddingModelExpected: expectedModel,
    skippedReason,
  };

  const resolvedMode: RetrievalMode =
    opts.mode === "hybrid" && dense.length ? "hybrid"
    : dense.length && opts.mode === "dense" ? "dense"
    : "keyword";

  const corpusId = scope.kind === "all" ? null : scope.corpusId;
  const evidenceGate: EvidenceGate = {
    ...evidence,
    clearedForInsufficient: evidence.kind === "insufficient" && packed.length > 0,
  };

  return {
    chunks: gatedPacked,
    candidates,
    trace: {
      query: opts.query,
      mode: resolvedMode,
      candidateCount: fused.length,
      usedCount: gatedPacked.length,
      candidates,
      dense: denseDiag,
      evidence: evidence.kind,
      evidenceGate,
      storage: opts.storage,
      scoreSemantics: SCORE_SEMANTICS,
      corpusId,
      corpusScope: scope.kind,
    },
    denseMs,
    keywordMs,
    rerankMs,
    assembleMs,
    candidateCount: fused.length,
    contextTokens: gatedPacked.reduce((n, c) => n + c.tokenCount, 0),
    evidence: evidence.kind,
    evidenceNote: evidence.note,
    evidenceGate,
    probe: evidence.probe,
    dense: denseDiag,
    actualMode: resolvedMode,
    corpusId,
    corpusScope: scope.kind,
    stages: {
      dense: denseSlugRanks,
      keyword: firstSlugRanks(keyword),
      fused: firstSlugRanks(fused),
      rerank: firstSlugRanks(ranked),
    },
  };
}
