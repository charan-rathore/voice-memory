# Independent adversarial reproduction fixtures (local only)

Written by the independent review (Instinct), not by the fixture/oracle
author, to reproduce the 2026-11-08 adversarial findings against unseen
synthetic documents. All data is synthetic; no production system is
contacted (the probe starts a local server on 127.0.0.1).

- `build-fixtures.mjs`, `build-fixtures2.mjs` regenerate the PDFs in
  `files/` (dob-conflict, namesake3, namesake-majority, narrative-summary,
  injection-summary).
- `probe.mjs [dob|citation|namesake|majority|narrative|injection|all]`
  uploads through the public API and prints full answers, citations and
  evidence spans.

These are reproduction evidence, not CI: the committed harness regressions
covering them are evaluation/patient-identity.test.mjs (DOB conflicts),
evaluation/evidence-trim.test.mjs (excerpt trimming) and
evaluation/case-file.test.mjs (evidence excerpt quality).
