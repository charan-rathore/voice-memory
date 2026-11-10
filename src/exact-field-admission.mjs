// Bounded positive admission for explicit two-column Field | Value schemas.
// This is an exact schema lookup grammar, not arbitrary-language understanding.
// No synonym expansion, header authority ranking, event inference or model use.
import { createHash } from "node:crypto";
import { admitAnswer } from "./answer-admission.mjs";
const digest = (x) =>
  createHash("sha256").update(JSON.stringify(x)).digest("hex");
const key = (s) => s.toLowerCase().replace(/\s+/g, " ").trim();
const plain = (s) => typeof s === "string" && s.length > 0 && !/[\n|]/.test(s);
const cells = (s) =>
  s
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((x) => x.trim());
export function explicitFieldRows(bundle) {
  const rows = [];
  for (const source of bundle.sources ?? []) {
    let offset = 0,
      table = false;
    for (const line of source.text.split("\n")) {
      const start = offset;
      offset += line.length + 1;
      if (!line.trim().startsWith("|")) {
        table = false;
        continue;
      }
      const c = cells(line);
      if (c.length !== 2) {
        table = false;
        continue;
      }
      if (key(c[0]) === "field" && key(c[1]) === "value") {
        table = true;
        continue;
      }
      if (table && c.every((x) => /^:?-{3,}:?$/.test(x))) continue;
      if (!table || !c.every(plain) || c[0].length > 100 || c[1].length > 1000)
        continue;
      rows.push({
        sourceId: source.id,
        sourceHash: source.hash ?? digest(source.text),
        title: source.title,
        label: c[0],
        value: c[1],
        start,
        end: start + line.length,
        quote: line,
      });
    }
  }
  return rows;
}
// All remaining question text must be a sequence of printed labels. Enumerate
// ambiguity instead of choosing the first segmentation of a label containing
// "and". Limit search to keep untrusted inputs from creating unbounded work.
export function exactFieldPlan(question, bundle, sourceGeneration) {
  if (
    typeof question !== "string" ||
    question.length > 800 ||
    !Number.isInteger(sourceGeneration)
  )
    return null;
  const m = /^\s*what (is|are) (?:the )?(.+?)\s*\?\s*$/i.exec(question);
  if (!m) return null;
  const rows = explicitFieldRows(bundle),
    labels = [...new Set(rows.map((r) => key(r.label)))];
  const body = key(m[2]);
  const solutions = [];
  let visits = 0,
    bounded = true;
  function visit(rest, chosen) {
    if (++visits > 5000) {
      bounded = false;
      return;
    }
    if (!bounded || solutions.length > 1 || chosen.length > 8) return;
    if (!rest) {
      solutions.push(chosen);
      return;
    }
    for (const label of labels) {
      if (rest === label) visit("", [...chosen, label]);
      else if (m[1].toLowerCase() === "are" && rest.startsWith(label + " and "))
        visit(rest.slice(label.length + 5), [...chosen, label]);
    }
  }
  visit(body, []);
  if (
    !bounded ||
    solutions.length !== 1 ||
    new Set(solutions[0]).size !== solutions[0].length
  )
    return null;
  const requirements = solutions[0].map((label, i) => ({
    id: `field-${digest([question, i, label]).slice(0, 16)}`,
    text: label,
    protectedText: question,
    owners: [],
    relation: "recorded-field-value",
    fieldLabel: label,
    semanticState: "bounded-exact-schema",
  }));
  const value = {
    version: 1,
    originalQuestion: question,
    sourceGeneration,
    sourceFingerprint: digest(
      (bundle.sources ?? []).map((s) => [s.id, s.hash, s.text]),
    ),
    requirements,
    coverageEstablished: true,
    semanticQualification: "bounded-exact-schema-lookup",
    limitations: [
      "Exact printed-label table lookup only. No approval, payment, ownership, chronology or prose entailment is inferred.",
    ],
  };
  const freeze = (x) => {
    if (x && typeof x === "object") {
      Object.values(x).forEach(freeze);
      Object.freeze(x);
    }
    return x;
  };
  return freeze({ ...value, key: digest(value) });
}
const rowIdentity = (r) =>
  digest([r.sourceId, r.sourceHash, r.start, r.end, r.quote, r.label, r.value]);
