import { briefAnswer, briefIntent } from "./record-brief.mjs";
import { labDigest } from "../clinical/answer.mjs";
import { subjectOf } from "../clinical/observations.mjs";
import { unboundOwnerTurn } from "./requested-owner.mjs";
import { identifierRequest, explicitRecordRequest } from "../dist/engine.mjs";
/** OpenAI-compatible streaming contract for a future Bolna custom LLM.
 * Disabled unless explicitly instantiated by a caller. No public listener,
 * credential creation, account configuration or real calls in this module.
 * Each opaque bearer capability binds ONE server-owned bundle. Request body,
 * messages, model and user_data can never select another bundle.
 */
import { randomBytes } from "node:crypto";
import {
  answer,
  answerFromRetrieval,
  constrainRequestedEvidence,
  draft,
  validateEvidence,
} from "../dist/engine.mjs";
import {
  DENSE_MODEL_ID,
  denseAvailableFor,
  embedQueryReady,
} from "./dense.mjs";
import { spokenTurn, historyField } from "./spoken.mjs";
import { normalizeSpoken } from "./spoken-normalize.mjs";
import { repairRecordTerms, vocabularyOf } from "./transcript-fix.mjs";

// One vocabulary per indexed bundle (rebuilt when the bundle changes).
const vocabCache = new WeakMap();
function vocabFor(bundle) {
  if (!bundle) return { terms: [], ids: [] };
  let v = vocabCache.get(bundle);
  if (!v) vocabCache.set(bundle, (v = vocabularyOf(bundle.clinical ?? [])));
  return v;
}
import { extractiveSpoken, isQuestion } from "./spoken-extract.mjs";
import {
  clinicalOverview,
  clinicalAnswer,
  observationEvidence,
  findTest,
  DATE_ASK_RE,
  identityReportsFor,
  patientDecision,
} from "../clinical/answer.mjs";
import { aliasesFor, nameOf, thirdPerson } from "../clinical/explain.mjs";
import {
  coverageNotice,
  wholeQuestionCoverage,
} from "./whole-question-coverage.mjs";
import { finalAnswer } from "./answer-contract.mjs";
import {
  voiceQuestions,
  isFragment,
  FRAGMENT_REPLY,
  selfRepair,
} from "./spoken-repair.mjs";
import { promotedAnswer } from "./paraphrase.mjs";
import { sectionAnswer } from "./doc-sections.mjs";
import { bundleFactAnswer, recordIntent } from "./record-facts.mjs";
import { cite as citeSpan } from "./spoken-routes.mjs";
import {
  callLanguage,
  isHindi,
  socialTurn,
  stripPreamble,
  repairDealTerms,
  glossHindi,
  splitCompound,
  splitMixed,
  domainOf,
  isVagueLab,
  clarifyLab,
  fragmentReply,
  toHindi,
  hasSubject,
  isDealQuestion,
  isSocialReply,
} from "./conversation.mjs";
import { normalizeVernacular, adviceKind, declineLead } from "./vernacular.mjs";

