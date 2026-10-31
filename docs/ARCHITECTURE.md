# Voice Memory: architecture (branch `vm2-ingestion`)

This document describes what the code on this branch does, what was measured,
and what is deliberately not claimed. Numbers come from the test and benchmark
runs listed in the final section; nothing here is a target unless labelled so.

## 1. Pipeline

```
file bytes ──► validate ──► parse ──► canonical document ──► index ──► retrieve ──► evidence gate ──► answer
 (upload)     signature     worker    vm.document/1          chunks     keyword       exact span        screen: lead + citations
              size limits   pdf.js    elements + spans        + anchors  (BM25)        validation        voice:  same sentence
                            OCR       pages + regions                                   claim graph
                            docx xml  warnings
```

Each stage has a contract a test checks:

| Stage | Contract | Where it is tested |
| --- | --- | --- |
| Validate | Format comes from the file signature, never the extension alone; a mislabelled file is rejected, not guessed at. | `ingest/bench.mjs` (fake.pdf, binary.txt, empty.txt) |
| Parse | Runs in a worker thread with a heap cap and a wall-clock timeout; returns a typed failure, never a crash. | bench (encrypted, corrupted, bomb.docx), `ingest/upload.test.mjs` |
| Canonical document | Every indexed element knows its exact `[start, end)` in the canonical text; PDF and image elements also carry page and bounding box. | bench check "element spans exact" |
| Index | Every chunk is anchored to an exact source span at index time (repeat-safe). Unanchorable chunks can never be cited. | `ingest/engine-anchors.test.mjs` |
| Evidence gate | A quote must equal `source.text.slice(start, end)` and the source hash must match (unchanged `validateEvidence`). | existing suites + anchor tests |
| Answer | Screen and voice speak the same deterministic sentence (claim renderer, else one verbatim sentence or table row). | `ingest/spoken-extract.test.mjs`, browser journey |

Upload status is the real server state, not the HTTP result:
`uploaded → validating → parsing → indexing → ready`, with `needs_review` and
`failed` as explicit outcomes. `needs_review` documents are kept out of the
index until a person chooses "Use it anyway".

## 2. Canonical document (`vm.document/1`)

```
document  { schema, kind, mime, filename, sha256 (original bytes), bytes,
            parser { name, ocr, pipeline }, parsedAt, text, textSha256,
            pages[], elements[], warnings[], stats }
page      { number, width, height, rotation, textSource: pdf|ocr|none, columns, unit? }
element   { id, type: heading|paragraph|table|table-header|table-row|furniture,
            text | cells, level?, parent?, section[], page?, bbox?,
            method: pdf-text|ocr|docx-xml|text, confidence?, indexed, start, end }
```

- The original upload is stored byte-identical and served back inert
  (`Content-Security-Policy: default-src 'none'; sandbox`).
- `text` is the parser's linearization: headings as `#`, tables as pipe rows,
  so a value never leaves the line holding its label, unit and range.
- For `.txt`/`.md`, `text` *is* the original (newline-normalized), so every
  citation is a literal span of what was uploaded.
- Coordinates exist only where the format has them (PDF, images). DOCX and
  text carry order, not invented pages.
- Repeated page headers/footers are kept as `furniture` elements (visible,
  `indexed: false`) and excluded from the index.

`locate(doc, start, end)` resolves any citation to elements, pages, regions,
extraction method and minimum OCR confidence. The server adds a `focus`
(the elements inside the span that match the question) so the viewer lands
on the line, not the whole chunk.

## 3. Decisions

### ADR-1: Node parsers now, Docling later only if tables demand it
- **Problem:** binary files were decoded as UTF-8 and indexed as garbage (HTTP 200).
- **Choice:** pdf.js (text layer + layout heuristics), tesseract.js with the
  English model shipped in `node_modules` (no network, no paid service),
  WordprocessingML via fflate + xmldom. One runtime, no Python worker.
- **Alternative rejected for now:** Docling. It scores best on table
  structure in a vendor-published benchmark (Nutrient, Oct 2026; TEDS 0.93 vs
  0.73 for pymupdf4llm) but runs ~0.55 s/page and needs a Python ML stack that
  does not fit the 512 MB free host. Re-evaluate on real lab reports once the
  gold set exists; the canonical schema is parser-agnostic, so swapping the
  parser does not touch the engine.
