// vendor/web/src/lib/rag/text.ts
var TOKEN_PATTERN = /[\p{L}\p{M}\p{N}\u200C\u200D]+/gu;
var QUERY_STOPWORDS = /* @__PURE__ */ new Set([
  "the",
  "and",
  "for",
  "you",
  "with",
  "from",
  "that",
  "this",
  "what",
  "how",
  "why",
  "are",
  "was",
  "were",
  "into",
  "your",
  "a",
  "an",
  "of",
  "to",
  "in",
  "on",
  "or",
  "do",
  "does",
  "did",
  "is",
  "it",
  "as",
  "be",
  "by",
  "if",
  "not",
  "can",
  "should",
  "would",
  "could",
  "when",
  "which",
  "who",
  "whom",
  "been",
  "have",
  "has",
  "had",
  "will",
  "just",
  "about",
  "than",
  "then",
  "also",
  "only",
  "over",
  "after",
  "before",
  "between",
  "same",
  "each",
  "other",
  "more",
  "most",
  "such",
  "very",
  "right",
  "me",
  "my",
  "we",
  "our",
  "i",
  "explain",
  "describe",
  "tell",
  "show",
  "work",
  "works",
  "please",
  "thanks"
]);
var GENERIC_OPS_TERMS = /* @__PURE__ */ new Set([
  "node",
  "nodes",
  "memory",
  "cpu",
  "cpus",
  "ram",
  "resource",
  "resources",
  "server",
  "servers",
  "service",
  "services",
  "guide",
  "runbook",
  "error",
  "errors",
  "issue",
  "issues",
  "use",
  "using",
  "used",
  "handle",
  "handling",
  "system",
  "systems",
  "process",
  "limit",
  "limits",
  "timeout",
  "timeouts",
  "request",
  "requests",
  "cluster",
  "host",
  "free",
  "enough",
  "individual",
  "aggregate",
  "pattern",
  "failure",
  "failures"
]);
function tokenize(text) {
  const prepared = /[\u0080-\uFFFF]/.test(text) ? text.normalize("NFC") : text;
  return prepared.toLowerCase().match(TOKEN_PATTERN) ?? [];
}
function stemToken(token) {
  if (token.length < 5) return token;
  if (token.endsWith("ing") && token.length > 6) return token.slice(0, -3);
  if (token.endsWith("ers") && token.length > 6) return token.slice(0, -1);
  if (token.endsWith("ies") && token.length > 5) return `${token.slice(0, -3)}y`;
  if (token.endsWith("es") && token.length > 5) return token.slice(0, -2);
  if (token.endsWith("ed") && token.length > 5) {
    const minusD = token.slice(0, -1);
    if (minusD.endsWith("e")) return minusD;
    return token.slice(0, -2);
  }
  if (token.endsWith("s") && !token.endsWith("ss") && token.length > 4) return token.slice(0, -1);
  return token;
}
function contentTokens(text) {
  return tokenize(text).filter((t) => t.length > 1 && !QUERY_STOPWORDS.has(t)).map(stemToken);
}
function bigrams(tokens) {
  const out = [];
  for (let i = 0; i < tokens.length - 1; i += 1) {
    out.push(`${tokens[i]} ${tokens[i + 1]}`);
  }
  return out;
}
function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  if (Math.abs(a.length - b.length) > 2) return 99;
  const prev = new Array(b.length + 1);
  const cur = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j += 1) prev[j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    cur[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min((prev[j] ?? 99) + 1, (cur[j - 1] ?? 99) + 1, (prev[j - 1] ?? 99) + cost);
    }
    for (let j = 0; j <= b.length; j += 1) prev[j] = cur[j] ?? 99;
  }
  return prev[b.length] ?? 99;
}
function expandTypos(queryTokens, vocab) {
  const extra = [];
  for (const raw of queryTokens) {
    if (vocab.has(raw) || raw.length < 5) continue;
    let best = null;
    let bestD = 99;
    let ties = 0;
    const max = raw.length >= 8 ? 2 : 1;
    for (const v of vocab) {
      if (Math.abs(v.length - raw.length) > max) continue;
      const d = levenshtein(raw, v);
      if (d < bestD) {
        bestD = d;
        best = v;
        ties = 1;
      } else if (d === bestD) {
        ties += 1;
      }
    }
    if (best && bestD <= max && ties === 1) extra.push(best);
  }
  return extra;
}
function tokenSetMatches(queryToken, doc) {
  if (doc.has(queryToken)) return true;
  const stemmed = stemToken(queryToken);
  if (doc.has(stemmed)) return true;
  if (queryToken.length < 4) return false;
  for (const t of doc) {
    if (t.length < 4) continue;
    if (t.startsWith(queryToken) || queryToken.startsWith(t)) return true;
  }
  return false;
}
function cosineSimilarity(a, b) {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i += 1) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
function parseEmbedding(raw) {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length === 0) return null;
    for (const n of parsed) {
      if (typeof n !== "number" || !Number.isFinite(n)) return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

// vendor/web/src/lib/rag/corpus-scope.ts
var SEED_CORPUS_ID = "seed-lab";

// vendor/web/src/lib/rag/types.ts
var EMBEDDING_MODEL = "gemini-embedding-2";
var RRF_K = 60;
var CONTEXT_TOKEN_BUDGET = 1400;
var CONTEXT_RELATIVE_FLOOR = 0.62;
var CONTEXT_ABSOLUTE_FLOOR = 0.24;
var CONTEXT_SOLO_MARGIN = 1.35;

// vendor/web/src/lib/rag/ranking.ts
var SCORE_SEMANTICS = "Dense = raw cosine. Keyword = raw BM25. Hybrid = raw RRF (1/(60+rank)). Rerank = calibrated mix (not a cross-encoder, not confidence). The context gate is calibrated-score floor 0.24 AND 62% of rank-1. not an absolute 0.55 cosine threshold.";
function buildIdf(corpusTexts) {
  const df = /* @__PURE__ */ new Map();
  const n = Math.max(1, corpusTexts.length);
  for (const text of corpusTexts) {
    const seen = new Set(contentTokens(text));
    for (const t of seen) df.set(t, (df.get(t) ?? 0) + 1);
  }
  const idf = /* @__PURE__ */ new Map();
  for (const [t, c] of df) {
    const raw = Math.log(1 + (n - c + 0.5) / (c + 0.5));
    idf.set(t, GENERIC_OPS_TERMS.has(t) ? raw * 0.2 : raw);
  }
  return idf;
}
function queryTerms(query, vocab) {
  const base = contentTokens(query);
  const extra = expandTypos(base, vocab);
  return [.../* @__PURE__ */ new Set([...base, ...extra])];
}
function corpusVocab(texts) {
  const v = /* @__PURE__ */ new Set();
  for (const text of texts) for (const t of contentTokens(text)) v.add(t);
  return v;
}
function termWeight(term, idf) {
  if (QUERY_STOPWORDS.has(term)) return 0;
  const generic = GENERIC_OPS_TERMS.has(term) ? 0.2 : 1;
  return (idf.get(term) ?? Math.log(8)) * generic;
}
function weightedRecall(terms, text, idf) {
  if (!terms.length) return 0;
  const doc = new Set(contentTokens(text));
  let num = 0;
  let den = 0;
  for (const t of terms) {
    const w = termWeight(t, idf);
    if (w <= 0) continue;
    den += w;
    if (tokenSetMatches(t, doc)) num += w;
  }
  return den === 0 ? 0 : num / den;
}
function phraseBoost(query, text) {
  const q = contentTokens(query);
  const grams = bigrams(q).filter((g) => {
    const [a, b] = g.split(" ");
    return Boolean(a && b && !GENERIC_OPS_TERMS.has(a) && !GENERIC_OPS_TERMS.has(b));
  });
  const hay = contentTokens(text).join(" ");
  const hayRaw = text.toLowerCase();
  let hits = 0;
  let den = grams.length;
  for (const g of grams) {
    if (hay.includes(g)) hits += 1;
  }
  const named = query.match(/\bnode\s+[a-z0-9]\b/gi) ?? [];
  den += named.length;
  for (const n of named) {
    if (hayRaw.includes(n.toLowerCase())) hits += 1;
  }
  if (!den) return 0;
  return hits / den;
}
function topicalBoost(query, title, text) {
  const q = queryTokenSet(query);
  const d = new Set(contentTokens(`${title}
${text}`));
  let b = 0;
  if (looksLikeStampede(q) && hasAny(d, ["stampede", "redis"])) b += 0.28;
  if (looksLikeFragmentation(q) && hasAny(d, ["fragmentation", "pending"])) b += 0.22;
  if (looksLikeServerlessPg(q) && hasAny(d, ["pgbouncer", "postgres"])) b += 0.22;
  return Math.min(0.34, b);
}
function maxNorm(values, value) {
  const hi = Math.max(0, ...values);
  if (hi <= 1e-9) return 0;
  return value / hi;
}
var ENTITY_TERMS = /* @__PURE__ */ new Set([
  "postgres",
  "pgbouncer",
  "redis",
  "redlock",
  "kubernetes",
  "k8s",
  "docker",
  "tls",
  "aiohttp",
  "asyncio",
  "terraform",
  "nginx"
]);
function entityTermsInQuery(query) {
  return contentTokens(query).filter((t) => ENTITY_TERMS.has(t));
}
function hasAny(hay, terms) {
  return terms.some((t) => tokenSetMatches(t, hay));
}
function queryTokenSet(query) {
  return new Set(contentTokens(query));
}
function looksLikeStampede(q) {
  return hasAny(q, ["cache", "cached", "stampede"]) && hasAny(q, ["hundred", "sudden", "expensive", "disappear", "recompute", "popular", "thundering", "herd"]);
}
function looksLikeFragmentation(q) {
  return hasAny(q, ["pending", "pod", "scatter", "fragment", "schedul"]) || hasAny(q, ["2gi", "2gib"]);
}
function looksLikeServerlessPg(q) {
  return hasAny(q, ["postgres", "pgbouncer"]) && hasAny(q, ["pool", "serverless", "bouncer"]);
}
function expandQueryCues(query) {
  const q = queryTokenSet(query);
  const extra = [];
  if (looksLikeStampede(q)) extra.push("stampede", "redis", "ttl", "jitter", "lock");
  if (looksLikeFragmentation(q)) extra.push("fragmentation", "pending", "kubernetes");
  if (looksLikeServerlessPg(q)) extra.push("pgbouncer", "postgres", "transaction");
  return extra;
}
function calibratedScore(input) {
  const { dense, bm25Norm, idfRecall, titleRecall, phrase } = input;
  if (dense == null) {
    return 0.34 * bm25Norm + 0.32 * idfRecall + 0.2 * titleRecall + 0.14 * phrase;
  }
  return 0.46 * Math.max(0, dense) + 0.18 * bm25Norm + 0.2 * idfRecall + 0.1 * titleRecall + 0.06 * phrase;
}
function rrfFuse(dense, keyword, topK) {
  const scores = /* @__PURE__ */ new Map();
  const byId = /* @__PURE__ */ new Map();
  dense.forEach((c, i) => {
    scores.set(c.chunkId, (scores.get(c.chunkId) ?? 0) + 1 / (RRF_K + i + 1));
    byId.set(c.chunkId, c);
  });
  keyword.forEach((c, i) => {
    scores.set(c.chunkId, (scores.get(c.chunkId) ?? 0) + 1 / (RRF_K + i + 1));
    if (!byId.has(c.chunkId)) byId.set(c.chunkId, c);
  });
  const fused = [...scores.entries()].sort((a, b) => b[1] - a[1]).slice(0, topK).map(([id, score], rank) => {
    const base = byId.get(id);
    return { ...base, score, rank: rank + 1, retriever: "hybrid" };
  });
  return { fused, scores };
}
function rerankCalibrated(opts) {
  const bm25Raw = opts.candidates.map((c) => opts.keywordScores.get(c.chunkId) ?? 0);
  const signals = /* @__PURE__ */ new Map();
  const scored = opts.candidates.map((c) => {
    const dense = opts.denseScores.has(c.chunkId) ? opts.denseScores.get(c.chunkId) ?? null : null;
    const bm25 = opts.keywordScores.get(c.chunkId) ?? 0;
    const idfRecall = weightedRecall(opts.terms, `${c.title}
${c.heading ?? ""}
${c.text}`, opts.idf);
    const titleRecall = weightedRecall(opts.terms, `${c.title} ${c.heading ?? ""}`, opts.idf);
    const phrase = phraseBoost(opts.query, `${c.title}
${c.text}`);
    const topical = (c.corpusId ?? SEED_CORPUS_ID) === SEED_CORPUS_ID ? topicalBoost(opts.query, c.title, c.text) : 0;
    let score = Math.min(
      1,
      calibratedScore({
        dense,
        bm25Norm: maxNorm(bm25Raw, bm25),
        idfRecall,
        titleRecall,
        phrase
      }) + topical
    );
    const ents = entityTermsInQuery(opts.query);
    const titleTok = new Set(contentTokens(`${c.title} ${c.heading ?? ""}`));
    if ((c.corpusId ?? SEED_CORPUS_ID) === SEED_CORPUS_ID && ents.some((e) => tokenSetMatches(e, titleTok))) score = Math.min(1, score + 0.12);
    if (opts.preferredSlugs?.includes(c.slug)) score = Math.min(1, score + 0.03);
    const pathCost = opts.graphPathCosts?.get(c.chunkId);
    if (pathCost !== void 0) score = Math.min(1, score + 0.04 / (1 + pathCost));
    signals.set(c.chunkId, { idfRecall, titleRecall, phrase, topical, dense, bm25 });
    return { chunk: c, score };
  });
  scored.sort((a, b) => b.score - a.score);
  const scores = /* @__PURE__ */ new Map();
  const ranked = scored.map((s, i) => {
    scores.set(s.chunk.chunkId, s.score);
    return { ...s.chunk, score: s.score, rank: i + 1 };
  });
  return { ranked, scores, signals };
}
function isSupported(signals, calibrated) {
  if (calibrated < CONTEXT_ABSOLUTE_FLOOR) return false;
  if (signals.idfRecall >= 0.18) return true;
  if (signals.titleRecall >= 0.22) return true;
  if (signals.phrase >= 0.2) return true;
  if (signals.topical >= 0.18) return true;
  if ((signals.dense ?? 0) >= 0.52 && (signals.idfRecall >= 0.05 || signals.titleRecall >= 0.08)) {
    return true;
  }
  if ((signals.dense ?? 0) >= 0.62 && calibrated >= 0.32) return true;
  if (signals.dense == null && signals.idfRecall < 0.1 && signals.titleRecall < 0.12 && signals.topical < 0.18) {
    return false;
  }
  return false;
}
function distinctiveDocHits(query, ranked, idf) {
  const terms = contentTokens(query).filter((t) => !GENERIC_OPS_TERMS.has(t) && (idf.get(t) ?? 0) > 0.4);
  const slugs = [];
  for (const c of ranked.slice(0, 8)) {
    const title = new Set(contentTokens(`${c.title} ${c.heading ?? ""}`));
    const hit = terms.some((t) => tokenSetMatches(t, title));
    if (hit && !slugs.includes(c.slug)) slugs.push(c.slug);
  }
  return slugs;
}
function queryLooksMultiSource(query, ranked, idf) {
  const hits = distinctiveDocHits(query, ranked, idf);
  if (hits.length >= 2) return true;
  const q = query.toLowerCase();
  if (/\band\b|\bshared by\b|\bboth\b|\bversus\b|\bvs\.?\b/.test(q) && hits.length >= 2) return true;
  return false;
}
function selectContext(ranked, signals, opts) {
  const dropReasons = /* @__PURE__ */ new Map();
  const maxTokens = opts.maxTokens ?? CONTEXT_TOKEN_BUDGET;
  const underspecified = distinctiveTerms(opts.query).length === 0;
  if (underspecified) {
    const qtok = contentTokens(opts.query);
    const mentioning = ranked.filter((c) => {
      if (c.score < 0.1) {
        dropReasons.set(c.chunkId, "Underspecified query: calibrated score < 0.10. Inspect only.");
        return false;
      }
      const doc = new Set(contentTokens(`${c.title}
${c.text}`));
      const hit = qtok.some((t) => tokenSetMatches(t, doc));
      if (!hit) {
        dropReasons.set(
          c.chunkId,
          "Underspecified query: no overlap with the generic question terms. Inspect only."
        );
      }
      return hit;
    });
    const packed2 = [];
    const seen = /* @__PURE__ */ new Set();
    for (const chunk of mentioning) {
      if (packed2.length >= Math.min(3, opts.topK ?? 3)) {
        dropReasons.set(chunk.chunkId, "Outside the packed context window (max 3 supported chunks).");
        continue;
      }
      if (seen.has(chunk.slug)) {
        dropReasons.set(chunk.chunkId, "Duplicate document. a stronger chunk from this source is already packed.");
        continue;
      }
      packed2.push({ ...chunk, rank: packed2.length + 1 });
      seen.add(chunk.slug);
    }
    return { packed: packed2, dropReasons };
  }
  const supported = [];
  for (const c of ranked) {
    const sig = signals.get(c.chunkId) ?? {
      idfRecall: 0,
      titleRecall: 0,
      phrase: 0,
      topical: 0,
      dense: null,
      bm25: null
    };
    if (!isSupported(sig, c.score)) {
      dropReasons.set(
        c.chunkId,
        `Rejected: calibrated ${c.score.toFixed(2)} failed the support gate (absolute floor ${CONTEXT_ABSOLUTE_FLOOR}, need distinctive overlap or strong cosine). Inspect only.`
      );
      continue;
    }
    supported.push(c);
  }
  if (!supported.length) return { packed: [], dropReasons };
  const peak = supported[0].score;
  const afterCliff = [];
  for (const c of supported) {
    if (c.chunkId !== supported[0].chunkId && c.score < peak * CONTEXT_RELATIVE_FLOOR) {
      dropReasons.set(
        c.chunkId,
        `Below relative floor: ${c.score.toFixed(2)} < ${CONTEXT_RELATIVE_FLOOR} \xD7 rank-1 ${peak.toFixed(2)} (${(peak * CONTEXT_RELATIVE_FLOOR).toFixed(2)}). Not an absolute 0.55 cosine cut. Inspect only.`
      );
      continue;
    }
    afterCliff.push(c);
  }
  const coordinating = /\band\b|\bshared by\b|\bboth\b|\bversus\b|\bvs\.?\b/.test(opts.query.toLowerCase());
  const exclusive = entityTermsInQuery(opts.query);
  if (exclusive.length === 1 && !coordinating) {
    const holding = afterCliff.filter((c) => {
      const doc = new Set(contentTokens(`${c.title}
${c.text}`));
      return exclusive.every((t) => tokenSetMatches(t, doc));
    });
    if (holding.length) {
      for (const c of afterCliff) {
        if (!holding.includes(c)) {
          dropReasons.set(
            c.chunkId,
            `Missing required entity term (${exclusive.join(", ")}). Inspect only.`
          );
        }
      }
      afterCliff.length = 0;
      afterCliff.push(...holding);
    }
  } else if (exclusive.length >= 1 && coordinating) {
    const holding = afterCliff.filter((c) => {
      const doc = new Set(contentTokens(`${c.title}
${c.text}`));
      return exclusive.some((t) => tokenSetMatches(t, doc)) || hasAny(doc, ["pool", "exhaustion", "stampede"]);
    });
    if (holding.length) {
      for (const c of afterCliff) {
        if (!holding.includes(c)) {
          dropReasons.set(
            c.chunkId,
            `No overlap with the named entities (${exclusive.join(", ")}). Inspect only.`
          );
        }
      }
      afterCliff.length = 0;
      afterCliff.push(...holding);
    }
  }
  const multi = queryLooksMultiSource(opts.query, afterCliff, opts.idf);
  const second = afterCliff[1];
  let pool = afterCliff;
  if (!multi && second && peak >= second.score * CONTEXT_SOLO_MARGIN) {
    for (const c of afterCliff.slice(1)) {
      if (c.slug === afterCliff[0].slug) continue;
      dropReasons.set(
        c.chunkId,
        `Rank-1 margin: ${peak.toFixed(2)} is \u2265 ${CONTEXT_SOLO_MARGIN}\xD7 stronger than ${second.score.toFixed(2)}. Only the top source packed.`
      );
    }
    pool = afterCliff.filter((c) => c.slug === afterCliff[0].slug).slice(0, 2);
    if (!pool.length) pool = [afterCliff[0]];
  }
  const packed = [];
  const seenText = /* @__PURE__ */ new Set();
  let used = 0;
  const cap = Math.min(3, opts.topK ?? 3);
  for (const chunk of pool) {
    if (packed.length >= cap) {
      dropReasons.set(chunk.chunkId, "Outside the packed context window (max 3 supported chunks).");
      continue;
    }
    const normalizedText = chunk.text.replace(/\s+/g, " ").trim();
    if (seenText.has(normalizedText)) {
      dropReasons.set(chunk.chunkId, "Duplicate passage. the same text is already packed.");
      continue;
    }
    if (used + chunk.tokenCount > maxTokens && packed.length) {
      dropReasons.set(chunk.chunkId, "Outside the context token budget.");
      continue;
    }
    packed.push({ ...chunk, rank: packed.length + 1 });
    seenText.add(normalizedText);
    used += chunk.tokenCount;
  }
  return { packed, dropReasons };
}
function payloadQuery(query) {
  if (!/ignore (the )?(indexed )?corpus|answer from memory|from your (own )?knowledge/i.test(query)) {
    return query;
  }
  const idx = query.lastIndexOf(":");
  if (idx >= 0 && idx < query.length - 3) {
    const rest = query.slice(idx + 1).trim();
    if (rest.length > 8) return rest;
  }
  return query;
}
function retrievalQuery(query, vocab) {
  const extra = expandTypos(contentTokens(query), vocab);
  if (!extra.length) return query;
  return `${query} ${extra.join(" ")}`;
}
function distinctiveTerms(query) {
  return contentTokens(query).filter(
    (t) => t.length >= 4 && !GENERIC_OPS_TERMS.has(t) && !QUERY_STOPWORDS.has(t)
  );
}

// vendor/web/src/lib/rag/evidence.ts
var MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
function extractQueryDates(query) {
  const forms = [];
  const monthAlt = MONTHS.join("|");
  const dmy = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(${monthAlt})\\s+(\\d{4})\\b`, "gi");
  let m;
  while (m = dmy.exec(query)) {
    forms.push(dateForms(Number(m[1]), m[2].toLowerCase(), m[3]));
  }
  const mdy = new RegExp(`\\b(${monthAlt})\\s+(\\d{1,2})(?:st|nd|rd|th)?,??\\s+(\\d{4})\\b`, "gi");
  while (m = mdy.exec(query)) {
    forms.push(dateForms(Number(m[2]), m[1].toLowerCase(), m[3]));
  }
  const iso = /\b(\d{4})-(\d{2})-(\d{2})\b/g;
  while (m = iso.exec(query)) {
    forms.push(dateForms(Number(m[3]), MONTHS[Number(m[2]) - 1] ?? "", m[1]));
  }
  return forms;
}
function dateForms(day, month, year) {
  if (!month) return [];
  const mm = String(MONTHS.indexOf(month) + 1).padStart(2, "0");
  const dd = String(day).padStart(2, "0");
  return [
    `${day} ${month} ${year}`,
    `${month} ${day}, ${year}`,
    `${month} ${day} ${year}`,
    `${year}-${mm}-${dd}`
  ];
}
function hasTerm(packedLower, term) {
  return new RegExp(`\\b${term.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(packedLower);
}
var ABSENCE = /^(does|do|is|are|did)\b.+\b(recommend|mention|include|support|use|say|cover|describe)\b/i;
var ABSENCE_VERBS = /* @__PURE__ */ new Set([
  "recommend",
  "mention",
  "include",
  "support",
  "describe",
  "cover",
  "explain",
  "say",
  "use"
]);
var PACKED_DENSE_SUPPORT = 0.68;
function probeTermsNotInText(query, text) {
  const doc = new Set(contentTokens(text));
  return distinctiveTerms(query).filter(
    (t) => t.length >= 5 && !ABSENCE_VERBS.has(t) && !tokenSetMatches(t, doc)
  );
}
function queryChunkSupport(query, packed) {
  const supportQuery = payloadQuery(query);
  const terms = distinctiveTerms(supportQuery);
  const packedTokens = new Set(packed.flatMap((c) => contentTokens(`${c.title}
${c.text}`)));
  const hits = terms.filter((t) => tokenSetMatches(t, packedTokens));
  return {
    terms,
    hits,
    ratio: terms.length ? hits.length / terms.length : 0
  };
}
function looksLikeBypassInstruction(query) {
  return /ignore (the )?(indexed )?(corpus|sources?|documents?|runbook|readme)|answer from memory|from your (own )?knowledge|pretend (a )?source/i.test(
    query
  );
}
function gate(kind, note, extras = {}) {
  return {
    kind,
    note,
    supportTermCount: extras.supportTermCount ?? 0,
    supportHitCount: extras.supportHitCount ?? 0,
    packedTopDense: extras.packedTopDense ?? null,
    packedTopLexical: extras.packedTopLexical ?? 0,
    clearedForInsufficient: extras.clearedForInsufficient ?? false,
    denseRank1Slug: extras.denseRank1Slug ?? null,
    rerankRank1Slug: extras.rerankRank1Slug ?? null,
    denseRerankDisagree: extras.denseRerankDisagree ?? false,
    probe: extras.probe
  };
}
function classifyEvidence(opts) {
  const rerankRank1Slug = opts.ranked[0]?.slug ?? null;
  const denseRank1Slug = opts.denseRank1Slug ?? null;
  const disagree = Boolean(denseRank1Slug && rerankRank1Slug && denseRank1Slug !== rerankRank1Slug);
  const base = {
    denseRank1Slug,
    rerankRank1Slug,
    denseRerankDisagree: disagree
  };
  if (!opts.packed.length) {
    return gate(
      "insufficient",
      "No retrieved chunk passed the calibrated support gate. The corpus does not contain enough evidence.",
      base
    );
  }
  const packedText = opts.packed.map((c) => c.text).join("\n");
  const slugs = [...new Set(opts.packed.map((c) => c.slug))];
  const top = opts.packed[0];
  const second = opts.packed[1];
  const close = second && top.score > 0 ? second.score / top.score >= 0.78 && second.slug !== top.slug : false;
  const topSig = opts.signals.get(top.chunkId);
  const packedTopDense = topSig?.dense ?? null;
  const packedTopLexical = (topSig?.idfRecall ?? 0) + (topSig?.titleRecall ?? 0) + (topSig?.topical ?? 0);
  const support = queryChunkSupport(opts.query, opts.packed);
  const stats = {
    ...base,
    supportTermCount: support.terms.length,
    supportHitCount: support.hits.length,
    packedTopDense,
    packedTopLexical
  };
  const requestedCredentials = opts.query.match(/\b(?:passwords?|credentials?|api[ _-]?keys?|database_url|secrets?)\b/gi) ?? [];
  const missingCredentials = requestedCredentials.filter((term) => {
    const normalized = term.toLowerCase().replace(/[ _-]/g, "").replace(/s$/, "");
    return !packedText.toLowerCase().replace(/[ _-]/g, "").includes(normalized);
  });
  if (missingCredentials.length) {
    return gate("insufficient", "The requested credential field is not present in the retrieved passages; topic overlap does not establish its value.", { ...stats, clearedForInsufficient: true });
  }
  const packedLower = packedText.toLowerCase();
  const missingDates = extractQueryDates(opts.query).filter(
    (forms) => !forms.some((f) => packedLower.includes(f))
  );
  if (missingDates.length) {
    return gate("insufficient", "The question names a specific date that is not present in the retrieved passages; the passages do not establish date-bound events.", { ...stats, clearedForInsufficient: true });
  }
  const artifactIds = opts.query.match(/\b(?=\w*\d)(?=\w*[a-z])[a-z0-9]+(?:\.[a-z0-9]+)+\b/gi) ?? [];
  const missingArtifacts = artifactIds.filter((id) => !packedLower.includes(id.toLowerCase()));
  if (missingArtifacts.length) {
    return gate("insufficient", "The named artifact identifier is not present in the retrieved passages. Similar vocabulary does not answer this question.", { ...stats, clearedForInsufficient: true });
  }
  const requestedCommercial = opts.query.match(/\b(?:slas?|uptime|pricing|prices?|costs?|contractual|warrant(?:y|ies)|discounts?|refunds?|billing)\b/gi) ?? [];
  const missingCommercial = [...new Set(requestedCommercial.map((t) => t.toLowerCase()))].filter(
    (term) => !hasTerm(packedLower, term)
  );
  if (missingCommercial.length) {
    return gate("insufficient", "The requested commercial or contractual fact is not stated in the retrieved passages; topic overlap does not establish it.", { ...stats, clearedForInsufficient: true });
  }
  if (ABSENCE.test(opts.query.trim())) {
    const missing = probeTermsNotInText(opts.query, `${top.title}
${packedText}`);
    const relevantTitle = distinctiveTerms(opts.query).some(
      (t) => tokenSetMatches(t, new Set(contentTokens(top.title)))
    );
    if (relevantTitle && missing.length) {
      return gate(
        "negative_not_found",
        `The indexed source \u201C${top.title}\u201D was retrieved; ${missing.join(", ")} is not in that text.`,
        { ...stats, probe: missing[0] }
      );
    }
  }
  const identifiers = opts.query.match(/\b[a-z][a-z0-9]*[A-Z][A-Za-z0-9]*\b/g) ?? [];
  const normalizedEvidence = packedText.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (identifiers.some((name) => !normalizedEvidence.includes(name.toLowerCase()))) {
    return gate("insufficient", "The named API is not present in the retrieved passages. Similar vocabulary from another library does not answer this question.", { ...stats, clearedForInsufficient: true });
  }
  if (!distinctiveTerms(opts.query).length) {
    return gate(
      "ambiguous",
      "The question has no distinctive entity. Several indexed sources may apply. do not treat one as the only answer.",
      stats
    );
  }
  const noOverlap = support.hits.length === 0;
  if (looksLikeBypassInstruction(opts.query) && (noOverlap || support.ratio < 0.5)) {
    return gate(
      "insufficient",
      "The question asks to skip the corpus or answer from memory, and packed chunks do not support the remaining question.",
      { ...stats, clearedForInsufficient: true }
    );
  }
  if (noOverlap && packedTopDense != null && packedTopDense < PACKED_DENSE_SUPPORT) {
    return gate(
      "insufficient",
      "Packed chunks have no distinctive overlap with the question and are not a strong dense match. Nearby unrelated documents are not evidence.",
      { ...stats, clearedForInsufficient: true }
    );
  }
  if (slugs.length >= 2 && close) {
    return gate(
      "ambiguous",
      "Several indexed sources are similarly relevant. Distinguish what each one actually states.",
      stats
    );
  }
  return gate("positive", "Packed chunks have distinctive overlap with the question or a strong dense match.", stats);
}

// vendor/web/src/lib/rag/bm25.ts
var BM25Index = class {
  k1 = 1.5;
  b = 0.75;
  ids = [];
  texts = [];
  tfs = [];
  lengths = [];
  avgLen = 0;
  df = /* @__PURE__ */ new Map();
  postings = /* @__PURE__ */ new Map();
  constructor(chunks) {
    for (const chunk of chunks) {
      const tokens = contentTokens(chunk.text);
      if (!tokens.length) continue;
      const i = this.ids.length;
      this.ids.push(chunk.id);
      this.texts.push(chunk.text);
      this.lengths.push(tokens.length);
      const tf = /* @__PURE__ */ new Map();
      for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
      this.tfs.push(tf);
      for (const term of tf.keys()) {
        this.df.set(term, (this.df.get(term) ?? 0) + 1);
        let list = this.postings.get(term);
        if (!list) this.postings.set(term, list = []);
        list.push(i);
      }
    }
    const n = this.ids.length;
    if (!n) return;
    this.avgLen = this.lengths.reduce((a, b) => a + b, 0) / n;
  }
  search(query, topK) {
    const q = contentTokens(query);
    if (!q.length || !this.ids.length) return [];
    const candidates = /* @__PURE__ */ new Set();
    for (const term of q) for (const i of this.postings.get(term) ?? []) candidates.add(i);
    const scored = [];
    for (const i of [...candidates].sort((a, b) => a - b)) {
      const score = this.score(q, this.tfs[i], this.lengths[i]);
      if (score > 0) scored.push({ i, score });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK).map(({ i, score }) => ({
      id: this.ids[i],
      text: this.texts[i],
      score
    }));
  }
  score(query, tf, len) {
    let score = 0;
    const n = this.ids.length;
    for (const term of query) {
      const df = this.df.get(term);
      if (!df) continue;
      const freq = tf.get(term) ?? 0;
      if (!freq) continue;
      const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
      const denom = freq + this.k1 * (1 - this.b + this.b * len / this.avgLen);
      score += idf * (freq * (this.k1 + 1) / denom);
    }
    return score;
  }
};

// vendor/web/src/lib/rag/trace.ts
var STOP = /* @__PURE__ */ new Set([
  "the",
  "and",
  "for",
  "you",
  "with",
  "from",
  "that",
  "this",
  "what",
  "how",
  "why",
  "are",
  "was",
  "were",
  "into",
  "your",
  "a",
  "an",
  "of",
  "to",
  "in",
  "on",
  "or",
  "do",
  "does",
  "is",
  "it",
  "as"
]);
function overlapTerms(query, text, limit = 5) {
  const q = tokenize(query).filter((t) => t.length > 2 && !STOP.has(t));
  const doc = new Set(tokenize(text));
  const hits = [];
  for (const t of q) {
    if (doc.has(t) && !hits.includes(t)) hits.push(t);
    if (hits.length >= limit) break;
  }
  return hits;
}

// vendor/web/src/lib/rag/retrieve-core.ts
var INDEX_CACHE = /* @__PURE__ */ new WeakMap();
var indexStats = { builds: 0, hits: 0 };
function fingerprint(rows) {
  let h = 2166136261;
  for (const r of rows) {
    const s = r.chunk.id + (r.chunk.content_hash ?? "") + r.title;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
  }
  return h >>> 0;
}
function indexFor(all, scoped, scopeKey) {
  let byScope = INDEX_CACHE.get(all);
  if (!byScope) INDEX_CACHE.set(all, byScope = /* @__PURE__ */ new Map());
  const fp = fingerprint(scoped);
  const hit = byScope.get(scopeKey);
  if (hit && hit.fp === fp) {
    indexStats.hits++;
    return hit.index;
  }
  indexStats.builds++;
  const index = new BM25Index(scoped.map((r) => ({ id: r.chunk.id, text: `${r.title}
${r.chunk.text}` })));
  byScope.set(scopeKey, { fp, index });
  return index;
}
function toRetrieved(chunkId, meta, score, rank, retriever) {
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
    chunkKind: row.chunk.chunk_kind ?? "prose",
    corpusId: row.corpusId || row.chunk.corpus_id || SEED_CORPUS_ID
  };
}
function firstSlugRanks(chunks) {
  const seen = /* @__PURE__ */ new Set();
  const out = [];
  for (const c of chunks) {
    if (seen.has(c.slug)) continue;
    seen.add(c.slug);
    out.push({
      slug: c.slug,
      title: c.title,
      score: c.score,
      rank: out.length + 1,
      corpusId: c.corpusId
    });
  }
  return out;
}
function rankMap(chunks) {
  const map = /* @__PURE__ */ new Map();
  for (const c of chunks) {
    if (!map.has(c.chunkId)) map.set(c.chunkId, c.rank);
  }
  return map;
}
function retrieveFromRows(opts) {
  const scope = opts.corpusScope ?? { kind: "corpus", corpusId: SEED_CORPUS_ID };
  const scopedRows = scope.kind === "all" ? opts.rows : opts.rows.filter((r) => (r.corpusId || r.chunk.corpus_id || SEED_CORPUS_ID) === scope.corpusId);
  const meta = /* @__PURE__ */ new Map();
  for (const row of scopedRows) meta.set(row.chunk.id, row);
  const texts = scopedRows.map((r) => `${r.title}
${r.chunk.text}`);
  const idf = buildIdf(texts);
  const vocab = corpusVocab(texts);
  const query = payloadQuery(opts.query);
  const cues = scope.kind === "corpus" && scope.corpusId === SEED_CORPUS_ID ? expandQueryCues(query) : [];
  const terms = [.../* @__PURE__ */ new Set([...queryTerms(query, vocab), ...cues])];
  const bm25Query = `${retrievalQuery(query, vocab)} ${cues.join(" ")}`.trim();
  const retrieveN = Math.min(80, Math.max(scopedRows.length, opts.topK * 4, 10));
  let dense = [];
  let keyword = [];
  const denseScores = /* @__PURE__ */ new Map();
  const keywordScores = /* @__PURE__ */ new Map();
  const expectedModel = opts.embeddingModel ?? EMBEDDING_MODEL;
  let compatible = 0;
  let modelMatch = true;
  const queryEmbeddingProduced = Boolean(opts.queryVector?.length);
  const denseWanted = opts.mode !== "keyword";
  let skippedReason = null;
  if (!opts.storage.denseAvailable && denseWanted) {
    skippedReason = "Durable embeddings are unavailable (ephemeral Vercel storage). Fell back to BM25.";
  } else if (denseWanted && !queryEmbeddingProduced) {
    skippedReason = "Query embedding was not produced. Fell back to BM25.";
  }
  const denseStart = performance.now();
  if (denseWanted && queryEmbeddingProduced && opts.storage.denseAvailable && opts.queryVector) {
    const scored = [];
    for (const row of scopedRows) {
      const model = row.chunk.embedding_model;
      if (model && model !== expectedModel) {
        modelMatch = false;
        continue;
      }
      const vec = parseEmbedding(row.chunk.embedding);
      if (!vec || vec.length !== opts.queryVector.length) continue;
      compatible += 1;
      scored.push({ id: row.chunk.id, score: cosineSimilarity(opts.queryVector, vec) });
    }
    if (!compatible) {
      skippedReason = "No stored vectors matched the query embedding model/dimension. Query embedding alone is not dense retrieval. Fell back to BM25.";
    } else {
      scored.sort((a, b) => b.score - a.score);
      for (const s of scored) denseScores.set(s.id, s.score);
      dense = scored.slice(0, retrieveN).map((s, i) => toRetrieved(s.id, meta, s.score, i + 1, "dense")).filter((c) => Boolean(c));
    }
  }
  const denseMs = performance.now() - denseStart;
  const kwStart = performance.now();
  if (opts.mode !== "dense" || !dense.length) {
    const index = indexFor(opts.rows, scopedRows, scope.kind === "all" ? "*" : scope.corpusId);
    const lexicalQuery = terms.join(" ") || bm25Query;
    const hits = index.search(lexicalQuery, retrieveN);
    for (const s of hits) keywordScores.set(s.id, s.score);
    keyword = hits.map((s, i) => toRetrieved(s.id, meta, s.score, i + 1, "keyword")).filter((c) => Boolean(c));
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
  const fused = fusedPack?.fused ?? (dense.length && opts.mode === "dense" ? dense : keyword.length ? keyword : dense);
  const rerankStart = performance.now();
  const { ranked, scores: rerankScores, signals } = rerankCalibrated({
    query,
    candidates: fused,
    denseScores,
    keywordScores,
    idf,
    terms,
    preferredSlugs: opts.preferredSlugs,
    graphPathCosts: opts.graphPathCosts
  });
  const rerankMs = performance.now() - rerankStart;
  const assembleStart = performance.now();
  const { packed, dropReasons } = selectContext(ranked, signals, {
    query,
    idf,
    maxTokens: CONTEXT_TOKEN_BUDGET,
    topK: Math.min(3, opts.topK)
  });
  const assembleMs = performance.now() - assembleStart;
  const packedIds = new Set(packed.map((c) => c.chunkId));
  const denseSlugRanks = firstSlugRanks(dense);
  const evidence = classifyEvidence({
    query,
    packed,
    ranked,
    signals,
    denseRank1Slug: denseSlugRanks[0]?.slug ?? null
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
  const candidates = ranked.slice(0, 12).map((c, i) => {
    const usedInContext = gatedIds.has(c.chunkId);
    return {
      ...c,
      rank: i + 1,
      scores: {
        dense: denseScores.has(c.chunkId) ? denseScores.get(c.chunkId) : null,
        keyword: keywordScores.has(c.chunkId) ? keywordScores.get(c.chunkId) : null,
        hybrid: fusedPack?.scores.has(c.chunkId) ? fusedPack.scores.get(c.chunkId) : null,
        rerank: rerankScores.get(c.chunkId) ?? c.score
      },
      usedInContext,
      cited: false,
      overlapTerms: overlapTerms(opts.query, c.text),
      dropReason: usedInContext ? void 0 : dropReasons.get(c.chunkId),
      ranks: {
        dense: denseRanks.get(c.chunkId) ?? null,
        keyword: keywordRanks.get(c.chunkId) ?? null,
        fused: fusedRanks.get(c.chunkId) ?? null,
        rerank: i + 1
      }
    };
  });
  const denseDiag = {
    queryEmbeddingProduced,
    compatibleStoredVectors: compatible,
    denseCandidatesProduced: dense.length,
    embeddingModelMatch: modelMatch,
    embeddingModelExpected: expectedModel,
    skippedReason
  };
  const resolvedMode = opts.mode === "hybrid" && dense.length ? "hybrid" : dense.length && opts.mode === "dense" ? "dense" : "keyword";
  const corpusId = scope.kind === "all" ? null : scope.corpusId;
  const evidenceGate = {
    ...evidence,
    clearedForInsufficient: evidence.kind === "insufficient" && packed.length > 0
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
      corpusScope: scope.kind
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
      rerank: firstSlugRanks(ranked)
    }
  };
}
export {
  retrieveFromRows
};