export function createVoiceAdapter({
  ttlMs = 120000,
  now = () => Date.now(),
  retrieval = null,
  bodyTimeoutMs = 5000,
  hardTtlMs = null,
  hardExpiresAtMs = null,
  // Called after each answered turn with (token, {question, lead, result,
  // scope}). The server routes it into the owning session's episodic memory.
  onTurn = null,
  // Standalone keys have no trusted conversation identity for replay.
  allowClientReplay = true,
} = {}) {
  let resolveBundle = null;
  let resolveAnswer = null;
  if (
    !Number.isSafeInteger(ttlMs) ||
    ttlMs < 1 ||
    !Number.isSafeInteger(bodyTimeoutMs) ||
    bodyTimeoutMs < 1 ||
    bodyTimeoutMs > 30000 ||
    (hardTtlMs !== null &&
      (!Number.isSafeInteger(hardTtlMs) || hardTtlMs < 1)) ||
    (hardExpiresAtMs !== null &&
      (!Number.isSafeInteger(hardExpiresAtMs) || hardExpiresAtMs < 1)) ||
    (retrieval !== null &&
      (typeof retrieval.retrieve !== "function" ||
        !["keyword", "dense", "hybrid"].includes(retrieval.actualMode) ||
        (retrieval.actualMode !== "keyword" && !retrieval.embeddingModel)))
  )
    throw Error("Invalid voice adapter config.");
  const grants = new Map();
  // Operator-provided (fixed) credentials get a durable record that survives
  // grant release: bundle binding, immutable hard expiry, retirement.
  const credentials = new Map();
  const admit = (token) => {
    const cred = credentials.get(token);
    if (cred) {
      if (cred.retiredAt !== null || now() >= cred.hardExpiresAt)
        return { status: 401 };
      // Retargeted to "no documents" (owner removed them all): there is no
      // corpus this credential may answer from, so fail closed.
      if (!cred.bundle) return { status: 401 };
      let grant = grants.get(token);
      if (!grant || grant.expires <= now()) {
        // Rebind at admission: the credential, not the owner session, owns
        // the bundle; a lapsed or swept grant is recreated here.
        const generation = cred.generation + 1;
        cred.generation = generation;
        grant = {
          bundle: cred.bundle,
          expires: Math.min(now() + ttlMs, cred.hardExpiresAt),
          last: null,
          sequence: 0,
          generation,
          lastAdmission: now(),
        };
        grants.set(token, grant);
      } else {
        // Renewable lease: each authorized turn extends up to the hard cap.
        grant.expires = Math.min(now() + ttlMs, cred.hardExpiresAt);
        grant.lastAdmission = now();
      }
      return { grant };
    }
    const grant = grants.get(token);
    if (!grant || grant.expires <= now()) {
      grants.delete(token);
      return { status: 401 };
    }
    grant.lastAdmission = now();
    return { grant };
  };
  return {
    bind(bundle, provided) {
      const token = provided ?? randomBytes(32).toString("hex");
      if (typeof token !== "string" || token.length < 32)
        throw Error("Invalid voice capability.");
      // An operator-provided (fixed) capability is a singleton: binding it
      // while a grant is LIVE would silently retarget live callers to another
      // session's documents. An EXPIRED grant is a lapsed liveness artifact,
      // not a revocation: sweep it and allow rebind. Revocation removes the
      // grant entirely, and the server retires a revoked fixed credential
      // separately, so this never resurrects a retired capability.
      const existing = grants.get(token);
      if (existing && existing.expires > now())
        throw Error("Voice capability already in use.");
      if (provided) {
        const prior = credentials.get(token);
        if (prior && prior.retiredAt !== null)
          throw Error(
            "Voice capability was retired. It cannot rebind in this deployment.",
          );
        const hardExpiresAt =
          prior?.hardExpiresAt ??
          hardExpiresAtMs ??
          (hardTtlMs !== null ? now() + hardTtlMs : Number.MAX_SAFE_INTEGER);
        if (now() >= hardExpiresAt)
          throw Error("Voice capability has passed its hard expiry.");
        const generation = (prior?.generation ?? 0) + 1;
        credentials.set(token, {
          bundle,
          hardExpiresAt,
          retiredAt: null,
          generation,
        });
        grants.set(token, {
          bundle,
          expires: Math.min(now() + ttlMs, hardExpiresAt),
          last: null,
          sequence: 0,
          generation,
          lastAdmission: now(),
        });
        return token;
      }
      grants.set(token, {
        bundle,
        expires: now() + ttlMs,
        last: null,
        sequence: 0,
        generation: 0,
        lastAdmission: now(),
      });
      return token;
    },
    // Explicit revocation sticks: for an operator-provided credential this
    // retires the credential itself, so admission cannot silently rebind a
    // revoked capability. Session cleanup must use release()/releaseIdle().
    revoke(token) {
      grants.delete(token);
      const cred = credentials.get(token);
      if (cred) cred.retiredAt = now();
    },
    // Session cleanup (sweep/eviction): release the grant, never the
    // credential. A stale generation observed before a rebind is a no-op.
    release(token, generation) {
      const g = grants.get(token);
      if (!g) return;
      if (generation !== undefined && g.generation !== generation) return;
      grants.delete(token);
    },
    // Sweep/eviction guard: a grant with admission activity inside idleMs is
    // treated as a live call and left alone.
    releaseIdle(token, idleMs, generation) {
      const g = grants.get(token);
      if (!g) return;
      if (now() - (g.lastAdmission ?? 0) < idleMs) return;
      this.release(token, generation);
    },
    // Owner re-import: atomically retarget a fixed credential to the new
    // bundle. The old grant is dropped (any generation), so in-flight
    // old-generation requests reject at the next recheck instead of
    // answering from the stale corpus, and the next admission rebinds to
    // the new bundle. Never resurrects a retired credential and never
    // extends past the pinned hard expiry.
    retarget(token, bundle) {
      const cred = credentials.get(token);
      if (!cred || cred.retiredAt !== null || now() >= cred.hardExpiresAt)
        return false;
      cred.bundle = bundle;
      grants.delete(token);
      return true;
    },
    // Explicit owner revocation. Process-local tombstone: an instance
    // restart forgets it, so leaked-credential rotation is redeploy-with-new-
    // value (the server's runbook couples retire + rotate as one action).
    // Within a process it is permanent - rebind always refuses.
    retire(token) {
      const cred = credentials.get(token);
      if (cred) cred.retiredAt = now();
      grants.delete(token);
    },
    grantGeneration(token) {
      return (
        grants.get(token)?.generation ??
        credentials.get(token)?.generation ??
        null
      );
    },
    isBound(token) {
      const grant = grants.get(token);
      return !!grant && grant.expires > now();
    },
    async handle(req) {
      const bearer =
        req.headers.get("authorization")?.replace(/^Bearer /, "") || "";
      if (req.method === "GET") {
        if (new URL(req.url).pathname !== "/v1/models")
          return Response.json(
            { error: "Method not allowed" },
            { status: 405 },
          );
        // OpenAI-style model list: the registering console calls this with the
        // bearer to validate key and model name at save time. Same capability
        // gate as completions; read-only, advances no turn state.
        const cred = credentials.get(bearer);
        if (cred) {
          // Read-only validation for the registering console: never creates,
          // renews or deletes a grant.
          if (cred.retiredAt !== null || now() >= cred.hardExpiresAt)
            return Response.json(
              { error: "Invalid or expired session capability" },
              { status: 401 },
            );
        } else {
          const grant = grants.get(bearer);
          if (!grant || grant.expires <= now()) {
            grants.delete(bearer);
            return Response.json(
              { error: "Invalid or expired session capability" },
              { status: 401 },
            );
          }
        }
        return Response.json({
          object: "list",
          data: [
            {
              id: "voice-memory-local",
              object: "model",
              created: 0,
              owned_by: "voice-memory",
            },
          ],
        });
      }
      if (
        req.method !== "POST" ||
        new URL(req.url).pathname !== "/v1/chat/completions"
      ) {
        // Reject early but never leave an unread body hanging.
        req.body?.cancel().catch(() => {});
        return Response.json({ error: "Method not allowed" }, { status: 405 });
      }
      const token = bearer;
      const admitted = admit(token);
      if (admitted.status)
        return Response.json(
          { error: "Invalid or expired session capability" },
          { status: admitted.status },
        );
      const grant = admitted.grant;
      // Parse before taking a turn number. A rejected or side request must
      // not mark the spoken question as superseded.
      const receivedAt = Date.now();
      const logTurn = (entry) => {
        grant.turnLog ??= [];
        grant.turnLog.push({ seq: grant.sequence, receivedAt, ...entry });
        if (grant.turnLog.length > 50) grant.turnLog.shift();
      };
      let data;
      try {
        const raw = await boundedBody(req, bodyTimeoutMs);
        data = JSON.parse(raw);
      } catch {
        return Response.json({ error: "Invalid request" }, { status: 400 });
      }
      if (
        !data ||
        typeof data !== "object" ||
        Array.isArray(data) ||
        !Array.isArray(data.messages)
      ) {
        return Response.json(
          { error: "Invalid message list" },
          { status: 400 },
        );
      }
      if (grants.get(token) !== grant || grant.expires <= now()) {
        return Response.json(
          { error: "Invalid or expired session capability" },
          { status: 401 },
        );
      }
      // A visitor's own uploaded workspace, named by the session variable
      // Bolna substitutes into the agent prompt (vm_ws=<id>). The bearer
      // still authenticates; the id only selects among public workspaces.
      // The resolver answers with a bundle (older callers) or with
      // {bundle, call, caseId, expired}: the scope this call's page has
      // open, its per-call handle, and whether a workspace it names is gone.
      let bundle = grant.bundle;
      let callTag = null;
      let caseId = null;
      let scopeGone = false;
      let scopeBad = false;
      let scopePending = null;
      try {
        const ws = resolveBundle?.(data.messages, token);
        if (ws?.expired) scopeGone = true;
        if (ws?.malformed) scopeBad = true;
        if (ws?.pending) scopePending = ws.pending;
        if (
          ws &&
          ("bundle" in ws ||
            "expired" in ws ||
            "malformed" in ws ||
            "pending" in ws)
        ) {
          callTag = ws.call ?? null;
          caseId = ws.caseId ?? null;
          if (ws.bundle) bundle = ws.bundle;
        } else if (ws) bundle = ws;
      } catch {
        // A failed scope lookup cannot safely fall back to demo records.
        scopeBad = true;
      }
      const versionOf = (b) =>
        JSON.stringify([
          b?.scope,
          ...(b?.sources ?? []).map((source) => [
            source.id,
            source.hash,
            source.title,
          ]),
        ]);
      const startingVersion = versionOf(bundle);
      const askedRaw = latestUser(data.messages);
      if (!askedRaw) {
        return Response.json(
          {
            error: "A request with a user message is required",
          },
          { status: 400 },
        );
      }
      // Classifier / hangup checks (Bolna sets response_format json_object,
      // often with stream false). They share this endpoint. Answering them
      // from the evidence engine, or letting them take the turn number,
      // drops the caller's real question and returns JSON to a stream.
      const jsonMode = data.response_format?.type === "json_object";
      if (jsonMode) {
        return completionJson('{"hangup":"no"}');
      }
      // Bolna's spoken turn is always stream:true. A non-streaming request is
      // not a question: rejecting it before a turn number is taken means it
      // cannot supersede the utterance that is already in flight.
      if (data.stream !== true) {
        return Response.json(
          {
            error: "A streaming request with a final user message is required",
          },
          { status: 400 },
        );
      }
      if (scopeGone || scopeBad) {
        // Their workspace expired (30 idle minutes) or was replaced, or the
        // call names a scope this server cannot read. Say so plainly, and
        // show the same words on the page; never answer from the fictional
        // demo records (or every record) instead.
        const said = scopeGone
          ? "Your uploaded documents have expired, so I can't answer from them. Upload them again on the page and ask me once more."
          : "I can't tell which documents this call is for, so I won't answer from any of them. Please end the call and start it again from the page.";
        logTurn({
          transcript: askedRaw,
          outcome: scopeGone ? "scope_expired" : "scope_malformed",
        });
        try {
          onTurn?.(token, {
            question: askedRaw,
            lead: {
              intent: scopeGone ? "SCOPE_EXPIRED" : "SCOPE_UNKNOWN",
              verdict: "UNKNOWN",
              spoken: said,
              citations: [],
            },
            result: null,
            scope: null,
            call: callTag,
            caseId,
          });
        } catch {
          /* best-effort */
        }
        return sseOnce(said);
      }
      if (scopePending) {
        // Their workspace is live but has nothing answerable yet: uploads
        // still being read, or every upload failed. Say which - never
        // "expired", and never the demo records instead.
        const said =
          scopePending === "failed"
            ? "I couldn't read those documents. Please try uploading them again on the page."
            : scopePending === "empty"
              ? "I don't have any documents for this call yet. Upload them on the page, then ask me again."
              : "I'm still reading your documents. Give me a few seconds and ask me again.";
        logTurn({ transcript: askedRaw, outcome: "scope_pending" });
        try {
          onTurn?.(token, {
            question: askedRaw,
            lead: {
              intent: "SCOPE_PENDING",
              verdict: "UNKNOWN",
              spoken: said,
              citations: [],
            },
            result: null,
            scope: null,
            call: callTag,
            caseId,
          });
        } catch {
          /* best-effort */
        }
        return sseOnce(said);
      }
      // "the triglycer, sorry, the HDL" is a question about HDL: only what
      // the caller settled on is read, here and in the history the engine sees
      let busyTaken = false;
      try {
        // Names the recogniser cannot know ("creating in", "tea s h", "s y n
        // zero zero zero one") are repaired from these documents' own
        // vocabulary first; numbers are never touched (transcript-fix.mjs).
        const repaired = repairRecordTerms(
          selfRepair(askedRaw),
          vocabFor(bundle),
        );
        const heardFixes = repaired.fixes;
        const transcript = repaired.text;
        if (transcript !== askedRaw) {
          const at = data.messages.map((m) => m?.role).lastIndexOf("user");
          data = {
            ...data,
            messages: data.messages.map((m, i) =>
              i === at ? { ...m, content: transcript } : m,
            ),
          };
        }
        // Repair recogniser damage (patient ids, misheard test names) and, for
        // a fragment or a follow-up that lost its subject, join this caller's
        // own previous utterances. Lab questions take the first candidate the
        // clinical layer can answer.
        const reports = bundle?.clinical ?? [];
        // Earlier utterances are joined in only when this one is a fragment or
        // has no subject of its own ("and the other one?"); otherwise a deal
        // question right after a lab question would be answered as lab.
        const ownOnly = hasSubject(transcript) && !isFragment(transcript);
        const candidates = voiceQuestions(
          ownOnly ? data.messages.slice(-1) : data.messages,
          {
            reports,
            ids: [
              ...new Set(
                reports.map((r) => r.meta?.patient?.id).filter(Boolean),
              ),
            ],
            aliasesFor,
            text: messageText,
          },
        )
          // phrased any way: drop a leading "hi, can you hear me", repair the
          // deal's names as the recogniser spells them, and add an English
          // rendering of a Hindi question so both reach the same intent
          .flatMap((q) => {
            const r = repairDealTerms(stripPreamble(q)) || q;
            const g = glossHindi(r);
            return [r, ...(g ? [g] : []), q];
          })
          .map((q) => normalizeSpoken(q) || q)
          .filter((q, i, all) => q && all.indexOf(q) === i);
        // Bounded per-call context, from this request's own messages only:
        // the agent's last spoken answer and the caller's last question.
        const prevSaid = messageText(
          [...data.messages.slice(0, -1)]
            .reverse()
            .find(
              (m) => m?.role === "assistant" && messageText(m.content).trim(),
            )?.content ?? "",
        );
        const prevAsked = messageText(
          [...data.messages.slice(0, -1)]
            .reverse()
            .find((m) => m?.role === "user" && messageText(m.content).trim())
            ?.content ?? "",
        );
        if (reports.length) {
          let own = null;
          try {
            own = findTest(transcript, reports);
          } catch {
            own = null;
          }
          // "SYN-0003", said back after "whose TSH results?", answers that
          // question: read it joined to the question it answers, first. A
          // new question with its own test ("creatinine in September?") is a
          // change of topic, not an answer.
          if (
            !own &&
            /Whose (results|report)|Which one did you mean|किसके|kiske/i.test(
              prevSaid,
            ) &&
            prevAsked
          )
            candidates.unshift(
              normalizeSpoken(`${prevAsked} ${transcript}`) ||
                `${prevAsked} ${transcript}`,
            );
          // "Is that normal?" four turns after "ferritin": the subject of the
          // last answer, as the typed path keeps the last answer's field.
          let said = null;
          try {
            said = findTest(prevSaid, reports);
          } catch {
            said = null;
          }
          if (said && !own && (!said.keys || said.keys.length <= 1)) {
            // a patient is inherited only when the last answer named exactly
            // one, and never from a "whose results?" question: no silent pick
            const ids = [
              ...new Set(prevSaid.match(/\b[A-Z]{2,5}-\d{3,6}\b/g) ?? []),
            ];
            const pid =
              ids.length === 1 && !/Whose|which one|किसके|kiske/i.test(prevSaid)
                ? ids[0]
                : "";
            // one dated report in the last answer: keep its date too
            const dates = [
              ...new Set(
                prevSaid.match(
                  /\b\d{1,2} (?:January|February|March|April|May|June|July|August|September|October|November|December) \d{4}\b/g,
                ) ?? [],
              ),
            ];
            const day =
              dates.length === 1 &&
              !/\b(before|earlier|previous|since|chang\w*|improv\w*|went|up|down|compar\w*|correct\w*|amend\w*|original\w*|first|earliest|pehle)\b|पहले/i.test(
                transcript,
              )
                ? dates[0]
                : "";
            const withCtx = `${transcript} ${pid} ${nameOf(said)} ${day}`
              .replace(/\s+/g, " ")
              .trim();
            // a clear follow-up ("is that normal?", "why?") is about the last
            // answer before anything older; otherwise it is a last resort
            // A question that names its own subject ("is his kidney function
            // okay?") or asks for dates is not a follow-up, however short.
            const followUp =
              transcript.split(/\s+/).length <= 7 &&
              !DATE_ASK_RE.test(transcript) &&
              !/\b(kidney|liver|thyroid|heart|sugar|diabetes|cholesterol|lipid|blood|urine|vitamin|iron|report|test)\b|किडनी|लिवर|थायरॉइड|शुगर/i.test(
                transcript,
              ) &&
              /\b(it|its|that|this|those|them|again|same|normal|high|low|range|why|mean\w*|okay|ok|fine|good|bad|worried|worry)\b|ठीक|सामान्य|normal hai|theek/i.test(
                transcript,
              );
            if (DATE_ASK_RE.test(transcript)) {
              /* a date question carries no inherited subject */
            } else if (followUp) candidates.unshift(withCtx);
            else if (!own) candidates.push(withCtx);
          }
        }
        // This call's own history only (a fixed bearer is shared by callers).
        const userHistory = data.messages
          .slice(0, -1)
          .filter((m) => m?.role === "user")
          .map((m) => messageText(m.content));
        const lang = callLanguage(transcript, userHistory);
        // the last answer about the records: a hear-check or "you're welcome"
        // in between is not what "say that again" means
        const clientLastSpoken =
          [...data.messages.slice(0, -1)]
            .reverse()
            .find(
              (m) =>
                m?.role === "assistant" &&
                messageText(m.content).trim() &&
                !isSocialReply(messageText(m.content)),
            )?.content ?? null;
        // Scoped calls repeat only a server-produced evidence answer from
        // this call and source version. Client assistant text is not proof.
        const replayKey =
          callTag && caseId ? JSON.stringify([callTag, caseId]) : null;
        const savedReplay = replayKey
          ? grant.recordAnswers?.get(replayKey)
          : null;
        const guardedReplay =
          !allowClientReplay ||
          !!callTag ||
          (typeof caseId === "string" && /^w_/.test(caseId));
        const lastSpoken = guardedReplay
          ? savedReplay?.version === startingVersion
            ? savedReplay.spoken
            : null
          : clientLastSpoken;
        const social = socialTurn(repairDealTerms(transcript), {
          lang,
          uploaded:
            typeof caseId === "string" && /^w_[0-9a-f]{32}$/.test(caseId),
          last: lastSpoken ? messageText(lastSpoken) : null,
          repeatUnavailable: guardedReplay && !lastSpoken,
        });
        // Two subjects in one breath ("my ferritin, and what changed in the
        // Northstar deal"): each half answered by the renderer for its records,
        // in the caller's language, then spoken together.
        let mixedTurn = null;
        if (!social) {
          const parts = splitMixed(normalizeVernacular(transcript));
          if (parts.length >= 2 && new Set(parts.map(domainOf)).size >= 2) {
            const said = [],
              cites = [];
            let verdict = null;
            for (const part of parts) {
              const q = normalizeSpoken(part) || part;
              let r = null;
              try {
                if (domainOf(q) === "lab" && reports.length) {
                  const c =
                    clinicalAnswer(q, reports) ?? clinicalOverview(q, reports);
                  if (c)
                    r = {
                      spoken: c.spoken,
                      verdict: c.verdict,
                      citations: c.used
                        .map((o) => observationEvidence(o, bundle))
                        .filter(Boolean)
                        .map((e) => ({
                          // sourceId/start/end ride to the turn feed's
                          // decorateResult, which resolves documentId and
                          // the page bbox; stripped anchors made voice
                          // citations unverifiable.
                          title: e.title,
                          sourceId: e.sourceId,
                          start: e.start,
                          end: e.end,
                          docDate: null,
                          quote: e.quote,
                          firstLine: e.firstLine,
                          lastLine: e.lastLine,
                          hash: e.hash,
                        })),
                      localized: true,
                    };
                } else {
                  const g = glossHindi(repairDealTerms(q));
                  const broad =
                    !g &&
                    /\b(chang\w*|happen\w*|exactly|summary|status|update|overview|badl\w*)\b|बदल|क्या\s+हुआ/i.test(
                      q,
                    );
                  const qs = broad
                    ? ["What happened to the fee?", "What's still open?"]
                    : [normalizeSpoken(g ?? repairDealTerms(q)) || q];
                  const got = qs
                    .map((x) => spokenTurn(x, bundle, null))
                    .filter((x) => x?.spoken && x.verdict !== "UNKNOWN");
                  if (got.length)
                    r = {
                      spoken: got.map((x) => x.spoken).join(" "),
                      verdict: got[0].verdict,
                      citations: got.flatMap((x) => x.citations ?? []),
                      localized: false,
                    };
                }
              } catch {
                r = null;
              }
              if (!r) continue;
              verdict ??= r.verdict;
              said.push(
                isHindi(lang) && !r.localized ? toHindi(r.spoken) : r.spoken,
              );
              cites.push(...r.citations);
            }
            if (said.length)
              mixedTurn = {
                spoken: said.join(" "),
                verdict: verdict ?? "MIXED",
                citations: cites,
              };
          }
        }
        let asked = candidates[0] || normalizeSpoken(transcript) || transcript;
        let clinicalHit = false;
        const deal = isDealQuestion(transcript) || isDealQuestion(asked);
        if (reports.length && !deal) {
          const hit = candidates.find((q) => {
            try {
              return clinicalAnswer(q, reports);
            } catch {
              return false;
            }
          });
          if (hit) ((asked = hit), (clinicalHit = true));
        }
        // A Hindi question about the deal: the engine reads English, so ask
        // with the English rendering (lab questions are read in Hindi already).
        if (!clinicalHit && isHindi(lang)) {
          const g = glossHindi(repairDealTerms(stripPreamble(transcript)));
          if (g) asked = normalizeSpoken(g) || g;
        }
        // Two questions in one breath: answer the first here, the second below.
        // Only what the caller said in THIS utterance is split. A candidate
        // joined from earlier turns ("ferritin result? what was it before the
        // correction?") is one follow-up, and splitting it re-answered the
        // previous question instead of the one just asked.
        const ownCompound =
          splitCompound(normalizeSpoken(transcript) || transcript).length > 1;
        const [firstQ, secondQ0] = ownCompound ? splitCompound(asked) : [asked];
        const secondQ = mixedTurn ? null : secondQ0;
        if (secondQ) asked = firstQ;
        const streaming = true;
        // Barge-in is per call. The operator's fixed bearer is shared by every
        // caller, so one counter per bearer let caller B's turn supersede
        // caller A's answer in flight (A heard silence). The per-call handle
        // from vm_ws keys the counter; without one (a phone call, an older
        // page) the bearer-wide counter is kept, as before.
        const seqKey = callTag ?? "";
        grant.seqs ??= new Map();
        const sequence = (grant.seqs.get(seqKey) ?? 0) + 1;
        grant.seqs.delete(seqKey);
        grant.seqs.set(seqKey, sequence);
        if (grant.seqs.size > 500)
          grant.seqs.delete(grant.seqs.keys().next().value);
        grant.sequence = sequence;
        const current = () => grant.seqs.get(seqKey) === sequence;
        grant.busy = (grant.busy ?? 0) + 1;
        busyTaken = true;
        const releaseBusy = () => {
          grant.busy = Math.max(0, (grant.busy ?? 1) - 1);
        };
        if (req.signal.aborted) {
          releaseBusy();
          logTurn({ transcript, outcome: "aborted" });
          return new Response(null, { status: 499 });
        }
        let spoken, turn;
        const identityDecision = patientDecision(
          transcript,
          identityReportsFor(bundle),
        );
        const ownerBlocked =
          unboundOwnerTurn(transcript, bundle) ??
          (identityDecision.conflictIdentity
            ? {
                intent: "AMBIGUOUS_PATIENT",
                verdict: "AMBIGUOUS_PATIENT",
                spoken: identityDecision.spoken,
                citations: [],
              }
            : null);
        // Direct factual questions reach the common resolver
        // before voice-specific retrieval/renderers choose any fact. Speech
        // repair/history remain above; specialist orchestration stays below.
        let earlyUnified = null;
        if (
          resolveAnswer &&
          !mixedTurn &&
          !secondQ &&
          !social &&
          !ownerBlocked &&
          !adviceKind(transcript) &&
          isQuestion(transcript)
        ) {
          earlyUnified = await resolveAnswer({
            question: asked,
            originalQuestion: askedRaw,
            exactSchemaOnly: false,
            bundle,
            caseId,
            call: callTag,
          });
          if (req.signal.aborted) {
            releaseBusy();
            return new Response(null, { status: 499 });
          }
          if (streaming && !current()) {
            releaseBusy();
            return Response.json({ error: "Superseded turn" }, { status: 409 });
          }
        }
        if (earlyUnified) {
          // Render once at the shared boundary below. Do not execute a
          // second factual fallback or populate draft state from it.
        } else if (ownerBlocked) {
          spoken = ownerBlocked.spoken;
          grant.last = {
            refused: true,
            evidence: [],
            requestedChecked: true,
            spoken,
          };
          turn = { result: grant.last, spokenTurn: ownerBlocked };
        } else if (mixedTurn) {
          spoken = mixedTurn.spoken;
          turn = {
            spokenTurn: {
              intent: "MIXED",
              verdict: mixedTurn.verdict,
              spoken,
              citations: mixedTurn.citations,
            },
          };
        } else if (!social && adviceKind(transcript)) {
          // Treatment, diagnosis or a decision that is the caller's to make:
          // declined before any record can turn into advice, in the caller's
          // language, exactly as the typed path declines it.
          const d = declineLead(
            adviceKind(transcript),
            lang === "hi" ? "hi" : lang === "hinglish" ? "hinglish" : "en",
            transcript,
          );
          spoken = d.text;
          turn = {
            spokenTurn: {
              intent: "ADVICE",
              verdict: d.verdict,
              spoken,
              citations: [],
            },
          };
        } else if (social) {
          // about the call itself: a fixed reply, no record facts
          spoken = social.spoken;
          turn = {
            spokenTurn: {
              intent: social.intent,
              verdict: "SOCIAL",
              spoken,
              citations: [],
            },
          };
        } else if (
          identifierRequest(transcript) &&
          !explicitRecordRequest(asked, bundle.sources)
        ) {
          grant.last = answer(transcript, bundle);
          spoken = grant.last.spoken;
          turn = {
            result: grant.last,
            spokenTurn: {
              intent: "IDENTIFIER",
              verdict: grant.last.refused ? "UNKNOWN" : "QUOTED",
              spoken,
              citations: grant.last.evidence,
            },
          };
        } else if (
          /^\s*(turn (that|this|the brief) into (an? )?email|draft (an? )?email)\s*[.!]?\s*$/i.test(
            transcript,
          )
        ) {
          // The draft comes from THIS call's previous question (its own message
          // history), never from whatever another caller on the same bearer
          // asked last.
          const prev = [...data.messages.slice(0, -1)]
            .reverse()
            .find((m) => m?.role === "user" && messageText(m.content).trim());
          const prevQ = prev ? messageText(prev.content) : undefined;
          let prior = null;
          try {
            prior = prevQ
              ? answer(normalizeSpoken(prevQ) || prevQ, bundle)
              : null;
          } catch {
            prior = null;
          }
          // A minted per-call token is one call, so its own last turn is fine;
          // the fixed operator bearer is shared and never falls back.
          if (!prevQ && !credentials.has(token)) prior = grant.last ?? null;
          if (
            !prior ||
            prior.refused ||
            prior.unresolved ||
            !prior.evidence?.length
          )
            spoken =
              "Ask a question with supporting evidence first. I have not created or sent an email.";
          else {
            const reviewDraft = draft(prior, bundle);
            turn = { draft: reviewDraft };
            spoken =
              "A review draft is ready on screen. Check decisions, conditions and open items before using it. Nothing has been sent.";
          }
        } else {
          let result = retrieval
            ? answerFromRetrieval(
                asked,
                bundle,
                await retrieval.retrieve(asked, bundle, {
                  signal: req.signal,
                }),
                {
                  actualMode: retrieval.actualMode,
                  embeddingModel: retrieval.embeddingModel,
                },
              )
            : answer(asked, bundle, {
                queryVector: await embedQueryReady(asked),
                model: DENSE_MODEL_ID,
                available: denseAvailableFor(bundle),
              });
          if (retrieval)
            result = constrainRequestedEvidence(asked, bundle, result);
          if (
            !result ||
            typeof result.refused !== "boolean" ||
            !Array.isArray(result.evidence) ||
            (!result.refused && !result.evidence.length)
          )
            // The engine has no answer shape for some in-corpus questions
            // (e.g. fields outside its vocabulary). Treat that as an honest
            // refusal for the evidence feed; the claim-graph renderer below
            // still speaks when it has grounded citations.
            result = { refused: true, evidence: [] };
          for (const evidence of result.evidence)
            validateEvidence(evidence, bundle);
          if (req.signal.aborted) {
            releaseBusy();
            logTurn({ transcript, outcome: "aborted" });
            return new Response(null, { status: 499 });
          }
          if (grants.get(token) !== grant || grant.expires <= now()) {
            releaseBusy();
            return Response.json(
              { error: "Invalid or expired session capability" },
              { status: 401 },
            );
          }
          if (streaming && !current()) {
            releaseBusy();
            logTurn({ transcript, outcome: "superseded" });
            return Response.json({ error: "Superseded turn" }, { status: 409 });
          }
          grant.last = result;
          turn = { result };
          // Deterministic spoken renderer: routes intent, resolves the field
          // from the claim graph (per-grant inheritance for follow-ups), and
          // fills guarded templates. Engine output above stays the authority
          // for evidence; this layer only chooses what is spoken.
          // Lab results across reports (bundle.clinical, set by the server for
          // uploaded lab tables) answer first; absent for Northstar.
          const clinical =
            !result.requestedChecked && bundle.clinical?.length && !deal
              ? (clinicalAnswer(asked, bundle.clinical) ??
                candidates
                  .map((q) => clinicalOverview(q, bundle.clinical))
                  .find(Boolean) ??
                null)
              : null;
          let rendered = clinical
            ? {
                spoken: clinical.spoken,
                verdict: clinical.verdict,
                field: null,
                intent: clinical.intent,
                citations: clinical.used
                  .map((o) => observationEvidence(o, bundle))
                  .filter(Boolean)
                  .map((c) => ({
                    // Anchors pass through: see the mixed-turn note above.
                    title: c.title,
                    sourceId: c.sourceId,
                    start: c.start,
                    end: c.end,
                    docDate: null,
                    quote: c.quote,
                    firstLine: c.firstLine,
                    lastLine: c.lastLine,
                    hash: c.hash,
                  })),
              }
            : null;
          rendered ??= result.requestedChecked
            ? null
            : spokenTurn(
                asked,
                bundle,
                // Context from this request's own history only: a fixed bearer is
                // shared by every caller, so grant-level state would leak between
                // concurrent calls.
                historyField(bundle, data.messages.slice(0, -1)) ??
                  (credentials.has(token) ? null : (grant.lastField ?? null)),
              );
          // Outside the claim graph's fields: speak one verbatim sentence or
          // table row from the engine's already-validated evidence, or keep
          // the abstention. Deliberate abstentions (unknown entity/amount)
          // carry no "no_field" reason and are never overridden.
          if (
            !clinical &&
            (result.requestedChecked ||
              !rendered ||
              rendered.reason === "no_field")
          ) {
            const quoted = extractiveSpoken(
              asked,
              result,
              bundle,
              bundle.locateEvidence,
              result?.queryTransform?.expanded ?? undefined,
            );
            if (quoted)
              rendered = {
                spoken: quoted.spoken,
                verdict: quoted.verdict,
                field: null,
                intent: rendered?.intent ?? "LOOKUP",
                citations: quoted.citations.map((c) => ({
                  // Anchors pass through: see the mixed-turn note above.
                  title: c.title,
                  sourceId: c.sourceId ?? null,
                  start: c.start ?? null,
                  end: c.end ?? null,
                  docDate: null,
                  quote: c.quote,
                  firstLine: c.firstLine,
                  lastLine: c.lastLine,
                  hash: c.hash,
                })),
              };
          }
          if (rendered) {
            grant.lastField = rendered.field ?? grant.lastField ?? null;
            grant.lastTurn = {
              at: Date.now(),
              intent: rendered.intent,
              field: rendered.field,
              verdict: rendered.verdict,
              spoken: rendered.spoken,
              citations: rendered.citations,
            };
            spoken = rendered.spoken;
            // Expose the verified spoken turn (verdict + citations) to the
            // owner's evidence feed alongside the engine result.
            turn = { result, spokenTurn: grant.lastTurn };
          }
          spoken ??=
            grant.last.spoken ??
            (grant.last.unresolved
              ? "Relevant passages need review, but this question is unresolved. No supported answer or draft is available. Review the original passages on screen."
              : grant.last.refused
                ? "I could not find supporting evidence in these documents."
                : `I found ${grant.last.evidence.length} relevant source passages. This local build shows excerpts rather than a synthesized answer. Review the sources on screen, including any conditions or differing decision statements.`);
        }
        const refusal = (x) =>
          /^I (don't|do not) see that in these documents\.?$|^I could not find supporting evidence/i.test(
            x ?? "",
          );
        // The second half of a compound question, from the same deterministic
        // renderers (clinical first, then the claim graph).
        if (!earlyUnified && !ownerBlocked && !social && secondQ) {
          let second = null;
          try {
            const secondResult = answer(secondQ, bundle);
            second = secondResult.requestedChecked
              ? extractiveSpoken(
                  secondQ,
                  secondResult,
                  bundle,
                  bundle.locateEvidence,
                )
              : ((bundle.clinical?.length && !deal
                  ? clinicalAnswer(secondQ, bundle.clinical)
                  : null) ??
                spokenTurn(secondQ, bundle, turn?.spokenTurn?.field ?? null));
          } catch {
            second = null;
          }
          const s2 = second?.spoken;
          if (s2 && !refusal(s2) && s2 !== spoken)
            spoken = refusal(spoken) ? s2 : `${spoken} ${s2}`;
          else if (
            !deal &&
            refusal(spoken) &&
            isVagueLab(secondQ) &&
            bundle.clinical?.length
          )
            spoken = clarifyLab(lang);
        }
        // A broad question about the deal ("what exactly changed in the
        // Northstar deal?"): the fee change and what is still open, from the
        // same renderers, rather than an abstention.
        // Reworded beyond keyword reach: one verbatim sentence, only when the
        // calibrated paraphrase gate is unambiguous (paraphrase.mjs).
        // A record question ("was iron prescribed?") is answered from the
        // records' facts even when a lab answer was found.
        let briefed = false;
        if (
          !earlyUnified &&
          !turn?.result?.requestedChecked &&
          !social &&
          !mixedTurn &&
          briefIntent(asked)
        ) {
          const b = (() => {
            try {
              // Reuse the shared source-bound identity decision. Never let
              // the brief layer choose a majority record or pool lab digests.
              return briefAnswer(asked, bundle, citeSpan, {
                patient: identityDecision.patient ?? null,
                labs: labDigest(
                  bundle.clinical ?? [],
                  identityDecision.patient ?? null,
                ),
                reports: (bundle.clinical ?? []).filter(
                  (r) =>
                    !identityDecision.patient ||
                    subjectOf(r) === identityDecision.patient,
                ),
                namedTest:
                  !!findTest(asked, bundle.clinical ?? []) ||
                  !!findTest(grant?.lastField ?? "", bundle.clinical ?? []),
              });
            } catch {
              return null;
            }
          })();
          if (b) {
            briefed = true;
            spoken = b.spoken;
            turn = {
              ...turn,
              spokenTurn: {
                intent: b.intent,
                verdict: "QUOTED",
                spoken,
                citations: b.citations,
              },
            };
          }
        }
        if (
          !earlyUnified &&
          !briefed &&
          !turn?.result?.requestedChecked &&
          !social &&
          !mixedTurn &&
          !refusal(spoken) &&
          recordIntent(asked)
        ) {
          const fa = (() => {
            try {
              return bundleFactAnswer(asked, bundle, citeSpan);
            } catch {
              return null;
            }
          })();
          if (fa) {
            spoken = fa.spoken;
            turn = {
              ...turn,
              spokenTurn: {
                intent: "LOOKUP",
                verdict: fa.clarify ? "AMBIGUOUS_PATIENT" : "QUOTED",
                spoken,
                citations: fa.citations,
              },
            };
          }
        }
        if (
          !earlyUnified &&
          !social &&
          !mixedTurn &&
          !turn?.result?.requestedChecked &&
          refusal(spoken) &&
          !isFragment(transcript)
        ) {
          let p = null;
          try {
            // A recorded fact, from the most authoritative record first.
            const fa = bundleFactAnswer(asked, bundle, citeSpan);
            if (fa)
              p = {
                spoken: fa.spoken,
                citation: fa.citations[0],
                citations: fa.citations,
              };
            else {
              p = sectionAnswer(asked, bundle);
              if (p)
                p = {
                  spoken: p.spoken,
                  citation: p.citations[0],
                  citations: p.citations,
                };
              else p = await promotedAnswer(asked, bundle);
            }
          } catch {
            p = null;
          }
          if (p) {
            spoken = p.spoken;
            turn = {
              ...turn,
              spokenTurn: {
                intent: "LOOKUP",
                verdict: "QUOTED",
                spoken,
                citations: p.citations ?? [p.citation],
              },
            };
          }
        }
        // Only for a broad question that names this deal: an abstention about
        // anything else (another company, an unknown amount) must stand.
        const broadDeal =
          /\b(northstar|deal)\b/i.test(asked + " " + (secondQ ?? "")) &&
          /\b(chang\w*|happen\w*|exactly|summary|summari[sz]e|status|update|overview|badl\w*)\b|बदल|क्या\s+हुआ/i.test(
            transcript,
          );
        if (!earlyUnified && !social && deal && broadDeal && refusal(spoken)) {
          const parts = ["What happened to the fee?", "What's still open?"]
            .map((q) => {
              try {
                return spokenTurn(q, bundle, null)?.spoken;
              } catch {
                return null;
              }
            })
            .filter((x) => x && !refusal(x));
          if (parts.length) spoken = parts.join(" ");
        }
        // "my result" without a test name: ask which, don't abstain.
        if (
          !earlyUnified &&
          !social &&
          !deal &&
          refusal(spoken) &&
          bundle.clinical?.length &&
          isVagueLab(asked)
        )
          spoken = clarifyLab(lang);
        // A cut-off fragment gets a helpful prompt, not a flat abstention.
        if (!earlyUnified && refusal(spoken) && isFragment(transcript))
          spoken = fragmentReply(lang) ?? FRAGMENT_REPLY;
        // The page has one demo case open and the caller asked about the other
        // one: point to it instead of a bare "I don't see that". No facts from
        // the case that is not on screen are spoken.
        let pointed = false;
        if (
          (!earlyUnified ||
            (earlyUnified.lead?.verdict === "UNKNOWN" &&
              !earlyUnified.lead?.citations?.length)) &&
          !social &&
          !mixedTurn &&
          (earlyUnified ||
            refusal(spoken) ||
            /^I (don't|do not) see .{1,80} in these documents\.?$/i.test(
              spoken,
            )) &&
          (caseId === "health" || caseId === "deal")
        ) {
          const d = domainOf(normalizeVernacular(transcript));
          const want =
            caseId === "health" && (deal || d === "deal")
              ? "deal"
              : caseId === "deal" && !deal && d === "lab"
                ? "lab"
                : null;
          if (want) {
            pointed = true;
            if (earlyUnified) {
              // Navigation has no factual draft source from this or a prior turn.
              grant.last = {
                refused: true,
                evidence: [],
                requestedChecked: true,
              };
              grant.lastField = null;
            }
            spoken = isHindi(lang)
              ? want === "deal"
                ? "यह Northstar deal के बारे में है, जो अभी स्क्रीन पर खुला नहीं है। Northstar टैब खोलिए और मुझसे फिर पूछिए।"
                : "यह लैब रिपोर्ट्स के बारे में है, जो अभी स्क्रीन पर खुली नहीं हैं। Lab reports टैब खोलिए और मुझसे फिर पूछिए।"
              : want === "deal"
                ? "That's about the Northstar deal, which isn't open on screen right now. Switch to the Northstar tab and ask me again."
                : "That's about the lab reports, which aren't open on screen right now. Switch to the lab reports tab and ask me again.";
            turn = {
              spokenTurn: {
                intent: "OTHER_CASE",
                verdict: "UNKNOWN",
                spoken,
                citations: [],
              },
            };
          }
        }
        // Hindi on request or when spoken to in Hindi. Clinical answers are
        // already rendered in the caller's language; deal templates are
        // rendered here, with record quotes kept verbatim.
        if (
          !earlyUnified &&
          isHindi(lang) &&
          !clinicalHit &&
          !social &&
          !mixedTurn &&
          !pointed &&
          turn?.spokenTurn?.intent !== "ADVICE"
        )
          spoken = toHindi(spoken);
        if (!social && bundle.clinical?.length) spoken = thirdPerson(spoken);
        releaseBusy();
        let sharedRendered = false,
          sharedCoverage = null;
        // Optional server-owned common answer boundary. Caller messages never
        // select a provider, grant consent, or supply this resolver. Scope and
        // cancellation are checked again after the asynchronous result.
        if (
          resolveAnswer &&
          !pointed &&
          !social &&
          !ownerBlocked &&
          !adviceKind(transcript)
        ) {
          // Mixed/compound specialist cases stay separate except for the
          // bounded exact-schema contract. Direct clinical questions now use
          // the common resolver after channel history/repair. A split cannot
          // drop one of its caller-owned field requirements.
          const exactSchemaOnly = !!(mixedTurn || secondQ);
          const unified =
            earlyUnified ??
            (await resolveAnswer({
              question: exactSchemaOnly ? transcript : asked,
              originalQuestion: askedRaw,
              exactSchemaOnly,
              bundle,
              caseId,
              call: callTag,
            }));
          if (req.signal.aborted) return new Response(null, { status: 499 });
          if (streaming && !current())
            return Response.json({ error: "Superseded turn" }, { status: 409 });
          if (unified) {
            sharedRendered = true;
            sharedCoverage = unified.wholeQuestion ?? null;
            const lead = unified.lead;
            const evs = lead?.citations ?? [];
            if (
              !lead?.text ||
              evs.some((ev) => {
                try {
                  return !validateEvidence(ev, bundle);
                } catch {
                  return true;
                }
              })
            )
              throw Error("Common answer evidence contract mismatch");
            spoken = isHindi(lang) ? toHindi(lead.text) : lead.text;
            if (bundle.clinical?.length) spoken = thirdPerson(spoken);
            if (earlyUnified) {
              // Never retain a previous turn as this answer's draft source.
              grant.last = unified.raw ?? {
                refused: true,
                unresolved: true,
                evidence: [],
                spoken,
              };
              grant.lastField = lead.field ?? null;
            }
            turn = {
              result: unified.raw ?? null,
              spokenTurn: {
                at: Date.now(),
                intent: lead.intent ?? "SHARED",
                questionPlan: unified.questionPlan ?? null,
                admission: unified.admission ?? null,
                verdict: lead.verdict,
                field: lead.field ?? null,
                spoken,
                citations: evs,
              },
            };
          }
        }
        // Whole-question coverage on the call. A turn rendered by the shared
        // resolver already carries its coverage and disclosure in lead.text.
        // A voice-local renderer has no qualified decomposition (its splits
        // are not qualification), so an asserting answer discloses that
        // whole-question coverage was not verified, in the caller's language,
        // with the same sentence the screen shows.
        // Social replies (thanks, can-you-hear-me, help) assert no answer.
        if (turn?.spokenTurn && spoken && !sharedRendered && !social) {
          const kind = finalAnswer({
            lead: { text: spoken, verdict: turn.spokenTurn.verdict },
          }).kind;
          const coverage = wholeQuestionCoverage({ question: askedRaw }, kind);
          turn.spokenTurn.wholeQuestion = coverage;
          if (coverage.state === "unverified") {
            const notice = coverageNotice(
              lang === "hi" ? "hi" : lang === "hinglish" ? "hinglish" : "en",
            );
            if (!spoken.includes(notice)) spoken = `${spoken.trim()} ${notice}`;
            turn.spokenTurn.spoken = spoken;
          }
        } else if (turn?.spokenTurn && sharedRendered)
          turn.spokenTurn.wholeQuestion = sharedCoverage;
        // Answer first, nothing repeated: a general explanation already spoken
        // earlier in THIS call ("Some general background: ferritin shows...")
        // is not read out again. Facts are never dropped, only these fixed
        // explanation sentences, and the page shows the same words.
        {
          const before = data.messages
            .slice(0, -1)
            .filter((m) => m?.role === "assistant")
            .map((m) => messageText(m.content))
            .join(" ");
          if (before)
            spoken = spoken
              .replace(
                /(?:Some general background|Thodi general jaankari|थोड़ी सामान्य जानकारी): [^.।]+[.।]\s*|Your doctor can read it[^.]+\.\s*|Results just outside a range are common[^.]+\.\s*|आपके डॉक्टर इसे[^।]+।\s*|Aapke doctor ise[^.]+\.\s*/g,
                (m) => (before.includes(m.trim()) ? "" : m),
              )
              .trim();
        }
        // The page may have moved this call to another case while the answer
        // was being built (tab switched mid-turn). An answer for a case that is
        // no longer on screen is not spoken: say what happened instead, with
        // no facts, and tie the turn to the case now open. A round trip back
        // (A -> B -> A) leaves the answer valid for what is on screen.
        if (caseId && resolveBundle) {
          let now2 = null;
          try {
            now2 = resolveBundle?.(data.messages, token) ?? null;
          } catch {
            now2 = null;
          }
          const nowCase = now2?.caseId ?? null;
          // Explicit no-upload demo scope uses the fixed grant's bundle.
          // Unavailable uploaded scopes never take this fallback.
          const currentBundle =
            nowCase === "demo" ? (now2?.bundle ?? grant.bundle) : now2?.bundle;
          const readable =
            currentBundle && !now2.expired && !now2.malformed && !now2.pending;
          const unchanged =
            readable &&
            versionOf(currentBundle) === startingVersion &&
            currentBundle === bundle;
          if (!readable || (nowCase === caseId && !unchanged)) {
            spoken = isHindi(lang)
              ? "आपके दस्तावेज़ बदल गए हैं या अभी उपलब्ध नहीं हैं। कृपया फिर से पूछिए।"
              : "Your documents changed or became unavailable while I was answering. Please ask again.";
            turn = {
              spokenTurn: {
                intent: "SCOPE_CHANGED",
                verdict: "UNKNOWN",
                spoken,
                citations: [],
              },
            };
          } else if (nowCase !== caseId) {
            const label =
              nowCase === "deal"
                ? "the Northstar deal"
                : nowCase === "health"
                  ? "the lab reports"
                  : "your documents";
            spoken = isHindi(lang)
              ? `जवाब देते समय स्क्रीन ${label === "the Northstar deal" ? "Northstar deal" : label === "the lab reports" ? "लैब रिपोर्ट्स" : "आपके दस्तावेज़ों"} पर चली गई, इसलिए वह जवाब मैंने छोड़ दिया। कृपया फिर से पूछिए।`
              : `The page switched to ${label} while I was answering, so I dropped that answer. Please ask again.`;
            turn = {
              spokenTurn: {
                intent: "SCOPE_CHANGED",
                verdict: "UNKNOWN",
                spoken,
                citations: [],
              },
            };
            caseId = nowCase;
          }
        }
        if (grants.get(token) !== grant || grant.expires <= now()) {
          return Response.json(
            { error: "Invalid or expired session capability" },
            { status: 401 },
          );
        }
        if (
          replayKey &&
          !social &&
          turn?.spokenTurn?.intent !== "SCOPE_CHANGED" &&
          ((turn?.result?.evidence?.length ?? 0) > 0 ||
            (turn?.spokenTurn?.citations?.length ?? 0) > 0)
        ) {
          const cache = (grant.recordAnswers ??= new Map());
          cache.delete(replayKey);
          if (Buffer.byteLength(spoken, "utf8") <= 8192)
            cache.set(replayKey, { version: startingVersion, spoken });
          // The shared fixed grant serves many callers; keep separate,
          // bounded entries (at most 128 KiB of spoken UTF-8 per grant),
          // and let grant expiry/revocation release them. Oversized answers
          // are never truncated into a potentially misleading replay.
          while (cache.size > 16) cache.delete(cache.keys().next().value);
        }
        const id = "local-contract-" + randomBytes(8).toString("hex");
        const encoder = new TextEncoder();
        const stream = new ReadableStream({
          start(controller) {
            logTurn({
              transcript,
              heard: askedRaw,
              heardFixes,
              normalized: asked ?? null,
              firstByteAt: Date.now(),
              spoken,
              verdict: turn?.spokenTurn?.verdict ?? null,
              outcome: "answered",
            });
            try {
              onTurn?.(token, {
                question: transcript,
                // what the recogniser heard and how names were understood,
                // so the page can show "heard ... understood as ..."
                heard: heardFixes.length ? askedRaw : null,
                heardFixes,
                // what was actually spoken (both halves, in the caller's
                // language), so the page shows the same words; plus any page
                // action the turn asks for (show the upload panel)
                lead: turn?.spokenTurn
                  ? {
                      ...turn.spokenTurn,
                      spoken,
                      action: social?.action ?? null,
                    }
                  : null,
                result: turn?.result ?? null,
                scope: bundle?.scope ?? null,
                call: callTag,
                caseId,
              });
            } catch {
              /* memory is best-effort; never break the call */
            }
            for (const content of spoken.match(/.{1,64}(?:\s|$)|.{1,64}/g) ||
              []) {
              controller.enqueue(
                encoder.encode(
                  "data: " +
                    JSON.stringify({
                      id,
                      object: "chat.completion.chunk",
                      choices: [
                        { index: 0, delta: { content }, finish_reason: null },
                      ],
                    }) +
                    "\n\n",
                ),
              );
            }
            controller.enqueue(
              encoder.encode(
                "data: " +
                  JSON.stringify({
                    id,
                    object: "chat.completion.chunk",
                    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
                  }) +
                  "\n\ndata: [DONE]\n\n",
              ),
            );
            controller.close();
          },
        });
        grant.turn = turn;
        return new Response(stream, {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-store",
          },
        });
      } catch (turnError) {
        // Evidence-integrity rejections are the fail-closed contract, not
        // a fault: retrieval or evidence that fails its contract is
        // refused, never smoothed over with a fallback line.
        if (
          /contract mismatch|does not match its original/.test(
            turnError?.message ?? "",
          )
        )
          throw turnError;
        if (busyTaken) grant.busy = Math.max(0, (grant.busy ?? 1) - 1);
        if (req.signal.aborted) {
          logTurn({ transcript: askedRaw, outcome: "aborted" });
          return new Response(null, { status: 499 });
        }
        if (grants.get(token) !== grant || grant.expires <= now()) {
          return Response.json(
            { error: "Invalid or expired session capability" },
            { status: 401 },
          );
        }
        // An unexpected engine fault must never cross the vendor boundary
        // as a bare error or a dead turn: the caller hears one fixed line,
        // the page shows the same words, and only the class is logged.
        console.warn("voice turn failed:", turnError?.name ?? "error");
        logTurn({ transcript: askedRaw, outcome: "error" });
        const said = "I hit a problem answering that. Please ask me again.";
        try {
          onTurn?.(token, {
            question: askedRaw,
            lead: {
              intent: "ERROR",
              verdict: "UNKNOWN",
              spoken: said,
              citations: [],
            },
            result: null,
            scope: null,
            call: callTag,
            caseId,
          });
        } catch {
          /* best-effort */
        }
        return sseOnce(said);
      }
    },
    // Voice lab: this grant's recent turns (transcript as received, receipt and
    // first-byte wall-clock times, interruptions). Owner diagnostics only.
    turnLog(token) {
      const g = grants.get(token);
      if (!g || g.expires <= now()) return [];
      return [...(g.turnLog ?? [])];
    },
    setBundleResolver(fn) {
      resolveBundle = typeof fn === "function" ? fn : null;
    },
    setAnswerResolver(fn) {
      resolveAnswer = typeof fn === "function" ? fn : null;
    },
    setOnTurn(fn) {
      onTurn = typeof fn === "function" ? fn : null;
    },
    lastTurn(token) {
      const g = grants.get(token);
      if (!g || g.expires <= now()) return null;
      return g.turn ?? null;
    },
  };
}

