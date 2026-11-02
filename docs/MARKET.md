# Voice Memory: market, position and the path to a sale (2 November 2026)

This is a decision document, not a pitch. It separates what was checked from
what is assumed, and ends with experiments that can prove the plan wrong.
The health-specific assessment stays in [MEDICAL-MARKET.md](MEDICAL-MARKET.md).

## 1. The one-line position

**A trust layer for voice and chat agents that answer from documents that
change.** Every answer carries a fixed verdict (current, corrected, proposed
not approved, superseded, not comparable, not in the record) and the exact
line it rests on, in English, Hindi or Hinglish.

It is not a voice platform, a RAG chatbot, or a lab-report explainer. Those
markets exist and are crowded (section 3). The product is the part they leave
to the prompt: knowing which version of a fact is in force, and refusing
when the record cannot say.

## 2. Why now (checked)

- **Voice agents are being deployed in India at volume.** Bolna (YC, $6.3M
  seed led by General Catalyst, January 2026) reports growth from 1,500 to
  200,000 daily calls and 1,050 customers. Sarvam is raising at a reported
  $1.5B valuation (April 2026) on voice-first models for 22 Indian languages.
  Sources: TechCrunch, Bolna press release, Simplify, Let's Data Science.
- **Price pressure moves the question from "can it talk" to "can it be
  trusted".** A minute of AI voice in India is quoted at Rs 1.75 to 5.5
  against Rs 7 to 8 for a human agent; global platforms land at $0.07 to
  $0.30 a minute all-in (Vapi, Retell, Bland pricing pages as reported in
  2026 comparisons). When talking is cheap, the cost that remains is a wrong
  answer: a refund promised on a superseded policy, a fee quoted from a
  draft, a lab value read from the preliminary report.
- **Documents in these flows change by design.** Lab reports are amended,
  proposals are revised, price lists and policy terms are versioned. India
  alone has over 100 crore health records linked to ABHA accounts (May 2026,
  PIB). Contract-review vendors now treat "what changed between versions"
  as a baseline feature (Sirion, SpotDraft, LegalOn), but inside legal
  suites, not in the agent's answer path.

## 3. Who already does what (checked)

| Category | Examples | What they do | What they leave open |
| --- | --- | --- | --- |
| Voice orchestration | Bolna, Vapi, Retell, Bland, ElevenLabs Agents | Telephony, STT, TTS, LLM routing, per-minute pricing | Answer correctness over the customer's changing documents is the customer's prompt problem |
| Grounded doc Q&A | NotebookLM (free tier; bundled in Workspace), ChatGPT projects, Glean ($30K to $200K+ a year), Hebbia | Cited answers over uploaded or indexed documents | Version status is not a first-class output; a cited line can be a superseded one |
| Lab report explainers (India) | ReportSense, Bharat Swasth, Ashvi Health (14 languages), ChatGPT Health (US records) | Plain-language summary of one report | Cross-report comparison that refuses unsafe comparisons; line-level source |
| Contract version compare | Sirion, SpotDraft, LegalOn, Spellbook | Diffs and AI change summaries for lawyers | Not an API an agent calls mid-conversation; English-first |

**Commodity now:** "upload a PDF, get a cited summary". Competing there is a
losing position.

**Not a commodity:** a per-answer verdict about *which* value is in force,
a refusal when units, people or versions make a comparison unsafe, and that
verdict surviving a phone call in Hindi.

## 4. Where Voice Memory stands today (measured, not claimed)

| Capability | State |
| --- | --- |
| Version-aware answers (amended, preliminary, proposed, superseded, open) | Working on fictional cases; 152 evaluation tests and a vault of golden answers in CI |
| Refusals (unit mismatch, patient mismatch, not in record) | Working; enforced by tests |
| Hindi, Hinglish, mixed-domain questions | Working on typed and Bolna voice paths; real-call replay harness (`evaluation/call-replay.mjs`) |
| Reworded questions | Hybrid ranking helps on outside contracts (top-1 44% → 50%); the closest-line pointer is built but off, at 65 to 82% right when shown against a 90% bar |
| Outside-authored benchmark | QMSum meetings and CUAD contracts: hybrid top-1 42.1% and 50.0% against chance 5.3% and 1.2% |
| Integration surfaces | Public REST API (OpenAPI, llms.txt), Bolna custom-LLM endpoint, **MCP server** (`mcp/server.mjs`) |
| Not done | Real customer documents, SSO, audit log, retention controls, SLAs, clinician review, LOINC/UCUM |

## 5. Ideal first customer (assumption to test)

**Teams already running a voice or chat agent on Bolna-class platforms whose
answers depend on a small, versioned document set**, where a wrong version
has a measurable cost:

1. **Lending and insurance support lines (first).** Rate cards, policy
   wordings and fee schedules change; callers ask in Hindi or Hinglish;
   a wrong figure creates complaints and regulatory exposure. Documents are
   not personal health data, so the compliance path is shorter.