export function verifyExactFieldCertificate({
  plan,
  requirement,
  claim,
  bundle,
}) {
  const reconstructed = exactFieldPlan(
    plan.originalQuestion,
    bundle,
    plan.sourceGeneration,
  );
  if (
    !reconstructed ||
    reconstructed.key !== plan.key ||
    !reconstructed.requirements.some(
      (r) =>
        r.id === requirement.id &&
        JSON.stringify(r) === JSON.stringify(requirement),
    )
  )
    return { ok: false };
  const currentRows = explicitFieldRows(bundle).filter(
    (x) => key(x.label) === requirement.fieldLabel,
  );
  const row = currentRows.find((x) => rowIdentity(x) === claim.rowId);
  const expected =
    row && `The source table lists "${row.label}" as "${row.value}".`;
  const ok =
    !!row &&
    new Set(currentRows.map((x) => x.value)).size === 1 &&
    expected === claim.text &&
    JSON.stringify(claim.citations) ===
      JSON.stringify([
        {
          sourceId: row.sourceId,
          title: row.title,
          hash: row.sourceHash,
          start: row.start,
          end: row.end,
          quote: row.quote,
        },
      ]);
  return {
    ok,
    kind: "exact-source-field-row",
    requirementId: requirement.id,
    questionPlanKey: plan.key,
    sourceGeneration: plan.sourceGeneration,
    rowId: claim.rowId,
    sourceId: row?.sourceId,
    operation: "read-printed-field-with-no-conflicting-value",
  };
}
export async function resolveExactFields({
  question,
  bundle,
  sourceGeneration,
  isCurrent = () => true,
}) {
  // Patient record identity belongs to the clinical/owner resolver, never to
  // a table's number of occurrences or an exact field label.
  if (
    (bundle.clinical ?? []).length ||
    (bundle.sourceRecords ?? []).some((r) => r.meta?.patient)
  )
    return null;
  const plan = exactFieldPlan(question, bundle, sourceGeneration);
  if (!plan) return null;
  const rows = explicitFieldRows(bundle);
  const draft = {
    questionPlanKey: plan.key,
    sourceGeneration,
    outcomes: plan.requirements.map((r) => {
      const hits = rows.filter((x) => key(x.label) === r.fieldLabel);
      if (new Set(hits.map((x) => x.value)).size !== 1)
        return { requirementId: r.id, status: "clarify", claims: [] };
      return {
        requirementId: r.id,
        status: "answered",
        claims: hits.map((row) => ({
          text: `The source table lists "${row.label}" as "${row.value}".`,
          rowId: rowIdentity(row),
          citations: [
            {
              sourceId: row.sourceId,
              title: row.title,
              hash: row.sourceHash,
              start: row.start,
              end: row.end,
              quote: row.quote,
            },
          ],
        })),
      };
    }),
  };
  const admission = await admitAnswer({
    plan,
    draft,
    bundle,
    verifyEvidence: ({ claim }) => ({
      ok: claim.citations.every((c) => {
        const s = bundle.sources.find((s) => s.id === c.sourceId);
        return (
          s &&
          (s.hash ?? digest(s.text)) === c.hash &&
          s.text.slice(c.start, c.end) === c.quote
        );
      }),
    }),
    verifyDeterministic: ({ claim, requirement }) =>
      verifyExactFieldCertificate({ plan, claim, requirement, bundle }),
  });
  if (
    !isCurrent() ||
    digest((bundle.sources ?? []).map((s) => [s.id, s.hash, s.text])) !==
      plan.sourceFingerprint
  )
    return null;
  return { plan, admission };
}