function messageText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (part && typeof part.text === "string") return part.text;
      return "";
    })
    .join("");
}

// Bolna's OpenAI client sometimes ends the history with an empty assistant
// stub, and it may send user text as content parts. The question is the
// latest non-empty user message, not strictly messages.at(-1).
function latestUser(messages) {
  let i = messages.length - 1;
  while (i >= 0) {
    const m = messages[i];
    const t = messageText(m?.content).trim();
    if (!t && (m?.role === "assistant" || m?.role === "tool")) {
      i -= 1;
      continue;
    }
    break;
  }
  const m = messages[i];
  if (!m || m.role !== "user") return null;
  const text = messageText(m.content).trim();
  if (!text || text.length > 4000) return null;
  return text;
}

/** One fixed spoken sentence as a complete OpenAI-style SSE stream. */
function sseOnce(content) {
  const id = "local-contract-" + randomBytes(8).toString("hex");
  const chunk = (delta, finish_reason = null) =>
    "data: " +
    JSON.stringify({
      id,
      object: "chat.completion.chunk",
      choices: [{ index: 0, delta, finish_reason }],
    }) +
    "\n\n";
  return new Response(
    chunk({ content }) + chunk({}, "stop") + "data: [DONE]\n\n",
    {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-store",
      },
    },
  );
}

function completionJson(content) {
  return Response.json({
    id: "local-contract-" + randomBytes(8).toString("hex"),
    object: "chat.completion",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content },
        finish_reason: "stop",
      },
    ],
  });
}

async function boundedBody(req, timeoutMs) {
  if (req.signal.aborted) throw Error("Aborted");
  if (!req.body) throw Error("Missing body");
  const reader = req.body.getReader();
  let timer, listener;
  const stopped = new Promise((_, reject) => {
    listener = () => reject(Error("Aborted"));
    req.signal.addEventListener("abort", listener, { once: true });
    timer = setTimeout(() => reject(Error("Body deadline")), timeoutMs);
  });
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let raw = "",
    bytes = 0;
  try {
    while (true) {
      const { done, value } = await Promise.race([reader.read(), stopped]);
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 128 * 1024) throw Error("Body too large");
      raw += decoder.decode(value, { stream: true });
    }
    return raw + decoder.decode();
  } finally {
    clearTimeout(timer);
    req.signal.removeEventListener("abort", listener);
    reader.cancel().catch(() => {});
  }
}
