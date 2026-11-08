// Bounded event assertion language, not an arbitrary-document entailment model.
// Questions are consumed completely before retrieval. Actor, action, object,
// recipient, amount and polarity are never supplied by a candidate producer.
import { createHash } from "node:crypto";
import { admitAnswer } from "./answer-admission.mjs";
const digest = (x) =>
  createHash("sha256").update(JSON.stringify(x)).digest("hex");
const freeze = (x) => {
  if (x && typeof x === "object") {
    Object.values(x).forEach(freeze);
    Object.freeze(x);
  }
  return x;
};
const entity = "[A-Z][a-zA-Z0-9-]*(?: [A-Z][a-zA-Z0-9-]*){0,3}?";
const money = "\\$[0-9]+(?:,[0-9]{3})*(?:\\.[0-9]{2})?";
const object = "(?:the )?[a-z][a-z -]{0,79}";
const eventPattern = (question) =>
  new RegExp(
    question
      ? `^Did (${entity}) (not )?(?:(pay) (${money}) to (${entity})|(approve|sign) (${object}))$`
      : `^(${entity}) (?:(did not) (pay|approve|sign) |(paid|approved|signed) )(.+)\\.$`,
    "i",
  );
const canon = (actor, action, target, polarity) => {
  const pronoun =
    /^(?:I|You|He|She|It|We|They|Me|Him|Her|Us|Them|Mine|Yours|His|Hers|Ours|Theirs|This|That|Someone|Anyone|Nobody|Everybody)$/i;
  // Case-insensitive auxiliaries must not turn an adverb or polarity word
  // into part of the actor. Entity labels retain their explicit name syntax.
  const named = new RegExp(`^${entity}$`);
  if (pronoun.test(actor) || !named.test(actor)) return null;
  if (
    /\b(and|or|if|unless|before|after|when|not|no|without|subject|pending|proposed|draft|former|current|latest|yesterday|today|tomorrow|previously|originally|recently|already|still)\b/i.test(
      actor + " " + target,
    )
  )
    return null;
  if (action === "pay") {
    const m = new RegExp(`^(${money}) to (${entity})$`).exec(target);
    return m && !pronoun.test(m[2]) && named.test(m[2])
      ? {
          actor,
          action,
          object: "payment",
          amount: m[1],
          recipient: m[2],
          polarity,
        }
      : null;
  }
  if (!new RegExp(`^${object}$`).test(target)) return null;
  return {
    actor,
    action,
    object: target,
    amount: null,
    recipient: null,
    polarity,
  };
};
const actionOf = (participle) =>
  ({ paid: "pay", approved: "approve", signed: "sign" })[
    participle.toLowerCase()
  ];
function parseQuestionPart(s) {
  const direct = eventPattern(true).exec(s);
  if (direct)
    return canon(
      direct[1],
      (direct[3] || direct[6]).toLowerCase(),
      direct[3] ? `${direct[4]} to ${direct[5]}` : direct[7],
      direct[2] ? "negative" : "positive",
    );
  const perfect = new RegExp(
    `^Has (${entity}) (not )?(?:(paid) (${money}) to (${entity})|(approved|signed) (${object}))$`,
    "i",
  ).exec(s);
  if (perfect)
    return canon(
      perfect[1],
      actionOf(perfect[3] || perfect[6]),
      perfect[3] ? `${perfect[4]} to ${perfect[5]}` : perfect[7],
      perfect[2] ? "negative" : "positive",
    );
  const passive = new RegExp(
    `^Was (${object}?) (not )?(approved|signed) by (${entity})$`,
    "i",
  ).exec(s);
  if (passive)
    return canon(
      passive[4],
      actionOf(passive[3]),
      passive[1],
      passive[2] ? "negative" : "positive",
    );
  return null;
}
function parseAssertion(s) {
  const m = eventPattern(false).exec(s);
  if (!m) return null;
  const verb =
    m[3]?.toLowerCase() ||
    { paid: "pay", approved: "approve", signed: "sign" }[m[4]?.toLowerCase()];
  return canon(m[1], verb, m[5], m[2] ? "negative" : "positive");
}
const fingerprint = (bundle) =>
  digest((bundle.sources ?? []).map((s) => [s.id, s.hash, s.text]));
