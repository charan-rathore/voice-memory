// Trial-scope audience gate for paid semantics.
//
// Under VM_SEMANTIC_AUDIENCE=demo, ONLY the two known built-in synthetic
// demo cases ("case:deal", "case:health") may use the model - an exact
// allowlist, so an unknown, aliased or mis-routed session id (including
// "case:voice" and any future internal sid) fails closed, and no client
// consent flag can widen the trial scope. Outside demo scope the
// pre-existing rule is unchanged: fictional/internal cases yes, a
// visitor's own documents ("ws:" sessions) only with their consent.
const DEMO_CASE_SIDS = new Set(["case:deal", "case:health"]);

export function semanticConsentFor(sid, optedInConsent, env = process.env) {
  const s = String(sid ?? "");
  if (String(env.VM_SEMANTIC_AUDIENCE ?? "") === "demo")
    return DEMO_CASE_SIDS.has(s);
  return !s.startsWith("ws:") || !!optedInConsent;
}
