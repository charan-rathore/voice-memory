// Trial-scope audience gate for paid semantics.
//
// The built-in synthetic demo cases (session ids NOT starting "ws:") may use
// the model: their corpus is fictional, so nothing personal can egress.
// A visitor's own documents ("ws:" sessions) may use it only with that
// visitor's explicit consent - and while VM_SEMANTIC_AUDIENCE=demo, not even
// then. The gate is server-side and authoritative: a client consent flag
// cannot widen the trial scope.
export function semanticConsentFor(sid, optedInConsent, env = process.env) {
  const demoCase = !String(sid ?? "").startsWith("ws:");
  if (demoCase) return true;
  if (!optedInConsent) return false;
  return String(env.VM_SEMANTIC_AUDIENCE ?? "") !== "demo";
}
