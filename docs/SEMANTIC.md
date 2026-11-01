# Semantic layer, visual summary, dictation and the reader (2026-11-01)

What changed on branch `semantic-visual-upgrade`, what was measured, and what
is deliberately not claimed. Nothing here is clinical validation.

## 1. The failure this starts from

The live smoke test asked *"Why is creatinine in different units?"* and heard
*"Your Creatinine result is 106 µmol/L…"*: a related value substituted for the
answer. Reproducing on `main` (cd851a7) found more of the same shape:

| Question | `main` answered | Problem |
| --- | --- | --- |
| Why is creatinine in different units? | the October value | why → value |
| creatinine ka unit alag kyun hai | the October value, in English | why → value, wrong language |
| Why was the ferritin corrected? | the ferritin value | the report states the reason ("transcription error") |
| What is hemoglobin? | "Whose results?" | definition asked, patient asked back |
| what is a retainer? | "$42,000 is the current proposal" | term → fee |
| what is my blood pressure | a whole-report overview | absent measure → other values |
| what is SYN-0003's ferritin? | **SYN-0001's 50 ng/mL** | **patient mix-up** (SYN-0003 has no ferritin) |
| SYN-0003 ka HbA1c kitna hai | **SYN-0001's 6.1 %** | **patient mix-up** |
| how come creatnine is in umol… | filler removal turned "umol" into "ol" | normaliser bug |

## 2. Architecture (smallest change that fixes the class, not the cases)

```
question ─► normalizeSpoken (notation only; IDs "syn 0003" → SYN-0003; fillers whole-word)
         ─► classifyIntent      src/semantic/intent.mjs   WHY · TERM · COMPARE · SUMMARY · MISSING · LOOKUP
         ─► intentLead          src/semantic/route.mjs    deterministic, no model call
               WHY   → clinical/why.mjs: units / correction / flag / "not recorded"
               TERM  → vetted glossary (MedlinePlus-paraphrased) + where it appears
               MISSING / absent test → "not in these reports" + what is there
         ─► deterministic engine (unchanged: claim graph, clinical answers, sections, hybrid search)
         ─► semanticRescue      only when it changes the outcome
               TERM not in glossary  → Gemini + google_search on the generic term only (sources kept)
               SUMMARY of records    → composed from the engine's own cited sub-answers
               unanswered            → Gemini *interprets* the question; the engine answers the rewrite
               still unanswered      → Gemini claims over redacted passages (consent required),
                                       each verified by src/semantic/verify.mjs
         ─► auditLead           a why met by a bare value, an absent measure met by other values,
                                or a model sentence with an uncited number → honest no-answer
```

Answers keep three things apart: what the documents state (cited rows), general
background (labelled, with its source), and what cannot be concluded (no
conversion, no cause, no diagnosis).

**Claim verification** (`verifyClaims`): a model claim is accepted only if its
quote is a literal span of the original document (placeholders restored), every
number and unit in the statement is printed in that quote, a strong status
(approved, signed, final) is printed in the quote, polarity matches, and it
names no other subject. Citation ≠ correctness, so all five run.

**Gemini** (`src/semantic/gemini.mjs`, official `@google/genai`, model
`VM_GEMINI_MODEL`, default `gemini-3.8-flash`):

| Control | Default | Env |
| --- | --- | --- |
| Off without a key; kill switch | off | `GEMINI_API_KEY`, `VM_GEMINI=off` |
| Grounded search | on when keyed | `VM_GEMINI_SEARCH=off` |
| Calls / day | 500 | `VM_GEMINI_DAILY_CALLS` |
| Search calls / day | 100 | `VM_GEMINI_DAILY_SEARCH` |
| Estimated spend / day | $2 | `VM_GEMINI_DAILY_USD` (prices: `VM_GEMINI_IN_USD_PER_M` 0.75, `…OUT…` 3.75, `VM_GEMINI_SEARCH_USD` 0.014) |
| Calls / IP / hour | 40 | `VM_GEMINI_CALLS_PER_IP_HOUR` |
| Timeouts | 4.5 s interpret, 8 s claims, 9 s search, 12 s transcribe | `VM_GEMINI_*_MS` |
| Cache | 600 entries, 24 h, by content hash | — |

Over any cap, on any error or timeout: `null`, and the deterministic answer
stands. Patient IDs, printed names, phones, emails and dates of birth are
replaced with placeholders before document text leaves the server; search
receives only a generic term and refuses anything identifier-shaped. Visitor
documents reach the model only when the request carries `semantic: true`
(the fictional demo cases are always allowed). `/healthz` reports counts,
spend estimate and the last error class — never the key or content.

## 3. Setting the Gemini key (Render encrypted environment variables)

Do not put the key in Git, in `site/` (Vercel serves it to browsers), in chat,
or in logs. The browser never talks to Gemini; only the Render engine does.

1. Create a key in Google AI Studio (aistudio.google.com → *Get API key*), and
   in Google Cloud restrict it to the *Generative Language API*. Set a budget
   alert on that project.
2. Render dashboard → the `voice-memory` web service → **Environment** →
   **Add Environment Variable**: key `GEMINI_API_KEY`, value = the key. Render
   encrypts it at rest and injects it at runtime only.
3. Optional in the same screen: `VM_GEMINI_MODEL=gemini-3.8-flash`,
   `VM_GEMINI_DAILY_USD=2`, `VM_GEMINI_DAILY_CALLS=500`.
