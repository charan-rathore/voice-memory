# Records, facts and the grounded graph

A file is often several records: an intake note, a preliminary lab report,
its amendment, an estimate, a signed discharge summary, a posted bill. The
engine reads each record separately, ranks it by the status it prints, and
answers from the most authoritative record that states the fact.

## What is built, and from what

| Layer | Source of truth | Module |
| --- | --- | --- |
| Tables | Column grid of the text layer (`gridRuns`): same cell x positions, evenly spaced rows, label/value tables included | `ingest/pdf.mjs` |
| Records | A page whose own header (patient ID + date/status, or a top heading) differs from the previous page's | `clinical/observations.mjs` `packetSegments`, `src/record-facts.mjs` `headingSegments` |
| Authority | Printed status words in the record's header block only. Provisional words win: `DRAFT / NOT APPROVED` is never approved. Labels such as `Expected …`, `Estimated …` are provisional wherever they sit | `recordStatus`, `PROVISIONAL_LABEL` |
| Facts | Table rows and `Label: value` lines, each with its exact character span | `recordsOf` |
| Answers | Most authoritative record first; a provisional value of the same field or concept, of the same kind (date/amount) and actually different, is named as superseded; an amount or date named in the question steers to its field; yes/no questions answered "not according to the most authoritative record" when it does not carry the asked value | `factAnswer` |
| Graph | Records, patients (same printed name + different ID is an explicit "not the same person" edge), facts with their spans, `supersedes` and `corrects` edges | `src/record-graph.mjs`, `clinicalGraph` |
| Digest | What the reading view shows: block mix, records, a real BM25 lookup (index tokenizer, k1 1.5, b 0.75), one passage's term weights, graph counts | `src/index-digest.mjs` |

Nothing is taken from prose for facts or graph edges. A question is not
answered from a fact when more of its distinctive words are absent from the
documents (or from that fact) than the fact matches.

## Benchmarks (2026-11-04)

`evaluation/semantic/run.mjs` asks every case through the public `/ask`
route; packets are uploaded through the visitor upload route
(`workspaces` in the case file). `firstNot` checks only the first sentence,
so naming a superseded value as superseded is allowed.

Held-out first runs: questions and gold written before either build was
run, run once, no code change in between. Same author as the code, so not
independent.

| Set | main | this branch (first run) |
| --- | --- | --- |
| `packets.json` (clinic, procurement, lease) | 10/32, 1 critical | 19/32, 1 critical |
| `packets-heldout2.json` (vet, event, grades) | 4/21, 1 critical | 12/21, 4 critical |
| `packets-heldout3.json` (car service, home loan) | 2/14, 1 critical | 7/14, 0 critical |

Abstention was 100% with 0 false acceptances in every run above.

Each set was then used for development, so the later numbers are NOT held
out: `packets` 30/32, `heldout2` 21/21, `heldout3` 11/14, all with 0 false
acceptances and 0 critical failures. The earlier suites (`cases`,
`heldout`, `vernacular`, `vernacular-heldout`) are unchanged versus main.

Known gaps: compound questions ("how many arrived, and were any
damaged?"), abbreviations not printed in the document ("EMI"), Hinglish
questions about record facts (answered in English, or not at all), and
questions whose subject is in the documents but not in any table fact
("is there duplicate billing?" gets the bill's issue date, true but not the
answer). Status words outside the lists in `record-facts.mjs` leave a record
"unknown", ranked between provisional and authoritative.

Run: `npm run eval:packets`. Packets: `python3 evaluation/packets/build.py`
(and `build2.py`, `build3.py`; fictional, reportlab, invariant output).
