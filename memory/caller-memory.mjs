// Caller memory: what Voice Memory may remember about a VERIFIED caller
// across calls, with their consent, and nothing else.
//
// It extends the existing layers in memory.mjs (evidence, semantic,
// episodic, working, temporal) with one more, kept apart from all of them:
//
//   caller   per verified caller (memory/caller-identity.mjs), never per
//            phone number or prompt variable. Four explicit kinds:
//     preference  caller-stated, allow-listed keys and values only
//                 (language, answer length). Presentation only.
//     episode     one answered question: time, the caller's own words, the
//                 outcome kind and verdict, the source scope and version it
//                 was answered from, and the exact cited spans.
//     referent    which document subject a past episode was about (the fee,
//                 the payment split), bound to the scope it came from.
//     request     something the caller asked to be followed up ("tell me
//                 when the fee is approved"). Open until the caller or an
//                 operator closes it; an answer never closes it.
//
// Rules that hold for every operation:
//  - A preference can change language and length. It can never change a
//    fact, a status, an approval, a source version or an access decision:
//    nothing here is passed to the resolver except the question itself.
//  - Recall never replays an old answer as current. Each remembered subject
//    is re-asked against the documents as they are NOW, and the result says
//    whether the source version and the status changed since.
//  - Episodes and referents are kept only after the caller consents to
//    conversation memory; preferences only on an explicit "remember" with an
//    allow-listed value. Raw consent utterances are not stored.
//  - Health scopes are never retained across calls in this slice.
//  - Medical words never become a preference (refused, not sanitised).
//  - Forget is a hard delete (memory and disk); forget-all removes the file.
//  - Every item expires; expired items are purged on every read.
//
// Durability: with `store` (memory/store.mjs, AES-256-GCM, one file per
// caller) memory survives a process restart on a persistent disk. Without
// it, memory lives in this process only and `durable` says so.
import { contractVocabulary } from "../src/conversation-shadow.mjs";

const DAY = 24 * 3600 * 1000;
export const CALLER_LIMITS = Object.freeze({
  episodes: 40,
  referents: 20,
  requests: 20,
  audit: 50,
  bytes: 32 * 1024,
});
export const RETENTION = Object.freeze({
  preference: 365 * DAY,
  episode: 90 * DAY,
  referent: 90 * DAY,
  request: 90 * DAY,
});
export const PREFERENCES = Object.freeze({
  language: Object.freeze(["en", "hi", "hinglish"]),
  answerLength: Object.freeze(["short", "detailed"]),
});
// Scopes whose content is never kept across calls in this slice.
const NOT_RETAINED_SCOPES = new Set(["health"]);

export class CallerMemoryError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "CallerMemoryError";
    this.code = code;
  }
}

// ------------------------------------------------------------ understanding
const SENSITIVE =
  /\b(diabet\w*|cancer|hiv|aids|pregnan\w*|medic(ine|ation)s?|prescri\w*|diagnos\w*|disease|illness|symptom\w*|blood|bp|sugar|thyroid|ferritin|creatinine|cholesterol|hba1c|lab|report|test result|depress\w*|anxiety|therapy|surgery|allerg\w*|dose|tablet|insulin|bimari|dawai|davai|ilaaj)\b|बीमारी|दवा|डायबिटीज|शुगर|कैंसर|रिपोर्ट/i;
const REMEMBER =
  /\b(remember|keep in mind|note that|save that)\b|yaad\s*rakh|याद\s*रख/i;
const CONSENT_CONVERSATION =
  /\b(remember (this|our|the) (conversation|call|chat)|remember what (we|i) (discussed|asked)|keep (a )?(record|note) of (this|our) (call|conversation))\b|(yeh|ye|is) (baat|call|conversation)\s*yaad\s*rakh/i;
