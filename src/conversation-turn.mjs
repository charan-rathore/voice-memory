// The shared conversation contract: one deterministic pipeline for every
// caller turn, typed or spoken. It decides what the caller is asking, which
// record subject and dimension that needs, and what may be carried to the
// next turn. It never states a record fact itself: facts come only from the
// record interface passed in (`records.resolve`), and this module only
// selects, compacts, or declines what that interface returned.
//
// Resolution order (see docs/CONVERSATION-CONTRACT.md):
//   1. bind the state to this call and source version (scope changes clear it)
//   2. drop duplicate deliveries of one utterance
//   3. repair the transcript once (self-correction, record IDs)
//   4. parse a frame: social / repeat / subject / dimension / follow-up cue
//   5. resolve outstanding clarification, then direct subject, then referent
//   6. ask the record interface per part; never coverage-blind
//   7. novelty: repeat, compact, or strip what the caller already heard
//   8. stage the turn; the caller commits it only when delivery completed
//
// Nothing here calls a model. Interpretation is deterministic, so typed and
// voice turns with the same words reach the same decision.

import { createHash } from "node:crypto";

export const OUTCOMES = Object.freeze([
  "answered",
  "clarify",
  "abstain",
  "repeat",
  "interrupted",
  "scope_changed",
  "duplicate",
]);

const DEFAULT_LIMITS = Object.freeze({
  maxTurns: 8,
  maxBytes: 16384,
  maxSeen: 32,
});

// ------------------------------------------------------------ state

/**
 * Server-owned, bounded memory for one call. Callers never supply this as
 * text; it is only ever produced by this module and kept by the server.
 */
export function createConversationState({
  callId,
  sourceVersion = null,
  limits = {},
} = {}) {
  return {
    callId: String(callId ?? ""),
    sourceVersion,
    limits: { ...DEFAULT_LIMITS, ...limits },
    seq: 0,
    turns: [], // committed, completed turns (record, social, repeat, clarify)
    pending: null, // one outstanding clarification, or null
    staged: null, // the turn resolved but not yet committed
    seen: [], // bounded { utteranceId, turnId } for duplicate delivery
    resetReason: null,
  };
}

/** Bytes a committed turn costs against the per-call budget. */
const turnBytes = (t) => Buffer.byteLength(JSON.stringify(t), "utf8");

function trimmed(state) {
  const { maxTurns, maxBytes, maxSeen } = state.limits;
  let turns = state.turns.slice(-maxTurns);
  let total = turns.reduce((n, t) => n + turnBytes(t), 0);
  while (turns.length > 0 && total > maxBytes) {
    total -= turnBytes(turns[0]);
    turns = turns.slice(1);
  }
  return {
    ...state,
    turns,
    seen: state.seen.slice(-maxSeen),
  };
}

// The state carried into a turn: same call and same source version, or a
// fresh state. A source version change or a different call never replays
// old referents, pending clarifications, or spoken answers.
function bind(prior, input) {
  const callId = String(input.callId ?? "");
  const version = input.sourceVersion ?? null;
  if (!prior || prior.callId !== callId) {
    const fresh = createConversationState({
      callId,
      sourceVersion: version,
      limits: prior?.limits,
    });
    return { state: fresh, scopeChanged: false };
  }
  if (prior.sourceVersion !== version) {
    const hadContext = prior.turns.length > 0 || !!prior.pending;
    const fresh = {
      ...createConversationState({
        callId,
        sourceVersion: version,
        limits: prior.limits,
      }),
      seq: prior.seq,
      seen: [], // previous document generations cannot make current deliveries duplicates
      resetReason: "source_version",
    };
    return { state: fresh, scopeChanged: hadContext };
  }
  return { state: prior, scopeChanged: false };
}

// ------------------------------------------------------------ language

const DEVANAGARI = /[ऀ-ॿ]/;
const HINDI_CUE =
  /\b(kya|kyun|kyu|kyon|hai|hain|batao|bataiye|mera|meri|mere|kitna|kitni|kab|nahi|dobara|phir|wapas|pehle|kaise)\b/i;
export const isHindiText = (t) => DEVANAGARI.test(t) || HINDI_CUE.test(t);

const orList = (xs, or) =>
  xs.length > 1 ? `${xs.slice(0, -1).join(", ")} ${or} ${xs.at(-1)}` : xs[0];
/** Up to three subjects this bundle actually holds, to offer as examples. */
const examplesOf = (vocabulary) => vocabulary.slice(0, 3).map((v) => v.label);