- **Rollback:** the old JSON text import (`/api/import`) is unchanged.

### ADR-2: Anchor chunks at index time instead of searching at answer time
- **Problem (reproduced at dfd848e):** chunks after the first carry an overlap
  tail or a repeated table header, so `source.text.indexOf(chunk.text)` found
  nothing and the passage was silently dropped. In a 9.5k-character document,
  4 of 5 chunks were uncitable.
- **Choice:** at import, anchor each chunk's verbatim core with a forward
  cursor (resolves repeated boilerplate to the right occurrence). The evidence
  gate itself is unchanged: quotes are still exact source slices.
- **Measured:** 245k-character document → 126 chunks, 0 unanchored, import
  354 ms, query 525 ms (this sandbox, 2 vCPU).

### ADR-3: One spoken sentence for both screen and voice
- **Problem:** outside the claim graph's commercial fields, voice said "I don't
  see that in these documents" for every question about an uploaded file, and
  the screen showed raw excerpt dumps.
- **Choice:** the claim renderer stays first. If it has no field, speak one
  verbatim sentence or table row from the engine's validated evidence
  (`spoken-extract.mjs`), with column headers for rows and comparators as
  words (`<0.05` → "less than 0.05"). Commands are never answered with a quote.
  Deliberate abstentions (unknown entity, unknown amount) are never overridden.
- **Screen:** shows the same sentence as the lead, with the claim/evidence
  citations; the engine's full record text sits under "Full record text".

### ADR-4: Hybrid retrieval ships behind a memory guard
Hybrid retrieval (local bge-small, fused with BM25) was merged in PR #3. On the
30-question benchmark it adds one paraphrase question of 7 and two literal
questions of 23 at recall@3. It also took production from about 60 MB to peaks
of about 498 MB of Render's 512 MB. Since 2.0, the model loads only with about
360 MB of headroom under the container limit, and it is dropped back to
keyword retrieval above 90% of the limit (`dense.mjs`, `/healthz`). The voice
path answers from the claim graph and spoken routes first, so its correctness
does not depend on the dense stage.

### ADR-5: Generalise the spoken layer at the root, measure on unseen corpora
Spoken questions failed for notation and vocabulary reasons, not retrieval:
number words, dropped "-ed", "go live", "retainer" instead of "fee", dates in
months other than November, and authority carried by the document type.
Fixes went into a notation-only normaliser (`spoken-normalize.mjs`) and a
generic claim vocabulary (`claim-check.ts`). New question shapes are answered
only from verbatim, span-validated sentences (`spoken-routes.mjs`): open
items, named-document asks, explicit rejections, documented reasons, an
explicit "no price agreed" for a named subject, and pending-versus-rejected.
Each corpus counted as held out only until its failures were seen
(`evaluation/spoken-eval.mjs` records which was which).

## 4. Format support (measured on synthetic fixtures)

| Format | Status | Notes |
| --- | --- | --- |
| PDF with text layer | Supported | Two-column, rotated, multi-page tables, repeated headings measured. |
| Scanned PDF (image-only pages) | Supported, flagged | Embedded page images OCR'd locally (max 12 pages per file). Citations say "read by OCR" with confidence. |
| Encrypted PDF | Rejected with instructions | No password prompt yet. |
| DOCX | Supported | Paragraphs, Title/Heading styles, tables, tracked insertions. Footnotes, headers/footers, comments and embedded images are reported as not read. |
| PNG / JPEG of printed text | Supported, flagged | Below 85% mean OCR confidence the file waits for review; below 40% it is rejected as unreadable. |
| TXT / Markdown | Supported | Canonical text is the original. |
| .doc, XLSX, HTML, handwriting | Not supported | Explicit message; not attempted. |

Limits: 15 MB per file, 60 PDF pages, 250,000 characters of text per
document, 10 documents and 40 MB per session, 90 s parse timeout, 384 MB
worker heap, one parse at a time by default (`VM_PARSE_CONCURRENCY`).

## 5. Benchmark (ingest/bench.mjs)

22 fixtures, 131 checks against hand-written gold labels
(`ingest/fixtures/gold.json`). Result on this branch: **131/131**.

