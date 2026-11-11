// HTTP surface for caller memory (memory/caller-memory.mjs).
//
//   POST /api/public/caller/demo-assertion  { persona }    VM_CALLER_DEMO=on only:
//        stands in for a tenant backend and signs a FICTIONAL persona.
//   POST /api/public/caller/start           { assertion, case }
//        verifies the tenant-signed assertion server-side, opens a new call
//        (HttpOnly cookie), and returns what is remembered with every
//        remembered subject re-checked against the documents now.
//   POST /api/public/caller/turn            { utterance }
//        a memory instruction (remember / change / forget / what do you
//        remember) or a question, answered by the canonical resolver.
//   GET  /api/public/caller/memory          everything remembered
//   POST /api/public/caller/forget          { all | preference | conversation | id }
//   POST /api/public/caller/end             ends the call (the next start is a new call)
//
// Every response is `no-store`: personalised answers never reach the CDN
// answer cache. Writes need a same-origin Origin header (the cookie is
// SameSite=Strict too). The page never supplies identity, case history or
// assistant text; the server owns the call.
//
// Each answer comes back in three explicitly separate sections:
//   remembered  what caller memory contributed (preferences, earlier turns)
//   verified    the canonical final answer: kind, verdict, admitted text,
//               exact citations, source scope and version
//   unresolved  what is still open: unanswered parts, open requests, a
//               status the documents do not establish
import { randomBytes } from "node:crypto";
import {
  DEMO_PERSONAS,
  CallerIdentityError,
} from "../memory/caller-identity.mjs";
import {
  readMemoryInstructions,
  subjectOfQuestion,
  CallerMemoryError,
} from "../memory/caller-memory.mjs";
import { toHinglish } from "./vernacular.mjs";
import { toHindi, langOfText } from "./conversation.mjs";
import { coverageNotice } from "./whole-question-coverage.mjs";

const NOTICES = ["en", "hi", "hinglish"].map(coverageNotice);
const CALL_IDLE_MS = 30 * 60000;
const MAX_CALLS = 500;

const LIST =
  /\bwhat do you (remember|know) about me\b|\bkya yaad hai\b|मेरे बारे में क्या याद/i;
const FORGET_ALL =
  /\bforget (everything|all of it|me|all about me)\b|\bsab bhool ja/i;
const FORGET_LANG =
  /\bforget (my )?(language|language preference|preference)\b|\b(language|bhasha) (wali )?(preference )?bhool/i;
const FORGET_CONV =
  /\bforget (this|our|the) (conversation|call|chat)s?\b|\bstop remembering (our|my) (calls|conversations)\b/i;
const CHANGE_LANG =
  /\b(change|switch|set|make)\b.*\blanguage\b.*\bto\s+(english|hindi|hinglish)\b|\b(speak|talk|reply|answer) (to me )?in (english|hindi|hinglish) (from now on|instead)\b/i;

const said = {
  en: {
    pref: (k, v) =>
      `Okay. I'll remember your ${k === "language" ? "language" : "answer length"}: ${label(v)}. You can change or delete it any time.`,
    consent:
      'Okay. I\'ll remember what we discuss on these calls, so next time I can recheck it for you. Say "forget this conversation" to delete it.',
    request:
      "Noted as an open request. I can't promise an action; I'll recheck the documents when you call again.",
    sensitive:
      "I don't keep health or medical details as a preference, so I haven't saved that.",
    notPref:
      "I can remember preferences like language or answer length. What the documents say is decided by the documents, so I haven't saved that.",
    forgotAll: "Done. I've deleted everything I remembered about you.",
    forgotLang: "Done. I've deleted your language preference.",
    forgotConv:
      "Done. I've deleted our earlier conversations and stopped remembering them.",
    nothing: "I don't have anything remembered for you yet.",
  },
};
const label = (v) =>
  ({
    en: "English",
    hi: "Hindi",
    hinglish: "Hinglish",
    short: "short",
    detailed: "detailed",
  })[v] ?? v;

