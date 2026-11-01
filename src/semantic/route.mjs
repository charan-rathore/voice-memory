// The semantic router: understand the question first, then let the evidence
// decide the answer.
//
//   question ─► classifyIntent (deterministic, multilingual)
//            ─► intentLead: WHY / TERM / MISSING answered from typed rows and
//               vetted glossary text (no model call)
//            ─► deterministic engine (claim graph, clinical answers, sections, search)
//            ─► semanticRescue, only when it can change the outcome:
//                 - TERM not in the vetted glossary   -> grounded search (generic term only)
//                 - SUMMARY of non-lab documents      -> cited sub-answers composed
//                 - low-confidence / unanswered       -> Gemini interprets, the engine
//                                                       answers the rewrite
//                 - still unanswered (consented)       -> Gemini claims, each verified
//                                                       against the exact source span
//            ─► auditLead: does this answer the question that was asked?
//               If not, an honest abstention replaces it.
import { classifyIntent, ABSENT_MEASURES } from "./intent.mjs";
import { verifyClaims, auditLead } from "./verify.mjs";
import { redact } from "./gemini.mjs";
import { clinicalWhy, clinicalTerm } from "../../clinical/why.mjs";
import { observationEvidence, findTest } from "../../clinical/answer.mjs";
import { detectLang, nameOf } from "../../clinical/explain.mjs";
import { subjectOf } from "../../clinical/observations.mjs";

const MISSING = {
  en: (m, have) =>
    `These reports don't include ${/^[aeiou]/i.test(m) ? "an" : "a"} ${m} reading. They hold lab results${have ? `: ${have}` : ""}.`,
  hi: (m, have) =>
    `इन रिपोर्ट्स में ${m} का कोई माप नहीं है। इनमें लैब नतीजे हैं${have ? `: ${have}` : ""}।`,
  hinglish: (m, have) =>
    `In reports mein ${m} ka koi reading nahi hai. Inmein lab results hain${have ? `: ${have}` : ""}.`,
};
const NOT_MENTIONED = {
  en: (t) => `These documents don't mention “${t}”.`,
  hi: (t) => `इन दस्तावेज़ों में “${t}” का ज़िक्र नहीं है।`,
  hinglish: (t) => `In documents mein “${t}” ka zikr nahi hai.`,
};
const BACKGROUND = {
  en: (t) => `General background, not from your documents: ${t}`,
  hi: (t) => `सामान्य जानकारी, आपके दस्तावेज़ों से नहीं: ${t}`,
  hinglish: (t) => `General jaankari, aapke documents se nahi: ${t}`,
};

const langOf = (q) => detectLang(q);
const norm = (s) =>
  String(s ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9\u0900-\u097f]+/g, " ")
    .trim();
// Common tests people ask for by name. Used only to say "not in these
// reports" when the report text never mentions them.
const OTHER_TESTS = [
  "vitamin d",
  "vitamin b12",
  "b12",
  "cholesterol",
  "ldl",
  "hdl",
  "triglycerides",
  "glucose",
  "blood sugar",
  "sodium",
  "potassium",
  "calcium",
  "magnesium",
  "platelets",
  "platelet count",
  "wbc",
  "white blood cells",
  "crp",
  "esr",
  "psa",
  "testosterone",
  "estrogen",
  "cortisol",
  "insulin",
  "uric acid",
  "bilirubin",
  "albumin",
  "alt",
  "ast",
  "sgpt",
  "sgot",
  "t3",
  "t4",
  "free t4",
  "lipid profile",
  "egfr",
  "troponin",
  "d dimer",
  "hiv",
  "dengue",
  "malaria",
  "covid",
];

function cite(evs, validate) {
  return evs.filter((ev) => {
    if (!ev) return false;
    try {
      return validate(ev);
    } catch {
      return false;
    }
  });
}

const plain = (s) =>
  ` ${String(s ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9\u0900-\u097f]+/g, " ")
    .trim()} `;
/** Does any document mention this measure (in any of its forms)? */
function mentionedIn(bundle, label) {
  const hay = plain((bundle?.sources ?? []).map((x) => x.text).join(" \n "));
  return (ABSENT_MEASURES.find(([l]) => l === label)?.[1] ?? [label]).some(
    (f) => hay.includes(plain(f)),
  );
}

