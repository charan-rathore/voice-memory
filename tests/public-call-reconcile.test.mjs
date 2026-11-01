// Reconciliation of ambiguous voice mints against an INJECTED vendor read
// transport. No network, no credentials, no vendor contact: fixtures only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createCallCounters } from "../src/public-call-counters.mjs";
import { reconcileAmbiguousMints } from "../src/public-call-reconcile.mjs";
import { createBolnaExecutionReader } from "../src/server.mjs";

const LIM = { perIpDay: 9, globalDay: 99, lifetimeMax: 99 };
const mkCounters = async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "vm-reconcile-"));
  const c = createCallCounters({ file: path.join(dir, "c.json") });
  return c;
};
// Admit then force a mint failure path manually: admission stays charged
// and an ambiguous record exists.
const mkAmbiguous = async (c, extra = {}) => {
  const adm = await c.admitVisitor("1.1.1.1", LIM);
  assert.equal(adm.ok, true);
  await c.recordAmbiguous({
    reservation: adm.reservation,
    at: Date.parse("2026-11-01T12:00:00Z"),
    ...extra,
  });
  return adm.reservation;
};

test("reconcile: id-specific read FOUND -> settle, actuals captured", async () => {
  const c = await mkCounters();
  const res = await mkAmbiguous(c, { sessionId: "exec-1" });
  const report = await reconcileAmbiguousMints({
    counters: c,
    agentId: "agent-x",
    vendorRead: async (op, args) => {
      assert.equal(op, "get");
      assert.equal(args.executionId, "exec-1");
      return {
        kind: "found",
        execution: {
          id: "exec-1",
          agent_id: "agent-x",
          status: "completed",
          conversation_duration: 173,
          total_cost: 0.24,
        },
      };
    },
  });
  assert.deepEqual(report.settled, [res]);
  assert.equal(report.actuals[0].conversationDuration, 173);
  assert.equal(report.actuals[0].totalCost, 0.24);
  // Settled reservation: no longer refundable, record cleared.
  await c.refundReservation(res);
  assert.equal((await c.peek()).lifetime, 1);
  assert.deepEqual(await c.listAmbiguous(), []);
});

test("reconcile: id-specific read NOT-FOUND STAYS CHARGED (not proof of non-existence)", async () => {
  const c = await mkCounters();
  const res = await mkAmbiguous(c, { sessionId: "exec-ghost" });
  const report = await reconcileAmbiguousMints({
    counters: c,
    agentId: "agent-x",
    vendorRead: async () => ({ kind: "not-found" }),
  });
  // Web-call indexing in /executions is unverified: not-found never
  // auto-releases. The charge stays for manual reconcile.
  assert.deepEqual(report.settled, []);
  assert.deepEqual(report.stillAmbiguous, [res]);
  assert.equal((await c.peek()).lifetime, 1);
  assert.equal((await c.listAmbiguous()).length, 1);
});

test("reconcile: id read ERROR -> stays charged and ambiguous", async () => {
  const c = await mkCounters();
  const res = await mkAmbiguous(c, { sessionId: "exec-1" });
  const report = await reconcileAmbiguousMints({
    counters: c,
    agentId: "agent-x",
    vendorRead: async () => ({ kind: "error", status: 503 }),
  });
  assert.deepEqual(report.stillAmbiguous, [res]);
  assert.equal((await c.peek()).lifetime, 1);
  assert.equal((await c.listAmbiguous()).length, 1);
});

test("reconcile: FOUND with mismatched id is NOT settled (fail closed)", async () => {
  const c = await mkCounters();
  const res = await mkAmbiguous(c, { sessionId: "exec-1" });
  const report = await reconcileAmbiguousMints({
    counters: c,
    agentId: "agent-x",
    vendorRead: async () => ({
      kind: "found",
      execution: { id: "exec-OTHER" },
    }),
  });
  assert.deepEqual(report.stillAmbiguous, [res]);
  assert.equal((await c.peek()).lifetime, 1);
});