const LANG_WORDS = [
  ["hinglish", /\bhinglish\b|हिंग्लिश/i],
  ["hi", /\bhindi\b|हिंदी|हिन्दी/i],
  ["en", /\benglish\b|अंग्रेज़ी|अंग्रेजी/i],
];
const SHORT = /\b(short|brief|quick|concise|chhot[ae]|kam shabd)\b/i;
const DETAILED = /\b(detail(ed)?|full|long(er)?|vistaar)\b/i;
const FOLLOW_UP =
  /\b(let me know|tell me|inform me|notify me|call me( back)?|update me|ping me)\b.*\b(when|once|if|after)\b|\b(batana|bata dena|bataiye|inform karna|call karna)\b/i;

/**
 * Read one utterance for an explicit memory instruction. Never guesses: an
 * utterance that says "remember" about anything other than an allow-listed
 * preference is refused with a reason, and medical content is refused.
 * @returns {{ type: "preference", key: string, value: string }
 *   | { type: "conversation_consent" }
 *   | { type: "follow_up_request", text: string }
 *   | { type: "refused", reason: "sensitive"|"not_a_preference" }
 *   | null}
 */
export function readMemoryInstruction(utterance, { explicit = false } = {}) {
  const u = String(utterance ?? "").trim();
  if (!u) return null;
  if (FOLLOW_UP.test(u) && !REMEMBER.test(u))
    return SENSITIVE.test(u)
      ? { type: "refused", reason: "sensitive" }
      : { type: "follow_up_request", text: u.slice(0, 200) };
  if (!explicit && !REMEMBER.test(u) && !/\bprefer\b|pasand/i.test(u))
    return null;
  if (SENSITIVE.test(u)) return { type: "refused", reason: "sensitive" };
  if (CONSENT_CONVERSATION.test(u)) return { type: "conversation_consent" };
  const lang = LANG_WORDS.find(([, re]) => re.test(u));
  if (
    lang &&
    /\b(prefer|speak|talk|reply|answer|language|baat|bol|mein|in)\b|पसंद|में/i.test(
      u,
    )
  )
    return { type: "preference", key: "language", value: lang[0] };
  if (SHORT.test(u) && /\b(answer|repl|keep|baat|jawab)\w*/i.test(u))
    return { type: "preference", key: "answerLength", value: "short" };
  if (DETAILED.test(u) && /\b(answer|repl|explain|jawab)\w*/i.test(u))
    return { type: "preference", key: "answerLength", value: "detailed" };
  return { type: "refused", reason: "not_a_preference" };
}

/**
 * Every explicit memory instruction in one utterance ("remember I prefer
 * Hinglish, and remember this conversation"). Medical content anywhere in
 * the utterance refuses the whole utterance: nothing from it is kept.
 */
export function readMemoryInstructions(utterance) {
  const u = String(utterance ?? "").trim();
  if (!u) return [];
  if (SENSITIVE.test(u) && (REMEMBER.test(u) || /\bprefer\b|pasand/i.test(u)))
    return [{ type: "refused", reason: "sensitive" }];
  const parts = u
    .split(/\s*[,;]?\s+\b(?:and|aur|also|plus)\b\s+|[;.!?]\s+/i)
    .filter((x) => x && x.trim());
  const out = [];
  for (const part of parts.length > 1 ? parts : [u]) {
    const one = readMemoryInstruction(part, { explicit: REMEMBER.test(u) });
    if (!one) continue;
    // "not a preference" for one clause of a compound is only reported if
    // nothing else in the utterance was understood.
    if (out.some((x) => JSON.stringify(x) === JSON.stringify(one))) continue;
    out.push(one);
  }
  const useful = out.filter(
    (x) => !(x.type === "refused" && x.reason === "not_a_preference"),
  );
  return useful.length ? useful : out;
}

const VOCAB = contractVocabulary(null);
/** Which known document subject an utterance names, if exactly one. */
export function subjectOfQuestion(question, vocab = VOCAB) {
  const q = ` ${String(question ?? "").toLowerCase()} `;
  const hits = vocab.filter((v) =>
    v.aliases.some(
      (a) =>
        q.includes(` ${String(a).toLowerCase()} `) ||
        q.includes(` ${String(a).toLowerCase()}?`),
    ),
  );
  const ids = [...new Set(hits.map((h) => h.id))];
  // "revised fee" names both the fee and the revision: the fee is the
  // subject (the revision is how it changed).
  if (ids.includes("deal.fee")) return hits.find((h) => h.id === "deal.fee");
  return ids.length === 1 ? hits[0] : null;
}