/** Turn a clinical why/term result into a lead with validated citations. */
function leadOfClinical(r, bundle, validate) {
  const citations = cite(
    [
      ...(r.used ?? []).map((o) => observationEvidence(o, bundle)),
      ...(r.extra ?? []),
    ],
    validate,
  );
  return {
    text: r.spoken,
    verdict: r.verdict,
    field: null,
    citations,
    intent: r.intent,
    parts: r.parts ?? null,
    background: r.parts?.background ?? null,
    used: r.used ?? [],
  };
}

/**
 * Deterministic answers chosen by intent, before the engine's own routes.
 * @returns {null | object} a lead
 */
export function intentLead(question, bundle, validate) {
  const intent = classifyIntent(question);
  const lang = langOf(question);
  const reports = bundle?.clinical ?? [];
  if (!reports.length) return null;
  if (intent.intent === "WHY") {
    const w = clinicalWhy(question, reports, lang, bundle);
    return w ? leadOfClinical(w, bundle, validate) : null;
  }
  if (intent.intent === "TERM" && intent.term) {
    const t = clinicalTerm(intent.term, question, reports, lang);
    return t ? leadOfClinical(t, bundle, validate) : null;
  }
  // Only absent if no document mentions it ("Home blood pressure log").
  const hay = () =>
    ` ${(bundle?.sources ?? [])
      .map((x) => x.text)
      .join(" \n ")
      .toLowerCase()
      .replace(/[^a-z0-9\u0900-\u097f]+/g, " ")} `;
  const mentioned = (label) =>
    (ABSENT_MEASURES.find(([l]) => l === label)?.[1] ?? [label]).some((f) =>
      hay().includes(
        ` ${f
          .toLowerCase()
          .replace(/[^a-z0-9\u0900-\u097f]+/g, " ")
          .trim()} `,
      ),
    );
  // A named lab test that none of these reports contains ("vitamin D"):
  // say so, instead of summarising whatever results are there.
  const absentTest = OTHER_TESTS.find(
    (t) =>
      ` ${norm(question)} `.includes(` ${t} `) && !hay().includes(` ${t} `),
  );
  if (absentTest && intent.intent !== "TERM" && !findTest(question, reports)) {
    const names = [
      ...new Set(reports.flatMap((r) => r.observations.map((o) => nameOf(o)))),
    ];
    const label =
      absentTest.length <= 4
        ? absentTest.toUpperCase()
        : absentTest.replace(/\b\w/, (c) => c.toUpperCase());
    return {
      text: {
        en: `These reports don't include a ${label} result. They have: ${names.slice(0, 8).join(", ")}.`,
        hi: `इन रिपोर्ट्स में ${label} का कोई नतीजा नहीं है। इनमें हैं: ${names.slice(0, 8).join(", ")}।`,
        hinglish: `In reports mein ${label} ka koi result nahi hai. Inmein hain: ${names.slice(0, 8).join(", ")}.`,
      }[lang],
      verdict: "NOT_IN_REPORT",
      field: null,
      citations: [],
      intent: "MISSING",
    };
  }
  if (intent.intent === "MISSING" && !mentioned(intent.measure)) {
    const names = [
      ...new Set(reports.flatMap((r) => r.observations.map((o) => nameOf(o)))),
    ];
    const have =
      names.length > 6
        ? names.slice(0, 6).join(", ") + ` +${names.length - 6}`
        : names.join(", ");
    return {
      text: MISSING[lang](intent.measure, have),
      verdict: "NOT_IN_REPORT",
      field: null,
      citations: [],
      intent: "MISSING",
    };
  }
  return null;
}

// Answers that are complete without a citation: a definition (its source is
// the vetted glossary), "not in these reports", a question back.
const SELF_SUFFICIENT = new Set([
  "DEFINED",
  "NOT_IN_REPORT",
  "NOT_IN_DOCUMENTS",
  "AMBIGUOUS_PATIENT",
  "CLARIFY",
  "NO_REASON",
  "EXPLAINED",
]);
const WEAK = (l) =>
  !l ||
  l.verdict === "UNKNOWN" ||
  (!(l.citations ?? []).length && !SELF_SUFFICIENT.has(l.verdict));