2. **Diagnostic lab callback lines (second, after clinician review).**
   "Did my value change, and is it comparable?" across amended reports, in
   the caller's language. Highest emotional value, highest regulatory bar
   (see MEDICAL-MARKET.md).
3. **Agencies and deal desks (third).** "What fee did we last propose, and
   was it approved?" across proposals, minutes and emails. Smaller budgets
   per account, fast cycles, good design partners.

The buyer is the person who owns the agent's answer quality (support ops or
the voice-agent platform team), not legal or IT.

## 6. Pricing hypothesis

Price per **verified answer**, not per seat or minute, so it stacks on top of
whatever voice platform the customer already pays:

- Pilot: free for 30 days on up to 5 documents and 2,000 answers.
- Usage: about Rs 0.50 per answered question (about $0.006), abstentions
  free. At three questions per call that is roughly Rs 1.5 a call, under a
  third of the per-minute voice cost it protects.
- Team plan with retention controls, audit export and SSO: flat monthly,
  quoted.

This is a hypothesis to test in the pilots, not a validated price.

## 7. Distribution

- **Inside the agent platforms, not around them.** One configuration line:
  Bolna custom-LLM URL today; MCP for Claude, ChatGPT connectors and IDE
  agents (`npm run mcp`); REST for everything else.
- **Proof first.** A public, reproducible benchmark on outside-authored
  records (QMSum, CUAD) and the "what it refuses" page are the sales
  material; every number links to the script that produced it.
- **Design partners from the Bolna buildathon and customer community**, then
  case studies with their own (redacted) before/after transcripts.

## 8. Risks

- Platforms add version awareness themselves. Mitigation: be the neutral
  layer across platforms, with the benchmark as the bar they have to match.
- Rule-based extraction does not generalize to every document layout.
  Mitigation: the outside benchmark and real pilot documents decide which
  layouts to support next; abstain rather than guess.
- Health use invites regulation (FDA CDS scope unresolved for patient-facing
  tools; India DPDP obligations from around May 2027). Mitigation: lead with
  non-health documents; health only after clinician review.

## 9. The next 90 days: falsifiable milestones

| By | Milestone | Pass | Fail means |
| --- | --- | --- | --- |
| 30 days | 3 design partners connect their own agent via MCP, REST or Bolna | 3 connected, each with 5+ real versioned documents | The integration is not the bottleneck we think; revisit ICP |
| 45 days | Outside benchmark with dense retrieval and a reranker | Closest-line gate right in 90%+ of shown lines, shown on under 10% of absent clauses | Keep reworded answers as pointers only |
| 60 days | Pilot metric: wrong-version answers on partner transcripts | At least 50% fewer than the partner's current agent on the same questions | The verdict layer is not worth paying for in this segment |
| 90 days | First paid conversion at the usage price | 1 of 3 partners pays | Price, buyer or segment is wrong; test the next segment |

## Sources

- [Bolna seed round, TechCrunch (Jan 2026)](https://techcrunch.com/2026/01/20/bolna-nabs-6-3-million-from-general-catalyst-for-its-india-focused-voice-orchestration-platform/)
- [Bolna press release](https://www.bolna.ai/newsroom/bolna-bags-63-million-seed-funding-led-by-general-catalyst-to-build-indias-voice-ai-platform)
- [Bolna profile and India voice unit costs, Simplify](https://simplify.jobs/c/Bolna-AI)
- [Sarvam AI round, Let's Data Science (Apr 2026)](https://letsdatascience.com/news/sarvam-ai-raises-300m-at-15b-valuation-6770af09)
- [Vapi vs Retell pricing, Fora Soft (Jul 2026)](https://www.forasoft.com/blog/article/vapi-vs-retell-vs-custom)
- [Voice agent platform pricing, DevToolLab (Sep 2026)](https://devtoollab.com/blog/best-ai-voice-agent-platforms)
- [Workplace AI search landscape and pricing](https://vibereference.vercel.app/ai-development/workplace-ai-search-tools)
- [NotebookLM pricing (Jul 2026)](https://aiproductivity.ai/pricing/notebooklm/)
- [AI contract version comparison, Sirion (Mar 2026)](https://www.sirion.ai/library/contract-insights/ai-contract-change-detection/)
- [Document version comparison tools 2026, Vaquill](https://www.vaquill.ai/blog/ai-tools-comparing-document-versions-2026)
- [ReportSense](https://peerlist.io/company/reportsense); Bharat Swasth and Ashvi Health (vendor pages, 2026)
- [ABDM: 104 crore records, PIB (Jul 2026)](https://static.pib.gov.in/WriteReadData/specificdocs/documents/2026/jul/doc202676912801.pdf)
- QMSum: Zhong et al., NAACL 2021, [github.com/Yale-LILY/QMSum](https://github.com/Yale-LILY/QMSum); CUAD: Hendrycks et al., NeurIPS 2021, [github.com/TheAtticusProject/cuad](https://github.com/TheAtticusProject/cuad)
