# A/B: the same voice agent with and without Voice Memory

`node scripts/ab-eval.mjs dev|heldout [out.json]` runs identical scripted,
fictional scenarios through the v1 API in two arms:

- **A**: no persistent caller memory (anonymous calls). A returning caller
  has to repeat their context.
- **B**: Voice Memory with a verified fictional caller.

Measured per arm: repeated context needed, recall checks / correct recall,
unsupported confident claims, expected vs safe clarifications, failed
expectations, cross-caller isolation failures, local recall/answer latency.
First-audio latency is **not** measured (no real provider call).

**These are developer-authored scenarios: regression evidence, not accuracy
evidence and not business outcomes.** Both arms use the same document
checks, so safety metrics are expected to be equal; the difference Voice
Memory makes here is continuity (recall, no repeated context).

## Held-out set

`heldout.mjs` was written in this release before any tuning against it and
is frozen. SHA-256: `97480cb925a5cfe64bef4317d6e58ac7cb68e81dc514ea7604c7dfdf148c747b`. `tests/ab-eval.test.mjs` fails if the file
changes. New cases go into a new file with a new recorded hash.
Still developer-authored: an independent author should write the next set.

## Results on this release (local)

| Set | Arm | Repeated context | Recall correct | Unsupported claims | Safe clarifications | Isolation failures |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| dev (5) | A | 3 | 0 / 4 | 0 | 1 / 1 | — |
| dev (5) | B | 0 | 4 / 4 | 0 | 1 / 1 | 0 |
| held-out (5) | A | 2 | 0 / 2 | 0 | 2 / 2 | — |
| held-out (5) | B | 0 | 2 / 2 | 0 | 2 / 2 | 0 |
