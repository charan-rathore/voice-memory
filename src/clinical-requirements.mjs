// Explicit single-ID, multi-test inventory grammar. This owns request units,
// not clinical entailment or the legacy latest/version selection algorithm.
import { createHash } from "node:crypto";
const digest = (x) =>
  createHash("sha256").update(JSON.stringify(x)).digest("hex");
const freeze = (x) => {
  if (x && typeof x === "object") {
    Object.values(x).forEach(freeze);
    Object.freeze(x);
  }
  return x;
};
export const exactTestLabel = (s) =>
  String(s).toLowerCase().replace(/\s+/g, " ").trim();
export function clinicalListPlan(question, bundle, sourceGeneration, patient) {
  if (
    typeof question !== "string" ||
    question.length > 500 ||
    !patient ||
    !Number.isInteger(sourceGeneration)
  )
    return null;
  const m = /^What are ([A-Z0-9][A-Z0-9_.-]{0,100})'s (.+) results\?$/i.exec(
    question,
  );
  const partial =
    /^What is ([A-Z0-9][A-Z0-9_.-]{0,100})'s ([a-z][a-z0-9 /()-]{0,79}) result and ((?:who|what|where|when|why|how|did|has|was|is) .+)\?$/i.exec(
      question,
    );
  const parsed = m ?? partial;
  if (!parsed || parsed[1].toLowerCase() !== patient.toLowerCase()) return null;
  const tests = m ? m[2].split(/ and /i) : [partial[2]];
  if (
    (m && tests.length < 2) ||
    tests.length > 6 ||
    new Set(tests.map(exactTestLabel)).size !== tests.length
  )
    return null;
  if (
    tests.some(
      (s) =>
        !/^[a-z][a-z0-9 /()-]{0,79}$/i.test(s) ||
        /\b(?:and|or|who|what|where|when|why|if|unless|not|before|after|current|latest|previous|original|corrected|approved|treatment)\b/i.test(
          s,
        ),
    )
  )
    return null;
  const requirements = tests.map((test, i) => ({
    id: "clinical-test-" + digest([question, i, patient, test]).slice(0, 16),
    text: test,
    owners: [patient],
    protectedText: question,
    slots: {
      targetOwner: patient,
      object: exactTestLabel(test),
      expectedAnswerType: "reported-test-result",
      time: null,
      version: null,
    },
    semanticState: "explicit-clinical-test-list-only",
  }));
  if (partial)
    requirements.push({
      id: "unresolved-tail-" + digest([question, partial[3]]).slice(0, 16),
      text: partial[3] + "?",
      owners: [],
      protectedText: partial[3] + "?",
      slots: {
        targetOwner: null,
        object: null,
        expectedAnswerType: null,
        time: null,
        version: null,
      },
      semanticState: "opaque-unresolved-tail",
    });
  const value = {
    version: 1,
    originalQuestion: question,
    sourceGeneration,
    requirements,
    coverageEstablished: !partial,
    unresolvedRemainder: partial ? partial[3] + "?" : null,
    semanticQualification:
      "requirement-list-only-clinical-entailment-unverified",
    sourceFingerprint: digest(
      (bundle.sources ?? []).map((s) => [s.id, s.hash, s.text]),
    ),
    limitations: [
      "Only explicit single-ID test result requirements are resolved; a repeated-interrogative tail stays opaque and unresolved. Clinical answer selection and source status/version operations remain the existing clinical implementation, not independent semantic certificates.",
    ],
  };
  return freeze({ ...value, key: digest(value) });
}

