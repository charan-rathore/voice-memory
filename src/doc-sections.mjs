// Answers from the structure of narrative documents (radiology reports,
// discharge summaries, doctors' letters, contracts with headed clauses).
//
// A reader asking "what does this report suggest?" or "why was the scan
// done?" means a section, not a sentence: the radiologist's IMPRESSION, the
// CLINICAL INFORMATION, the RECOMMENDATIONS. Keyword retrieval misses these
// because the question shares no words with the answer ("suggest" vs
// "Hyperinflation consistent with COPD"), and a single best sentence is the
// wrong unit. So: find the document's headed sections, map the question's
// intent to the section that answers it, and read that section verbatim
// with a citation to its exact span. Nothing is generated or paraphrased.
import { cite, docLabelOf } from "./spoken-routes.mjs";
import { detectLang } from "../clinical/explain.mjs";

// Section names as documents print them, grouped by what they answer.
export const SECTIONS = {
  conclusion: [
    "impression",
    "impressions",
    "conclusion",
    "conclusions",
    "summary",
    "diagnosis",
    "diagnoses",
    "final diagnosis",
    "provisional diagnosis",
    "clinical impression",
    "assessment",
    "opinion",
    "interpretation",
    "overall impression",
    "result summary",
    "summary of findings",
    "final impression",
    "clinical assessment",
  ],
  findings: [
    "findings",
    "finding",
    "observations",
    "observation",
    "report",
    "results",
    "result",
    "examination findings",
    "clinical findings",
    "on examination",
    "examination",
    "patient's medical information",
    "medical information",
  ],
  reason: [
    "clinical information",
    "clinical history",
    "history",
    "indication",
    "indications",
    "reason for exam",
    "reason for examination",
    "reason for referral",
    "reason for visit",
    "chief complaint",
    "chief complaints",
    "presenting complaint",
    "presenting complaints",
    "history of present illness",
    "clinical details",
    "clinical notes",
    "complaints",
    "patient's clinical history",
    "medical history",
    "past medical history",
  ],
  method: [
    "technique",
    "procedure",
    "protocol",
    "method",
    "contrast",
    "exam",
    "study",
  ],
  advice: [
    "recommendation",
    "recommendations",
    "advice",
    "plan",
    "plan of care",
    "management",
    "follow up",
    "follow-up",
    "treatment",
    "treatment plan",
    "suggestion",
    "suggestions",
    "next steps",
    "instructions",
    "discharge advice",
    "discharge instructions",
  ],
  medicines: [
    "medications",
    "medication",
    "medicines",
    "drugs",
    "prescription",
    "current medications",
    "discharge medications",
  ],
  comparison: [
    "comparison",
    "prior studies",
    "prior study",
    "previous studies",
  ],
};
const NAME_TO_KIND = new Map(
  Object.entries(SECTIONS).flatMap(([kind, names]) =>
    names.map((n) => [n, kind]),
  ),
);

