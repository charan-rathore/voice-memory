# Real reports: why uploads failed, and what changed (2026-11-01)

A visitor uploaded their own two-page lab report (an Indian lab's printout:
CBC, liver panel, CRP, dengue serology) and asked *"does this patient have
some critical symptoms? what exactly is this report suggesting"*. The answer
was "I could not find supporting passages." Asking for the platelet count
returned a garbled table row. This note records the root causes, found by
running the same upload path on that report and on public sample reports,
and the fixes, measured on a field set.

## Root causes (in the order the request meets them)

| # | Where | What went wrong |
| --- | --- | --- |
| 1 | `clinical/observations.mjs` `extractReport` | Results were read only from tables whose header row said *Test / Result / Unit / Reference range*. Real printouts put that header on its own line, split rows with method lines (`IFCC`, `(Calculated)`), print the range before the unit, or write `Hemoglobin: 13.5 g/dL (Normal Range: Female: 11-15 g/dL)`. Zero results were extracted from the visitor's report. |
| 2 | `reportMeta` | Patient and dates were recognised only in the synthetic format (`Patient: …, ID SYN-0001`, `Collected: 12 October 2026`). Its case-insensitive regex also matched prose ("patients on steroid therapy" became patient *s on stero*, ID *THERAPY*). |
| 3 | `clinical/answer.mjs` `clinicalTurn` | With no patient ID, every lab question was refused ("I can't tell whose results these are"), even for a single uploaded report. |
| 4 | Question matching | Only exact printed names or a few aliases matched: "haemoglobin" vs `HAEMOGLOBIN PERCENTAGE`, "SGPT" vs `ALANINE AMINOTRANSFERASE ALT (SGPT)`, "platlets" all missed. |
| 5 | Intents | There was no answer for the questions people ask first: *what is this report suggesting, anything abnormal, how is my liver, is the dengue test positive*. |
| 6 | `src/paraphrase.mjs` | `QUERY_PREFIX` was referenced but no longer defined after a refactor, so every paraphrase lookup threw and was swallowed: semantic rescue was silently off in production. |
| 7 | Narrative reports | Radiology reports and doctors' letters answer in sections (IMPRESSION, FINDINGS, CLINICAL INFORMATION). Keyword search returned the heading line ("IMPRESSION.") or the form header ("PATIENT: … DOB: …") as the "answer". |
| 8 | PDF text | Fonts that map ligatures to odd code points turned "Patient" into "PaƟent" and "after" into "aŌer", so neither search nor name matching saw the words. |

## Fixes

- **`clinical/lab-lines.mjs`**: a line reader that decides what each piece
  of a row is from its content: value (number, bound, or qualitative word),
  unit (shape of a unit), range (shape of an interval), flag. It handles
  sex-specific ranges (`13-99 YRS,Male:13.5-18`, `M:13-17 F:12.0-15.0`), the
  "Adults" range, Indian digit grouping (`1,50,000`), `32.5 +/- 2.5`, open
  bounds (`< 150`, `up to 10`), and qualitative references (`NEGATIVE`). A
  line is a result only with a test name, a value and a unit or range, so
  prose and headers are not read as results. Same safety rules as before: no
  unit is inferred, no conversions, and an ambiguous range is kept as text
  and never used to judge a value. A child's result is not judged against
  adult ranges.
- **Report headers** (`genericMeta`): name, ID (UHID, MRN, Lab No, PID…),
  sex, age; dates only when unambiguous. `11/06/2026` stays as printed unless
  the document shows its day/month order elsewhere.
- **Subjects**: results belong to the printed ID, else the printed name,
  else the document. Reports are combined only under the same subject; two
  unidentified uploads are never treated as one person.
- **Test identity** (`canonOf`): printed names map to one glossary entry by
  their words (abbreviations, British spellings, generic extra words), with
  ~35 new entries, each paraphrased from a MedlinePlus page. Questions also
  match by alias and tolerate one or two typos in long words.
- **New answers** (`clinicalAnswer`): one test; a body system or printed
  section ("liver", "dengue profile"); the whole report (what is outside
  the lab's printed range, qualitative results against the expected result,
  no diagnosis, "a lab report shows results, not symptoms"); and "not in
  these reports" with what is there. English, Hindi and Hinglish.
- **Narrative documents** (`src/doc-sections.mjs`): a section-shaped
  question is answered with that headed section, verbatim and cited:
  *what does this suggest* → IMPRESSION/CONCLUSION, *why was it done* →
  CLINICAL INFORMATION, *was contrast used* → CONTRAST/TECHNIQUE. A heading
  or form header is no longer returned as an answer.
- **Semantic search for any document**: `QUERY_PREFIX` restored (with a
  test); lay words also search for the clinical words reports use
  (`src/lay-terms.mjs`: "fluid" → effusion, "enlarged heart" →
  cardiomegaly, after the Consumer Health Vocabulary idea); short findings
  ("Moderate hiatal hernia.") are retrieval units; and an agreement gate
  serves a sentence when the lexical leader is also semantically close, in
  addition to the calibrated cosine gate. On the Northstar paraphrase bench
  this adds no wrong passages and no accepted unanswerable questions.
- **PDF ligatures** repaired at extraction (`ingest/pdf.mjs`).

## Measured

`evaluation/field/` holds questions written by reading eleven public sample
reports (Indian, Pakistani and US lab printouts, a radiology report, a
narrative medical report). The files are third-party samples on GitHub;
`fetch.mjs` downloads them locally and they are never committed.

FIELD_RESULTS

The visitor's own report is not part of the committed set (it is personal
data); it was used locally only, and the fictional
`clinical/real-layouts.test.mjs` reproduces its layout in CI.
