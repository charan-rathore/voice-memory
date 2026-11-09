# AMBIGUOUS classification repair

Base: f63291df04214edaa0b1e879e134cb98d928f579. This is a narrow contract repair, not arbitrary-document or production readiness.

The unchanged lead "The approved records conflict: $30,000 versus $45,000. I can't pick one without knowing which you mean." previously left the public API with final.kind/status answered. AMBIGUOUS now maps to clarify, preserving supported conflict wording and source citations. OPEN and NO-RECORD remain answered. Evidence-only fallback remains abstained with separately labelled related evidence; PR77's all-content-word heuristic is not introduced.

## Executed evidence

- Build ran before reproduction.
- Exact focused tests: node --test --test-force-exit tests/answer-contract.test.mjs tests/public-api.test.mjs. Corrected final assertions: base 50 PASS / 3 FAIL, candidate 53 PASS / 0 FAIL.
- The API test creates a real local HTTP workspace, uploads two synthetic approved-fee documents, waits for ingestion, asks the full question, and checks actual lead/final/status and both document citation identities. Provider is explicitly disabled. It does not mock the answer.
- Candidate format check, typecheck, build passed.
- Core 268/268; boundaries 214/214; evaluation 515/515 with a fresh local counter file; ingest 51/51; clinical 119/119; ingest benchmark 131/131.
- First complete evaluation run: 513 PASS / 2 FAIL from an accumulated local test outcome journal reaching capacity. Existing local ledger was preserved, not reset. Rerunning with VM_PUBLIC_COUNTER_FILE=/tmp/vm-ambiguous-evaluation-isolated-20261109.json gave 515/515. This is test isolation, not a production counter change.
- Retrieval benchmark ran and reported literal R@3 0.91, paraphrase R@3 0.29, overall R@3 0.77. These are diagnostic results, not semantic qualification.
- Vault checks printed all checks passed, but the encompassing command reached the execution time limit before clean termination was observed. Do not count that as a verified successful exit.
- Full npm run verify, browser and remaining UI suites were not completed for this checkpoint. No new UI layout is included, so this patch makes no new visual claim.

## Other source-only hypotheses examined separately

Default document reasoning OFF, provider disabled, real synthetic HTTP upload: "Who owns the security review, and what is the retention window?" over "Maya owns the security review. The retention window is 17 days." returns only the owner sentence with final.kind answered and an opaque/unqualified plan. Both single-part controls work. An unknown second question likewise returns only the owner sentence. This is a confirmed remaining default-path whole-question coverage gap, not repaired by the AMBIGUOUS mapping. Do not disguise it with a conjunction split or treat structural coverage as semantic proof.

The public API already exposes questionPlan, admission and requirementCoverage beside final. Their absence inside final itself is not independently established as a functional bug.

A no-shared-resolver voice probe over two synthetic discharge records returned UNKNOWN for named-owner medicine questions even though a direct briefAnswer call with the explicit owner retrieved the correct medicine. This shows under-answering in that tested legacy path, not proof of cross-patient disclosure. It remains a separate investigation. No default identity binding policy was relaxed.

No provider calls, private documents, merge, deployment, PR77 closure or production changes occurred.
