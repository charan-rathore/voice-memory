// Upstash counter backend: full behavioral qualification against a mocked
// transport. NO network, NO account: the fake interprets the exact commands
// and Lua scripts the adapter sends, so the flows (limits, atomic
// reservation, exactly-once refund, owner sharing, fail-closed) are tested,
// not just the request shapes.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createUpstashCallCounters,
  selectCallCounters,
} from "../src/public-call-counters-upstash.mjs";

function fakeRedis() {
  const strings = new Map();
  const hashes = new Map();
  const calls = [];
  const h = (k) => hashes.get(k) ?? hashes.set(k, new Map()).get(k);
  const cmd = (name, args) => {
    switch (name) {
      case "GET":
        return strings.get(args[0]) ?? null;
      case "SET":
        strings.set(args[0], args[1]);
        return "OK";
      case "INCR":
        strings.set(args[0], String(Number(strings.get(args[0]) ?? 0) + 1));
        return Number(strings.get(args[0]));
      case "DECR":
        strings.set(args[0], String(Number(strings.get(args[0]) ?? 0) - 1));
        return Number(strings.get(args[0]));
      case "DEL":
        strings.delete(args[0]);
        return 1;
      case "HGET":
        return h(args[0]).get(args[1]) ?? null;
      case "HINCRBY": {
        const v = Number(h(args[0]).get(args[1]) ?? 0) + Number(args[2]);
        h(args[0]).set(args[1], String(v));
        return v;
      }
      case "EXPIRE":
        return 1;
      case "EXISTS":
        return strings.has(args[0]) || hashes.has(args[0]) ? 1 : 0;
      case "PING":
        return "PONG";
      case "HLEN":
        return h(args[0]).size;
      case "HSET":
        h(args[0]).set(args[1], args[2]);
        return 1;
      case "HDEL":
        return h(args[0]).delete(args[1]) ? 1 : 0;
      case "HGETALL": {
        const out = [];
        for (const [f, v] of h(args[0])) out.push(f, v);
        return out;
      }
      default:
        throw new Error(`fake does not implement ${name}`);
    }
  };
  // Interpret the adapter's exact Lua scripts by their Redis primitives.
  const evalLua = (script, numkeys, ...rest) => {
    const keys = rest.slice(0, Number(numkeys));
    const args = rest.slice(Number(numkeys));
    if (script.includes("perIpDay")) {
      // ADMIT_LUA (gap key + atomic pre-mint journal)
      const [day, lifetimeK, resK, gapK, journalK] = keys;
      const [ip, perIpDay, globalDay, lifetimeMax, res, dayStr, gapMs, at] =
        args;
      if (Number(gapMs) > 0 && strings.has(gapK)) return "gap";
      if (h(journalK).size >= 100) return "journal-full";
      const lifetime = Number(strings.get(lifetimeK) ?? 0);
      if (lifetime >= Number(lifetimeMax)) return "lifetime";
      const total = Number(h(day).get("total") ?? 0);
      if (total >= Number(globalDay)) return "global-day";
      const mine = Number(h(day).get(ip) ?? 0);
      if (mine >= Number(perIpDay)) return "visitor-day";
      h(day).set(ip, String(mine + 1));
      h(day).set("total", String(total + 1));
      strings.set(lifetimeK, String(lifetime + 1));
      strings.set(resK, `v|${ip}|${dayStr}`);
      h(journalK).set(res, `v|${ip}|${dayStr}|admitted|${at}`);
      if (Number(gapMs) > 0) strings.set(gapK, res);
      return "ok";
    }
    if (script.includes("|ambiguous|")) {
      // recordAmbiguous: idempotent structured update; recover on missing.
      // Mirrors the Lua: preserve a known session id on absence; a
      // conflicting non-empty id is rejected (original id + errorClass
      // win); original provenance (kind/day/time) preserved.
      const v = h(keys[0]).get(args[0]);
      let head;
      let oldsid = "";
      let olderr = "";
      if (v) {
        const pos = v.indexOf("|ambiguous|");
        if (pos >= 0) {
          head = v.slice(0, pos);
          const tail = v.slice(pos + 11);
          const sep = tail.indexOf("|");
          oldsid = tail.slice(0, sep);
          olderr = tail.slice(sep + 1);
        } else {
          head = v;
        }
      } else {
        head = `u|unknown|${args[4]}|admitted|${args[3]}`;
      }
      let sid = args[1];
      let err = args[2];
      if (sid === "") sid = oldsid;
      else if (oldsid !== "" && oldsid !== sid) {
        sid = oldsid;
        err = olderr;
      }
      h(keys[0]).set(args[0], `${head}|ambiguous|${sid}|${err}`);
      return "ok";
    }
    if (script.includes("if not v then")) {
      // REFUND_LUA: targets the ADMISSION day's bucket, never today's;
      // releases the cross-instance gap ONLY if this reservation owns it;
      // owner reservations adjust ONLY the owner counter; journal resolved.
      const [, lifetimeK, resK, gapK, ownerK, journalK] = keys;
      const [reservation] = args;
      const v = strings.get(resK);
      if (!v) return "noop";
      strings.delete(resK);
      h(journalK).delete(reservation);
      if (strings.get(gapK) === reservation) strings.delete(gapK);
      const [kind, ...rest] = v.split("|");
      if (kind === "v") {
        const dayStr = rest.at(-1);
        const ip = rest.slice(0, -1).join("|");
        const day = `vmc:day:${dayStr}`;
        const mine = Number(h(day).get(ip) ?? 0);
        if (mine > 0) h(day).set(ip, String(mine - 1));
        const total = Number(h(day).get("total") ?? 0);
        if (total > 0) h(day).set("total", String(total - 1));
        const lifetime = Number(strings.get(lifetimeK) ?? 0);
        if (lifetime > 0) strings.set(lifetimeK, String(lifetime - 1));
      } else {
        const ol = Number(strings.get(ownerK) ?? 0);
        if (ol > 0) strings.set(ownerK, String(ol - 1));
      }
      return "released";
    }
    if (script.includes("HDEL")) {
      // settleReservation: DEL reservation + HDEL journal.
      strings.delete(keys[0]);
      h(keys[1]).delete(args[0]);
      return "ok";
    }
    // admitOwner inline script: journal cap + INCR + SET + HSET.
    if (h(keys[2]).size >= 100) return "journal-full";
    strings.set(keys[0], String(Number(strings.get(keys[0]) ?? 0) + 1));
    strings.set(keys[1], args[0]);
    h(keys[2]).set(args[1], args[2]);
    return "ok";
  };
  const fetchImpl = async (url, opts) => {
    const body = JSON.parse(opts.body);
    calls.push({ url, auth: opts.headers.authorization, body });
    const [name, ...args] = body;
    try {
      const result =
        name === "EVAL"
          ? evalLua(args[0], args[1], ...args.slice(2))
          : cmd(name, args);
      return { ok: true, json: async () => ({ result }) };
    } catch (e) {
      return { ok: true, json: async () => ({ error: e.message }) };
    }
  };
  return { fetchImpl, calls, strings, hashes };
}