/** What the model may see about a bundle: names of things, never values. */
export function catalogOf(bundle) {
  const reports = bundle?.clinical ?? [];
  const tests = [
    ...new Set(reports.flatMap((r) => r.observations.map((o) => nameOf(o)))),
  ];
  const subjects = [...new Set(reports.map(subjectOf))].filter(
    (s) => !/^(doc|name):/.test(s),
  );
  return {
    domain: reports.length
      ? "lab reports"
      : "documents (contracts, notes, reports)",
    tests,
    subjects,
    documents: (bundle?.sources ?? []).map((s) => s.title).slice(0, 20),
  };
}
const patientNames = (bundle) =>
  (bundle?.clinical ?? [])
    .map((r) => r.meta?.patient?.name)
    .filter(Boolean)
    .map((n) => n.replace(/\s*\(synthetic\)/i, ""));

/** Does the rewrite stay inside the catalog's words (no invented values)? */
function safeRewrite(rewrite, original) {
  if (!rewrite || rewrite.length > 300) return false;
  const nums = (s) => String(s).match(/\d[\d,.]*/g) ?? [];
  const orig = new Set(nums(original));
  // A rewrite may restate the person's own numbers, never add new ones.
  return nums(rewrite).every((n) => orig.has(n) || /^SYN-?0*\d+$/i.test(n));
}

/**
 * The async part: grounded background, composed summaries, model
 * interpretation and verified model claims - each only where it changes the
 * outcome, each falling back to the deterministic answer.
 *
 * @param {object} a
 * @param {string} a.question
 * @param {object} a.bundle
 * @param {object|null} a.lead deterministic lead
 * @param {object} a.raw engine result (evidence passages)
 * @param {(q:string)=>Promise<object|null>} a.rerun deterministic lead for another wording
 * @param {(ev:object)=>boolean} a.validate exact-span evidence validator
 * @param {ReturnType<import("./gemini.mjs").createGemini>|null} a.gemini
 * @param {boolean} a.consent may document passages be sent to the model?
 * @param {string} [a.ip]
 * @param {string} [a.ctx] previous topic
 */