// What the question is asking for, most specific first.
const INTENTS = [
  [
    "method",
    /\b(how was (it|this|the \w+) (done|performed)|technique|contrast|protocol|procedure|which (scan|test)|what (scan|test|exam) (was|is))\b/i,
  ],
  [
    "medicines",
    /\b(medicines?|medications?|drugs?|prescri\w*|tablets?|pills?)\b|dawa\w*|दवा/i,
  ],
  [
    "advice",
    /\b(recommend\w*|advice|advis\w*|next steps?|what should (i|we|he|she|they)|follow[- ]?up|plan|treatment|what to do|what now)\b|kya karna|क्या करना|सलाह/i,
  ],
  [
    "comparison",
    /\b(compar\w*|previous (scan|study|report)|prior (scan|study)|than before)\b/i,
  ],
  [
    "reason",
    /\b(why|reason|indication|history|complain\w*|symptoms?|referred|purpose|presenting)\b|kyun|क्यों|लक्षण/i,
  ],
  [
    "findings",
    /\b(find\w*|found|saw|seen|see|show(s|ed|n)?|observ\w*|detect\w*|look like|what (did|does) (the |this |my )?(scan|mri|ct|x-?ray|ultrasound|report|test|exam|study) (find|show|see|say))\b/i,
  ],
  [
    "conclusion",
    /\b(impression|conclu\w*|summar\w*|overall|diagnos\w*|assessment|suggest\w*|indicat\w*|mean\w*|interpret\w*|what('s| is) (wrong|the result|the outcome|going on)|outcome|bottom line|main (points?|takeaways?)|key (points?|findings?)|critical|serious|abnormal|normal|okay|ok|anything wrong|tl;?dr|gist|explain (this|the|my))\b|matlab|kya (bata|keh|dikha)\w*|सारांश|निष्कर्ष|मतलब|क्या (बता|कह|दिखा)/i,
  ],
];

/** Headed sections of one source: {kind, name, start, end, body} with exact offsets. */
export function sectionsOf(src) {
  const text = src.text;
  const lines = [];
  let pos = 0;
  for (const line of text.split("\n")) {
    lines.push({ line, start: pos });
    pos += line.length + 1;
  }
  const heads = [];
  lines.forEach(({ line, start }, i) => {
    const t = line
      .replace(/^\s*#{1,6}\s*/, "")
      .replace(/^\s*(section\s+\d+\s*[:.-]\s*)/i, "")
      .trim();
    if (!t) return;
    // "IMPRESSION", "Findings:", "SECTION 3: PATIENT'S MEDICAL INFORMATION"
    const label = t
      .replace(/[:.\s]+$/, "")
      .toLowerCase()
      .replace(/[’']/g, "'");
    let kind = NAME_TO_KIND.get(label);
    let inlineStart = null;
    if (!kind) {
      // a heading the parser joined to its first line: "TECHNIQUE CT chest was ..."
      const m =
        /^([A-Z][A-Z' ]{2,40}?)\s+(?=[A-Z][a-z]|\d|[A-Z]{2,}\s+[a-z])/.exec(t);
      const k = m && NAME_TO_KIND.get(m[1].toLowerCase().trim());
      if (k) {
        kind = k;
        inlineStart = start + line.indexOf(t) + m[0].length;
      }
    }
    if (!kind) {
      // inline: "Impression: Normal study." -> the body starts after the colon
      const m = /^([A-Za-z' ]{3,40}?)\s*:\s*(\S.*)$/.exec(t);
      const k = m && NAME_TO_KIND.get(m[1].toLowerCase().replace(/[’']/g, "'"));
      if (k) {
        kind = k;
        inlineStart = start + line.indexOf(m[2]);
      }
    }
    if (!kind && t.length > 90) return;
    const shouting =
      /^[A-Z][A-Z0-9 ,'&()/-]{2,60}$/.test(t) && /[A-Z]{3}/.test(t);
    if (kind || shouting || /^\s*#{1,6}\s/.test(line))
      heads.push({
        i,
        kind: kind ?? null,
        name: t.replace(/[:.\s]+$/, ""),
        inlineStart,
        start,
      });
  });
  const out = [];
  heads.forEach((h, n) => {
    if (!h.kind) return;
    const next =
      heads.slice(n + 1).find((x) => x.inlineStart == null || x.kind) ?? null;
    const bodyStart = h.inlineStart ?? lines[h.i + 1]?.start ?? text.length;
    let bodyEnd = next ? next.start - 1 : text.length;
    // stop at page furniture the parser left in ("-- Page 2 --", "Page 2 of 2")
    const slice = text.slice(bodyStart, Math.max(bodyStart, bodyEnd));
    const firstLine = (text.match(/^\s*(\S[^\n]{8,})/) ?? [])[1]?.trim();
    const furniture = new RegExp(
      `\\n\\s*(-- Page \\d+ --|Page \\d+ of \\d+|Report approved on|Electronically signed|THIS REPORT WAS ELECTRONICALLY${firstLine ? "|" + firstLine.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : ""})`,
      "i",
    );
    const stop = furniture.exec(slice);
    if (stop) bodyEnd = bodyStart + stop.index;
    let body = text.slice(bodyStart, bodyEnd);
    const lead = body.length - body.trimStart().length;
    body = body.trim();
    if (body.length < 3) return;
    out.push({
      kind: h.kind,
      name: h.name,
      start: bodyStart + lead,
      end: bodyStart + lead + body.length,
      body,
    });
  });
  return out;
}

const SAY = {
  en: {
    conclusion: (l, n) => `${l}'s ${n.toLowerCase()} says: `,
    findings: (l, n) => `${l}'s ${n.toLowerCase()}: `,
    reason: (l, n) => `${l} gives this ${n.toLowerCase()}: `,
    method: (l, n) => `${l}'s ${n.toLowerCase()} section says: `,
    advice: (l, n) => `${l}'s ${n.toLowerCase()}: `,
    medicines: (l, n) => `${l} lists these ${n.toLowerCase()}: `,
    comparison: (l, n) => `${l}'s ${n.toLowerCase()} section says: `,
    noDx: " I can read the report to you, but I can't diagnose; your doctor can explain what it means for you.",
    notSymptoms:
      "The report doesn't describe symptoms beyond what it records as history. ",
  },
  hi: {
    conclusion: (l, n) => `रिपोर्ट का ${n} कहता है: `,
    findings: (l, n) => `रिपोर्ट के ${n}: `,
    reason: (l, n) => `रिपोर्ट में दी गई ${n}: `,
    method: (l, n) => `रिपोर्ट का ${n}: `,
    advice: (l, n) => `रिपोर्ट की ${n}: `,
    medicines: (l, n) => `रिपोर्ट में ये ${n} लिखी हैं: `,
    comparison: (l, n) => `रिपोर्ट का ${n}: `,
    noDx: " मैं रिपोर्ट पढ़कर सुना सकती हूं, पर निदान नहीं कर सकती; आपके डॉक्टर बता सकते हैं कि इसका आपके लिए क्या मतलब है।",
    notSymptoms: "",
  },
  hinglish: {
    conclusion: (l, n) => `Report ka ${n.toLowerCase()} kehta hai: `,
    findings: (l, n) => `Report ke ${n.toLowerCase()}: `,
    reason: (l, n) => `Report mein di gayi ${n.toLowerCase()}: `,
    method: (l, n) => `Report ka ${n.toLowerCase()}: `,
    advice: (l, n) => `Report ki ${n.toLowerCase()}: `,
    medicines: (l, n) => `Report mein yeh ${n.toLowerCase()} likhi hain: `,
    comparison: (l, n) => `Report ka ${n.toLowerCase()}: `,
    noDx: " Main report padhkar suna sakti hoon, par diagnosis nahi kar sakti; aapke doctor bata sakte hain ki iska aapke liye kya matlab hai.",
    notSymptoms: "",
  },
};
const cap = (s) => s[0].toUpperCase() + s.slice(1);
// Reading a whole section aloud: up to ~700 characters, cut at a sentence.
function excerpt(sec) {
  const flat = sec.body.replace(/\s*\n\s*/g, " ").replace(/\s{2,}/g, " ");
  if (flat.length <= 700) return { text: flat, end: sec.end };
  const cut = flat.slice(0, 700).lastIndexOf(". ");
  const text = cut > 200 ? flat.slice(0, cut + 1) : flat.slice(0, 700) + "…";
  // the citation covers the original span up to the same sentence
  const marker = text.replace(/…$/, "").slice(-25);
  const raw = sec.body.replace(/\s*\n\s*/g, " ");
  const at = raw.indexOf(marker);
  return {
    text,
    end:
      at > 0
        ? sec.start + Math.min(sec.body.length, at + marker.length)
        : sec.end,
  };
}

/**
 * A section-shaped question answered with the section, verbatim and cited.
 * @returns {null | {spoken, verdict:"QUOTED", kind, citations: object[]}}
 */
// Words that ask about the report as a whole rather than about a topic in it.
const ABOUT_WHOLE = new Set(
  "a an the is are was were be been am do does did has have had what whats which who why how when where this that these those it its my me i you your our we their there any anything some something all exactly really please tell say says said show shows mean means meaning report reports scan scans study result results test tests exam document letter paper patient patients person doctor critical serious symptom symptoms suggest suggests suggesting suggested indicate indicates indicating impression conclusion conclusions summary summarize summarise overall overview main key points findings finding found find normal abnormal okay ok fine wrong going on outcome bottom line gist explain interpretation diagnosis of in on for to from with about and or so if can could would should will kya hai mera meri matlab".split(
    " ",
  ),
);
function topicWords(question) {
  return (
    String(question)
      .toLowerCase()
      .match(/[a-z]+/g) ?? []
  ).filter((w) => !ABOUT_WHOLE.has(w) && w.length > 2);
}

export function sectionAnswer(question, bundle) {
  let asked = INTENTS.filter(([, re]) => re.test(question)).map(([k]) => k);
  // "is the liver ok?" is about the liver, not the whole report: leave it to
  // sentence search unless the question is only about the report itself
  if (topicWords(question).length)
    asked = asked.filter((k) => k !== "conclusion" && k !== "findings");
  if (!asked.length) return null;
  const lang = detectLang(question);
  const S = SAY[lang];
  const all = (bundle?.sources ?? []).map((src) => ({
    src,
    secs: sectionsOf(src),
  }));
  // symptoms + "what is it suggesting": history first, then the conclusion
  const wants =
    asked.includes("reason") && asked.includes("conclusion")
      ? ["reason", "conclusion"]
      : [asked[0]];
  const fallback = { findings: "conclusion", conclusion: "findings" };
  const parts = [];
  const citations = [];
  for (const kind of wants) {
    let hit = null;
    for (const k of [kind, fallback[kind]].filter(Boolean)) {
      for (const { src, secs } of all) {
        const s = secs.find((x) => x.kind === k);
        if (s) {
          hit = { src, s };
          break;
        }
      }
      if (hit) break;
    }
    if (!hit) continue;
    const ex = excerpt(hit.s);
    const label = all.length === 1 ? "The report" : cap(docLabelOf(hit.src));
    parts.push(S[hit.s.kind](label, hit.s.name) + ex.text);
    try {
      citations.push(cite(hit.src, { start: hit.s.start, end: ex.end }));
    } catch {
      return null; // never speak a section whose span does not validate
    }
  }
  if (!parts.length) return null;
  let spoken = parts.join(" ");
  if (wants.includes("conclusion") || asked.includes("conclusion"))
    spoken += S.noDx;
  return { spoken, verdict: "QUOTED", kind: wants[0], citations };
}