test("reconcile: exactly one UNCORRELATED candidate is NOT attribution (concurrent calls possible)", async () => {
  const c = await mkCounters();
  const res = await mkAmbiguous(c, { sessionId: null });
  const report = await reconcileAmbiguousMints({
    counters: c,
    agentId: "agent-x",
    vendorRead: async (op) => {
      assert.equal(op, "list");
      return {
        kind: "ok",
        executions: [
          { id: "somebody-else", status: "completed", total_cost: 0.07 },
        ],
      };
    },
  });
  // Uniqueness in the window is not correlation: stays charged, candidate
  // surfaced for MANUAL reconcile.
  assert.deepEqual(report.settled, []);
  assert.deepEqual(report.stillAmbiguous, [res]);
  assert.equal(report.manualCandidates[0].reservation, res);
  assert.deepEqual(report.manualCandidates[0].candidateIds, ["somebody-else"]);
  assert.equal((await c.peek()).lifetime, 1);
  assert.equal((await c.listAmbiguous()).length, 1);
});

test("reconcile: candidate carrying this reservation's vm_res tag settles (vendor-supported correlation)", async () => {
  const c = await mkCounters();
  const res = await mkAmbiguous(c, { sessionId: null });
  const report = await reconcileAmbiguousMints({
    counters: c,
    agentId: "agent-x",
    vendorRead: async () => ({
      kind: "ok",
      executions: [
        { id: "other-call", status: "completed" },
        {
          id: "exec-mine",
          agent_id: "agent-x",
          status: "completed",
          conversation_duration: 41,
          total_cost: 0.07,
          user_data: { vm_res: res },
        },
      ],
    }),
  });
  assert.deepEqual(report.settled, [res]);
  assert.equal(report.actuals[0].sessionId, "exec-mine");
  assert.equal(report.actuals[0].correlatedViaTag, true);
  assert.deepEqual(await c.listAmbiguous(), []);
});

test("reconcile: right id but WRONG AGENT is not ours - stays charged", async () => {
  const c = await mkCounters();
  const res = await mkAmbiguous(c, { sessionId: "exec-1" });
  const report = await reconcileAmbiguousMints({
    counters: c,
    agentId: "agent-x",
    vendorRead: async () => ({
      kind: "found",
      execution: { id: "exec-1", agent_id: "agent-OTHER", status: "completed" },
    }),
  });
  assert.deepEqual(report.settled, []);
  assert.deepEqual(report.stillAmbiguous, [res]);
  assert.equal((await c.listAmbiguous()).length, 1); // journal NOT cleared
});

test("reconcile: IN-PROGRESS record is not terminal - stays journaled, no final cost claimed", async () => {
  const c = await mkCounters();
  const res = await mkAmbiguous(c, { sessionId: "exec-1" });
  const report = await reconcileAmbiguousMints({
    counters: c,
    agentId: "agent-x",
    vendorRead: async () => ({
      kind: "found",
      execution: {
        id: "exec-1",
        agent_id: "agent-x",
        status: "in-progress",
        conversation_duration: 30,
        total_cost: 0.05,
      },
    }),
  });
  assert.deepEqual(report.settled, []);
  assert.deepEqual(report.actuals, []);
  assert.deepEqual(report.stillAmbiguous, [res]);
  assert.equal((await c.listAmbiguous()).length, 1);
});

test("reconcile: no captured id - ZERO list candidates STAYS CHARGED (absence is not proof)", async () => {
  const c = await mkCounters();
  const res = await mkAmbiguous(c, { sessionId: null });
  const report = await reconcileAmbiguousMints({
    counters: c,
    agentId: "agent-x",
    vendorRead: async () => ({ kind: "ok", executions: [] }),
  });
  assert.deepEqual(report.stillAmbiguous, [res]);
  assert.equal((await c.peek()).lifetime, 1);
});

test("reconcile: no captured id - MULTIPLE candidates cannot be attributed safely", async () => {
  const c = await mkCounters();
  const res = await mkAmbiguous(c, { sessionId: null });
  const report = await reconcileAmbiguousMints({
    counters: c,
    agentId: "agent-x",
    vendorRead: async () => ({
      kind: "ok",
      executions: [{ id: "a" }, { id: "b" }],
    }),
  });
  assert.deepEqual(report.stillAmbiguous, [res]);
  assert.equal((await c.peek()).lifetime, 1);
});

test("reconcile: no captured id and no agent configured -> bounded unrecoverable gap", async () => {
  const c = await mkCounters();
  const res = await mkAmbiguous(c, { sessionId: null });
  const report = await reconcileAmbiguousMints({
    counters: c,
    vendorRead: async () => {
      throw new Error("must not be called");
    },
  });
  assert.deepEqual(report.unrecoverable, [res]);
  assert.equal((await c.peek()).lifetime, 1); // still charged
});

