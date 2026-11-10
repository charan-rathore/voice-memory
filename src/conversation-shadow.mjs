// The shared conversation contract, run beside the existing voice answer
// path ("shadow mode"). It keeps server-owned, bounded state per call and
// records what the contract decided for each Bolna turn, without changing
// what is spoken. This is the cut-over instrument: when the contract and the
// legacy chain agree on the evaluation corpora, the legacy chain is deleted
// and the contract decides (see docs/CONVERSATION-CONTRACT.md, "Cut-over").
//
// The contract reads only the caller's latest utterance and its own state;
// assistant text in the request is never memory.
import {
  resolveConversationTurn,
  commitConversationTurn,
} from "./conversation-turn.mjs";
import { createHash } from "node:crypto";
import { aliasesFor } from "../clinical/explain.mjs";

// Deal fields the spoken engine answers (spoken.mjs ALL_FIELDS), by the words
// callers use for them.
const DEAL_SUBJECTS = [
  {
    id: "deal.fee",
    label: "the fee",
    aliases: ["fee", "fees", "engagement fee", "price", "cost", "फीस", "फ़ीस"],
  },
  {
    id: "deal.paymentSplit",
    label: "the payment split",
    aliases: ["payment split", "payment", "split", "भुगतान"],
  },
  {
    id: "deal.deadline",
    label: "the deadline",
    aliases: ["deadline", "due date", "डेडलाइन"],
  },
  {
    id: "deal.scope",
    label: "the scope",
    aliases: ["scope", "region", "regions"],
  },
  {
    id: "deal.contract",
    label: "the contract",
    aliases: ["contract", "agreement", "अनुबंध"],
  },
  {
    id: "deal.revision",
    label: "the revision",
    aliases: ["revision", "proposal"],
  },
];

const vocabCache = new WeakMap();

/** Subjects the contract can recognise in this bundle: its tests, then the deal fields. */
export function contractVocabulary(bundle) {
  if (!bundle || typeof bundle !== "object") return DEAL_SUBJECTS;
  const hit = vocabCache.get(bundle);
  if (hit) return hit;
  const reports = Array.isArray(bundle.clinical)
    ? bundle.clinical
    : (bundle.clinical?.reports ?? []);
  const byId = new Map();
  for (const r of reports)
    for (const o of r?.observations ?? []) {
      const name = String(o?.test ?? "").trim();
      if (!name) continue;
      const canon = o.canon ?? o.key ?? name.toLowerCase();
      const e = byId.get(canon) ?? {
        id: `lab.${canon}`,
        label: name,
        aliases: new Set(),
      };
      e.aliases.add(name.toLowerCase());
      for (const a of aliasesFor(canon)) e.aliases.add(String(a));
      byId.set(canon, e);
    }
  const vocab = [
    ...[...byId.values()].map((e) => ({
      id: e.id,
      label: e.label,
      aliases: [...e.aliases].filter((a) => a.length >= 2),
    })),
    ...DEAL_SUBJECTS,
  ];
  vocabCache.set(bundle, vocab);
  return vocab;
}

// The record interface, backed by the answer the legacy chain already
// produced for this turn: the contract decides structure, the record engine
// still decides facts. Only the first part receives the legacy answer.
function legacyRecords(vocabulary, legacy) {
  let used = false;
  return {
    vocabulary,
    resolve() {
      if (used || !legacy?.spoken) return { status: "unanswered" };
      used = true;
      const factIds = (legacy.citations ?? [])
        .map(
          (c) =>
            c?.hash ??
            (c?.sourceId != null ? `${c.sourceId}:${c.start}:${c.end}` : null),
        )
        .filter(Boolean);
      if (legacy.verdict === "UNKNOWN" || !factIds.length)
        return {
          status: "unanswered",
          spoken: legacy.spoken,
          verdict: legacy.verdict ?? "UNKNOWN",
        };
      return {
        status: "answered",
        spoken: legacy.spoken,
        verdict: legacy.verdict ?? null,
        factIds,
      };
    },
  };
}

