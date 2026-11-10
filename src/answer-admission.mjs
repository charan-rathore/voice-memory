// Shared provider-free admission contract. Candidate producers and renderers
// cannot certify themselves. This module does not parse natural language.
import { validateRequirementOutcomes } from "./question-plan.mjs";
const freeze = (x) => {
  if (x && typeof x === "object") {
    Object.values(x).forEach(freeze);
    Object.freeze(x);
  }
  return x;
};
const unresolved = (plan, reason, outcomes = []) =>
  freeze({
    questionPlanKey: plan.key,
    sourceGeneration: plan.sourceGeneration,
    status: reason === "interpretation_unresolved" ? "clarify" : "unresolved",
    userReady: false,
    reason,
    outcomes,
  });

export async function admitAnswer({
  plan,
  draft,
  bundle,
  verifyEvidence,
  verifyDeterministic,
}) {
  if (!plan?.key || !Array.isArray(plan.requirements))
    throw Error("A caller-owned question plan is required.");
  if (
    plan.sourceGeneration === null ||
    plan.sourceGeneration === undefined ||
    draft?.questionPlanKey !== plan.key ||
    draft?.sourceGeneration !== plan.sourceGeneration
  )
    return unresolved(plan, "stale_or_wrong_request");
  try {
    validateRequirementOutcomes(draft.outcomes, plan);
  } catch {
    return unresolved(plan, "invalid_requirement_coverage");
  }
  // Lossless preservation and outcome cardinality do not prove that an
  // opaque compound request was decomposed or answered completely.
  if (
    plan.coverageEstablished !== true ||
    plan.semanticQualification === "unresolved"
  )
    return unresolved(plan, "interpretation_unresolved");
  const outcomes = [];
  for (const item of draft.outcomes) {
    const requirement = plan.requirements.find(
      (r) => r.id === item.requirementId,
    );
    if (item.status !== "answered") {
      // A producer's uncertain outcome is not proof of source absence.
      outcomes.push({
        requirementId: requirement.id,
        status: item.status,
        claims: [],
        reason: "producer_uncertainty",
      });
      continue;
    }
    const claims = [];
    for (const proposed of item.claims) {
      // Clone before each check so a callback cannot alter a previously
      // inspected candidate. These callbacks are server-owned, never fields
      // in a provider result or request body.
      const claim = freeze(structuredClone(proposed));
      let evidence, certificate;
      try {
        evidence = await verifyEvidence?.({ plan, requirement, claim, bundle });
        if (evidence?.ok === true)
          certificate = await verifyDeterministic?.({
            plan,
            requirement,
            claim,
            bundle,
          });
      } catch {
        certificate = null;
      }
      if (
        evidence?.ok !== true ||
        certificate?.ok !== true ||
        certificate.requirementId !== requirement.id ||
        certificate.questionPlanKey !== plan.key ||
        certificate.sourceGeneration !== plan.sourceGeneration
      )
        continue;
      claims.push({
        ...claim,
        admission: "deterministic_verified",
        certificate: structuredClone(certificate),
      });
    }
    // A partial claim set cannot dress itself as the complete requirement.
    const complete = claims.length === item.claims.length && claims.length > 0;
    outcomes.push({
      requirementId: requirement.id,
      status: complete ? "answered" : "not_established",
      claims: complete ? claims : [],
      reason: complete ? null : "claim_not_admitted",
    });
  }
  const count = outcomes.filter((x) => x.status === "answered").length;
  return freeze({
    questionPlanKey: plan.key,
    sourceGeneration: plan.sourceGeneration,
    status:
      count === outcomes.length
        ? "answered"
        : count
          ? "partial"
          : outcomes.some((x) => x.status === "clarify")
            ? "clarify"
            : "unresolved",
    userReady: count > 0,
    complete: count === outcomes.length,
    outcomes,
    limitations: [
      "Deterministic certificates prove only their defined source-backed operations. General semantic interpretation is not qualified by this contract.",
    ],
  });
}

