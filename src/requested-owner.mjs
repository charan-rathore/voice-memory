// A narrow veto, not a general owner parser. It learns opaque identifier
// namespaces from source identity fields; it never invents an association.
export function unboundRequestedOwner(question, bundle) {
  const identities = new Set(
    (bundle.records ?? []).flatMap((en) =>
      (en.records ?? []).flatMap(recordOwnerIds),
    ),
  );
  const prefixes = new Set(
    [...identities].map((id) => /^(.+[-_])\d+$/.exec(id)?.[1]).filter(Boolean),
  );
  const asked = [
    ...String(question)
      .toUpperCase()
      .matchAll(/\b[A-Z][A-Z0-9_-]*[-_]\d+\b/g),
  ].map((m) => m[0]);
  return (
    asked.find(
      (id) =>
        prefixes.has(/^(.+[-_])\d+$/.exec(id)?.[1]) && !identities.has(id),
    ) ?? null
  );
}

// Exact printed opaque identity values, not inferred medical identity metadata.
export function recordOwnerIds(record) {
  const ids = new Set(recordPatientIds(record));
  for (const f of record.facts ?? [])
    if (/\b(?:id|identifier)\s*$/i.test(f.label ?? "")) {
      const value = String(f.value ?? "").trim();
      if (/^[A-Z][A-Z0-9]*(?:[-_][A-Z0-9]+)+$/i.test(value) && /\d/.test(value))
        ids.add(value.toUpperCase());
    }
  return [...ids];
}
export function namedRecordOwners(question, records) {
  const text = String(question).toUpperCase();
  return [...new Set(records.flatMap(recordOwnerIds))].filter((id) => {
    const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(?<![A-Z0-9_-])${escaped}(?![A-Z0-9_-])`).test(text);
  });
}

export function recordPatientIds(record) {
  const ids = new Set();
  if (record.patient) ids.add(String(record.patient).toUpperCase());
  for (const f of record.facts ?? [])
    if (
      /^(?:patient|pt\.?)\s*(?:id|identifier)$/i.test(
        String(f.label ?? "").trim(),
      )
    ) {
      const value = String(f.value ?? "").trim();
      if (/^[A-Z][A-Z0-9]*(?:[-_][A-Z0-9]+)+$/i.test(value) && /\d/.test(value))
        ids.add(value.toUpperCase());
    }
  return [...ids];
}

// Shared consumer veto. This is a refusal, never evidence or an identity inference.
export function unboundOwnerTurn(question, bundle) {
  if (!unboundRequestedOwner(question, bundle)) return null;
  return {
    intent: "UNBOUND_OWNER",
    verdict: "UNBOUND_OWNER",
    field: null,
    spoken:
      "I cannot bind the requested identifier to a record in these documents. I will not substitute another record's facts.",
    citations: [],
  };
}