const LIM = { perIpDay: 2, globalDay: 4, lifetimeMax: 5 };
const mk = (extra = {}) => {
  const { fetchImpl, calls } = fakeRedis();
  const c = createUpstashCallCounters({
    url: "https://example.upstash.io",
    token: "test-token",
    fetchImpl,
    ...extra,
  });
  return { c, calls };
};

test("upstash: per-visitor day, global day and lifetime limits enforced", async () => {
  const { c } = mk();
  assert.equal((await c.admitVisitor("1.1.1.1", LIM)).ok, true);
  assert.equal((await c.admitVisitor("1.1.1.1", LIM)).ok, true);
  assert.equal((await c.admitVisitor("1.1.1.1", LIM)).scope, "visitor-day");
  assert.equal((await c.admitVisitor("2.2.2.2", LIM)).ok, true);
  assert.equal((await c.admitVisitor("3.3.3.3", LIM)).ok, true);
  assert.equal((await c.admitVisitor("4.4.4.4", LIM)).scope, "global-day");
  const tight = mk();
  assert.equal(
    (
      await tight.c.admitVisitor("9.9.9.9", {
        ...LIM,
        globalDay: 9,
        lifetimeMax: 1,
      })
    ).ok,
    true,
  );
  assert.equal(
    (
      await tight.c.admitVisitor("9.9.9.9", {
        ...LIM,
        globalDay: 9,
        lifetimeMax: 1,
      })
    ).scope,
    "lifetime",
  );
});

