// Durable reconciliation for ambiguous voice-mint sessions.
//
// When a visitor/owner mint fails with an AMBIGUOUS vendor outcome (5xx or
// network/timeout - the session may exist) the reservation stays charged.
// That bias alone is not reconciliation: this module closes the loop
// against the vendor's READ API (injected; never probed with real
// credentials from tests).
//
// Vendor contract used (docs.bolna.ai, read-only GETs):
// - GET /executions/{execution_id} -> 200 execution object
//   {id, agent_id, conversation_duration, total_cost, status, created_at},
//   or an error body when no such execution exists.
// - GET /v2/agent/{agent_id}/executions?page_number&page_size&provider=
//   web-call&from&to -> {data: [...executions], has_more} for recovering
//   sessions whose id was never captured (timeout before a response body).
//
// Fail-closed rules:
// - Records WITH a captured session id come from settle-failure paths: the
//   session definitely exists, the accounting is what failed. A matching
//   200 settles it; actuals (duration/cost/status) flow to observability
//   and any eventual authorized spend accounting.
// - 404/"not found" is NOT proof the call was never created (web-call
//   indexing in /executions is unverified). STAYS CHARGED, flagged for
//   manual reconcile - never auto-released.
// - List-based recovery settles ONLY on vendor-supported request
//   correlation: a candidate execution that carries this reservation's own
//   vm_res tag (minted into user_data) in its record. A window with exactly
//   one UNCORRELATED candidate is NOT attribution (concurrent owner/other
//   calls are possible): stays charged, candidate surfaced for manual
//   reconcile. Zero candidates: STAYS CHARGED (list lag cannot prove
//   non-existence). Multiple: stays ambiguous.
// - Any read error (network/5xx) -> stays ambiguous, retried next run.
// - Nothing here ever auto-releases an allowance; only the owner,
//   reconciling manually against the vendor dashboard, can do that.
//
// SCOPE: the journal is an UNRESOLVED-OUTCOME safety record only. Settled
// normal calls leave no durable trace and reconcile actuals are returned
// ephemerally to the caller - this is deliberately NOT a durable billing
// accrual, and no money claim rests on it.

const WINDOW_BEFORE_MS = 5 * 60000;
const WINDOW_AFTER_MS = 10 * 60000;
// Known-terminal vendor statuses (docs enumerate scheduled/queued/
// in-progress/completed/failed "etc." - the full enum is not published, so
// ONLY these two are treated as terminal). Accounting settles only on a
// terminal record; an in-progress call keeps its journal entry and its
// charge, and no final cost is claimed for it.
const TERMINAL = new Set(["completed", "failed"]);

export async function reconcileAmbiguousMints({
  counters,
  vendorRead,
  agentId,
  now = () => Date.now(),
}) {
  if (!counters || typeof counters.listAmbiguous !== "function")
    throw new Error("reconcile needs a counter store with ambiguous records");
  if (typeof vendorRead !== "function")
    throw new Error("reconcile needs an injected vendorRead");
  const report = {
    settled: [],
    stillAmbiguous: [],
    unrecoverable: [],
    manualCandidates: [],
    actuals: [],
  };
  for (const rec of await counters.listAmbiguous()) {
    try {
      if (rec.sessionId) {
        const r = await vendorRead("get", { executionId: rec.sessionId });
        const ex = r.execution;
        // Session binding: auto-settle requires a NON-EMPTY expected
        // agent, a NON-EMPTY execution id matching the captured session id
        // exactly, AND the candidate's agent matching the expected agent.
        // A right-id/wrong-agent record is not ours; an uncheckable
        // binding (expected agent unknown) is never auto-settled - it is
        // held charged for manual reconciliation.
        const bound =
          r.kind === "found" &&
          !!agentId &&
          !!ex?.id &&
          ex.id === rec.sessionId &&
          ex.agent_id === agentId;
        if (bound && TERMINAL.has(ex.status)) {
          await counters.settleReservation(rec.reservation);
          await counters.clearAmbiguous(rec.reservation);
          report.settled.push(rec.reservation);
          report.actuals.push({
            reservation: rec.reservation,
            sessionId: rec.sessionId,
            status: ex.status,
            conversationDuration: ex.conversation_duration ?? null,
            totalCost: ex.total_cost ?? null,
          });
        } else {
          // not-found is NOT proof of non-existence (web-call indexing
          // unverified); in-progress is not terminal; read errors retry
          // next run. All stay charged. A found record whose binding
          // cannot be verified (wrong agent, or expected agent unknown)
          // is held charged as a MANUAL candidate - never auto-settled.
          report.stillAmbiguous.push(rec.reservation);
          if (
            r.kind === "found" &&
            ex &&
            ex.id === rec.sessionId &&
            (!agentId || ex.agent_id !== agentId)
          ) {
            // The record IS our session id but the agent binding cannot
            // be verified (wrong agent, or expected agent unknown): held
            // charged for MANUAL reconcile, never auto-settled.
            report.manualCandidates.push({
              reservation: rec.reservation,
              candidateIds: [ex.id],
              reason: agentId
                ? "agent-binding-mismatch"
                : "expected-agent-unknown",
            });
          }
        }
        continue;
      }
      // No captured session id (timeout before any response body):
      // recover via the documented executions list for this agent.
      if (!agentId) {
        report.unrecoverable.push(rec.reservation);
        continue;
      }
      const r = await vendorRead("list", {
        agentId,
        from: new Date(rec.at - WINDOW_BEFORE_MS).toISOString(),
        to: new Date(Math.min(rec.at + WINDOW_AFTER_MS, now())).toISOString(),
      });
      if (r.kind !== "ok") {
        report.stillAmbiguous.push(rec.reservation);
        continue;
      }
      const candidates = Array.isArray(r.executions) ? r.executions : [];
      // Vendor-supported request correlation ONLY: the candidate's record
      // must carry this reservation's own vm_res tag (minted into
      // user_data). Uniqueness in the window is never attribution.
      const tagged = candidates.filter(
        (ex) =>
          // Auto-settle requires a NON-EMPTY expected agent, a NON-EMPTY
          // execution id, and the candidate's agent matching the expected
          // agent: a candidate lacking either id or agent_id cannot be
          // auto-settled even when it carries our tag - it is held
          // charged for manual reconciliation.
          !!agentId &&
          !!ex?.id &&
          !!ex?.agent_id &&
          ex.agent_id === agentId &&
          (ex?.user_data?.vm_res === rec.reservation ||
            ex?.context_details?.vm_res === rec.reservation),
      );
      if (tagged.length === 1 && TERMINAL.has(tagged[0].status)) {
        const ex = tagged[0];
        await counters.settleReservation(rec.reservation);
        await counters.clearAmbiguous(rec.reservation);
        report.settled.push(rec.reservation);
        report.actuals.push({
          reservation: rec.reservation,
          sessionId: ex.id ?? null,
          correlatedViaTag: true,
          status: ex.status ?? null,
          conversationDuration: ex.conversation_duration ?? null,
          totalCost: ex.total_cost ?? null,
        });
      } else {
        if (candidates.length > 0)
          report.manualCandidates.push({
            reservation: rec.reservation,
            candidateIds: candidates.map((ex) => ex?.id ?? null),
          });
        // Zero or uncorrelated candidates: STAYS CHARGED. Absence in a
        // possibly-lagging list is not proof; uniqueness is not attribution.
        report.stillAmbiguous.push(rec.reservation);
      }
    } catch {
      report.stillAmbiguous.push(rec.reservation);
    }
  }
  return report;
}