// ------------------------------------------------------------ request admission
// The final check that an admitted answer addresses the request that was
// made (question-plan.mjs `request`). It runs once, at the canonical answer
// boundary, for typed and spoken requests alike, and it only ever:
//   - replaces a lead that does not state the requested relationship with
//     a verbatim source sentence that does (exact span, cited);
//   - demotes a lead that shares words with the question but does not
//     establish the claim to "related evidence", with an explicit statement
//     of what is not established;
//   - removes a bare Yes/No in front of an answer to a negated question.
// It never writes a fact: every sentence it admits is a literal source span.
import { rankUnitsLexical, replacedSource } from "./paraphrase.mjs";
import { cite, docLabelOf } from "./spoken-routes.mjs";
import {
  relationSupport,
  assertedAgent,
  mentionsRelation,
  deniesRelation,
} from "./semantic/verify.mjs";
import { RELATIONS } from "./semantic/intent.mjs";
import { finalAnswer } from "./answer-contract.mjs";

// Outcomes of a certified source operation are not second-guessed here.
const CERTIFIED_ORIGIN = new Set([
  "source-field-certificate",
  "source-event-certificate",
  "explicit-owner-test-matrix",
]);
const CANDIDATE_LIMIT = 24;
const sameParty = (a, b) => {
  const n = (x) =>
    String(x ?? "")
      .toLowerCase()
      .replace(/^the\s+/, "")
      .replace(/[^a-z0-9 ]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  const x = n(a),
    y = n(b);
  return !!x && !!y && (x === y || x.includes(y) || y.includes(x));
};
const upperFirst = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

/** Source sentences that could state the relation: existing BM25 units. */
function relationCandidates(plan, bundle, lead) {
  const r = plan.request.relation;
  const forms = RELATIONS[r.family];
  const probe = `${plan.originalQuestion} ${r.object} ${forms.verb
    .replace(/[^a-z| ]/gi, "")
    .split("|")
    .join(" ")} ${forms.participle
    .replace(/[^a-z| ]/gi, "")
    .split("|")
    .join(" ")}`;
  const ranked = rankUnitsLexical(probe, bundle)
    .filter((x) => x.lexical > 0)
    .slice(0, CANDIDATE_LIMIT)
    .map((x) => x.unit);
  // sentences the current lead already cites are candidates too
  const cited = new Set(
    (lead?.citations ?? []).map((c) => `${c.sourceId}:${c.start}`),
  );
  const seen = new Set();
  return ranked
    .filter((u) => !replacedSource(bundle, u.src))
    .filter((u) => {
      const k = `${u.src.id}:${u.sent.start}`;
      return seen.has(k) ? false : seen.add(k);
    })
    .map((u) => ({
      unit: u,
      text: u.sent.text,
      context: u.text.slice(0, Math.max(0, u.text.length - u.sent.text.length)),
      cited: cited.has(`${u.src.id}:${u.sent.start}`),
    }));
}

const WITHDRAWN =
  /\b(?:withdrawn|withdrew|rescinded|revoked|cancell?ed|voided|void|reversed|retracted|no longer|superseded|set aside|overturned)\b/i;
const sentencesIn = (text) =>
  String(text ?? "")
    .split(/(?<=[.!?])\s+|\n+/)
    .map((x) => x.trim())
    .filter(Boolean);
/** Sentences that deny, withdraw or leave pending the asked relation. */
function takenBack(relation, bundle) {
  const forms = RELATIONS[relation.family];
  const anaphor = new RegExp(
    `\\b(?:that|this|the|its|their)\\s+(?:${forms.event}|${forms.noun}\\w*)\\b`,
    "i",
  );
  const term = (t) =>
    new RegExp(
      `(?<![a-z0-9])${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:e?s)?(?![a-z0-9])`,
      "i",
    );
  const out = [];
  for (const src of bundle.sources ?? []) {
    if (replacedSource(bundle, src)) continue;
    for (const sentence of sentencesIn(src.text)) {
      const aboutObject =
        relation.terms.some((t) => term(t).test(sentence)) ||
        anaphor.test(sentence);
      if (!aboutObject) continue;
      const denies = deniesRelation(relation.family, sentence);
      const withdraws =
        WITHDRAWN.test(sentence) && mentionsRelation(relation.family, sentence);
      if (denies || withdraws) out.push({ sourceId: src.id, sentence });
      if (out.length >= 4) return out;
    }
  }
  return out;
}

const notStated = (plan) => {
  const r = plan.request.relation;
  const q = plan.originalQuestion.trim().replace(/[?.!]+$/, "");
  if (r.ask === "actor" && /^who\s/i.test(q))
    return `These documents don't state ${q[0].toLowerCase()}${q.slice(1)}.`;
  return "These documents don't establish that relationship.";
};

/**
 * Admit, repair or demote one resolved answer against its plan.
 * Mutates and returns `shown`; attaches `shown.requestAdmission`.
 * @param {{plan: object, shown: {lead?: any, evidence?: any[]}, bundle: object,
 *   decorate?: (evidence: object[]) => object[]}} a
 *   `decorate` maps raw exact-span citations to the caller's public form.
 */
export function admitRequest({ plan, shown, bundle, decorate = (e) => e }) {
  const req = plan?.request ?? null;
  if (!req || !shown || (plan.requirements?.length ?? 0) !== 1) return shown;
  const requirement = plan.requirements[0];
  const note = (outcome, reason, extra = {}) => {
    // Outcome and reason only. The requirement's id and wording belong to
    // the caller-owned plan (`shown.questionPlan`), where the answer
    // contract reads them, so the same answer reached by two wordings is
    // the same recorded admission.
    shown.requestAdmission = { requirements: [{ outcome, reason }], ...extra };
    return shown;
  };
  const kind = finalAnswer(shown).kind;
  const lead = shown.lead ?? null;
  const asserting = ["answered", "partial", "quoted"].includes(kind);

  // ---- a negated question is never met with a bare Yes/No
  if (req.negated && asserting && lead?.text) {
    const m = /^(?:Yes|No)[.,]\s+(?=\S)/.exec(lead.text);
    if (m) {
      lead.text = upperFirst(lead.text.slice(m[0].length));
      lead.polarityPrefixRemoved = true;
    }
  }

  // ---- a requested relationship must be stated by the record
  const r = req.relation;
  if (!r || !bundle?.sources?.length) return shown;
  if (["clarify", "refused", "social"].includes(kind)) return shown;
  if (asserting && CERTIFIED_ORIGIN.has(lead?.origin)) return shown;

  let candidates = [];
  try {
    candidates = relationCandidates(plan, bundle, lead);
  } catch {
    candidates = [];
  }
  const found = relationSupport(r, candidates);
  const related = found.related;
  // A statement is not support if the documents take it back. Any other
  // sentence, in any current source, that denies, withdraws or leaves
  // pending the same relation about the same object ("That approval was
  // withdrawn", "the scope is not approved") voids it: the question is then
  // not established, and both sentences are offered as related evidence.
  let contested = [];
  try {
    contested = found.supported.length ? takenBack(r, bundle) : [];
  } catch {
    contested = [{}]; // could not check: do not admit
  }
  const supported = contested.length ? [] : found.supported;
  if (contested.length)
    for (const s of found.supported)
      if (!related.includes(s.index)) related.push(s.index);

  // A certified operation (an event or field admission) already recorded a
  // finding for this request. Its abstention protects against reading a
  // role field or a different party as the asked event, so it is replaced
  // only by a sentence that asserts exactly what was asked: for "did A do
  // X?" that means a sentence naming A. Anything less leaves it untouched.
  const certified = !!shown.admission;
  const namesAsked =
    r.ask !== "polar" || supported.some((s) => sameParty(s.agent, r.actor));
  if (certified && !(supported.length && namesAsked))
    return note(
      "unsupported",
      "relation_not_established_by_certified_operation",
    );

  if (supported.length) {
    // one statement per distinct agent, in retrieval order; never a pick
    const byAgent = [];
    for (const s of supported)
      if (!byAgent.some((x) => sameParty(x.agent, s.agent))) byAgent.push(s);
    const kept = byAgent.slice(0, 3);
    // the current lead already cites exactly this statement and names the
    // agent: it stands as it is
    if (
      asserting &&
      kept.length === 1 &&
      candidates[kept[0].index].cited &&
      lead.text.includes(kept[0].agent)
    )
      return note("supported", "relation_stated_by_cited_span");
    const citations = [];
    const lines = [];
    for (const s of kept) {
      const { unit } = candidates[s.index];
      let c;
      try {
        c = cite(unit.src, unit.sent);
      } catch {
        continue;
      }
      citations.push(c);
      lines.push(
        `${unit.sent.text.replace(/\s+/g, " ")} That's from ${docLabelOf(unit.src)}.`,
      );
    }
    if (lines.length) {
      const asked = r.ask === "polar" ? r.actor : null;
      const match = asked && kept.some((s) => sameParty(s.agent, asked));
      const prefix =
        r.ask !== "polar" || lines.length > 1
          ? ""
          : match
            ? r.negated || req.negated
              ? ""
              : "Yes. "
            : `The record I can verify names ${kept[0].agent}: `;
      const previous = asserting ? (lead?.citations ?? []) : [];
      shown.lead = {
        text: prefix + lines.join(" "),
        verdict: "QUOTED",
        field: null,
        citations: decorate(citations),
        intent: "RELATION",
        origin: "relation-statement",
      };
      // what the replaced lead cited is related context, never the answer
      shown.relatedEvidence = previous.slice(0, 6);
      shown.visual = null;
      // A quoted sentence establishes what it says, not that the whole
      // request is covered: conditions stated elsewhere in the document
      // are not read here, so coverage stays "unverified" and is disclosed.
      delete shown.requirementCoverage;
      return note("supported", "relation_stated_by_source_sentence", {
        relation: { family: r.family, agents: kept.map((s) => s.agent) },
      });
    }
  }

  const relatedCites = related
    .slice(0, 4)
    .map((i) => {
      try {
        return cite(candidates[i].unit.src, candidates[i].unit.sent);
      } catch {
        return null;
      }
    })
    .filter(Boolean);

  if (asserting && lead?.text) {
    // Judged on the answer's own statement, not on everything it cites: a
    // superseded proposal that was "not yet approved" does not deny an
    // approval the current record states.
    const said = lead.text;
    // "not approved", "no signed agreement exists": the record denies the
    // event, so there is no party to name, and the lead says why.
    if (deniesRelation(r.family, said)) {
      const role = RELATIONS[r.family].role.split("|")[0];
      const tail = `No ${RELATIONS[r.family].event} is recorded, so there is no ${role} to name.`;
      // "Who signed it?" is not a yes/no question
      if (r.ask === "actor")
        lead.text = upperFirst(
          lead.text.replace(/^(?:Yes|No)[.,]\s+(?=\S)/, ""),
        );
      if (!lead.text.includes(tail)) lead.text = `${lead.text.trim()} ${tail}`;
      return note("unsupported", "relation_denied_by_record");
    }
    // The lead itself reports the event's status ("$16,200 is approved")
    // but no source names the party: keep that fact, and say plainly which
    // part of the request is not established.
    if (
      !contested.length &&
      mentionsRelation(r.family, lead.text) &&
      !assertedAgent(r.family, lead.text)
    ) {
      const role = RELATIONS[r.family].role.split("|")[0];
      const tail = `These documents don't name the ${role}.`;
      if (r.ask === "actor")
        lead.text = upperFirst(
          lead.text.replace(/^(?:Yes|No)[.,]\s+(?=\S)/, ""),
        );
      if (!lead.text.includes(tail)) lead.text = `${lead.text.trim()} ${tail}`;
      lead.verdict = "PARTIAL_DOCUMENT";
      shown.relatedEvidence = decorate(relatedCites);
      shown.requirementCoverage = {
        questionPlanKey: plan.key,
        source: "certified-operation",
        scope: "relation-statement-with-bound-object",
        complete: false,
        status: "partial",
        semanticAdmissionVerified: false,
        outcomes: [
          {
            requirementId: requirement.id,
            text: requirement.text,
            status: "not_established",
          },
        ],
      };
      return note("unsupported", "relation_party_not_named");
    }
    // it shares words with the question but never states the relationship
    shown.evidence = [
      ...decorate(relatedCites),
      ...(lead.citations ?? []),
    ].slice(0, 6);
    shown.lead = {
      text: contested.length
        ? "The documents state this and then take it back, so it is not established."
        : notStated(plan),
      verdict: "UNKNOWN",
      field: null,
      citations: [],
      intent: "RELATION",
      origin: "relation-not-stated",
    };
    shown.visual = null;
    delete shown.requirementCoverage;
    return note(
      "unsupported",
      contested.length ? "relation_taken_back" : "relation_not_stated",
    );
  }

  // already an abstention: say what is not established, plainly
  if (kind === "abstained") {
    shown.lead = {
      text: notStated(plan),
      verdict: "UNKNOWN",
      field: null,
      citations: [],
      intent: "RELATION",
      origin: "relation-not-stated",
    };
    if (relatedCites.length)
      shown.evidence = [
        ...decorate(relatedCites),
        ...(shown.evidence ?? []),
      ].slice(0, 6);
    return note("unsupported", "relation_not_stated");
  }
  return shown;
}