test("upstash: reservation refund is exactly-once and never releases another call", async () => {
  const { c } = mk();
  const a = await c.admitVisitor("1.1.1.1", LIM);
  const b = await c.admitVisitor("1.1.1.1", LIM);
  await c.refundReservation(a.reservation);
  await c.refundReservation(a.reservation); // duplicate: no-op
  await c.refundReservation("r_forged"); // unknown: no-op
  // A released one slot: visitor has 1 counted, one more admit fits.
  assert.equal((await c.admitVisitor("1.1.1.1", LIM)).ok, true);
  assert.equal((await c.admitVisitor("1.1.1.1", LIM)).scope, "visitor-day");
  // Settle B then a late refund: no-op.
  await c.settleReservation(b.reservation);
  await c.refundReservation(b.reservation);
  assert.equal((await c.peek()).lifetime, 2);
});

test("upstash: owner counted, never capped by the visitor abuse budget", async () => {
  const { c } = mk();
  assert.equal(
    (await c.admitVisitor("1.1.1.1", { ...LIM, lifetimeMax: 1 })).ok,
    true,
  );
  assert.equal(
    (await c.admitVisitor("2.2.2.2", { ...LIM, lifetimeMax: 1 })).scope,
    "lifetime",
  );
  const own = await c.admitOwner();
  assert.equal(own.ok, true);
  // Owner observability is SEPARATE: the visitor lifetime stays untouched.
  let pk = await c.peek();
  assert.equal(pk.lifetime, 1);
  assert.equal(pk.ownerLifetime, 1);
  await c.settleReservation(own.reservation);
  await c.refundReservation(own.reservation); // no-op after settle
  pk = await c.peek();
  assert.equal(pk.lifetime, 1);
  assert.equal(pk.ownerLifetime, 1);
});

test("upstash: refund releases the gap ONLY when this reservation owns it", async () => {
  const { fetchImpl, strings } = fakeRedis();
  const c = createUpstashCallCounters({
    url: "https://example.upstash.io",
    token: "t",
    fetchImpl,
  });
  const lim = { ...LIM, gapMs: 45000 };
  const a = await c.admitVisitor("1.1.1.1", lim);
  assert.equal(a.ok, true);
  assert.equal(strings.get("vmc:gap"), a.reservation);
  // Gap re-owned by a different call: a stale refund of A must NOT release it.
  strings.set("vmc:gap", "r_someone_else");
  await c.refundReservation(a.reservation);
  assert.equal(strings.get("vmc:gap"), "r_someone_else");
  // Owner refund must not clear a visitor-owned gap either (owner mints
  // never own the gap).
  const own = await c.admitOwner();
  await c.refundReservation(own.reservation);
  assert.equal(strings.get("vmc:gap"), "r_someone_else");
  // Normal case: gap expires (or is released), a new mint re-owns it, and
  // ITS owning refund releases the line.
  strings.delete("vmc:gap");
  const b = await c.admitVisitor("1.1.1.1", {
    ...lim,
    perIpDay: 9,
    globalDay: 9,
  });
  assert.equal(b.ok, true);
  assert.equal(strings.get("vmc:gap"), b.reservation);
  await c.refundReservation(b.reservation);
  assert.equal(strings.has("vmc:gap"), false);
});

