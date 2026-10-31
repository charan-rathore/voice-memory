# Medical reports: market assessment (31 October 2026)

**Recommendation: narrow, don't pursue as a general "explain my lab report" product.**
Test one specific job: **comparing the same measurement across reports, safely, in the person's own language.** The engine already does that job without a language model in the answer path. Explaining a single report is now a commodity.

What follows separates evidence of the problem, evidence about competitors, and what is still unknown. No market size is estimated: no source found supports a defensible number for this narrow job.

## 1. Is the problem real?

| Evidence | What it shows | Limit |
| --- | --- | --- |
| [Bather et al., *JAMA Network Open*, Aug 2026](https://www.news-medical.net/news/20260818/Study-Many-patients-struggle-to-understand-online-test-results.aspx) (HINTS 2024, n = 4,982 US adults with record access) | 68.6% saw results before hearing from a clinician. Of those, 33.4% reported understanding them only fairly well or poorly (26.8% + 6.6%). | Self-reported; US only. |
| [Lustria et al., *JMIR*, May 2026](https://www.jmir.org/2026/1/e88259) (systematic review, 39 studies, 2013–2026) | In an experiment with 1,817 US adults, only 51% recognised a moderately high HbA1c (8.4%) as out of range. 18 of 24 people were confused by at least one feature of a trend graph. | Measures are inconsistent across studies; most are US-based. |

**Reading:** comprehension is a real, measured gap, specifically in recognising out-of-range values and reading trends. That's the job the comparison feature targets. Neither source measures **worry caused by self-interpretation**, so "reduces anxiety" is a hypothesis, not a finding.

## 2. Who already does this?

| Product | What it does (verified) | Gap Voice Memory could fill |
| --- | --- | --- |
| [ChatGPT Health](https://openai.com/index/introducing-chatgpt-health/) (Jan 2026) | Connects US medical records (via b.well) and Apple Health. Explains test results, tracks trends such as cholesterol, prepares questions for a visit. Runs as a separate space and is "not intended for diagnosis or treatment". Record connection is US-only; the EEA, Switzerland and the UK are excluded. | A generated answer with no line-level source. No India record integration. Hindi and Hinglish quality not measured here. |
| Eka Care (India) | PHR/EMR and the EkaScribe clinical scribe ([source](https://medtechspectrum.com/news/16/24807/eka-cares-ai-powered-ekascribe-transforms-clinical-documentation-for-doctors-across-india.html)). | **Not verified here** whether it explains lab values to patients or compares them across reports. |
| Function Health / InsideTracker (US) | Consumer blood testing with dashboards and trends ([comparison](https://superpower.com/biomarker-testing-companies/function-health-vs-insidetracker)). | Tied to their own lab panels; uploading other labs' reports isn't their model. Prices weren't verified from first-party pages. |

**Already a commodity:** uploading a PDF and getting a plain-language explanation. ChatGPT Health makes that free for many US users.

**Not a commodity yet:** a comparison that refuses to compare when it isn't safe. It checks for different units, a missing unit, different patients, or an amended report (and uses the corrected value), and it cites the exact row on the page. Out-of-range recognition in the evidence above is the measured failure that this addresses.

## 3. What the prototype does today (synthetic data only)

- Extracts typed lab observations: test, comparator, value, unit, range, flag, patient, dates and report status.
- Comparisons refuse on a unit mismatch, a missing unit or a patient mismatch. An amended value wins and the original is still cited.
- Explains the result in English, Hindi or Hinglish in the language of the question. Every number comes from the cited row, and general background is labelled as general.
- Tone is enforced by tests, not by hope: disease names, alarming words and false reassurance ("you're fine") are banned in all three languages (`clinical/explain.test.mjs`). Every comparison ends by pointing to the clinician.
- **Not done:** review by qualified clinicians, real lab layouts, LOINC/UCUM mapping, specimen and method checks. **No clinical claim can be made.**

## 4. Regulatory and privacy constraints

- **US FDA:** the [January 2026 CDS guidance](https://www.cov.com/en/news-and-insights/insights/2026/01/5-key-takeaways-from-fdas-revised-clinical-decision-support-cds-software-guidance) covers only software aimed at healthcare professionals. A patient-facing lab explainer isn't clearly covered by that exclusion; FDA plans to revise its device-software policy in FY26. Treat the US status as unresolved and get regulatory advice before launching there.
- **India DPDP:** the [DPDP Rules 2025](https://www.india-briefing.com/news/dpdp-rules-2025-india-data-protection-law-compliance-40769.html) were notified on 14 November 2025.
  - Core obligations (consent notices, purpose limitation, retention and erasure, security safeguards) apply after 18 months, around May 2027.
  - Breach reports to the Board are due within 72 hours.
  - The rules carry no health-specific provisions, so health data falls under the general regime.
- **This deployment** keeps data in memory, with optional encrypted at-rest storage. It has no audit log or retention policy and is not appropriate for real records. No compliance is claimed.

## 5. The experiment that decides it (falsifiable, not yet run)

**Who:** about 12 people in India who track a repeated test (thyroid, HbA1c, ferritin or vitamin D) across at least two reports, plus about 3 caregivers. Use their own reports only with explicit consent, processed locally.

**Task:** "Did this value change since your last report, and is it comparable?"
- Arm A: their usual way (lab portal, ChatGPT, asking someone).
- Arm B: Voice Memory, typed or spoken, in their language.
- The order of the two arms is counterbalanced.

**Measures:**
- correct answer, including correctly saying "not comparable" when units differ;
- time to a verified answer;
- whether they opened the cited row;
- the language they chose;
- self-reported worry before and after (a 1–5 scale).

**Continue if:**
- ≥ 8/12 prefer B;
- B makes zero unsafe comparisons;
- ≥ 4 people ask to use it on their next report.

**Kill or narrow if:**
- ≤ 5/12 prefer B; or
- people value the explanation but never the comparison (a commodity: ChatGPT Health already does it); or
- worry doesn't fall.

**Payment signal:** after the session, offer a ₹199 one-time "compare my next report" and record who pays. Stated willingness doesn't count.

**Status: not run.** No users were contacted. Outreach needs the owner's approval.
