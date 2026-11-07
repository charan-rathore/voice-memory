# Additive extracted source lines: prototype contract

Status: local, unlanded, no ownership or answer consumer. This is parser-returned metadata, not proof of source-image characters, record boundaries or numeric correctness.

## Availability

`element.sourceLines` is optional. Missing means metadata was not captured for this element, never that the source has no lines. Empty and absent must not certify authority. This prototype captures indexed PDF/image paragraph and heading lines and digital table parent lines. Non-indexed furniture/overlay lines are retained as unmapped extraction evidence. DOCX/text adapters do not capture lines, and digital tables have no exact cell lineage. Original uploads, parent text/bbox and existing canonical citations remain available independently.

No downstream consumer may require this metadata or promote a legacy fact because it is absent. No schema completeness or layout coverage claim is made.

## Fields

- `id`: element-local line identifier, not a source record or patient ID.
- `rawText`: line text returned by extraction before paragraph joining. PDF text may already include the parser's ligature normalization; OCR text is the recognizer output, not visually verified text.
- `page`, `bbox`: original containing page coordinates. PDF boxes use the existing viewport transform; image boxes use pixels. A box is not a record boundary or certified crop.
- `confidence`: recognizer score where available, otherwise null. High scores do not establish correct digits.
- `group`: existing digital PDF reading-order group or null, not an owner or independently validated column.
- `origin`: extraction method.
- `alignment`: `exact`, `verified-whitespace`, or `unmapped`.
- `canonicalStart`, `canonicalEnd`: offsets into existing rendered canonical text only. Null when unmapped. Never byte offsets into the original PDF or image.

## Alignment policy

Normalize line whitespace only for matching. Require a unique occurrence across the WHOLE rendered parent block, whitespace or block-edge boundaries, and monotonic order after the last mapped line. Repeats, missing text, out-of-order text, dehyphenation, table pipe formatting or other unsupported transforms remain unmapped. A skipped/unmapped line does not prove the other lines' identity or adjacency. `exact` means an identical bounded substring, not proof that the whole visual line has been reconstructed or that its source glyphs are correct.

Canonical text, text hash, original-file hash, existing element spans, pages and warnings are unchanged. Five paired actual extraction fixtures checked payload equality after removing this optional metadata and the parse timestamp. This is finite regression evidence, not format-wide equivalence.

## Versioned capability and caches

`sourceLineMetadata` uses schema `vm.source-lines/1`, with state `partial` when any extraction lines were captured, otherwise `unavailable`. It never claims complete layout coverage. `authority` is always false. Counts report captured parent indexed blocks, extracted lines, aligned lines and lines with geometry. They are coverage diagnostics, not safety certification. Text/DOCX results explicitly report unavailable. The document view calculates this summary from stored lines; legacy/restored documents without lines remain unavailable without changing stored facts or pipeline stamps.

A shared `ingest/version.mjs` exports `vm-ingest/source-lines-1` for worker final/partial results, text imports and content-addressed cache keys. The declared extension stays in the key so format validation remains separate. This invalidates the old runtime-2 parse-cache namespace, not persisted owner workspaces. Restored legacy parses are not silently re-ingested or upgraded. Their originals remain available for a future explicit reparse. In-process cache clones retain metadata independently across sessions. Partial mixed-PDF results report the same optional schema while pending scan pages remain pending.

The current metadata is deliberately not a mandatory replacement for vm.document/1. Ownership derivation needs its own reviewed schema, explicit supported/unresolved states and source-derived positive/negative controls before any generic, clinical, graph, retrieval, cache or voice consumer uses it.

## Remaining qualification

Full exact-head gates, memory/latency deltas, independent review and table alignment coverage remain separate. No persistent-workspace migration is implemented. No automatic same-page segmentation, mixed logistics/clinical safety or wrong-clear numeric OCR solution is implemented by this prerequisite.