test("upstash: cross-midnight refund debits the ADMISSION day, never today", async () => {
  let t = Date.parse("2026-11-01T23:59:00Z");
  const { c } = mk({ now: () => t });
  const lim = { perIpDay: 1, globalDay: 1, lifetimeMax: 9 };
  const a = await c.admitVisitor("1.1.1.1", lim);
  assert.equal(a.ok, true);
  // Day 2: another visitor fills the new day.
  t = Date.parse("2026-11-02T00:01:00Z");
  const b = await c.admitVisitor("2.2.2.2", lim);
  assert.equal(b.ok, true);
  // Refunding day-1's reservation must NOT release day-2 capacity.
  await c.refundReservation(a.reservation);
  assert.equal((await c.admitVisitor("3.3.3.3", lim)).scope, "global-day");
  assert.equal((await c.peek()).lifetime, 1); // only B stays counted
});

test("upstash: day key rolls on UTC midnight (same semantics as file backend)", async () => {
  let t = Date.parse("2026-11-01T23:59:00Z");
  const { c, calls } = mk({ now: () => t });
  await c.admitVisitor("1.1.1.1", LIM);
  assert.ok(calls[0].body.includes("vmc:day:2026-11-01"));
  t = Date.parse("2026-11-02T00:01:00Z");
  await c.admitVisitor("1.1.1.1", LIM);
  assert.ok(calls.at(-1).body.includes("vmc:day:2026-11-02"));
});

test("upstash: store failure fails closed with 503", async () => {
  const c = createUpstashCallCounters({
    url: "https://example.upstash.io",
    token: "t",
    fetchImpl: async () => ({ ok: false, status: 500 }),
  });
  await assert.rejects(
    () => c.admitVisitor("1.1.1.1", LIM),
    (e) => e.status === 503,
  );
});

test("upstash: request shape hits the REST endpoint with the bearer token", async () => {
  const { c, calls } = mk();
  await c.admitVisitor("1.1.1.1", LIM);
  assert.equal(calls[0].url, "https://example.upstash.io");
  assert.equal(calls[0].auth, "Bearer test-token");
  assert.equal(calls[0].body[0], "EVAL");
});

test("selector: durable-by-default; file backend only on explicit dev/test opt-in; PARTIAL always fails closed", () => {
  // Default (nothing set): FAILS CLOSED - production safety must not depend
  // on remembering an opt-in env var.
  assert.throws(
    () => selectCallCounters({ env: {} }),
    (e) => e.status === 503 && /durable call-counter store/.test(e.message),
  );
  assert.throws(
    () =>
      selectCallCounters({
        env: { VM_PUBLIC_VOICE: "on", NODE_ENV: "production" },
      }),
    (e) => e.status === 503,
  );
  // Explicit local dev/test opt-in returns null (caller uses the file backend).
  assert.equal(
    selectCallCounters({ env: { VM_COUNTERS_ALLOW_FILE: "on" } }),
    null,
  );
  // Partial config is a misconfiguration, never a silent downgrade.
  assert.throws(
    () =>
      selectCallCounters({ env: { VM_UPSTASH_REDIS_REST_URL: "https://x" } }),
    (e) => e.status === 503,
  );
  assert.throws(
    () => selectCallCounters({ env: { VM_UPSTASH_REDIS_REST_TOKEN: "t" } }),
    (e) => e.status === 503,
  );
  // Full config: durable backend.
  const c = selectCallCounters({
    env: {
      VM_UPSTASH_REDIS_REST_URL: "https://x",
      VM_UPSTASH_REDIS_REST_TOKEN: "t",
    },
  });
  assert.ok(c && typeof c.admitVisitor === "function");
  assert.ok(typeof c.verify === "function");
});

test("upstash: cross-instance mint gap is enforced inside the atomic admission", async () => {
  // Two adapter instances sharing one store (two server processes): the
  // second admission within the gap is refused even though each instance's
  // local memory is empty.
  const { fetchImpl } = fakeRedis();
  const a = createUpstashCallCounters({
    url: "https://example.upstash.io",
    token: "t",
    fetchImpl,
  });
  const b = createUpstashCallCounters({
    url: "https://example.upstash.io",
    token: "t",
    fetchImpl,
  });
  const lim = { ...LIM, gapMs: 45000 };
  const first = await a.admitVisitor("1.1.1.1", lim);
  assert.equal(first.ok, true);
  assert.equal((await b.admitVisitor("2.2.2.2", lim)).scope, "gap");
  // A pre-session refund releases the gap (the mint never happened).
  await a.refundReservation(first.reservation);
  assert.equal((await b.admitVisitor("2.2.2.2", lim)).ok, true);
});