const TEXT = {
  en: {
    // examples come from this bundle's own subjects, never the demo's
    fragment: (ex) =>
      ex.length
        ? `I didn't catch a question. Ask about something in these documents, like ${orList(ex, "or")}.`
        : "I didn't catch a question. Ask about something in these documents.",
    which: (ex) =>
      ex.length
        ? `Which one do you mean? For example: ${orList(ex, "or")}.`
        : "Which part of these documents do you mean?",
    twoRef: (a, b) => `Do you mean ${a} or ${b}?`,
    ambiguous: (labels) =>
      `That name matches more than one record: ${labels.join(" or ")}. Which one do you mean? You can say the ID.`,
    earlier: "Which earlier value should I check? Say its name.",
    noRepeat:
      "I don't have a verified answer to repeat yet. Ask your question again.",
    unanswered: "The documents don't establish that.",
    greet:
      "Hi. Ask a question about these documents, and I'll show the line the answer comes from.",
    thanks: "You're welcome. Ask me about these records whenever you like.",
    bye: "Glad I could help. Your records stay on screen.",
    hear: "Yes, I can hear you. Ask a question about these documents.",
  },
  hi: {
    fragment: (ex) =>
      ex.length
        ? `माफ़ कीजिए, मैं सवाल पूरा नहीं सुन पाई। इन दस्तावेज़ों में से किसी चीज़ के बारे में पूछिए, जैसे ${orList(ex, "या")}।`
        : "माफ़ कीजिए, मैं सवाल पूरा नहीं सुन पाई। इन दस्तावेज़ों के बारे में पूछिए।",
    which: (ex) =>
      ex.length
        ? `आपका मतलब किससे है? जैसे: ${orList(ex, "या")}?`
        : "इन दस्तावेज़ों में आपका मतलब किस बात से है?",
    twoRef: (a, b) => `क्या आपका मतलब ${a} से है या ${b} से?`,
    ambiguous: (labels) =>
      `यह नाम एक से ज़्यादा रिकॉर्ड से मेल खाता है: ${labels.join(" या ")}। आप कौन सा चाहते हैं? ID बोल सकते हैं।`,
    earlier: "कौन सा पिछला मान देखूँ? उसका नाम बताइए।",
    noRepeat:
      "दोहराने के लिए अभी कोई सत्यापित जवाब नहीं है। अपना सवाल फिर से पूछिए।",
    unanswered: "ये दस्तावेज़ यह तय नहीं करते।",
    greet:
      "नमस्ते। इन दस्तावेज़ों के बारे में पूछिए, मैं वह लाइन दिखाऊँगी जिससे जवाब आता है।",
    thanks:
      "आपका स्वागत है। इन रिकॉर्ड्स के बारे में कुछ और पूछना हो तो पूछिए।",
    bye: "मदद करके अच्छा लगा। रिकॉर्ड स्क्रीन पर ही हैं।",
    hear: "हाँ, मैं आपको सुन पा रही हूँ। इन दस्तावेज़ों के बारे में पूछिए।",
  },
};

// ------------------------------------------------------------ vocabulary

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
function aliasRe(alias) {
  if (DEVANAGARI.test(alias)) return new RegExp(escapeRe(alias), "u");
  return new RegExp(
    `(?<![\\p{L}\\p{N}])${escapeRe(alias)}(?![\\p{L}\\p{N}])`,
    "iu",
  );
}

/**
 * Subjects named in `text`, earliest first, one per subject id. `vocabulary`
 * comes from the record bundle: [{ id, label, aliases: [...] }].
 */
export function findSubjects(text, vocabulary = []) {
  const found = [];
  for (const v of vocabulary)
    for (const alias of v.aliases ?? []) {
      const m = aliasRe(alias).exec(text);
      if (m)
        found.push({
          id: v.id,
          label: v.label,
          alias,
          at: m.index,
          len: alias.length,
        });
    }
  found.sort((a, b) => a.at - b.at || b.len - a.len);
  const seen = new Set();
  return found.filter((f) => (seen.has(f.id) ? false : seen.add(f.id)));
}

// ------------------------------------------------------------ transcript repair

// "creatinine, sorry, ferritin": the caller settled on the last subject.
const REPAIR_RE =
  /^(.*?)(?:^|[\s,;])(?:sorry|i mean|maaf kijiye|maaf|माफ़ कीजिए|माफ़|मतलब)(?=[\s,;]|$)[\s,;]*(.+)$/iu;

/** Self-correction: keep the head's frame with the corrected subject. */
export function selfRepair(text, vocabulary = []) {
  const m = REPAIR_RE.exec(text);
  if (!m) return { text, repaired: false };
  const head = m[1].replace(/[\s,;]+$/, "");
  const tail = m[2].replace(/[?.!।]+$/, "").trim();
  const ts = findSubjects(tail, vocabulary);
  if (!ts.length) return { text, repaired: false };
  const hs = findSubjects(head, vocabulary);
  const question = /\?\s*$/.test(text) ? "?" : "";
  if (!hs.length) return { text: tail + question, repaired: true };
  const from = hs[0];
  // Preserve every word after the correction. Replacing the old subject with
  // only the first tail alias silently discarded additional requests.
  const newHead = head.replace(aliasRe(from.alias), tail);
  return { text: newHead + question, repaired: true };
}