// ------------------------------------------------------------ the store
const emptyRecord = (binding, t) => ({
  v: 1,
  tenant: binding.tenant,
  subject: binding.subject,
  createdAt: new Date(t).toISOString(),
  consent: { preferences: null, conversation: null },
  preferences: {},
  episodes: [],
  referents: [],
  requests: [],
  audit: [],
  seq: 0,
});

/**
 * @param {{
 *   identity: { isVerified: (b:any) => boolean },
 *   store?: { save:(ns:string,v:any)=>void, load:(ns:string)=>any, remove:(ns:string)=>void } | null,
 *   now?: () => number,
 *   retention?: Partial<typeof RETENTION>,
 * }} opts
 */
export function createCallerMemory({
  identity,
  store = null,
  now = Date.now,
  retention = {},
} = {}) {
  if (!identity?.isVerified)
    throw Error("Caller memory needs a caller identity verifier.");
  const keep = { ...RETENTION, ...retention };
  const live = new Map(); // subject -> record (also the cache when durable)
  const nsOf = (b) => `caller:${b.tenant}:${b.subject}`;

  const must = (binding) => {
    if (!identity.isVerified(binding))
      throw new CallerMemoryError(
        "unverified",
        "Caller memory needs a verified caller.",
      );
  };
  const purge = (r, t) => {
    const alive = (x) => !x.expiresAt || Date.parse(x.expiresAt) > t;
    for (const [k, p] of Object.entries(r.preferences))
      if (!alive(p)) delete r.preferences[k];
    r.episodes = r.episodes.filter(alive);
    r.referents = r.referents.filter(alive);
    r.requests = r.requests.filter(alive);
    return r;
  };
  const load = (binding) => {
    const t = now();
    let r = live.get(binding.subject);
    if (!r && store) {
      try {
        r = store.load(nsOf(binding));
      } catch {
        r = null; // tampered or wrong key: never half-read
      }
    }
    if (r && (r.subject !== binding.subject || r.tenant !== binding.tenant))
      r = null;
    r = purge(r ?? emptyRecord(binding, t), t);
    live.set(binding.subject, r);
    return r;
  };
  const audit = (r, op, kind) => {
    r.audit.push({ op, kind, at: new Date(now()).toISOString() });
    r.audit = r.audit.slice(-CALLER_LIMITS.audit);
  };
  const isEmpty = (r) =>
    !Object.keys(r.preferences).length &&
    !r.episodes.length &&
    !r.referents.length &&
    !r.requests.length &&
    !r.consent.conversation;
  const save = (binding, r) => {
    // Bounded: oldest episodes go first, then oldest referents.
    while (
      JSON.stringify(r).length > CALLER_LIMITS.bytes &&
      (r.episodes.length || r.referents.length)
    )
      (r.episodes.length ? r.episodes : r.referents).shift();
    live.set(binding.subject, r);
    if (!store) return;
    if (isEmpty(r)) store.remove(nsOf(binding));
    else store.save(nsOf(binding), r);
  };
  const exp = (kind) => new Date(now() + keep[kind]).toISOString();
  const at = () => new Date(now()).toISOString();

  const api = {
    durable: !!store,

    /** Everything remembered about this caller, as the caller may see it. */
    list(binding) {
      must(binding);
      const r = load(binding);
      return structuredClone({
        consent: r.consent,
        preferences: r.preferences,
        episodes: r.episodes,
        referents: r.referents,
        requests: r.requests,
        durable: !!store,
      });
    },

    /** Presentation only: what a preference may influence. */
    presentation(binding) {
      must(binding);
      const p = load(binding).preferences;
      return {
        lang: p.language?.value ?? null,
        answerLength: p.answerLength?.value ?? null,
      };
    },

    rememberPreference(
      binding,
      { key, value, callId = null, channel = "voice" },
    ) {
      must(binding);
      if (!Object.hasOwn(PREFERENCES, key) || !PREFERENCES[key].includes(value))
        throw new CallerMemoryError(
          "not_allowed",
          "Only allow-listed preferences can be remembered.",
        );
      const r = load(binding);
      const prev = r.preferences[key];
      r.preferences[key] = {
        value,
        at: at(),
        revision: (prev?.revision ?? 0) + 1,
        callId,
        channel,
        expiresAt: exp("preference"),
      };
      r.consent.preferences ??= { at: at(), channel, callId };
      audit(r, prev ? "correct" : "remember", `preference.${key}`);
      save(binding, r);
      return structuredClone(r.preferences[key]);
    },

    /** Change a remembered preference. The old value is not kept. */
    correctPreference(
      binding,
      { key, value, callId = null, channel = "voice" },
    ) {
      must(binding);
      if (!load(binding).preferences[key])
        throw new CallerMemoryError(
          "not_found",
          "Nothing remembered for that yet.",
        );
      return api.rememberPreference(binding, { key, value, callId, channel });
    },

    consentToConversation(binding, { callId = null, channel = "voice" } = {}) {
      must(binding);
      const r = load(binding);
      r.consent.conversation = { at: at(), channel, callId };
      audit(r, "consent", "conversation");
      save(binding, r);
    },

    /**
     * Keep one answered turn, if the caller consented to conversation
     * memory and the scope may be retained. Returns the episode or a reason.
     */
    recordEpisode(binding, { callId, caseId, question, final, corpus }) {
      must(binding);
      const r = load(binding);
      if (!r.consent.conversation) return { kept: false, reason: "no_consent" };
      if (NOT_RETAINED_SCOPES.has(caseId))
        return { kept: false, reason: "sensitive_scope" };
      if (!final || !corpus?.version)
        return { kept: false, reason: "no_answer" };
      const subj = subjectOfQuestion(question);
      const ep = {
        id: "e" + ++r.seq,
        at: at(),
        callId,
        caseId,
        question: String(question).slice(0, 300),
        outcome: { kind: final.kind ?? null, verdict: final.verdict ?? null },
        scope: { key: caseId, version: corpus.version },
        subjectId: subj?.id ?? null,
        citations: (final.citations ?? []).slice(0, 6).map((c) => ({
          sourceId: c.sourceId ?? null,
          hash: c.hash ?? null,
          title: c.title ?? null,
          start: c.start ?? null,
          end: c.end ?? null,
          quote: typeof c.quote === "string" ? c.quote.slice(0, 300) : null,
        })),
        expiresAt: exp("episode"),
      };
      r.episodes.push(ep);
      r.episodes = r.episodes.slice(-CALLER_LIMITS.episodes);
      if (subj) {
        r.referents = r.referents.filter(
          (x) => !(x.subjectId === subj.id && x.scopeKey === caseId),
        );
        r.referents.push({
          subjectId: subj.id,
          label: subj.label,
          scopeKey: caseId,
          lastEpisodeId: ep.id,
          at: ep.at,
          expiresAt: exp("referent"),
        });
        r.referents = r.referents.slice(-CALLER_LIMITS.referents);
      }
      audit(r, "remember", "episode");
      save(binding, r);
      return { kept: true, episode: structuredClone(ep) };
    },

    /** "Tell me when the fee is approved": an open request, never a fact. */
    recordRequest(binding, { callId, caseId, text }) {
      must(binding);
      const r = load(binding);
      if (!r.consent.conversation) return { kept: false, reason: "no_consent" };
      if (NOT_RETAINED_SCOPES.has(caseId))
        return { kept: false, reason: "sensitive_scope" };
      const subj = subjectOfQuestion(text);
      const req = {
        id: "r" + ++r.seq,
        at: at(),
        callId,
        caseId,
        text: String(text).slice(0, 200),
        subjectId: subj?.id ?? null,
        status: "open",
        expiresAt: exp("request"),
      };
      r.requests.push(req);
      r.requests = r.requests.slice(-CALLER_LIMITS.requests);
      audit(r, "remember", "request");
      save(binding, r);
      return { kept: true, request: structuredClone(req) };
    },

    /** Only the caller or an operator closes a request; answers never do. */
    closeRequest(binding, id, { by }) {
      must(binding);
      if (!["caller", "operator"].includes(by))
        throw new CallerMemoryError(
          "not_allowed",
          "Requests are closed by the caller or an operator.",
        );
      const r = load(binding);
      const q = r.requests.find((x) => x.id === id);
      if (!q) throw new CallerMemoryError("not_found", "No such request.");
      q.status = "closed";
      q.closedAt = at();
      q.closedBy = by;
      audit(r, "close", "request");
      save(binding, r);
    },

    /**
     * Hard delete. `{ all: true }` removes everything (and the file),
     * `{ preference: key }`, `{ id }` one item, `{ conversation: true }`
     * revokes conversation consent and deletes episodes, referents, requests.
     */
    forget(binding, what = {}) {
      must(binding);
      const r = load(binding);
      let removed = 0;
      if (what.all) {
        removed =
          Object.keys(r.preferences).length +
          r.episodes.length +
          r.referents.length +
          r.requests.length;
        live.delete(binding.subject);
        if (store) store.remove(nsOf(binding));
        return { removed, all: true };
      }
      if (what.preference && r.preferences[what.preference]) {
        delete r.preferences[what.preference];
        removed++;
        if (!Object.keys(r.preferences).length) r.consent.preferences = null;
      }
      if (what.conversation) {
        removed += r.episodes.length + r.referents.length + r.requests.length;
        r.episodes = [];
        r.referents = [];
        r.requests = [];
        r.consent.conversation = null;
      }
      if (what.id) {
        for (const k of ["episodes", "requests"]) {
          const n = r[k].length;
          r[k] = r[k].filter((x) => x.id !== what.id);
          removed += n - r[k].length;
        }
        const n = r.referents.length;
        r.referents = r.referents.filter((x) => x.lastEpisodeId !== what.id);
        removed += n - r.referents.length;
      }
      audit(
        r,
        "forget",
        what.preference
          ? `preference.${what.preference}`
          : what.conversation
            ? "conversation"
            : "item",
      );
      save(binding, r);
      return { removed, all: false };
    },

    /**
     * Start of a new call: what is remembered, and every remembered subject
     * re-checked against the documents NOW.
     * `answer({ caseId, question })` must resolve through the same canonical
     * path as any other question and return `{ final, corpus: { version } }`.
     */
    async recall(binding, { caseId, answer }) {
      must(binding);
      const r = load(binding);
      const rechecked = [];
      for (const ref of r.referents
        .filter((x) => x.scopeKey === caseId)
        .slice(-3)
        .reverse()) {
        const ep = r.episodes.find((e) => e.id === ref.lastEpisodeId);
        if (!ep) continue;
        const now_ = await answer({ caseId, question: ep.question });
        rechecked.push({
          subjectId: ref.subjectId,
          label: ref.label,
          previously: {
            at: ep.at,
            question: ep.question,
            verdict: ep.outcome.verdict,
            kind: ep.outcome.kind,
            sourceVersion: ep.scope.version,
          },
          now: now_,
          sourceChanged: now_?.corpus?.version
            ? now_.corpus.version !== ep.scope.version
            : null,
          statusChanged: now_?.final
            ? (now_.final.verdict ?? null) !== ep.outcome.verdict
            : null,
        });
      }
      return {
        preferences: structuredClone(r.preferences),
        consent: structuredClone(r.consent),
        rechecked,
        openRequests: structuredClone(
          r.requests.filter((q) => q.status === "open" && q.caseId === caseId),
        ),
        durable: !!store,
      };
    },
  };
  return api;
}