test("upstash: owner refund adjusts ONLY the owner counter, exactly once", async () => {
  const { c } = mk();
  // Active visitor + active owner reservation.
  const v = await c.admitVisitor("1.1.1.1", LIM);
  assert.equal(v.ok, true);
  const o = await c.admitOwner();
  assert.equal(o.ok, true);
  let pk = await c.peek();
  assert.equal(pk.lifetime, 1);
  assert.equal(pk.ownerLifetime, 1);
  // Owner refund: visitor lifetime and day bucket untouched.
  await c.refundReservation(o.reservation);
  pk = await c.peek();
  assert.equal(pk.lifetime, 1);
  assert.equal(pk.ownerLifetime, 0);
  assert.equal(pk.today.total, 1);
  // Duplicate owner refund: no-op, never drives the counter negative.
  await c.refundReservation(o.reservation);
  pk = await c.peek();
  assert.equal(pk.lifetime, 1);
  assert.equal(pk.ownerLifetime, 0);
});

test("upstash: owner-only refund drives owner counter to exactly 0", async () => {
  const { c } = mk();
  const o = await c.admitOwner();
  await c.refundReservation(o.reservation);
  const pk = await c.peek();
  assert.equal(pk.ownerLifetime, 0);
  assert.equal(pk.lifetime, 0);
});

test("upstash journal: 100 unresolved refuse every mint atomically, owner included; concurrent never exceed", async () => {
  const { fetchImpl, hashes } = fakeRedis();
  const c = createUpstashCallCounters({
    url: "https://example.upstash.io",
    token: "t",
    fetchImpl,
  });
  const lim = { perIpDay: 1000, globalDay: 1000, lifetimeMax: 1000 };
  // Fill the journal to 99 unresolved.
  for (let i = 0; i < 99; i++) {
    const a = await c.admitVisitor(`10.0.0.${i}`, lim);
    assert.equal(a.ok, true);
  }
  // 10 concurrent admissions at 99: EXACTLY ONE gets the last journal slot.
  const rs = await Promise.all(
    Array.from({ length: 10 }, (_, i) => c.admitVisitor(`10.1.0.${i}`, lim)),
  );
  assert.equal(rs.filter((x) => x.ok).length, 1);
  assert.equal(rs.filter((x) => x.scope === "journal-full").length, 9);
  assert.equal(hashes.get("vmc:journal").size, 100); // never 106
  // Full: visitor and owner both refuse.
  assert.equal((await c.admitVisitor("10.2.0.1", lim)).scope, "journal-full");
  assert.equal((await c.admitOwner()).scope, "journal-full");
  // Resolving one entry frees exactly one slot, for either path.
  const anyRes = [...hashes.get("vmc:journal").keys()][0];
  await c.refundReservation(anyRes);
  assert.equal((await c.admitOwner()).ok, true);
  assert.equal((await c.admitVisitor("10.2.0.1", lim)).scope, "journal-full");
});