const LEGACY_SOCIAL = new Set([
  "GREET",
  "THANKS",
  "BYE",
  "HEAR",
  "HELP",
  "WHO",
  "SCREEN",
  "UPLOAD",
  "LANGUAGE",
]);

function legacyKind(legacy) {
  const intent = String(legacy?.intent ?? "").toUpperCase();
  if (intent === "REPEAT") return "repeat";
  if (LEGACY_SOCIAL.has(intent)) return "social";
  const cited = (legacy?.citations?.length ?? 0) > 0 || legacy?.evidence > 0;
  return cited && legacy?.verdict !== "UNKNOWN" ? "answered" : "unanswered";
}

function contractKind(turn) {
  if (turn.understanding?.intent === "social") return "social";
  if (turn.outcome === "repeat") return "repeat";
  if (turn.outcome === "answered") return "answered";
  if (turn.outcome === "clarify") return "clarify";
  return "unanswered";
}

/**
 * Bounded shadow state for many calls. `maxCalls` caps how many calls are
 * remembered at once; each call's own state is bounded by the contract.
 */
export function createConversationShadow({ maxCalls = 64 } = {}) {
  const calls = new Map(); // key -> { state, seq } last committed turn
  const staged = new Map(); // key -> { seq, state, turnId } awaiting delivery
  let seqCounter = 0;
  return {
    observe({ key, bundle, version, heard, legacy, mode = "voice" }) {
      if (!key) return null;
      const prior = calls.get(key)?.state ?? null;
      const { turn, state } = resolveConversationTurn(
        {
          utterance: heard,
          // The key may hold a capability token: only its digest leaves here,
          // so turn ids shown on the page can never carry a credential.
          callId: createHash("sha256").update(key).digest("hex").slice(0, 16),
          sourceVersion: version,
          mode,
          records: legacyRecords(contractVocabulary(bundle), legacy),
        },
        prior,
      );
      // A turn becomes memory only through the returned commit(), after
      // the response stream carrying it has been produced. Bolna reports a
      // barge-in as the next request, not as an event, so stream production
      // is the delivery boundary this transport can attest.
      const seq = ++seqCounter;
      staged.delete(key);
      staged.set(key, { seq, state, turnId: turn.turnId });
      while (staged.size > maxCalls) staged.delete(staged.keys().next().value);
      const u = turn.understanding ?? {};
      const decision = {
        legacy: legacyKind(legacy),
        contract: contractKind(turn),
      };
      return {
        turnId: turn.turnId,
        outcome: turn.outcome,
        intent: u.intent ?? null,
        subject: u.subject ?? null,
        dimension: u.dimension ?? null,
        followUp: u.followUp === true,
        referencedTurnId: u.referencedTurnId ?? null,
        // "Heard / Understood as" is shown only when meaning changed
        understoodAs: u.changedMeaning ? (u.understoodAs ?? null) : null,
        needsClarification: u.needsClarification === true,
        wouldSay: turn.answer.spoken,
        decision,
        diverges: decision.legacy !== decision.contract,
        // Delivery acknowledgement, exactly once per observation. A turn
        // superseded by a newer observation, committed twice, or committed
        // after a newer turn of the same call never becomes memory.
        commit({ completed = true } = {}) {
          const s = staged.get(key);
          if (!s || s.seq !== seq) return false;
          staged.delete(key);
          if (seq <= (calls.get(key)?.seq ?? 0)) return false;
          const next = commitConversationTurn(s.state, s.turnId, {
            completed,
          });
          calls.delete(key);
          calls.set(key, { state: next, seq });
          while (calls.size > maxCalls) calls.delete(calls.keys().next().value);
          return true;
        },
      };
    },
    forget(key) {
      if (key) {
        calls.delete(key);
        staged.delete(key);
      }
    },
    size: () => calls.size,
  };
}