export function eventQuestionPlan(question, bundle, generation) {
  if (
    typeof question !== "string" ||
    question.length > 800 ||
    !Number.isInteger(generation)
  )
    return null;
  // This exact connective is part of the small language. No guessed split of
  // opaque clauses, follow-up pronouns, corrections or temporal modifiers.
  const m = /^(?:Did|Has|Was) .+\?$/i.exec(question);
  if (!m) return null;
  const parts = question.slice(0, -1).split(/ and (?=(?:did|has|was) )/i);
  if (parts.length > 4) return null;
  const parsed = parts.map(parseQuestionPart);
  if (parsed.some((p) => !p)) return null;
  const requirements = parsed.map((slots, i) => ({
    id: "event-" + digest([question, i, slots]).slice(0, 16),
    text: parts[i][0].toUpperCase() + parts[i].slice(1) + "?",
    protectedText: question,
    owners: [],
    slots,
    semanticState: "bounded-explicit-event-question",
  }));
  const value = {
    version: 1,
    originalQuestion: question,
    sourceGeneration: generation,
    sourceFingerprint: fingerprint(bundle),
    requirements,
    coverageEstablished: true,
    semanticQualification: "bounded-explicit-event-assertion-language",
    limitations: [
      "Only fully consumed named actor pay/approve/sign questions and assertion-only source sets are certified. No coreference, synonyms, dates, versions, surrounding conditions or real-world event truth is inferred.",
    ],
  };
  return freeze({ ...value, key: digest(value) });
}
// Every nonblank byte-bearing line of every source must be an assertion in
// this language. A heading, quoted sentence, instruction, condition, amendment,
// table or arbitrary prose prevents affirmative admission, not silent skipping.
export function eventSourceFacts(bundle) {
  const facts = [];
  if (!(bundle.sources ?? []).length) return { complete: false, facts };
  for (const s of bundle.sources) {
    let offset = 0;
    for (const line of s.text.split("\n")) {
      const start = offset;
      offset += line.length + 1;
      if (!line.trim()) continue;
      const slots = parseAssertion(line);
      if (!slots) return { complete: false, facts: [] };
      facts.push({
        slots,
        citation: {
          sourceId: s.id,
          title: s.title,
          hash: s.hash ?? digest(s.text),
          start,
          end: start + line.length,
          quote: line,
        },
      });
      if (facts.length > 1000) return { complete: false, facts: [] };
    }
  }
  return { complete: facts.length > 0, facts };
}
const relationKey = ({ polarity, ...rest }) => JSON.stringify(rest);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const ambiguousCase = (facts, slots) =>
  facts.some(
    (f) =>
      relationKey(f.slots).toLowerCase() === relationKey(slots).toLowerCase() &&
      relationKey(f.slots) !== relationKey(slots),
  );
function proposedClaim(fact, requirement) {
  const matches = fact.slots.polarity === requirement.slots.polarity;
  return {
    text: `${matches ? "Yes" : "No"}. The source records: "${fact.citation.quote}"`,
    slots: fact.slots,
    citations: [fact.citation],
  };
}
export function verifyEventCertificate({ plan, requirement, claim, bundle }) {
  const rebuilt = eventQuestionPlan(
    plan.originalQuestion,
    bundle,
    plan.sourceGeneration,
  );
  if (
    !rebuilt ||
    rebuilt.key !== plan.key ||
    !rebuilt.requirements.some((r) => same(r, requirement))
  )
    return { ok: false };
  const source = eventSourceFacts(bundle);
  const hits = source.facts.filter(
    (f) => relationKey(f.slots) === relationKey(requirement.slots),
  );
  const match = hits.find((f) =>
    same(proposedClaim(f, requirement), {
      text: claim.text,
      slots: claim.slots,
      citations: claim.citations,
    }),
  );
  return {
    ok:
      source.complete &&
      !ambiguousCase(source.facts, requirement.slots) &&
      !!match &&
      new Set(hits.map((f) => f.slots.polarity)).size === 1,
    kind: "explicit-event-relation",
    requirementId: requirement.id,
    questionPlanKey: plan.key,
    sourceGeneration: plan.sourceGeneration,
    operation:
      "reconstruct-complete-source-assertion-set-and-match-all-event-slots",
  };
}
export async function resolveExplicitEvents({
  question,
  bundle,
  sourceGeneration,
  isCurrent = () => true,
}) {
  // Named clinical identities still need their clinical binding resolver.
  if (
    (bundle.clinical ?? []).length ||
    (bundle.sourceRecords ?? []).some((r) => r.meta?.patient)
  )
    return null;
  const plan = eventQuestionPlan(question, bundle, sourceGeneration);
  if (!plan) return null;
  const source = eventSourceFacts(bundle);
  const draft = {
    questionPlanKey: plan.key,
    sourceGeneration,
    outcomes: plan.requirements.map((r) => {
      const hits = source.facts.filter(
        (f) => relationKey(f.slots) === relationKey(r.slots),
      );
      const conflict =
        ambiguousCase(source.facts, r.slots) ||
        new Set(hits.map((f) => f.slots.polarity)).size > 1;
      return {
        requirementId: r.id,
        status:
          source.complete && hits.length && !conflict
            ? "answered"
            : conflict
              ? "clarify"
              : "not_established",
        claims:
          source.complete && hits.length && !conflict
            ? hits.map((f) => proposedClaim(f, r))
            : [],
      };
    }),
  };
  const admission = await admitAnswer({
    plan,
    draft,
    bundle,
    verifyEvidence: ({ claim }) => ({
      ok:
        claim.citations.length > 0 &&
        claim.citations.every((c) => {
          const s = bundle.sources.find((s) => s.id === c.sourceId);
          return (
            s &&
            (s.hash ?? digest(s.text)) === c.hash &&
            s.text.slice(c.start, c.end) === c.quote
          );
        }),
    }),
    verifyDeterministic: ({ claim, requirement }) =>
      verifyEventCertificate({ plan, requirement, claim, bundle }),
  });
  if (!isCurrent() || fingerprint(bundle) !== plan.sourceFingerprint)
    return null;
  return { plan, admission };
}