test("journal: lost-ack recovery - a missing entry is RECREATED with the known session, never dropped", async () => {
  const c = await mkCounters();
  // Settle committed but its ack was lost, then the caller learned of a
  // live session: the known id must be preserved, not thrown away.
  await c.recordAmbiguous({
    reservation: "r-lost-ack",
    sessionId: "exec-live-9",
    errorClass: "settle-failed",
    settleFailed: true,
  });
  const list = await c.listAmbiguous();
  assert.equal(list.length, 1);
  assert.equal(list[0].reservation, "r-lost-ack");
  assert.equal(list[0].sessionId, "exec-live-9"); // known live id preserved
  assert.equal(list[0].recovered, true);
  assert.equal(list[0].settleFailed, true);
  const adm = await c.admitVisitor("1.1.1.1", LIM);
  await c.recordAmbiguous({
    reservation: adm.reservation,
    sessionId: null,
    errorClass: "network",
  });
  await c.recordAmbiguous({
    reservation: adm.reservation,
    sessionId: "s1",
    errorClass: "http-502",
  });
  // Idempotent structured update on the same reservation (1 new + 1 recovered).
  const list2 = await c.listAmbiguous();
  assert.equal(list2.length, 2);
  const upd = list2.find((x) => x.reservation === adm.reservation);
  assert.equal(upd.sessionId, "s1");
  assert.equal(upd.errorClass, "http-502");
});

test("journal: stale admitted-only outcomes become visible with original metadata", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "vm-reconcile-"));
  let t = Date.parse("2026-11-01T12:00:00Z");
  const c = createCallCounters({
    file: path.join(dir, "c.json"),
    now: () => t,
  });
  const a = await c.admitVisitor("1.1.1.1", LIM);
  // Fresh admitted-only entry: not yet suspicious, not listed.
  assert.deepEqual(await c.listAmbiguous(), []);
  // Crash/lost outcome: 11 minutes later the unresolved admission surfaces.
  t += 11 * 60000;
  const list = await c.listAmbiguous();
  assert.equal(list.length, 1);
  assert.equal(list[0].reservation, a.reservation);
  assert.equal(list[0].staleAdmission, true);
  assert.equal(list[0].kind, "visitor");
  assert.equal(list[0].at, Date.parse("2026-11-01T12:00:00Z")); // original
});

test("journal: 100 unresolved outcomes refuse EVERY further mint, owner included; resolving frees capacity", async () => {
  const c = await mkCounters();
  const lim = { perIpDay: 1000, globalDay: 1000, lifetimeMax: 1000 };
  const res = [];
  for (let i = 0; i < 100; i++) {
    const a = await c.admitVisitor(`10.0.0.${i % 250}`, lim);
    assert.equal(a.ok, true);
    res.push(a.reservation);
  }
  // Journal full: visitor AND owner mints refuse (no mint without a journal
  // write - safety invariant, not a count cap).
  assert.equal((await c.admitVisitor("10.1.1.1", lim)).scope, "journal-full");
  assert.equal((await c.admitOwner()).scope, "journal-full");
  // Resolving one outcome (settle OR refund) frees exactly one slot.
  await c.settleReservation(res[0]);
  assert.equal((await c.admitOwner()).ok, true);
  assert.equal((await c.admitVisitor("10.1.1.1", lim)).scope, "journal-full");
  await c.refundReservation(res[1]);
  assert.equal((await c.admitVisitor("10.1.1.1", lim)).ok, true);
});

test("ambiguous log: corrupt record shape fails closed on load", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "vm-reconcile-"));
  const file = path.join(dir, "c.json");
  const { writeFileSync } = await import("node:fs");
  writeFileSync(
    file,
    JSON.stringify({
      days: {},
      lifetime: 0,
      journal: { r1: { status: "maybe" } },
    }),
  );
  const c = createCallCounters({ file });
  await assert.rejects(
    () => c.listAmbiguous(),
    (e) => e.status === 503 && /invalid shape/.test(e.message),
  );
});

