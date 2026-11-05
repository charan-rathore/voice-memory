// Readiness states for the production canary, kept apart from the network
// script so they can be tested with a stubbed fetch.
//
//   waking      the engine did not answer (timeout, network error, 5xx, 429)
//   loading     the engine answered /status but a demo case is not loaded yet
//   ready       every demo case is loaded
//   mismatch    the engine is up but runs a different commit than expected
//
// A cold free host answers /status as soon as it listens, before the cases
// finish loading. Treating that first 200 as final was the canary failure of
// run 41923964422 ("engine up but cases not loaded"): loading is a state to
// wait through, within a deadline, never a verdict on its own.

export function classifyStatus(res) {
  if (!res || res.error)
    return { state: "waking", detail: res?.error ?? "no response" };
  if (res.status >= 500 || res.status === 429)
    return { state: "waking", detail: `HTTP ${res.status}` };
  if (res.status !== 200)
    return { state: "error", detail: `HTTP ${res.status}` };
  const cases = res.body?.cases ?? {};
  const missing = ["health", "deal"].filter((k) => !cases[k]);
  if (missing.length)
    return { state: "loading", detail: `not loaded: ${missing.join(", ")}` };
  return { state: "ready", detail: "health and deal loaded" };
}

/**
 * Poll until ready or the deadline passes. `probe()` resolves to
 * { status, body } or { error }. Returns the last classification plus a log
 * of every state seen, so a failure says which state it ended in.
 */
export async function waitReady(
  probe,
  { deadlineMs = 240000, sleep, now = Date.now, backoff } = {},
) {
  const start = now();
  const seen = [];
  for (let i = 0; ; i++) {
    let res;
    try {
      res = await probe();
    } catch (e) {
      res = { error: String(e?.message ?? e) };
    }
    const c = classifyStatus(res);
    seen.push(c.state);
    if (c.state === "ready" || c.state === "error")
      return { ...c, seen, ms: now() - start };
    if (now() - start >= deadlineMs)
      return { ...c, seen, ms: now() - start, timedOut: true };
    await sleep(
      backoff ? backoff(i) : Math.min(15000, 2000 * 2 ** Math.min(i, 3)),
    );
  }
}

/** Compare the engine's /healthz commit with an expected SHA (prefix ok). */
export function versionCheck(health, expected) {
  if (!expected)
    return { state: "unchecked", detail: "no expected commit given" };
  const got = health?.commit ?? null;
  if (!got) return { state: "mismatch", detail: "engine reports no commit" };
  const a = String(got).toLowerCase(),
    b = String(expected).toLowerCase();
  return a.startsWith(b) || b.startsWith(a)
    ? { state: "match", detail: got }
    : { state: "mismatch", detail: `engine ${got} != expected ${expected}` };
}
