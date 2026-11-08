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
  if (!m || m[1].toLowerCase() !== patient.toLowerCase()) return null;
  const tests = m[2].split(/ and /i);
  if (
    tests.length < 2 ||
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
  const value = {
    version: 1,
    originalQuestion: question,
    sourceGeneration,
    requirements: tests.map((test, i) => ({
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
    })),
    coverageEstablished: true,
    semanticQualification:
      "requirement-list-only-clinical-entailment-unverified",
    sourceFingerprint: digest(
      (bundle.sources ?? []).map((s) => [s.id, s.hash, s.text]),
    ),
    limitations: [
      "Only explicit single-ID multi-test result lists are segmented. Clinical answer selection and source status/version operations remain the existing clinical implementation, not independent semantic certificates.",
    ],
  };
  return freeze({ ...value, key: digest(value) });
}
