# Public-document understanding diagnostics

This is a diagnostic corpus, not a tuned green benchmark. Original PDFs are fetched from public source URLs, not private uploads. Do not add private documents or copyrighted original PDFs to this repository. Source hashes and exact original-page ranges identify what was tested.

The first baseline was captured at `fea4ecfc6efd2bb95ab5debd2980527071e31801` with model and dense inference disabled. A150-page annual report was refused by the60-page cap. An unchanged14-page excerpt of original PDF pages5-18 ingested correctly but failed relationship, chronology, multi-part, summary and missing-variable questions. Relevant retrieval is not counted as an answer. The baseline responses are frozen evidence of those failures, not a model-backed performance estimate.

The rubric is explicitly post-exposure and marks text-only versus original-pixel verification. It must never be renamed held-out or counted as independent qualification. Before capability tuning, add unfamiliar public documents and independent questions spanning narrative, tables, scans, related documents and revisions. Annotate answerable subquestions, entity ownership, source spans, time/revision and uncertainty. Keep synthetic safety regression counts separate.

Local preparation, provider fakes and contract checks do not demonstrate real document reasoning. No paid inference has been approved by this evaluation setup.
