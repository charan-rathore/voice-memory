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