// Cartesian coverage is licensed only by an explicit test list and explicit
// source-bound IDs. No surrounding suffix, alias, pronoun or condition is lost.
export function clinicalOwnerTestPlan(
  question,
  bundle,
  sourceGeneration,
  owners,
  ownerLabels = [],
) {
  if (
    typeof question !== "string" ||
    question.length > 800 ||
    !Number.isInteger(sourceGeneration) ||
    !Array.isArray(owners) ||
    owners.length < 2 ||
    owners.length > 6
  )
    return null;
  const resolveOwner = (label) => {
    const matches = new Set([
      ...owners.filter((x) => exactTestLabel(x) === exactTestLabel(label)),
      ...ownerLabels
        .filter(
          (x) => x.name && exactTestLabel(x.name) === exactTestLabel(label),
        )
        .map((x) => x.owner),
    ]);
    return matches.size === 1 && owners.includes([...matches][0])
      ? [...matches][0]
      : null;
  };
  const id = "[A-Z0-9][A-Z0-9_.-]{0,100}";
  const m =
    new RegExp(`^What is (.+) for (${id}(?: and ${id}){1,5})\\?$`, "i").exec(
      question,
    ) ??
    new RegExp(
      `^What are (.+) results for (${id}(?: and ${id}){1,5})\\?$`,
      "i",
    ).exec(question);
  const sharedPossessive = /^What are (.+)'s (.+) results\?$/i.exec(question);
  const paired = /^What are (.+) results\?$/.exec(question);
  let pairs;
  if (m) {
    if (exactTestLabel(m[1]) === "the") return null;
    const requested = m[2].split(/ and /i),
      tests = m[1].split(/ and /i);
    if (
      new Set(requested.map(exactTestLabel)).size !== requested.length ||
      requested.length !== owners.length ||
      tests.length > 6 ||
      new Set(tests.map(exactTestLabel)).size !== tests.length
    )
      return null;
    pairs = requested.flatMap((owner) =>
      tests.map((test) => ({ owner, test })),
    );
  } else if (sharedPossessive && !sharedPossessive[1].includes("'s")) {
    const requested = sharedPossessive[1].split(/ and /i),
      tests = sharedPossessive[2].split(/ and /i);
    if (requested.length !== owners.length || tests.length > 6) return null;
    pairs = requested.flatMap((owner) =>
      tests.map((test) => ({ owner, test })),
    );
  } else if (paired) {
    const parts = paired[1].split(/ and /i);
    if (parts.length < 2 || parts.length > 36) return null;
    pairs = parts.map((part) => {
      const x = new RegExp(`^(${id})'s (.+)$`, "i").exec(part);
      return x ? { owner: x[1], test: x[2] } : null;
    });
    if (pairs.some((x) => !x)) return null;
    if (
      new Set(pairs.map((p) => exactTestLabel(p.owner))).size !== owners.length
    )
      return null;
  } else return null;
  pairs = pairs.map((p) => ({ ...p, owner: resolveOwner(p.owner) }));
  if (
    pairs.some((p) => !p.owner) ||
    new Set(pairs.map((p) => p.owner)).size !== owners.length
  )
    return null;
  if (
    new Set(
      pairs.map((p) =>
        JSON.stringify([exactTestLabel(p.owner), exactTestLabel(p.test)]),
      ),
    ).size !== pairs.length
  )
    return null;
  if (
    pairs.some(
      ({ owner, test }) =>
        !owners.some((x) => exactTestLabel(x) === exactTestLabel(owner)) ||
        !/^[a-z][a-z0-9 /()-]{0,79}$/i.test(test) ||
        /\b(?:and|or|who|what|where|when|why|if|unless|not|before|after|current|latest|previous|original|corrected|approved|treatment|result|results)\b/i.test(
          test,
        ),
    )
  )
    return null;
  const requirements = pairs.map(({ owner, test }) => ({
    id: "owner-test-" + digest([question, owner, test]).slice(0, 16),
    text: test,
    owners: [owners.find((x) => exactTestLabel(x) === exactTestLabel(owner))],
    protectedText: question,
    slots: {
      targetOwner: owners.find(
        (x) => exactTestLabel(x) === exactTestLabel(owner),
      ),
      object: exactTestLabel(test),
      expectedAnswerType: "reported-test-result",
      time: null,
      version: null,
    },
    semanticState: "explicit-owner-test-matrix-only",
  }));
  const value = {
    version: 1,
    originalQuestion: question,
    sourceGeneration,
    requirements,
    coverageEstablished: true,
    semanticQualification:
      "owner-test-list-only-clinical-entailment-unverified",
    sourceFingerprint: digest(
      (bundle.sources ?? []).map((s) => [s.id, s.hash, s.text]),
    ),
    limitations: [
      "This exact owner-by-test inventory proves request coverage only. Existing clinical source selection and interpretation are not independent entailment certificates.",
    ],
  };
  return freeze({ ...value, key: digest(value) });
}