const WORD_DIGIT = {
  zero: "0",
  oh: "0",
  o: "0",
  one: "1",
  two: "2",
  three: "3",
  four: "4",
  five: "5",
  six: "6",
  seven: "7",
  eight: "8",
  nine: "9",
};
/** "S Y N zero zero zero three" -> "SYN-0003"; only ever touches record IDs. */
export function normalizeRecordIds(text) {
  return String(text).replace(
    /\bs\s*y\s*n\b((?:[\s-]+(?:zero|oh|one|two|three|four|five|six|seven|eight|nine|\d)\b)+)/gi,
    (_, rest) =>
      "SYN-" +
      rest
        .trim()
        .split(/[\s-]+/)
        .map((w) => WORD_DIGIT[w.toLowerCase()] ?? w)
        .join(""),
  );
}

/** The record ID the caller spoke or typed ("SYN-0003", "syn 3"), or null. */
export function recordIdOf(text) {
  const m = /\bsyn[\s-]*(\d{1,4})\b/i.exec(normalizeRecordIds(text));
  return m ? `SYN-${m[1].padStart(4, "0")}` : null;
}

/** Repair once, here: the transcript the rest of the pipeline reads. */
export function normalizeUtterance(raw, vocabulary = []) {
  const ids = normalizeRecordIds(String(raw ?? "").trim());
  const { text, repaired } = selfRepair(ids, vocabulary);
  return {
    text: text.replace(/\s+/g, " ").trim(),
    repaired: repaired || ids !== String(raw ?? "").trim(),
  };
}

// ------------------------------------------------------------ frame

const CUE = {
  repeat:
    /\b(say (?:that|it|this) again|repeat(?: that| it)?|once more|come again|pardon|dobara|phir se bol\w*)\b|दोबारा|फिर से/iu,
  shorter: /\b(short|shorter|brief|briefly|chhot\w*)\b/i,
  why: /\b(why|kyun|kyu|kyon|kyoon)\b|क्यों|क्यूं|कारण|वजह/iu,
  before:
    /\b(before that|before it|earlier|previous(?:ly)?|pehle|pichhl\w*|original)\b|पहले|पिछल/iu,
  change:
    /\b(chang\w*|badl\w*|increas\w*|gone up|went up|since|higher|lower|amend\w*)\b|बदल|बढ़/iu,
  status:
    /\b(approved?|approval|signed|sign\w*|open|pending|final\w*|agreed)\b|मंज़ूर|हस्ताक्षर/iu,
  followUp:
    /\b(it|that|this|those|them|the other one|other one|the same|normal|okay|fine|worried?)\b|वह|वो|यह/iu,
};