export async function semanticRescue(a) {
  const { question, bundle, raw, rerun, validate, gemini, consent, ip, ctx } =
    a;
  let lead = a.lead;
  const intent = classifyIntent(question);
  const lang = langOf(question);
  const trace = {
    intent: intent.intent,
    confidence: intent.confidence,
    lang,
    steps: [],
  };
  const live = !!gemini?.enabled?.();
  const isClinical = !!bundle?.clinical?.length;

  // TERM: vetted glossary first (intentLead); otherwise grounded search on the
  // generic term, labelled as general background, plus whether the documents
  // mention it at all.
  if (
    intent.intent === "TERM" &&
    intent.term &&
    (!lead || lead.verdict !== "DEFINED")
  ) {
    const hay = (bundle?.sources ?? [])
      .map((s) => s.text.toLowerCase())
      .join("\n");
    const mentioned = hay.includes(intent.term.toLowerCase());
    let bg = null;
    if (live && gemini.searchEnabled()) {
      bg = await gemini.groundedExplain(intent.term, lang, { ip });
      trace.steps.push(bg ? "grounded_search" : "grounded_search_failed");
    }
    if (!mentioned) {
      lead = {
        text: [
          NOT_MENTIONED[lang](intent.term),
          bg ? BACKGROUND[lang](bg.text) : null,
        ]
          .filter(Boolean)
          .join(" "),
        verdict: "NOT_IN_DOCUMENTS",
        field: null,
        citations: [],
        background: bg ? { text: bg.text, sources: bg.sources } : null,
        intent: "TERM",
      };
    } else if (bg && lead) {
      lead = {
        ...lead,
        text: `${BACKGROUND[lang](bg.text)} ${lead.text}`,
        background: { text: bg.text, sources: bg.sources },
      };
    }
  }

  // SUMMARY of non-lab documents: compose from cited sub-answers the engine
  // already gives, so a summary is never less checked than its parts.
  if (intent.intent === "SUMMARY" && !isClinical && WEAK(lead) && rerun) {
    const probes = [
      "What is the fee?",
      "What is the deadline?",
      "What's still open?",
      "Is there a signed contract?",
    ];
    const parts = [];
    for (const p of probes) {
      const l = await rerun(p);
      if (l && !WEAK(l) && !["UNKNOWN"].includes(l.verdict)) parts.push(l);
    }
    if (parts.length >= 2) {
      trace.steps.push("composed_summary");
      lead = {
        text: parts.map((l) => l.text).join(" "),
        verdict: "OVERVIEW",
        field: null,
        citations: parts.flatMap((l) => l.citations ?? []).slice(0, 6),
        intent: "SUMMARY",
      };
    }
  }

  // Low confidence or unanswered: let the model *read the question* (not the
  // documents), then answer its rewrite deterministically.
  // (An answered question costs no model call, whatever its confidence.)
  if (live && rerun && WEAK(lead) && intent.intent !== "MISSING") {
    const red = redact(question, patientNames(bundle));
    const cat = { ...catalogOf(bundle), previous: ctx || null };
    const it = await gemini.interpret(red.text, cat, { ip });
    if (it) {
      trace.steps.push(`interpret:${it.intent}`);
      const rewrite = red.restore(it.rewrite ?? "");
      if (
        it.intent === "UNCLEAR" &&
        it.clarify &&
        WEAK(lead) &&
        !/\d/.test(it.clarify)
      ) {
        lead = {
          text: red.restore(it.clarify),
          verdict: "CLARIFY",
          field: null,
          citations: [],
          intent: "UNCLEAR",
          origin: "model",
        };
      } else if (
        WEAK(lead) &&
        rewrite &&
        rewrite.toLowerCase() !== question.toLowerCase() &&
        safeRewrite(rewrite, question)
      ) {
        const l = await rerun(rewrite);
        if (l && !WEAK(l)) {
          trace.steps.push("rewrite_answered");
          lead = { ...l, interpretedAs: rewrite };
        }
      }
    }
  }

  // Still unanswered: verified model claims over the retrieved passages, only
  // with consent for this document set.
  if (live && consent && WEAK(lead) && (raw?.evidence ?? []).length) {
    const names = patientNames(bundle);
    const passages = raw.evidence.slice(0, 6).map((ev) => {
      const r = redact(String(ev.quote).slice(0, 1600), names);
      const subj = (bundle.clinical ?? []).find(
        (c) => c.sourceId === ev.sourceId,
      );
      return {
        text: r.text,
        restore: r.restore,
        evidence: { ...ev, quote: String(ev.quote).slice(0, 1600) },
        subject: subj ? subjectOf(subj) : undefined,
      };
    });
    const q = redact(question, names);
    const plan = await gemini.planClaims(
      q.text,
      passages.map((p) => p.text),
      { ip },
    );
    if (plan) {
      const { accepted, rejected } = verifyClaims(plan.claims, passages);
      trace.steps.push(
        `claims:${accepted.length}/${(plan.claims ?? []).length}`,
      );
      trace.rejected = rejected.map((r) => r.reason);
      const citations = cite(
        accepted.map((c) => c.evidence),
        validate,
      );
      if (plan.answerable && citations.length) {
        lead = {
          text: accepted.map((c) => c.statement).join(" "),
          verdict: "QUOTED",
          field: null,
          citations,
          intent: intent.intent,
          origin: "model",
        };
      }
    }
  }

  // Final audit: the answer must answer *this* question. "Not recorded"
  // only applies to a lab report that never mentions the measure (a
  // narrative report can hold a diagnosis).
  const auditIntent =
    intent.intent === "MISSING" &&
    !(isClinical && !mentionedIn(bundle, intent.measure))
      ? { ...intent, intent: "LOOKUP" }
      : intent;
  const audit = auditLead(auditIntent, lead);
  if (!audit.ok) {
    trace.steps.push(`audit_failed:${audit.reason}`);
    // An honest "no supported answer": the screen says so and the call
    // says so; nothing related is offered in its place.
    lead = null;
  }
  return { lead, trace };
}

export { classifyIntent };