test("upstash journal: idempotent structured updates, lost-ack recovery, stale admission visible", async () => {
  let t = Date.parse("2026-11-01T12:00:00Z");
  const { c } = mk({ now: () => t });
  const a = await c.admitVisitor("1.1.1.1", LIM);
  await c.recordAmbiguous({
    reservation: a.reservation,
    sessionId: "exec-9",
    errorClass: "http-502",
  });
  // Repeated update: structured, original timestamp preserved, no tail growth.
  t += 60000;
  await c.recordAmbiguous({
    reservation: a.reservation,
    sessionId: "exec-9",
    errorClass: "http-503",
  });
  let list = await c.listAmbiguous();
  assert.equal(list.length, 1);
  assert.equal(list[0].at, Date.parse("2026-11-01T12:00:00Z")); // original
  assert.equal(Number.isNaN(list[0].at), false);
  assert.equal(list[0].errorClass, "http-503"); // latest
  assert.equal(list[0].sessionId, "exec-9");
  // Lost ack: settle committed, reply lost, known live session recovered.
  const b = await c.admitVisitor("2.2.2.2", LIM);
  await c.settleReservation(b.reservation); // journal resolved...
  await c.recordAmbiguous({
    // ...then a late ambiguous report arrives with the KNOWN session id.
    reservation: b.reservation,
    sessionId: "exec-live-2",
    errorClass: "settle-failed",
  });
  list = await c.listAmbiguous();
  const rec = list.find((x) => x.reservation === b.reservation);
  assert.ok(rec, "recovered record visible");
  assert.equal(rec.sessionId, "exec-live-2");
  assert.equal(rec.kind, "unknown"); // admission metadata lost with the ack
  // Stale admitted-only (crash before outcome): invisible fresh, visible aged.
  const d = await c.admitVisitor("3.3.3.3", LIM);
  t += 11 * 60000;
  list = await c.listAmbiguous();
  const stale = list.find((x) => x.reservation === d.reservation);
  assert.ok(stale, "stale admission surfaced");
  assert.equal(stale.staleAdmission, true);
  assert.equal(stale.kind, "visitor");
  // Settle resolves the journal entry.
  await c.settleReservation(a.reservation);
  assert.equal(
    (await c.listAmbiguous()).filter((x) => x.reservation === a.reservation)
      .length,
    0,
  );
});

test("upstash journal: update without session id preserves known id; conflicting id rejected", async () => {
  const { c } = mk();
  const a = await c.admitVisitor("1.1.1.1", LIM);
  await c.recordAmbiguous({
    reservation: a.reservation,
    sessionId: "exec-9",
    errorClass: "http-502",
  });
  // Weaker repeat update: previously known session id is NOT erased.
  await c.recordAmbiguous({
    reservation: a.reservation,
    errorClass: "network",
  });
  let list = await c.listAmbiguous();
  assert.equal(list[0].sessionId, "exec-9");
  assert.equal(list[0].errorClass, "network");
  // Conflicting non-empty id: rejected - original id and errorClass win.
  await c.recordAmbiguous({
    reservation: a.reservation,
    sessionId: "exec-OTHER",
    errorClass: "http-500",
  });
  list = await c.listAmbiguous();
  assert.equal(list.length, 1);
  assert.equal(list[0].sessionId, "exec-9");
  assert.equal(list[0].errorClass, "network");
});

test("upstash journal: lost-ack recovery beyond 100 is KEPT; threshold refuses only new mints", async () => {
  const { fetchImpl, hashes } = fakeRedis();
  const c = createUpstashCallCounters({
    url: "https://example.upstash.io",
    token: "t",
    fetchImpl,
  });
  const lim = { perIpDay: 1000, globalDay: 1000, lifetimeMax: 1000 };
  for (let i = 0; i < 100; i++) {
    const a = await c.admitVisitor(`10.0.0.${i}`, lim);
    assert.equal(a.ok, true);
  }
  assert.equal(hashes.get("vmc:journal").size, 100);
  // Recovery of a previously-issued lost-ack reservation is not a new
  // mint: the record is kept even beyond the admission threshold.
  await c.recordAmbiguous({
    reservation: "previously-issued-lost-ack",
    sessionId: "live",
    errorClass: "settle-failed",
  });
  assert.equal(hashes.get("vmc:journal").size, 101); // no overflow drop
  const list = await c.listAmbiguous();
  const rec = list.find((x) => x.reservation === "previously-issued-lost-ack");
  assert.ok(rec, "recovered record visible");
  assert.equal(rec.sessionId, "live");
  assert.equal(rec.kind, "unknown"); // recovered entry provenance
  // The 100 threshold is an ADMISSION ceiling, not a storage ceiling.
  assert.equal((await c.admitOwner()).scope, "journal-full");
  assert.equal((await c.admitVisitor("10.9.9.9", lim)).scope, "journal-full");
});