What it covers: exact sentence extraction, reading order (including a
two-column page drawn in the wrong content-stream order), table rows kept
intact with empty cells in place (`Creatinine | 1.2 | mg/dL | 0.7-1.3 | `),
1.2 vs 12 and `<0.05` vs 0.05 in adjacent rows, page attribution across
repeated headings, header/footer exclusion, OCR of a scanned page and two
images, a heavy degradation that must be rejected, and seven rejection paths.

One gold label was corrected after verification: "Day 70" was guessed to be
on page 2 of the Chromium-printed table; poppler `pdftotext` (independent of
pdf.js) and `qpdf --show-npages` show page 3. The correction and its evidence
are recorded in the gold file.

**What this does not show:** all fixtures are synthetic and machine-generated.
Real scans (skew, stamps, handwriting, low contrast), real lab layouts
(merged cells, multi-line analyte names, reference ranges split across
lines), and real two-column papers with figures are not covered. Do not
describe this as accuracy on real documents.

Timing (2 vCPU sandbox): text-layer PDFs 180–270 ms per file including
worker start; OCR 560–900 ms per page image; peak RSS 276 MB while OCR runs.
Parsing cost is zero marginal dollars (all local).

## 6. Security boundaries added

- Upload: same-origin + session CSRF token (existing gate), Content-Length
  checked before reading, byte cap enforced while streaming.
- No filename ever touches disk; display names are stripped of paths,
  control and bidi characters and rendered with `textContent`.
- DOCX: only two parts are inflated; entry count, declared size and
  compression ratio are checked first; fflate pinned to 0.8.3 (ZIP64 loop fix).
  xmldom pinned to 0.9.12 (serialization advisories in ≤0.8.14).
- Parser output never reaches the log (worker stdout/stderr are drained).
- Originals are served only to their own session, inert, and are dropped
  for files that failed to parse.
- Removing a document rebuilds the index and **retargets the fixed voice
  credential**; with no documents left, the credential answers 401
  (`voice-adapter.mjs`: fail closed on an empty binding). Pinned demo mode
  is unchanged: uploads never retarget the Northstar credential.

Not done: encryption at rest, durable storage, audit log, per-tenant
retention policy. In-memory session storage is a demo store and is not
appropriate for real personal or medical records.

## 7. Clinical prototype (`clinical/`, synthetic data only)

Lab-table rows become typed observations shaped like FHIR R4 Observation
(code, value + comparator, unit, reference range, interpretation, subject,
effective/issued dates, status) without claiming FHIR conformance or
LOINC/UCUM coding. Kept separate from the commercial claim graph.

| Rule | Behaviour | Test |
| --- | --- | --- |
| Unit never inferred | Missing unit stays null; comparison refuses | `compare` missing_unit |
| No unit conversion | mg/dL vs µmol/L refuses: no analyte/unit pair is validated | Creatinine gold case |
| Same test only | Identical normalized names; no synonyms ("thyroid hormone" does not match "TSH") | retrieval paraphrase miss, by design |
| Same patient only | Different IDs never combine; without one named, the answer asks which patient | Hemoglobin gold case |
| Amended wins | Same collection date: amended/corrected over final over preliminary; the superseded value is cited | Ferritin gold case |
| Bounds stay bounds | `<0.05` vs `0.30` is higher; `<0.05` vs `<0.10` is undetermined | `compare` tests |
| Flag vs range | A printed H/L flag its own range contradicts is said out loud | flag conflict test |
| No interpretation | Comparisons end with "a question for your clinician"; banned words test | every comparison |

pdf.js NFKC-normalizes the micro sign (U+00B5) to Greek mu (U+03BC); units are
folded back to the printed form and the raw string is kept (`unitRaw`).

## 8. Retrieval baseline (`evaluation/retrieval-bench.mjs`)

30 questions written before the run (23 literal, 7 deliberately paraphrased),
run as two sessions of at most 10 documents. Keyword/BM25 stage only:

| Set | Recall@3 | MRR | Precision@3 |
| --- | --- | --- | --- |
| Literal | 0.91 | 0.91 | 0.83 |
| Paraphrase | 0.29 | 0.29 | 0.29 |

The retriever's evidence gate often returns a single chunk, so Recall@1, @3 and
@5 coincide. One literal "miss" is arguable: "How often is progress reported?"
retrieves the proposal, which also mentions weekly reporting; the gold label
names the kickoff notes and was left unchanged. Dense/hybrid candidates were not
run: this environment cannot download embedding models. The harness accepts any
`retrieve(question, k)` for a fair comparison on the same questions.