const SOCIAL = [
  [
    "thanks",
    /^(ok(?:ay)?[\s,.!]+)?(thanks|thank (?:you|u)|dhanyavaad|dhanyawad|shukriya)[\s,.!?]*$/i,
  ],
  ["thanks", /^(धन्यवाद|शुक्रिया)[\s।.!]*$/u],
  [
    "greet",
    /^(hi|hello|hey|namaste|good (?:morning|afternoon|evening))[\s,.!?]*$/i,
  ],
  ["greet", /^नमस्ते[\s।.!]*$/u],
  ["bye", /^(ok(?:ay)?[\s,.!]+)?(bye|goodbye|good bye|that'?s all)[\s,.!?]*$/i],
  ["hear", /^(can you hear me|are you there|hello,? can you hear me)\??\s*$/i],
  ["hear", /^(क्या आप मुझे सुन पा रही हैं|आप सुन पा रहे हैं)\??\s*$/u],
];

function socialKindOf(text) {
  const t = String(text).trim();
  if (!t) return null;
  for (const [kind, re] of SOCIAL) if (re.test(t)) return kind;
  return null;
}

// The dimension the caller wants of a subject: why, history, change, status
// or the plain value. A question with no cue asks for the value.
function dimensionOf(text) {
  if (CUE.why.test(text)) return "reason";
  if (CUE.before.test(text)) return "history";
  if (CUE.change.test(text)) return "change";
  if (CUE.status.test(text)) return "status";
  return "value";
}

// A part of a multi-part question must hold its own subject; a split is only
// made when every part does, so "the North and South regions" stays whole.
export function splitParts(text, vocabulary = []) {
  const parts = String(text)
    .split(/\?\s+|\s+(?:and(?: also)?|also|aur|और)\s+(?=\S)/i)
    .map((p) => p.trim().replace(/[?.!।]+$/, ""))
    .filter(Boolean);
  if (parts.length < 2) return [String(text).trim()];
  const withSubject = parts.filter((p) => findSubjects(p, vocabulary).length);
  if (withSubject.length !== parts.length) return [String(text).trim()];
  return parts;
}

// A narrow *negative* guard: do not treat an unsplit coordinated request as
// certified complete when a later clause carries a separate answer obligation
// but does not repeat the subject. This is not a general language parser.
function unresolvedCompound(text) {
  return /(?:\b(?:and|also|aur)\s+|\?\s+)(?:when|what|why|how|who|which|where|is|was|were|are|do|did|does|has|have|can|could)\b|\b(?:and|also)\s+(?:the\s+)?(?:approval\s+(?:date|status)|status|deadline|reason|history)\b/i.test(
    text,
  );
}

/** The structured frame for one (already repaired) utterance. */
export function frameOf(text, vocabulary = []) {
  const subjects = findSubjects(text, vocabulary);
  const id = recordIdOf(text);
  const social = subjects.length === 0 ? socialKindOf(text) : null;
  const repeat = !subjects.length && CUE.repeat.test(text);
  const followUp =
    !subjects.length &&
    (CUE.why.test(text) || CUE.before.test(text) || CUE.followUp.test(text));
  return {
    social,
    repeat,
    shorter: repeat && CUE.shorter.test(text),
    subjects,
    candidateId: id,
    dimension: dimensionOf(text),
    followUp,
    why: CUE.why.test(text),
    before: CUE.before.test(text),
    hindi: isHindiText(text),
  };
}

// ------------------------------------------------------------ answer shaping

// Sentences that carry a value, a unit, a refusal, or a status distinction.
// Anything else (general background, source instructions) may be dropped.
const NEEDED =
  /\d|\b(not|no|never|nothing|none|neither|only|proposed|approved|correct\w*|amend\w*|superseded|error|unit|unknown|don'?t|doesn'?t|cannot|can'?t|isn'?t|disput\w*|conflict\w*|transcription|rejected|patient)\b|नहीं|मंज़ूर/i;
const GENERIC =
  /general background|your doctor|doctor can|just outside|disclaimer|cited line|highlight|on the page|not medical advice/i;
// Sentences that must survive when a new dimension is answered: a correction,
// a refusal, a unit or identity distinction. A plain restated value does not.
const KEEP_ON_NEW_DIMENSION =
  /\b(correct\w*|amend\w*|transcription|error|superseded|not approved|unapproved|proposed|cannot|can'?t|don'?t|unit|different|patient)\b|SYN-\d+/i;

const sentencesOf = (s) =>
  String(s ?? "")
    .match(/[^.!?।]+[.!?।]+(?=\s|$)|[^.!?।]+$/g)
    ?.map((x) => x.trim())
    .filter(Boolean) ?? [];

/** Compact answer: the sentences that carry the value, unit or status. */
export function compactAnswer(spoken) {
  const parts = sentencesOf(spoken);
  if (!parts.length) return String(spoken ?? "").trim();
  // The opening must stand alone: "No." is not a compact form of
  // "No. Per the log: nothing was signed."
  const opening = shorterOf(spoken);
  const rest = parts.filter(
    (p) =>
      !opening.includes(p) &&
      NEEDED.test(p) &&
      !(GENERIC.test(p) && !/\d/.test(p)),
  );
  return [opening, ...rest].join(" ");
}

/** Drop sentences the caller already heard, keeping anything that corrects or refuses. */
export function stripRepeated(spoken, priorSpoken) {
  const prior = new Set(sentencesOf(priorSpoken).map((s) => s.toLowerCase()));
  const parts = sentencesOf(spoken);
  const kept = parts.filter(
    (p) => !prior.has(p.toLowerCase()) || KEEP_ON_NEW_DIMENSION.test(p),
  );
  return kept.length ? kept.join(" ") : String(spoken ?? "").trim();
}

/** The first sentences that stand alone, for "say that again, shorter". */
export function shorterOf(text) {
  const parts = sentencesOf(text);
  let out = "";
  for (const p of parts) {
    out = (out + " " + p).trim();
    if (out.split(/\s+/).length >= 4) break;
  }
  // An instruction to be brief never authorises dropping later correction,
  // refusal, identity, quantity, unit or status qualifications.
  const critical = /\d|\b(?:not|no|never|only|pending|proposed|approved|amended|corrected|superseded|different|patient|units?|refused|cannot|can't|isn't|wasn't)\b|नहीं|मंज़ूर/i;
  if (parts.some((p) => !out.includes(p) && critical.test(p)))
    return String(text ?? "").trim();
  return out || String(text ?? "").trim();
}

/** Never silently drop factual sentences to satisfy a voice-length target.
 * The record renderer must produce a shorter answer, or the caller must hear
 * the whole supported answer. `max` remains accepted for compatibility. */
export function voiceClip(spoken, max = 2) {
  void max;
  return String(spoken ?? "").trim();
}

const fingerprintOf = (subjectId, dimension, factIds, version) =>
  createHash("sha256")
    .update(
      JSON.stringify([
        subjectId,
        dimension,
        [...new Set(factIds ?? [])].sort(),
        version,
      ]),
    )
    .digest("hex")
    .slice(0, 16);

// ------------------------------------------------------------ referents

// The last completed record answer in this source version, if any.
const lastRecord = (state) => {
  // A partial or unsupported recent answer is an ambiguity barrier. A vague
  // follow-up must not jump over it to borrow a previous, unrelated subject.
  const last = [...state.turns]
    .reverse()
    .find(
      (t) =>
        t.sourceVersion === state.sourceVersion &&
        ["record", "partial", "abstain"].includes(t.kind),
    );
  return last?.kind === "record" ? last : null;
};

const recordTurns = (state) =>
  state.turns.filter(
    (t) => t.kind === "record" && t.sourceVersion === state.sourceVersion,
  );

// The referent of a bare follow-up, or a reason to ask. "Why?" refers to the
// last correction or status explanation only when that is unique; otherwise
// the two most recent subjects are both plausible and the caller is asked.
function referentFor(state, frame) {
  const last = lastRecord(state);
  if (!last) return { ask: "which" };
  if (frame.before) {
    if (last.temporal === true)
      return {
        subject: last.subject,
        dimension: "history",
        turnId: last.turnId,
      };
    return { ask: "earlier" };
  }
  if (frame.why) {
    if (["change", "status", "reason", "history"].includes(last.dimension))
      return {
        subject: last.subject,
        dimension: "reason",
        turnId: last.turnId,
      };
    const other = recordTurns(state)
      .slice(-2)
      .map((t) => t.subject)
      .filter((s, i, a) => s && a.indexOf(s) === i);
    if (other.length >= 2) return { ask: "two", options: other };
    return { subject: last.subject, dimension: "reason", turnId: last.turnId };
  }
  // "Was it approved?", "is that normal?": the follow-up's own cue decides
  return {
    subject: last.subject,
    dimension: frame.dimension,
    turnId: last.turnId,
  };
}

// ------------------------------------------------------------ records

const LABEL = (vocabulary, id) =>
  vocabulary.find((v) => v.id === id)?.label ?? id;

// Answer one part through the record interface. Returns one segment.
function answerPart(part, { records, vocabulary, state, lang, version }) {
  const priors = recordTurns(state).filter(
    (t) => t.subject === part.subject.id,
  );
  const prev = priors[priors.length - 1] ?? null;
  const req = {
    subject: { id: part.subject.id, label: part.subject.label },
    dimension: part.dimension,
    candidateId: part.candidateId ?? null,
    question: part.text,
    sourceVersion: version,
    language: lang,
  };
  const r = records.resolve(req);
  if (r?.status === "ambiguous") {
    return {
      status: "ambiguous",
      subject: part.subject,
      dimension: part.dimension,
      candidates: (r.candidates ?? []).map((c) => ({
        id: c.id,
        label: c.label ?? c.id,
      })),
    };
  }
  if (r?.status !== "answered" || !r.spoken) {
    return {
      status: "unanswered",
      subject: part.subject.id,
      dimension: part.dimension,
      spoken: r?.spoken || TEXT[lang].unanswered,
      verdict: r?.verdict ?? "UNKNOWN",
      factIds: [],
      citations: [],
      temporal: false,
      fingerprint: fingerprintOf(part.subject.id, part.dimension, [], version),
    };
  }
  const factIds = [...new Set(r.factIds ?? [])];
  const fingerprint = fingerprintOf(
    part.subject.id,
    part.dimension,
    factIds,
    version,
  );
  let spoken = r.spoken;
  let novelty = "fresh";
  if (
    prev &&
    prev.fingerprint === fingerprint &&
    prev.dimension === part.dimension
  ) {
    // the same fact, the same question: one compact direct answer
    spoken = compactAnswer(r.spoken);
    novelty = "compact";
  } else if (prev && prev.dimension !== part.dimension) {
    // the same fact, another dimension: do not restate the value first
    spoken = stripRepeated(r.spoken, prev.spoken);
    novelty = "new_dimension";
  }
  return {
    status: "answered",
    subject: part.subject.id,
    dimension: part.dimension,
    spoken,
    verdict: r.verdict ?? "ANSWERED",
    factIds,
    citations: r.citations ?? [],
    temporal: r.temporal === true,
    fingerprint,
    novelty,
  };
}

// ------------------------------------------------------------ the turn

const VERB = {
  reason: "why",
  history: "history",
  change: "compare",
  status: "status",
  value: "lookup",
};

/**
 * Resolve one caller utterance.
 *
 * input:
 *   utterance       what the caller said (typed or recognised speech)
 *   callId          stable call/session identity
 *   utteranceId     transport id; a second delivery of it is a duplicate
 *   sourceVersion   immutable record bundle version
 *   mode            "typed" | "voice"  (presentation only; the decision is the same)
 *   event           "barge_in": drop the staged answer that was cut off
 *   records         { vocabulary: [{ id, label, aliases }], resolve(req) }
 *                   resolve(req) returns one of
 *                     { status: "answered", spoken, verdict, factIds, temporal?, citations? }
 *                     { status: "ambiguous", candidates: [{ id, label }] }
 *                     { status: "unanswered", spoken?, verdict? }   (or null)
 *
 * prior: the state from the previous commitConversationTurn (or null).
 *
 * Returns { turn, state }. The turn is staged in `state`; call
 * commitConversationTurn(state, turn.turnId, { completed }) once delivery ends.
 * No model is consulted: the decision is deterministic.
 */
export function resolveConversationTurn(input, prior = null) {
  const records = input.records;
  const vocabulary = records?.vocabulary ?? [];
  const mode = input.mode === "voice" ? "voice" : "typed";
  const { state: base, scopeChanged } = bind(prior, input);
  const version = base.sourceVersion;
  const callId = base.callId;

  // A second delivery of one utterance: nothing spoken, nothing committed.
  if (input.utteranceId != null) {
    const dup = base.seen.find((s) => s.utteranceId === input.utteranceId);
    if (dup) {
      return {
        turn: emptyTurn({
          turnId: dup.turnId,
          callId,
          version,
          mode,
          outcome: "duplicate",
        }),
        state: base,
      };
    }
  }

  const turnId = `${callId || "call"}#${base.seq + 1}`;
  const seenNext =
    input.utteranceId != null
      ? [...base.seen, { utteranceId: input.utteranceId, turnId }]
      : base.seen;
  const advanced = { ...base, seq: base.seq + 1, seen: seenNext, staged: null };

  // The caller cut the previous answer off: it never becomes memory.
  if (input.event === "barge_in") {
    return {
      turn: emptyTurn({
        turnId,
        callId,
        version,
        mode,
        outcome: "interrupted",
        scopeChanged,
      }),
      state: { ...advanced, seen: base.seen },
    };
  }

  const heard = String(input.utterance ?? "").trim();
  const lang = isHindiText(heard) ? "hi" : "en";
  const { text, repaired } = normalizeUtterance(heard, vocabulary);
  const frame = frameOf(text, vocabulary);
  const understanding = {
    intent: "lookup",
    subject: null,
    dimension: null,
    followUp: false,
    referencedTurnId: null,
    confidence: "high",
    needsClarification: false,
    changedMeaning: repaired,
    heard,
    understoodAs: text,
    modelUsed: false,
  };

  // Every return path goes through finish(): one place decides what is
  // staged, what the turn carries forward, and what expires.
  const finish = ({
    outcome,
    spoken,
    screen,
    verdict = null,
    citations = [],
    factIds = [],
    staged = null,
    pendingAfter,
    complete = true,
    dimension = null,
    novelty = "fresh",
    notice = null,
  }) => {
    const full = String(spoken ?? "");
    const pending = pendingAfter === undefined ? null : pendingAfter;
    understanding.dimension = dimension;
    understanding.changedMeaning =
      understanding.changedMeaning || understanding.followUp;
    const stagedRecord = staged
      ? {
          ...staged,
          turnId,
          sourceVersion: version,
          // Transport IDs never enter committed record history; this temporary
          // field is used only to roll back seen IDs on interrupted delivery.
          utteranceId: input.utteranceId ?? null,
          factIds,
          citations,
          verdict,
          spoken: full,
          screen: screen ?? full,
          pendingAfter: pending,
        }
      : null;
    const expire = [];
    if (base.pending && pending === null) expire.push("pending_clarification");
    if (scopeChanged) expire.push("all_prior_turns");
    return {
      turn: {
        turnId,
        callId,
        sourceVersion: version,
        mode,
        outcome,
        understanding,
        answer: {
          spoken: mode === "voice" ? voiceClip(full) : full,
          screen: screen ?? full,
          verdict,
          citations,
          factIds,
          fingerprint: staged?.fingerprint ?? null,
          complete,
          novelty,
          notice,
        },
        conversationDelta: {
          carry:
            staged && staged.kind === "record"
              ? {
                  kind: "record",
                  subject: staged.subject,
                  dimension: staged.dimension,
                  factIds,
                  fingerprint: staged.fingerprint,
                  temporal: staged.temporal === true,
                  sourceVersion: version,
                }
              : null,
          expire,
        },
      },
      state: { ...advanced, staged: stagedRecord },
    };
  };

  const scopeNote = scopeChanged
    ? lang === "hi"
      ? "आपके दस्तावेज़ बदल गए हैं, इसलिए मैं पिछले जवाब दोबारा इस्तेमाल नहीं कर रही। सवाल फिर से पूछिए।"
      : "Your documents changed, so I'm not reusing earlier answers. Ask again."
    : null;

  // ---- social: fixed replies about the call, never a record fact or referent
  if (frame.social && !frame.subjects.length) {
    understanding.intent = "social";
    return finish({
      outcome: "answered",
      spoken: TEXT[lang][frame.social],
      staged: { kind: "social" },
      pendingAfter: base.pending,
      dimension: "social",
      novelty: "social",
    });
  }

  // ---- explicit repeat: the last verified record answer, word for word
  if (frame.repeat) {
    understanding.intent = "repeat";
    const last = lastRecord(base);
    if (!last) {
      return finish({
        outcome: "repeat",
        spoken: TEXT[lang].noRepeat,
        staged: { kind: "repeat" },
        pendingAfter: base.pending,
        dimension: "repeat",
        novelty: "none",
      });
    }
    understanding.referencedTurnId = last.turnId;
    understanding.followUp = true;
    return finish({
      outcome: "repeat",
      spoken: frame.shorter ? shorterOf(last.spoken) : last.spoken,
      verdict: last.verdict,
      citations: last.citations ?? [],
      factIds: last.factIds,
      staged: {
        kind: "repeat",
        subject: last.subject,
        dimension: last.dimension,
        fingerprint: last.fingerprint,
      },
      pendingAfter: base.pending,
      dimension: last.dimension,
      novelty: frame.shorter ? "shorter" : "repeat",
    });
  }

  // ---- an outstanding clarification: only its answer resolves it
  let parts = null;
  const p = base.pending;
  if (p) {
    understanding.referencedTurnId = p.turnId;
    if (p.kind === "ambiguous") {
      const chosen = frame.candidateId
        ? p.candidates.find((c) => c.id === frame.candidateId)
        : null;
      if (chosen) {
        understanding.followUp = true;
        parts = [
          {
            text,
            subject: p.subject,
            dimension: p.dimension,
            candidateId: chosen.id,
          },
        ];
      }
    } else if (p.kind === "referent" && frame.subjects.length) {
      // "Do you mean ferritin or creatinine?" -> "ferritin"
      const f = frame.subjects.find((s) => p.options.includes(s.id));
      if (f) {
        understanding.followUp = true;
        parts = [
          {
            text,
            subject: { id: f.id, label: f.label },
            dimension: p.dimension,
            candidateId: null,
          },
        ];
      }
    }
    // Anything else (a new subject, or an unrelated utterance) drops the old
    // clarification: a direct subject always overrides it.
  }

  // ---- direct subject, or a follow-up's referent
  if (!parts) {
    if (frame.subjects.length) {
      const pieces = splitParts(text, vocabulary);
      if (pieces.length === 1 && unresolvedCompound(text)) {
        understanding.confidence = "low";
        understanding.needsClarification = true;
        return finish({
          outcome: "clarify",
          spoken:
            lang === "hi"
              ? "इस सवाल के कई हिस्से हो सकते हैं। हर हिस्से का जवाब जाँचने के लिए उन्हें अलग-अलग पूछिए।"
              : "That may ask more than one thing. Please ask each part separately so I don't leave one unanswered.",
          staged: { kind: "clarify" },
          pendingAfter: null,
          dimension: "clarify",
          complete: false,
        });
      }
      parts =
        pieces.length > 1
          ? pieces.map((pt) => {
              const f = findSubjects(pt, vocabulary)[0];
              return {
                text: pt,
                subject: { id: f.id, label: f.label },
                dimension: dimensionOf(pt),
                candidateId: recordIdOf(pt),
              };
            })
          : [
              {
                text,
                subject: {
                  id: frame.subjects[0].id,
                  label: frame.subjects[0].label,
                },
                dimension: frame.dimension,
                candidateId: frame.candidateId,
              },
            ];
    } else if (frame.followUp) {
      const ref = referentFor(base, frame);
      if (ref.ask === "which" || ref.ask === "earlier") {
        understanding.confidence = "low";
        understanding.needsClarification = true;
        return finish({
          outcome: "clarify",
          spoken:
            scopeNote ??
            (ref.ask === "earlier"
              ? TEXT[lang].earlier
              : TEXT[lang].which(examplesOf(vocabulary))),
          staged: { kind: "clarify" },
          pendingAfter: null,
          dimension: "clarify",
          complete: false,
        });
      }
      if (ref.ask === "two") {
        const labels = ref.options.map((s) => LABEL(vocabulary, s));
        understanding.confidence = "low";
        understanding.needsClarification = true;
        return finish({
          outcome: "clarify",
          spoken: TEXT[lang].twoRef(labels[0], labels[1]),
          staged: { kind: "clarify" },
          pendingAfter: {
            kind: "referent",
            turnId,
            options: ref.options,
            dimension: "reason",
          },
          dimension: "clarify",
          complete: false,
        });
      }
      understanding.followUp = true;
      understanding.referencedTurnId = ref.turnId;
      understanding.confidence = "medium";
      parts = [
        {
          text,
          subject: { id: ref.subject, label: LABEL(vocabulary, ref.subject) },
          dimension: ref.dimension,
          candidateId: null,
        },
      ];
    } else {
      // nothing to answer from: a short question back, in the caller's language
      understanding.confidence = "low";
      understanding.needsClarification = true;
      return finish({
        outcome: "clarify",
        spoken: scopeNote ?? TEXT[lang].fragment(examplesOf(vocabulary)),
        staged: { kind: "clarify" },
        pendingAfter: null,
        dimension: "clarify",
        complete: false,
      });
    }
  }

  understanding.subject =
    parts.length === 1 ? parts[0].subject.id : parts.map((x) => x.subject.id);
  understanding.intent = VERB[parts[0].dimension] ?? "lookup";

  // ---- the record decides, part by part; a missing part is never filled in
  const segments = parts.map((part) =>
    answerPart(part, { records, state: base, lang, version }),
  );
  const ambiguous = segments.find((s) => s.status === "ambiguous");
  if (ambiguous) {
    understanding.needsClarification = true;
    understanding.confidence = "low";
    return finish({
      outcome: "clarify",
      spoken: TEXT[lang].ambiguous(ambiguous.candidates.map((c) => c.label)),
      staged: { kind: "clarify" },
      pendingAfter: {
        kind: "ambiguous",
        turnId,
        subject: ambiguous.subject,
        dimension: ambiguous.dimension,
        candidates: ambiguous.candidates,
      },
      dimension: "clarify",
      complete: false,
    });
  }

  const answered = segments.filter((s) => s.status === "answered");
  const complete = answered.length === segments.length;
  const single = segments.length === 1 ? segments[0] : null;
  return finish({
    outcome: answered.length ? "answered" : "abstain",
    spoken: segments.map((s) => s.spoken).join(" "),
    verdict: single ? single.verdict : segments.map((s) => s.verdict).join("+"),
    citations: segments.flatMap((s) => s.citations),
    factIds: [...new Set(segments.flatMap((s) => s.factIds))],
    staged: answered.length
      ? {
          kind: complete && single ? "record" : "partial",
          subject: single
            ? single.subject
            : segments.map((s) => s.subject).join("+"),
          dimension: single ? single.dimension : null,
          fingerprint: single ? single.fingerprint : null,
          temporal: segments.some((s) => s.temporal),
        }
      : { kind: "abstain" },
    pendingAfter: null,
    dimension: single ? single.dimension : null,
    complete,
    novelty: single ? single.novelty : "parts",
    notice: scopeNote,
  });
}

function emptyTurn({
  turnId,
  callId,
  version,
  mode,
  outcome,
  scopeChanged = false,
}) {
  return {
    turnId,
    callId,
    sourceVersion: version,
    mode,
    outcome,
    understanding: null,
    answer: {
      spoken: null,
      screen: null,
      verdict: null,
      citations: [],
      factIds: [],
      fingerprint: null,
      complete: false,
      novelty: "none",
      notice: null,
    },
    conversationDelta: {
      carry: null,
      expire: scopeChanged ? ["all_prior_turns"] : [],
    },
  };
}

/**
 * Commit the staged turn once its delivery finished. A turn that was cut off
 * (completed: false) never becomes a referent, a repeat, or a clarification.
 */
export function commitConversationTurn(
  state,
  turnId,
  { completed = true } = {},
) {
  if (!state?.staged || state.staged.turnId !== turnId) return state;
  const { pendingAfter, utteranceId, ...entry } = state.staged;
  const base = { ...state, staged: null };
  if (!completed) {
    // Aborted utterances are retryable. Do not make an unplayed utterance ID
    // look as if it was successfully committed.
    return {
      ...base,
      seen:
        utteranceId == null
          ? base.seen
          : base.seen.filter((s) => s.turnId !== turnId),
    };
  }
  return trimmed({
    ...base,
    turns: [...state.turns, entry],
    pending: pendingAfter ?? null,
  });
}

/** What is memory right now, for logs and tests (no spoken text). */
export function describeState(state) {
  return {
    callId: state.callId,
    sourceVersion: state.sourceVersion,
    turns: state.turns.map((t) => ({
      turnId: t.turnId,
      kind: t.kind,
      subject: t.subject,
      dimension: t.dimension,
      factIds: t.factIds,
    })),
    pending: state.pending
      ? { kind: state.pending.kind, turnId: state.pending.turnId }
      : null,
    bytes: state.turns.reduce((n, t) => n + turnBytes(t), 0),
  };
}
