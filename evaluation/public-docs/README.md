# Public-document understanding diagnostics

This is a diagnostic corpus, not a tuned green benchmark. Original PDFs are fetched from public source URLs, not private uploads. Do not add private documents or copyrighted original PDFs to this repository. Source hashes and exact original-page ranges identify what was tested.

The first baseline was captured at `fea4ecfc6efd2bb95ab5debd2980527071e31801` with model and dense inference disabled. A150-page annual report was refused by the60-page cap. An unchanged14-page excerpt of original PDF pages5-18 ingested correctly but failed relationship, chronology, multi-part, summary and missing-variable questions. Relevant retrieval is not counted as an answer. The baseline responses are frozen evidence of those failures, not a model-backed performance estimate.

The rubric is explicitly post-exposure and marks text-only versus original-pixel verification. It must never be renamed held-out or counted as independent qualification. Before capability tuning, add unfamiliar public documents and independent questions spanning narrative, tables, scans, related documents and revisions. Annotate answerable subquestions, entity ownership, source spans, time/revision and uncertainty. Keep synthetic safety regression counts separate.

Local preparation, provider fakes and contract checks do not demonstrate real document reasoning. No paid inference has been approved by this evaluation setup.

## Main-key local model trial, November 8

`berkshire-model-first-trial-wip.json` preserves both the initial multi-part answer and the initial rejected X/acquisition answer. A second attempt answered the X uncertainty and adjustment. Do not erase the first failure or count the second as a deterministic success. The first accepted answer's wording "adjustment to capital" is less precise than the source's incentive adjustment for additional capital employed; a model-based entailment audit is fallible.

`constitution-first-use-rubric.json` was frozen before this implementation's first model run on the National Archives transcription. Its one multipart question tested the unsigned-bill rule, Sundays exception, adjournment exception, and unknown2026budget amount. `constitution-first-use-model-wip.json` is the actual local public upload/ask response with consent true, not just a function mock. Its answer and citations meet those annotated parts and also cite the veto-override alternative. This is one fresh first-use case, not an independently authored hidden set or proof of arbitrary-document parity. No scanned/table/revision corpus has been qualified by this trial.

Provider-key usage updates lagged the first two artifacts. Their zero/immediate delta must not be reported as zero cost. `model-trial-accounting.json` records the later provider aggregate: seven calls completed; usage rose by$0.04109220, remaining$4.41911022 under the unchanged$5lifetimecap. No paid calls are outstanding. The aggregate cannot prove exclusive account activity.
