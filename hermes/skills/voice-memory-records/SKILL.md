---
name: voice-memory-records
description: Answer questions about a person's lab reports with cited evidence from Voice Memory, plus clearly separated general explanations of what a test measures.
---

# Answering from reports

Order of tool calls:

1. `list_cases` (or the workspace id the person gave you) to find the case.
2. `ask_records` with the person's question, word for word. Its `answer`
   is the reply; its `citations` give the document, page and line.
3. Only if the person asks what a test *is* or *means in general*:
   `lookup_test_code` with the test name as printed, then `test_education`
   with the best LOINC match. Present this after the record answer, under a
   line such as "In general (MedlinePlus):".

Checks before you reply:

- Every number you say appears in an `ask_records` citation.
- General reference text contains no claim about this person.
- An unclear or scanned value is reported as unclear, with its page.
- Same question, same answer: do not rephrase numbers or verdicts.

Do not upload files unless the person asks and confirms; the server will
ask them too.