## 9. Spoken answers: development and held-out results

Run through the real SSE voice endpoint (`npm run eval:spoken`). Retrieval
recall (did the engine's evidence include a gold document) is reported
separately from answer correctness: an abstention can be correct with no
retrieval, and some routes answer from claim spans the engine did not rank.

| Corpus | Role | Before 2.0 | First contact | Now |
| --- | --- | --- | --- | --- |
| Northstar (23 phrasings) | development | 11/22 | n/a | 23/23 |
| Harbor (15) | held out at `584254d`, then used for fixes | 3/15 | 3/15 | 15/15 |
| Lumen (14) | held out at `e6227d3`, never run during development | n/a | **12/14** | 14/14 |

Lumen's 12/14 is the honest generalisation number. Its two failures were a
split written as "30% on signature and 70% on launch", and "how much do the SMS
reminders cost" answered with the contract fee (a wrong-subject positive).
Both were fixed at the root afterwards. The same author wrote all three
corpora, so none of them is independently blind.

## 10. Memory layers and the knowledge graph (`memory/`)

| Layer | Holds | Can it change a record? |
| --- | --- | --- |
| evidence | original documents, exact text | immutable |
| semantic | claims (value, status, span), lab observations; recomputed per index | derived only |
| episodic | answered turns with exact cited spans (content-hash keyed) | no |
| working | the current call's or session's context | no |
| temporal | "as of / before <date>" views using only records dated on or before it | no |

The graph (`memory/graph.mjs`) is rebuilt from semantic and episodic memory on
every request, so it cannot drift from the evidence. Levels: overview → topic
→ value → exact sentences → original page. An episode citing text that no
longer exists drops out. `evaluation/longitudinal.test.mjs` covers:
- as-of answers;
- import-order invariance;
- duplicate imports;
- deleting sources;
- graph growth;
- conversation never promoting a status.

## 11. Voice: vault, lab, isolation

- **Vault** (`npm run test:vault`) replays Bolna-shaped calls against the real
  server over HTTP:
  - recogniser spelling variants;
  - barge-in with a truncated assistant turn;
  - overlapping turns;
  - 20 concurrent calls checked against their solo answers;
  - wrong and expired bearers;
  - lab turns in English, Hindi and Hinglish.

  Golden recordings flag every wording change. It simulates Bolna only: no
  audio, recogniser or TTS.
- **Voice lab** ("Measure this call") measures a real call. Speech end comes
  from local VAD, receipt and first byte from clock-aligned server timestamps,
  and agent audio onset from the SDK volume level. What the recogniser
  delivered is scored against a read script: WER, plus number, month and
  negation errors. No real call has been made with it.
- **Isolation:** the shared fixed bearer takes context only from the request's
  own message history. Before this fix, caller B's follow-up was answered with
  caller A's field.

## 12. Persistence, demo, operations

- `VM_DATA_DIR` + `VM_STORE_KEY` enable AES-256-GCM at-rest storage of the
  owner's workspace (library and episodic memory). It refuses to start without
  a key. Restore happens only after owner sign-in or in local single-user
  mode. Render free's disk is ephemeral.
- `VM_PUBLIC_DEMO=1` (off) enables an isolated synthetic demo at `/demo`:
  ask/map/cite/draft only, rate-limited, never touching owner data.
- **Answer cache** with coalescing: 7.8× throughput and p95 291 → 32 ms in the
  local load test (`evaluation/load-test.mjs`, 50 concurrent clients).
- **Cost** (`evaluation/cost-ledger.mjs`): about 4.9 ms of engine CPU per
  answer, measured on this machine. Voice cost is a published-price lower
  bound only.

## 13. Known gaps (ranked)

1. No real-document gold set; the synthetic benchmark cannot detect
   real-world table failures.
2. Table detection is heuristic (aligned runs of text); merged cells and
   wrapped cells are not handled.
3. OCR is English-only; no Hindi/Devanagari model shipped.
4. Voice answers outside claim fields quote one sentence; multi-document
   synthesis is not attempted.
5. Clinical model has no LOINC/UCUM coding and no validated unit conversions.
6. Durable storage needs a persistent disk or database (the code is ready,
   behind `VM_DATA_DIR`). Render free's disk is ephemeral.
7. No real-microphone call has been made or measured.