4. **Save, rebuild and deploy.**
5. Check `https://voice-memory.onrender.com/healthz` → `semantic.configured: true`,
   `semantic.enabled: true`, `semantic.lastError: null`; and
   `/api/public/status` → `semantic.enabled: true`.
6. To switch it off at once without removing the key: `VM_GEMINI=off`, deploy.
   To rotate: add the new key value, deploy, then delete the old key in AI Studio.

Without the key the product behaves exactly as described in §2 minus the
model steps: every result in §5 below was measured that way.

## 4. Front end (site/)

- **Visual summary** (`site/visual.js`): the empty answer panel shows the case
  at a glance. Lab results are measuring strips on chart paper: the lab's own
  printed range is the hatched band, the value is the ink dot, a corrected
  value stays visible as a struck-through ghost with a pen stroke to the
  correction, a unit change is a torn break in the history (never a line).
  Pine = inside the printed range, ochre = a little outside, carmine = clearly
  outside, indigo = corrections and other people. Records get a "where it
  stands" board with ink stamps and a dated document timeline. Answers carry a
  focused version (the tests the answer used, with history).
- **Narration**: English / हिन्दी / Hinglish, defaulting to the language of the
  last question. The server writes the sentence (deterministic, from the same
  rows); the browser's best local voice reads it; each strip is marked while
  its sentence is spoken. On a Bolna call, Bolna speaks the answer sentence.
- **Dictation** (`site/dictate.js`): press the mic in the ask bar. Live words
  appear as you speak (browser recognition, `en-IN`/`hi-IN`); the clip is also
  recorded and, when the engine has a Gemini key and you agreed, transcribed
  server-side with this case's vocabulary (test names, IDs, document terms).
  Fillers removed, self-corrections applied ("ferritin, no I mean creatinine"),
  spoken IDs normalised. Ends on press, Enter, or ~1.4 s of silence after
  speech (adaptive noise floor); 45 s cap; Escape discards. Consent is asked
  once and says where audio goes; the mic is released when the take ends.
- **Reader**: opening any document opens the whole case — every page of every
  document, in order, with a sticky page strip; the chosen document scrolls
  into view and cited lines are marked. Visitor PDFs render every page from the
  original file with pdf.js (vendored in `site/vendor/`, same-origin, CSP-safe).
  The four demo lab PDFs and seven Northstar files are each one page long;
  that is what they contain, not a truncation.

## 5. Measured (keyword retrieval; no Gemini key in this sandbox)

`evaluation/semantic/run.mjs` judges each answer by a rubric (does it answer,
explain, define, ask which patient, refuse to compare, or abstain as the
question needs; required facts present; known substitutions absent; language).
Labels were written from the documents by the same author as the code, so the
sets are **not independent**; 95% Wilson intervals are wide at these sizes.

| Set | Build | Answerable correct | Correct abstention | Critical failures |
| --- | --- | --- | --- | --- |
| Development (48) | `main` cd851a7 | 32/41 (78.0%, CI 63.3–88.0) | 2/7 (28.6%) | 6 (3 substitution incl. term→fee, 2 false accept, **1 patient mix-up**) |
| Development (48) | this branch | 41/41 (100%, CI 91.4–100) | 7/7 (CI 64.6–100) | 0 |
| Held-out (24), first and only frozen run | `main` | 17/20 (85%) | 3/4 | 1 (**patient mix-up**, x06) |
| Held-out (24), first and only frozen run | this branch | 15/20 (75%, CI 53.1–88.8) | 4/4 | 0 (4 unnecessary refusals) |
| Held-out after fixing those 5 (now development) | this branch | 20/20 | 4/4 | 0 |

The held-out first run is the honest generalisation number: the new build was
safer (no mix-up, no false accept) but refused 4 answerable "why" phrasings
and misparsed one definition. Those were fixed (normaliser `umol` bug, "changed",
"marked L", "explain what X is", "syn 0003"), after which the set is no longer
held out.

Field set (11 public reports, `evaluation/field/`), keyword-only because the
embedding model can't be downloaded here:

| Build | Right | Wrong | Unanswerable refused |
| --- | --- | --- | --- |
| `main`, keyword | 52/58 | 1 | 9/9 |
| this branch, keyword | 52/58 | 1 | 9/9 |

No regression; the production figure with the embedding model (57/58) was not
re-measured here. Latency (in-process, keyword): p50 7 ms, p95 23–27 ms.
Gemini latency, cost per answer, and semantic-only vs hybrid modes are
**not measured**: they need the key (§3) and a live run of
`node evaluation/semantic/run.mjs . hybrid heldout.json` on Render.

Release gates (95% correct, 95% abstention, zero critical) are met on these
sets, but the sets are small, self-labelled and partly development; they are
not a basis for production or clinical claims.

## 6. Voice calling

Public minting stays **off** (`VM_PUBLIC_VOICE` unset → deny). Server-side
minting, per-IP/hour, per-day and global gap limits, single-use expiring
tickets and the kill switch already exist in `src/public-api.mjs`. What blocks
turning it on is not code: the end-to-end path (mic → Bolna/Deepgram →
engine → ElevenLabs) has to be tested on a real call, and the Bolna connector
here can read agents but cannot place calls. Two configuration changes would
improve capture on calls and are worth making before that test (they change
the live agent, so they were not made from here): Deepgram `keywords`/keyterms
for ferritin, creatinine, HbA1c, TSH, SYN-0001, SYN-0003, Northstar, Meridian;
and `language: "multi"` instead of `"hi"` for Hinglish callers.
