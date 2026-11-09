// Bounded event assertion language, not an arbitrary-document entailment model.
// Questions are consumed completely before retrieval. Actor, action, object,
// recipient, amount and polarity are caller constraints; an explicit actor-slot
// completion is reconstructed from the complete assertion source, not a producer.
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
      ? `^Did (${entity}) (not )?(?:(pay|owe) (${money}) to (${entity})|(approve|sign) (${object}))$`
      : `^(${entity}) (?:(did not) (pay|owe|approve|sign) |(paid|owed|approved|signed) )(.+)\\.$`,
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
  if (action === "pay" || action === "owe") {
    const m = new RegExp(`^(${money}) to (${entity})$`).exec(target);
    return m && !pronoun.test(m[2]) && named.test(m[2])
      ? {
          actor,
          action,
          object: action === "pay" ? "payment" : "debt",
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
  ({ paid: "pay", owed: "owe", approved: "approve", signed: "sign" })[
    participle.toLowerCase()
  ];
function parseQuestionPart(s) {
  const recipientQuestion = new RegExp(
    `^(?:To whom did (${entity}) (pay|owe) (${money})|Who did (${entity}) (pay|owe) (${money}) to)$`,
    "i",
  ).exec(s);
  if (recipientQuestion) {
    const concrete = canon(
      recipientQuestion[1] || recipientQuestion[4],
      (recipientQuestion[2] || recipientQuestion[5]).toLowerCase(),
      `${recipientQuestion[3] || recipientQuestion[6]} to Placeholder`,
      "positive",
    );
    return concrete ? { ...concrete, recipient: null } : null;
  }
  const amountQuestion = new RegExp(
    `^How much did (${entity}) (pay|owe) to (${entity})$`,
    "i",
  ).exec(s);
  if (amountQuestion) {
    const concrete = canon(
      amountQuestion[1],
      amountQuestion[2].toLowerCase(),
      `$0 to ${amountQuestion[3]}`,
      "positive",
    );
    return concrete ? { ...concrete, amount: null } : null;
  }
  const actorQuestion = new RegExp(
    `^Who (?:(paid) (${money}) to (${entity})|(approved|signed) (${object}))$`,
    "i",
  ).exec(s);
  if (actorQuestion) {
    const concrete = canon(
      "Placeholder",
      actionOf(actorQuestion[1] || actorQuestion[4]),
      actorQuestion[1]
        ? `${actorQuestion[2]} to ${actorQuestion[3]}`
        : actorQuestion[5],
      "positive",
    );
    return concrete ? { ...concrete, actor: null } : null;
  }
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
    { paid: "pay", owed: "owe", approved: "approve", signed: "sign" }[
      m[4]?.toLowerCase()
    ];
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
  const m = /^(?:Did|Has|Was|Who|How much did|To whom did) .+\?$/i.exec(
    question,
  );
  if (!m) return null;
  const parts = question
    .slice(0, -1)
    .split(/ and (?=(?:did|has|was|who|how much did|to whom did) )/i);
  if (parts.length > 4) return null;
  const parsed = parts.map(parseQuestionPart);
  if (parsed.some((p) => !p)) return null;
  const requirements = parsed.map((slots, i) => ({
    id: "event-" + digest([question, i, slots]).slice(0, 16),
    text: parts[i][0].toUpperCase() + parts[i].slice(1) + "?",
    protectedText: question,
    owners: [],
    slots,
    ...(slots.actor === null
      ? { answerSlot: "actor" }
      : slots.amount === null && ["pay", "owe"].includes(slots.action)
        ? { answerSlot: "amount" }
        : slots.recipient === null && ["pay", "owe"].includes(slots.action)
          ? { answerSlot: "recipient" }
          : {}),
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
      "Only fully consumed pay/owe/approve/sign questions are handled. Event completion requires assertion-only source sets. Exact record headings with literal Approved by or Signed by fields support recorded-field observations only. No coreference, synonyms, dates, versions, surrounding conditions or real-world event truth is inferred.",
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
// Rejection-only provenance. Finding a parsed assertion inside a larger
// source does not establish complete context or permit affirmative admission.
export function candidateUsesEventAssertion(lead, bundle) {
  if (!lead?.citations?.length) return false;
  for (const source of bundle.sources ?? []) {
    const cites = lead.citations.filter(
      (c) =>
        c.sourceId === source.id &&
        Number.isInteger(c.start) &&
        Number.isInteger(c.end) &&
        source.text.slice(c.start, c.end) === c.quote,
    );
    if (!cites.length) continue;
    let offset = 0;
    for (const line of source.text.split("\n")) {
      const start = offset;
      offset += line.length + 1;
      if (
        parseAssertion(line) &&
        cites.some((c) => c.start < start + line.length && c.end > start)
      )
        return true;
    }
  }
  return false;
}
const relationKey = ({ polarity, ...rest }) => JSON.stringify(rest);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const ambiguousCase = (facts, slots) =>
  facts.some(
    (f) =>
      relationKey(f.slots).toLowerCase() === relationKey(slots).toLowerCase() &&
      relationKey(f.slots) !== relationKey(slots),
  );
// A missing-slot requirement leaves exactly one slot open, not every slot.
// Every bound predicate must match; only positive assertions fill that slot.
function sourceMatches(fact, requirement) {
  if (!requirement.answerSlot)
    return relationKey(fact.slots) === relationKey(requirement.slots);
  const source = { ...fact.slots },
    wanted = { ...requirement.slots };
  delete source[requirement.answerSlot];
  delete wanted[requirement.answerSlot];
  delete source.polarity;
  delete wanted.polarity;
  return same(source, wanted);
}
function eventHits(source, requirement) {
  const all = source.facts.filter((f) => sourceMatches(f, requirement));
  const caseConflict = requirement.answerSlot
    ? all.some((a) =>
        source.facts.some(
          (b) =>
            relationKey(a.slots).toLowerCase() ===
              relationKey(b.slots).toLowerCase() &&
            relationKey(a.slots) !== relationKey(b.slots),
        ),
      )
    : ambiguousCase(source.facts, requirement.slots);
  const conflict =
    caseConflict ||
    new Set(all.map((f) => f.slots.polarity)).size > 1 ||
    (requirement.answerSlot &&
      new Set(
        all
          .filter((f) => f.slots.polarity === "positive")
          .map((f) => f.slots[requirement.answerSlot]),
      ).size > 1);
  return {
    conflict,
    hits: requirement.answerSlot
      ? all.filter((f) => f.slots.polarity === "positive")
      : all,
  };
}
// A printed role field is a different operation from an event assertion.
// It reports only literal source text under an exactly named record heading.
// It never turns status words, prose or a nearby person's name into an actor.
function recordedRoleClaims(bundle, requirement) {
  if (requirement.answerSlot !== "actor") return [];
  const { action, object: target, amount, recipient } = requirement.slots;
  if (amount !== null || recipient !== null) return [];
  const label = { approve: "Approved by", sign: "Signed by", pay: "Paid by" }[
    action
  ];
  const wanted = target.replace(/^the /, "").toLowerCase();
  const rows = [];
  for (const source of bundle.sources ?? []) {
    let offset = 0,
      heading = null;
    for (const line of source.text.split("\n")) {
      const start = offset;
      offset += line.length + 1;
      const h =
        /^#{1,6} ([A-Za-z][A-Za-z -]*?)(?: ([A-Z]{1,8}-[A-Z0-9-]+))?$/.exec(
          line,
        );
      if (line.startsWith("#"))
        heading =
          h && h[1].toLowerCase() === wanted
            ? { start, end: start + line.length, quote: line }
            : null;
      if (!heading || !line.startsWith(label + ": ")) continue;
      const value = line.slice(label.length + 2);
      if (!value || value.length > 500) continue;
      const cite = (span) => ({
        sourceId: source.id,
        title: source.title,
        hash: source.hash ?? digest(source.text),
        ...span,
      });
      rows.push({
        text: `The source record lists "${line}". This is a recorded field, not confirmation that the event occurred.`,
        fieldValue: value,
        operation: "recorded-role-field",
        citations: [
          cite(heading),
          cite({ start, end: start + line.length, quote: line }),
        ],
      });
    }
  }
  return rows;
}
function proposedClaim(fact, requirement) {
  const matches = fact.slots.polarity === requirement.slots.polarity;
  return {
    text:
      requirement.answerSlot === "actor"
        ? `The source names ${fact.slots.actor}: "${fact.citation.quote}"`
        : requirement.answerSlot === "amount"
          ? `The source records ${fact.slots.amount}: "${fact.citation.quote}"`
          : requirement.answerSlot === "recipient"
            ? `The source names ${fact.slots.recipient} as recipient: "${fact.citation.quote}"`
            : `${matches ? "Yes" : "No"}. The source records: "${fact.citation.quote}"`,
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
  const roleFields = recordedRoleClaims(bundle, requirement);
  if (claim.operation === "recorded-role-field")
    return {
      ok:
        roleFields.length > 0 &&
        new Set(roleFields.map((c) => c.fieldValue)).size === 1 &&
        roleFields.some((c) =>
          same(c, {
            text: claim.text,
            fieldValue: claim.fieldValue,
            operation: claim.operation,
            citations: claim.citations,
          }),
        ),
      kind: "exact-recorded-role-field",
      requirementId: requirement.id,
      questionPlanKey: plan.key,
      sourceGeneration: plan.sourceGeneration,
      operation: "read-literal-role-label-under-exact-record-heading",
    };
  const source = eventSourceFacts(bundle);
  const { hits, conflict } = eventHits(source, requirement);
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
      !conflict &&
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
      const roleFields = recordedRoleClaims(bundle, r);
      if (roleFields.length) {
        const conflict =
          new Set(roleFields.map((c) => c.fieldValue)).size !== 1;
        return {
          requirementId: r.id,
          status: conflict ? "clarify" : "answered",
          claims: conflict ? [] : roleFields,
        };
      }
      const { hits, conflict } = eventHits(source, r);
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

// Compose a completely parsed first clause with an untouched opaque remainder.
// This does not interpret the remainder or certify whole-question coverage.
export function eventRemainderPlan(question, bundle, sourceGeneration) {
  if (
    typeof question !== "string" ||
    question.length > 1000 ||
    !question.endsWith("?")
  )
    return null;
  if (eventQuestionPlan(question, bundle, sourceGeneration)) return null;
  const body = question.slice(0, -1);
  const conjunctions = [...body.matchAll(/ (and|or) /gi)];
  // A suffix that is not an independent conjunction may constrain the event.
  // Preserve any such suffix without lexical guesses about date/total/etc.
  const qualifiers = [...body.matchAll(/ /g)]
    .reverse()
    .map((m) => ({ index: m.index, 1: "qualifier" }));
  for (const m of [...conjunctions, ...qualifiers]) {
    const first = body.slice(0, m.index) + "?",
      tail = body.slice(m.index);
    const known = eventQuestionPlan(first, bundle, sourceGeneration);
    if (!known || known.requirements.length !== 1) continue;
    const value = {
      version: 1,
      originalQuestion: question,
      sourceGeneration,
      sourceFingerprint: fingerprint(bundle),
      coverageEstablished: false,
      semanticQualification: "explicit-prefix-with-uninterpreted-remainder",
      unresolvedRemainder: tail + "?",
      connective:
        m[1].toLowerCase() === "and" &&
        !/^ and (?:who|what|where|when|why|how|did|has|was|is|to whom)\b/i.test(
          tail,
        )
          ? "qualifier"
          : m[1].toLowerCase(),
      prefixPlanKey: known.key,
      requirements: [
        {
          ...known.requirements[0],
          id: "prefix-" + digest([question, known.key]).slice(0, 16),
          protectedText: question,
        },
        {
          id: "opaque-" + digest([question, tail]).slice(0, 16),
          text: tail + "?",
          protectedText: tail + "?",
          owners: [],
          slots: {},
          semanticState: "opaque-unresolved-tail",
        },
      ],
      limitations: [
        "Only the first exact event clause is independently checked. The entire remaining conjunction and text stay opaque; whole-request coverage is not established. For or, neither alternative is selected. A non-conjunction suffix may constrain the event, so no unconditional prefix answer is admitted.",
      ],
    };
    return freeze({ ...value, key: digest(value), prefixQuestion: first });
  }
  return null;
}
export async function resolveExplicitEventRemainder({
  question,
  bundle,
  sourceGeneration,
  isCurrent = () => true,
}) {
  if (
    (bundle.clinical ?? []).length ||
    (bundle.sourceRecords ?? []).some((r) => r.meta?.patient)
  )
    return null;
  const plan = eventRemainderPlan(question, bundle, sourceGeneration);
  if (!plan) return null;
  const prefix =
    plan.connective === "and"
      ? await resolveExplicitEvents({
          question: plan.prefixQuestion,
          bundle,
          sourceGeneration,
          isCurrent,
        })
      : null;
  if (!isCurrent() || fingerprint(bundle) !== plan.sourceFingerprint)
    return null;
  const first = prefix?.admission.outcomes[0];
  const outcomes = [
    {
      requirementId: plan.requirements[0].id,
      status: first?.status ?? "not_established",
      claims: first?.claims ?? [],
    },
    {
      requirementId: plan.requirements[1].id,
      status: "not_established",
      claims: [],
    },
  ];
  const userReady = outcomes.some((o) => o.status === "answered");
  return {
    plan,
    admission: {
      complete: false,
      userReady,
      status: userReady ? "partial" : "unresolved",
      outcomes,
    },
    requirementCoverage: {
      questionPlanKey: plan.key,
      complete: false,
      status: userReady ? "partial" : "unresolved",
      semanticAdmissionVerified: false,
      unresolvedRemainder: plan.unresolvedRemainder,
      prefixAdmission: prefix
        ? { plan: prefix.plan, admission: prefix.admission }
        : null,
      outcomes: outcomes.map(({ requirementId, status }) => ({
        requirementId,
        status,
        operation: "independently-checked-prefix-with-opaque-remainder",
      })),
    },
  };
}
