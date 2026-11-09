# Legacy voice brief owner propagation

Base: 52ee11f4ec5549c9b6fe17dfc34edc97ab2e314e. Private synthetic fallback qualification, not a real audio/provider test or generic-document understanding benchmark.

## Actual failure

With two synthetic parsed discharge summaries, "What medicines is AL-101 taking?" and the equivalent BJ-202 question produced UNKNOWN even though briefAnswer with the existing explicitly selected canonical owner returned the correct medicine. The legacy voice fallback had already computed patientDecision against the source-bound identity catalog, but omitted its patient when calling briefAnswer and labDigest. briefAnswer correctly refused to pool records from multiple people, causing under-answering rather than cross-patient disclosure in this probe.

## Repair

Pass the existing shared identity decision's patient to briefAnswer and labDigest. Filter supplemental clinical reports by the same canonical subjectOf identity. No owner is inferred from frequency, majority, pronouns, first record, or free-form previous answers. No provider, model or frontend change. Unknown/conflicted owner vetoes and the common resolver's earlier authority remain intact.

## Executed evidence

- Final four focused tests, exact base vs candidate: 2 PASS / 2 FAIL before, 4 PASS after. Subsequent added distinct-name positive assertions also pass.
- Real streamed adapter requests over parsed synthetic source documents: explicit IDs and distinct names retrieve only the correct medicine with supporting citations; namesake records work by explicit ID but not shared name; unknown IDs, unbound pronouns and multi-owner questions do not silently inherit one medicine scope. A printed-ID collision with conflicting names and birth dates is refused by the existing identity veto.
- Focused plus existing record-owner/voice-adapter tests: 26/26 pass.
- Format/type/build passed; core 268/268; boundaries including the new regression 218/218; evaluation 515/515 using VM_PUBLIC_COUNTER_FILE=/tmp/vm-voice-brief-evaluation-isolated-20261109.json.
- Full verify, fresh browser/audio/provider, other operating systems and arbitrary document qualification were not run for this repair. Earlier AMBIGUOUS browser qualification is a separate checkpoint.

Known limit: the multi-owner legacy medicine request in this synthetic fixture still abstains rather than producing two separately verified briefs. This repair does not claim to answer such compound requests or solve the default generic whole-question coverage gap. It does not relax patient binding to make a test pass.