test("bolna execution reader maps the documented contract (injected transport)", async () => {
  const calls = [];
  const reader = createBolnaExecutionReader({
    apiKey: "dummy",
    vendorFetchImpl: async (url, opts) => {
      calls.push({ url, auth: opts.headers.authorization });
      if (
        url.includes("/executions/exec-1?") ||
        url.endsWith("/executions/exec-1")
      )
        return {
          ok: true,
          status: 200,
          json: async () => ({ id: "exec-1", status: "completed" }),
        };
      if (url.endsWith("/executions/ghost")) return { ok: false, status: 404 };
      if (url.includes("/v2/agent/agent-x/executions"))
        return {
          ok: true,
          status: 200,
          json: async () => ({ data: [{ id: "w1" }], has_more: false }),
        };
      return { ok: false, status: 500 };
    },
  });
  const found = await reader("get", { executionId: "exec-1" });
  assert.equal(found.kind, "found");
  assert.equal(found.execution.id, "exec-1");
  assert.equal(
    (await reader("get", { executionId: "ghost" })).kind,
    "not-found",
  );
  const list = await reader("list", {
    agentId: "agent-x",
    from: "2026-11-01T11:55:00Z",
    to: "2026-11-01T12:10:00Z",
  });
  assert.equal(list.kind, "ok");
  assert.equal(list.executions[0].id, "w1");
  assert.ok(calls[2].url.includes("provider=web-call"));
  assert.equal(calls[0].auth, "Bearer dummy");
  // Network failure -> error kind, never throws.
  const errReader = createBolnaExecutionReader({
    apiKey: "d",
    vendorFetchImpl: async () => {
      throw new Error("boom");
    },
  });
  assert.equal((await errReader("get", { executionId: "x" })).kind, "error");
});

test("reconcile: expected agent UNKNOWN -> never auto-settles, held manual charged", async () => {
  const c = await mkCounters();
  const res = await mkAmbiguous(c, { sessionId: "exec-1" });
  const report = await reconcileAmbiguousMints({
    counters: c,
    agentId: null, // expected agent missing: binding cannot be verified
    vendorRead: async () => ({
      kind: "found",
      execution: { id: "exec-1", agent_id: "agent-OTHER", status: "completed" },
    }),
  });
  assert.deepEqual(report.settled, []);
  assert.deepEqual(report.stillAmbiguous, [res]);
  assert.equal(report.manualCandidates[0].reservation, res);
  assert.equal(report.manualCandidates[0].reason, "expected-agent-unknown");
  assert.equal((await c.listAmbiguous()).length, 1); // stays charged
});

test("reconcile: tag candidate lacking execution id and agent_id is NOT auto-settled", async () => {
  const c = await mkCounters();
  const res = await mkAmbiguous(c, { sessionId: null });
  const report = await reconcileAmbiguousMints({
    counters: c,
    agentId: "agent-x",
    vendorRead: async () => ({
      kind: "ok",
      executions: [
        // Carries our tag but has NO execution id and NO agent_id: the
        // binding is unverifiable -> held manual charged, never settled.
        { status: "completed", user_data: { vm_res: res } },
      ],
    }),
  });
  assert.deepEqual(report.settled, []);
  assert.deepEqual(report.stillAmbiguous, [res]);
  assert.equal(report.manualCandidates.length, 1);
  assert.equal((await c.listAmbiguous()).length, 1);
});

test("journal (file): update without session id preserves known id; conflicting id rejected", async () => {
  const c = await mkCounters();
  const adm = await c.admitVisitor("1.1.1.1", LIM);
  await c.recordAmbiguous({
    reservation: adm.reservation,
    sessionId: "exec-9",
    errorClass: "http-502",
  });
  // Weaker repeat update (no session id): known id preserved, error updated.
  await c.recordAmbiguous({
    reservation: adm.reservation,
    errorClass: "network",
  });
  let list = await c.listAmbiguous();
  assert.equal(list[0].sessionId, "exec-9");
  assert.equal(list[0].errorClass, "network");
  // Conflicting non-empty id: rejected - original id AND errorClass win.
  await c.recordAmbiguous({
    reservation: adm.reservation,
    sessionId: "exec-OTHER",
    errorClass: "http-500",
  });
  list = await c.listAmbiguous();
  assert.equal(list.length, 1);
  assert.equal(list[0].sessionId, "exec-9");
  assert.equal(list[0].errorClass, "network");
});