const stripNotice = (t) => {
  let s = String(t ?? "").trim();
  for (const n of NOTICES)
    if (s.endsWith(n) && s !== n) s = s.slice(0, -n.length).trim();
  return s;
};
// Presentation only: deterministic templates (vernacular.mjs) that quote the
// record verbatim when a sentence has no template. Never a free translation.
const present = (text, lang) => {
  if (!text || !lang || lang === "en" || langOfText(text) !== "en") return text;
  return lang === "hinglish"
    ? toHinglish(text)
    : lang === "hi"
      ? toHindi(text)
      : text;
};

/**
 * @param {{
 *   identity: ReturnType<import("../memory/caller-identity.mjs").createCallerIdentity>,
 *   memory: ReturnType<import("../memory/caller-memory.mjs").createCallerMemory>,
 *   answer: (a:{caseId:string, question:string}) => Promise<{final:any, corpus:{version:string}|null, wholeQuestion?:any}>,
 *   cases: string[],
 *   demo?: { kid: string } | null,
 *   now?: () => number,
 *   secure?: boolean,
 *   allowedOrigins?: (req:any) => string[],
 * }} deps
 */
export function createCallerApi({
  identity,
  memory,
  answer,
  cases,
  demo = null,
  now = Date.now,
  secure = false,
  allowedOrigins,
}) {
  const calls = new Map(); // cookie id -> { binding, callId, caseId, at, noticeSaid }
  const send = (res, status, body, extra = {}) => {
    res.writeHead(status, {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      ...extra,
    });
    res.end(JSON.stringify(body));
  };
  const readJson = async (req) => {
    const chunks = [];
    let n = 0;
    for await (const c of req) {
      n += c.length;
      if (n > 8 * 1024)
        throw Object.assign(Error("Request too large."), { status: 413 });
      chunks.push(c);
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    } catch {
      throw Object.assign(Error("Send JSON."), { status: 400 });
    }
  };
  const cookieOf = (req) =>
    (req.headers.cookie || "")
      .split(/;\s*/)
      .find((c) => c.startsWith("vm_call="))
      ?.slice(8) ?? null;
  const sweep = () => {
    const t = now();
    for (const [k, v] of calls) if (t - v.at > CALL_IDLE_MS) calls.delete(k);
    while (calls.size > MAX_CALLS) calls.delete(calls.keys().next().value);
  };
  const callOf = (req) => {
    sweep();
    const c = calls.get(cookieOf(req) ?? "");
    if (c) c.at = now();
    return c ?? null;
  };
  const sameOrigin = (req) => {
    const o = req.headers.origin;
    if (!o) return false;
    const ok = allowedOrigins?.(req) ?? [
      `http://${req.headers.host}`,
      `https://${req.headers.host}`,
    ];
    return ok.includes(o);
  };

  // One answered question, in the three sections.
  async function answerTurn(call, question) {
    const pres = memory.presentation(call.binding);
    const got = await answer({ caseId: call.caseId, question });
    const final = got?.final ?? null;
    const asserting = typeof final?.admittedText === "string";
    const coverage = (got?.wholeQuestion ?? final?.coverage)?.state ?? null;
    const base = asserting
      ? stripNotice(final.admittedText)
      : (final?.text ?? "These documents don't establish that.");
    let say = present(base, pres.lang);
    if (coverage === "unverified" && !call.noticeSaid) {
      const l = /[ऀ-ॿ]/.test(say)
        ? "hi"
        : pres.lang === "hinglish"
          ? "hinglish"
          : pres.lang === "hi"
            ? "hi"
            : "en";
      say = `${say} ${coverageNotice(l)}`;
      call.noticeSaid = true;
    }
    const kept = memory.recordEpisode(call.binding, {
      callId: call.callId,
      caseId: call.caseId,
      question,
      final,
      corpus: got?.corpus ?? null,
    });
    const remembered = [];
    if (pres.lang && pres.lang !== "en")
      remembered.push({
        kind: "preference",
        label: "Language",
        detail: `${label(pres.lang)} (you asked me to remember this)`,
      });
    if (pres.answerLength)
      remembered.push({
        kind: "preference",
        label: "Answer length",
        detail: label(pres.answerLength),
      });
    const unresolved = [];
    if (final?.kind && !["answered", "social"].includes(final.kind))
      unresolved.push({
        kind: "answer",
        label: "Not established",
        detail: stripNotice(final.text),
      });
    for (const u of final?.unresolvedRequirements ?? [])
      unresolved.push({
        kind: "requirement",
        label: "Part not established",
        detail: u.text ?? null,
      });
    if (coverage === "unverified")
      unresolved.push({
        kind: "coverage",
        label: "Coverage",
        detail: "Not checked that this covers every part of the question.",
      });
    const subj = subjectOfQuestion(question)?.id ?? null;
    for (const q of memory.list(call.binding).requests)
      if (
        q.status === "open" &&
        q.caseId === call.caseId &&
        (!subj || !q.subjectId || q.subjectId === subj)
      )
        unresolved.push({
          kind: "request",
          label: "Your open request",
          detail: q.text,
        });
    if (
      /^(PROPOSED|OPEN|PENDING|REQUESTED|DISCUSSED)$/.test(final?.verdict ?? "")
    )
      unresolved.push({
        kind: "status",
        label: "Status",
        detail: `On record as ${String(final.verdict).toLowerCase()}, not approved.`,
      });
    return {
      kind: "answer",
      say,
      sections: {
        remembered,
        verified: final
          ? {
              kind: final.kind,
              verdict: final.verdict ?? null,
              text: asserting ? stripNotice(final.admittedText) : null,
              citations: final.citations ?? [],
              scope: {
                key: call.caseId,
                version: got?.corpus?.version ?? null,
              },
            }
          : null,
        unresolved,
      },
      memory: {
        episodeKept: kept.kept,
        reason: kept.kept ? null : kept.reason,
      },
    };
  }

  // Start of a call: remembered state and every remembered subject rechecked.
  async function greeting(call) {
    const rec = await memory.recall(call.binding, {
      caseId: call.caseId,
      answer: async ({ caseId, question }) => answer({ caseId, question }),
    });
    const lang = rec.preferences.language?.value ?? null;
    const rechecked = rec.rechecked.map((x) => {
      const f = x.now?.final ?? null;
      const asserting = typeof f?.admittedText === "string";
      const nowText = asserting
        ? stripNotice(f.admittedText)
        : (f?.text ?? null);
      return {
        label: x.label,
        previously: x.previously,
        sourceChanged: x.sourceChanged,
        statusChanged: x.statusChanged,
        say: present(nowText, lang),
        verified: f
          ? {
              kind: f.kind,
              verdict: f.verdict ?? null,
              text: nowText,
              citations: f.citations ?? [],
              scope: {
                key: call.caseId,
                version: x.now?.corpus?.version ?? null,
              },
            }
          : null,
      };
    });
    const first = rechecked[0];
    const known =
      Object.keys(rec.preferences).length > 0 ||
      rechecked.length > 0 ||
      rec.openRequests.length > 0;
    const intro = !known
      ? "You're verified. I don't have anything remembered for you yet."
      : {
          en: first
            ? `Welcome back. Last time you asked about ${first.label}. ${first.sourceChanged ? "The documents have changed since then." : "The documents haven't changed since then."}`
            : "Welcome back.",
          hinglish: first
            ? `Welcome back. Pichli baar aapne ${first.label.replace(/^the /, "")} ke baare mein poocha tha. ${first.sourceChanged ? "Tab se documents badle hain." : "Tab se documents nahi badle."}`
            : "Welcome back.",
          hi: first
            ? `फिर से स्वागत है। पिछली बार आपने ${first.label.replace(/^the /, "")} के बारे में पूछा था। ${first.sourceChanged ? "तब से दस्तावेज़ बदले हैं।" : "तब से दस्तावेज़ नहीं बदले।"}`
            : "फिर से स्वागत है।",
        }[lang ?? "en"];
    const pending = rec.openRequests.length
      ? `You also asked me to follow up: "${rec.openRequests.at(-1).text}". That is still open.`
      : null;
    return {
      say: [intro, first?.say, pending].filter(Boolean).join(" "),
      preferences: rec.preferences,
      consent: rec.consent,
      rechecked,
      openRequests: rec.openRequests,
      durable: rec.durable,
    };
  }

  function memoryTurn(call, utterance) {
    const b = call.binding;
    const lang = memory.presentation(b).lang ?? "en";
    const t = said.en; // memory confirmations are short and fixed; English copy only in this slice
    if (LIST.test(utterance)) {
      const m = memory.list(b);
      const any =
        Object.keys(m.preferences).length ||
        m.referents.length ||
        m.requests.length;
      return {
        kind: "memory",
        op: "list",
        say: any ? "Here is everything I remember about you." : t.nothing,
        memory: m,
      };
    }
    if (FORGET_ALL.test(utterance)) {
      memory.forget(b, { all: true });
      return {
        kind: "memory",
        op: "forget_all",
        say: t.forgotAll,
        memory: memory.list(b),
      };
    }
    if (FORGET_CONV.test(utterance)) {
      memory.forget(b, { conversation: true });
      return {
        kind: "memory",
        op: "forget_conversation",
        say: t.forgotConv,
        memory: memory.list(b),
      };
    }
    if (FORGET_LANG.test(utterance)) {
      memory.forget(b, { preference: "language" });
      return {
        kind: "memory",
        op: "forget_preference",
        say: t.forgotLang,
        memory: memory.list(b),
      };
    }
    const change = CHANGE_LANG.exec(utterance);
    if (change) {
      const v = { english: "en", hindi: "hi", hinglish: "hinglish" }[
        (change[2] ?? change[4]).toLowerCase()
      ];
      memory.rememberPreference(b, {
        key: "language",
        value: v,
        callId: call.callId,
      });
      return {
        kind: "memory",
        op: "correct",
        say: t.pref("language", v),
        memory: memory.list(b),
      };
    }
    const ins = readMemoryInstructions(utterance);
    if (!ins.length) return null;
    const lines = [];
    let op = "remember";
    for (const i of ins) {
      if (i.type === "preference") {
        memory.rememberPreference(b, {
          key: i.key,
          value: i.value,
          callId: call.callId,
        });
        lines.push(t.pref(i.key, i.value));
      } else if (i.type === "conversation_consent") {
        memory.consentToConversation(b, { callId: call.callId });
        lines.push(t.consent);
      } else if (i.type === "follow_up_request") {
        const r = memory.recordRequest(b, {
          callId: call.callId,
          caseId: call.caseId,
          text: i.text,
        });
        lines.push(
          r.kept
            ? t.request
            : "I can only keep follow-up requests if you ask me to remember our conversations.",
        );
      } else if (i.type === "refused") {
        op = "refused";
        lines.push(i.reason === "sensitive" ? t.sensitive : t.notPref);
      }
    }
    void lang;
    return { kind: "memory", op, say: lines.join(" "), memory: memory.list(b) };
  }

  return async function handle(req, res, path) {
    try {
      if (path === "/caller/demo-assertion" && req.method === "POST") {
        if (!demo) return (send(res, 404, { error: "Not found." }), true);
        if (!sameOrigin(req))
          return (
            send(res, 403, { error: "Same-origin requests only." }),
            true
          );
        const { persona } = await readJson(req);
        const p = Object.hasOwn(DEMO_PERSONAS, persona)
          ? DEMO_PERSONAS[persona]
          : null;
        if (!p)
          return (send(res, 400, { error: "Pick a fictional caller." }), true);
        const assertion = identity.issue({
          kid: demo.kid,
          tenant: p.tenant,
          sub: p.sub,
          name: p.name,
          amr: "demo-fictional",
          ttlS: 120,
        });
        return (send(res, 200, { assertion, fictional: true }), true);
      }
      if (path === "/caller/start" && req.method === "POST") {
        if (!sameOrigin(req))
          return (
            send(res, 403, { error: "Same-origin requests only." }),
            true
          );
        const data = await readJson(req);
        if (!cases.includes(data.case))
          return (send(res, 400, { error: "Pick a case." }), true);
        let binding;
        try {
          binding = identity.verify(data.assertion);
        } catch (e) {
          if (e instanceof CallerIdentityError)
            return (
              send(res, 401, { error: "Caller not verified.", code: e.code }),
              true
            );
          throw e;
        }
        sweep();
        const old = cookieOf(req);
        if (old) calls.delete(old); // a new start is a new call
        const id = randomBytes(24).toString("hex");
        const call = {
          binding,
          callId: "call_" + randomBytes(8).toString("hex"),
          caseId: data.case,
          at: now(),
          noticeSaid: false,
        };
        calls.set(id, call);
        const welcome = await greeting(call);
        return (
          send(
            res,
            200,
            {
              caller: {
                displayName: binding.displayName,
                method: binding.method,
                verifiedAt: binding.verifiedAt,
              },
              callId: call.callId,
              ...welcome,
            },
            {
              "Set-Cookie": `vm_call=${id}; HttpOnly; SameSite=Strict; Path=/api/public/caller${secure ? "; Secure" : ""}`,
            },
          ),
          true
        );
      }
      if (!path.startsWith("/caller/")) return false;
      if (req.method !== "GET" && !sameOrigin(req))
        return (send(res, 403, { error: "Same-origin requests only." }), true);
      const call = callOf(req);
      if (!call)
        return (
          send(res, 401, { error: "Start a verified call first." }),
          true
        );
      if (path === "/caller/memory" && req.method === "GET")
        return (send(res, 200, { memory: memory.list(call.binding) }), true);
      if (path === "/caller/forget" && req.method === "POST") {
        const d = await readJson(req);
        const what =
          d.all === true
            ? { all: true }
            : d.conversation === true
              ? { conversation: true }
              : typeof d.preference === "string"
                ? { preference: d.preference }
                : typeof d.id === "string"
                  ? { id: d.id }
                  : null;
        if (!what)
          return (send(res, 400, { error: "Say what to forget." }), true);
        const r = memory.forget(call.binding, what);
        return (
          send(res, 200, { ...r, memory: memory.list(call.binding) }),
          true
        );
      }
      if (path === "/caller/end" && req.method === "POST") {
        calls.delete(cookieOf(req));
        return (
          send(
            res,
            200,
            { ended: true },
            {
              "Set-Cookie": `vm_call=; Max-Age=0; HttpOnly; SameSite=Strict; Path=/api/public/caller${secure ? "; Secure" : ""}`,
            },
          ),
          true
        );
      }
      if (path === "/caller/turn" && req.method === "POST") {
        const { utterance } = await readJson(req);
        const u = typeof utterance === "string" ? utterance.trim() : "";
        if (!u || u.length > 400)
          return (
            send(res, 400, { error: "Say something of up to 400 characters." }),
            true
          );
        const mem = memoryTurn(call, u);
        if (mem) return (send(res, 200, mem), true);
        return (send(res, 200, await answerTurn(call, u)), true);
      }
      return (send(res, 404, { error: "Not found." }), true);
    } catch (e) {
      if (e instanceof CallerMemoryError)
        return (send(res, e.code === "unavailable" ? 503 : 400, { error: e.message, code: e.code }), true);
      send(res, e?.status && e.status < 500 ? e.status : 500, { error: e?.status ? e.message : "Something went wrong." });
      return true;
    }
  };
}
