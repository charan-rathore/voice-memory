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

### ADR-4: Hybrid retrieval is not added on this branch
Keyword retrieval with claim-aware logic stays. IntelliRAG's own experiment did
not beat BM25 on its dataset, and there is no retrieval gold set for Voice
Memory yet. Dense or hybrid retrieval ships only when a benchmark on Voice
Memory questions shows it recovers required evidence that BM25 misses.

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

## 7. Known gaps (ranked)

1. No real-document gold set; the synthetic benchmark cannot detect
   real-world table failures.
2. Table detection is heuristic (aligned runs of text); merged cells and
   wrapped cells are not handled.
3. OCR is English-only; no Hindi/Devanagari model shipped.
4. Voice answers outside claim fields quote one sentence; multi-document
   synthesis is not attempted.
5. No clinical data model (FHIR Observation/LOINC/UCUM); lab rows are text.
6. Storage is in-memory per session.
