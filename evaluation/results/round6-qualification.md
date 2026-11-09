# Round6 local qualification, still open

No merge, deploy or publication authority. Last published head remains 4ca0cf7; these repairs are local and the old published CI does not qualify them.

## Packet assertion change

The old `hospital case file: evidence excerpts start at the record they quote` assertion required every diagnostic retrieval excerpt to begin with Maya or HbA1c. That caught the original wrong-record display bug, but it also excluded packet records without lab observations. Round6 sourceRecords now includes those records by actual packet span, including a billing estimate tail. They are explicitly context-only, not supporting citations.

The replacement retains the original relevance assertion for supporting evidence. An excerpt without Maya/HbA1c must be contextOnly=true, binding=record-span, and lie entirely within its own record.start/end. Exact quote length versus start/end remains asserted. This does not permit a billing passage to become answer support. Final selected-patient citations are separately checked for correct owner, contextOnly=false, and source pinpoint locations in clinical/packet.test.mjs; actual desktop/mobile screenshots show final TV-P2002 source ownership and value90 matching the chart. The unselected UI has no chosen chart and marks all diagnostic excerpts context-only.

## Evaluation boundaries

Frozen main35 and holdout34 question files remain unchanged. Selected-context integration regression explicitly supplies HLG-P1047 and is labeled as such. The additional frozen-unselected69 pass checks original never-patterns and citationless ambiguity, not the legacy value-answer want-patterns. Neither is independent holdout qualification. Probe canonicality requires exact frozen question and document hashes, no selection context and no partial run. Modified canonical paths and per-question patient contexts are tested in isolated copies.

## Measured retrieval weakness

The earlier cede815 dirty-tree BM25 baseline measured overall R@3 .77 (30 prompts), paraphrase R@3 .29 (7 prompts), approximately1ms/query. This remains an unresolved measured weakness, not a production or clinical performance claim. Ingest131/131 printed across22files, but that combined earlier command timed out in cleanup, so it was not a clean-exit qualification result.

## Current checks

Latest local: evaluation452/452, clinical119/119, format/typecheck/build pass; call-ui pass. Core207/207 and boundaries207/207 passed before the final source-record integration repairs, so final reruns remain owed. A fresh Sol review is pending on the actual137219byte cumulative diff, SHA2565fad615641c1566b6ea00414cf6516b6f17f289138938d788bec7cac5f1aada3. This is not completion.

## Sol4 follow-up and latest local state

Sol4 requested changes. Reproduced two mixed-reference losses (full Bob + shorthand Alice; Alice ID + Bob name), aunt/uncle stale-selection routing, and dropped generic final citations in a partly clinical source. Current local repairs union all name/ID references, preserve ambiguous firstname matches outside full-name spans, extend relative vocabulary, and bind final clinical citations only when explicitly marked as clinical observation evidence. Nonclinical citations remain unchanged even inside or outside clinical record spans. Overlapping diagnostic spans aggregate per record and support/context class. The review's distinct-overlap fixture measured347 final entries locally, not its asserted24800; aggregation now tests100 records retained in100 output entries with10000 total quote characters. No identity or supporting record is dropped to meet a four-item cap.

Latest reruns: evaluation455/455, clinical119/119, full core214/214 in sequential non-forced mode, boundaries207/207 in sequential non-forced mode. Format/typecheck/build and real packet/long-ID UI pass. The old forced core runner printed206 or207 and omitted up to8 registered tail tests from output; direct identifier file49/49 and non-forced214/214 include them all. package scripts now use sequential non-forced runners with short parse-worker idle and watchdog off, matching the successful commands. Earlier non-forced attempt without short parse-worker idle timed out; do not count it as a pass.

Remaining: fresh adversarial review of these post-Sol4 repairs, GET patient-cache replay regression, complete positive unselected frozen oracle, broader invalid-date layout coverage, exact-head CI, retrieval weakness and final qualification. No publication, merge or deployment.
