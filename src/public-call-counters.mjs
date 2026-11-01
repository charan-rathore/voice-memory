// Public-call counters: rate smoothing for the visitor voice mint and the
// owner mint, kept in a small JSON file so counts survive a process
// spin-down within one machine.
//
// WHAT THIS IS NOT: a money ceiling, and NOT multi-instance safe. On
// Render's ephemeral filesystem a missing file cannot be told apart from a
// first boot, so these counters can reset to zero on redeploy/restart; and
// each process caches its state, so two processes sharing one file would
// BOTH issue up to the cap (stale-cache over-issue). One process, one
// file, rate smoothing only. The hard financial brakes are the vendor
// wallet (only once the vendor confirms credits-only behavior), the
// vendor-side call duration cap (once verified), and the mint gap. A store
// that EXISTS but cannot be read, is corrupt, has an invalid shape, or
// cannot be written fails closed (no mint).
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

const dayKey = (ms) => new Date(ms).toISOString().slice(0, 10);

const isCount = (n) => Number.isSafeInteger(n) && n >= 0;
// Strict shape: every counter must be a non-negative safe integer, every
// day bucket {total, perIp{}}, every reservation {ip, day}. A parseable
// file with the wrong shape is NOT accepted (no fail-open comparisons, no
// string-concat arithmetic on untrusted values).
function validShape(s) {
  if (!s || typeof s !== "object" || Array.isArray(s)) return false;
  if (!isCount(s.lifetime)) return false;
  if (s.ownerLifetime !== undefined && !isCount(s.ownerLifetime)) return false;
  if (!s.days || typeof s.days !== "object" || Array.isArray(s.days))
    return false;
  for (const b of Object.values(s.days)) {
    if (!b || typeof b !== "object" || !isCount(b.total)) return false;
    if (!b.perIp || typeof b.perIp !== "object" || Array.isArray(b.perIp))
      return false;
    if (!Object.values(b.perIp).every(isCount)) return false;
  }
  if (
    s.journal !== undefined &&
    (!s.journal ||
      typeof s.journal !== "object" ||
      Array.isArray(s.journal) ||
      !Object.values(s.journal).every(
        (a) =>
          a &&
          (a.status === "admitted" || a.status === "ambiguous") &&
          typeof a.at === "number" &&
          (a.kind === "visitor" ||
            a.kind === "owner" ||
            a.kind === "unknown") &&
          (a.recovered === undefined || typeof a.recovered === "boolean") &&
          typeof a.day === "string" &&
          (a.sessionId === null || typeof a.sessionId === "string") &&
          (a.errorClass === null || typeof a.errorClass === "string") &&
          (a.settleFailed === undefined || typeof a.settleFailed === "boolean"),
      ))
  )
    return false;
  if (
    s.reservations !== undefined &&
    (typeof s.reservations !== "object" ||
      s.reservations === null ||
      !Object.values(s.reservations).every(
        (r) =>
          r &&
          typeof r.ip === "string" &&
          typeof r.day === "string" &&
          (r.kind === "visitor" || r.kind === "owner"),
      ))
  )
    return false;
  return true;
}

// Backend seam: the shipped backend is this JSON file. The public methods
// are async so a durable remote backend (e.g. an approved Upstash REST
// store) can replace the file without touching any call site. Until such a
// store exists, every guarantee here is bounded by the local disk's life.
export function createCallCounters({ file, now = () => Date.now() }) {
  if (!file) throw new Error("createCallCounters needs a file path.");
  let state = null;
  const fail = (msg) => {
    const e = Error(msg);
    e.status = 503;
    return e;
  };
  const load = () => {
    if (state) return state;
    let raw = null;
    try {
      raw = readFileSync(file, "utf8");
    } catch (e) {
      if (e.code !== "ENOENT") throw fail("Call counter store is unreadable.");
    }
    if (raw == null) {
      state = { initializedAt: now(), days: {}, lifetime: 0, reservations: {} };
    } else {
      try {
        state = JSON.parse(raw);
      } catch {
        throw fail("Call counter store is corrupt.");
      }
      if (!validShape(state))
        throw fail("Call counter store has invalid shape.");
    }
    return state;
  };
  const save = () => {
    try {
      mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
      renameSync(tmp, file);
    } catch {
      throw fail("Call counter store is unwritable.");
    }
  };
  const bucket = () => {
    const s = load();
    const d = dayKey(now());
    if (!s.days[d]) {
      // Keep a week of day buckets; the file stays tiny.
      const keys = Object.keys(s.days).sort();
      while (keys.length > 7) delete s.days[keys.shift()];
      s.days[d] = { total: 0, perIp: {} };
    }
    return s.days[d];
  };
  return {
    // Visitor mint: per-visitor day allowance + global day allowance +
    // lifetime count. One atomic check-and-count; a refused call consumes
    // nothing. Per-IP shaping only (the address is spoofable); the global
    // and lifetime counts hold regardless. A successful admission returns a
    // unique reservation id: ONLY that id, exactly once, can hand the
    // allowance back (settleReservation on mint success makes it
    // non-refundable; refundReservation on mint failure releases it).
    async admitVisitor(ip, { perIpDay, globalDay, lifetimeMax }) {
      const s = load();
      const b = bucket();
      if (s.lifetime >= lifetimeMax) return { ok: false, scope: "lifetime" };
      if (b.total >= globalDay) return { ok: false, scope: "global-day" };
      if ((b.perIp[ip] ?? 0) >= perIpDay)
        return { ok: false, scope: "visitor-day" };
      // Pre-mint journal, atomic with admission: every admitted reservation
      // is journaled UNRESOLVED before any vendor call can happen. A full
      // journal (100 unresolved outcomes) refuses the mint - no journal
      // write, no mint. Applies to owner mints identically (a safety
      // invariant, not a count cap).
      s.journal = s.journal ?? {};
      if (Object.keys(s.journal).length >= 100)
        return { ok: false, scope: "journal-full" };
      b.perIp[ip] = (b.perIp[ip] ?? 0) + 1;
      b.total += 1;
      s.lifetime += 1;
      const reservation = `r_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
      s.reservations = s.reservations ?? {};
      s.reservations[reservation] = { ip, day: dayKey(now()), kind: "visitor" };
      s.journal[reservation] = {
        status: "admitted",
        at: now(),
        kind: "visitor",
        day: dayKey(now()),
        sessionId: null,
        errorClass: null,
      };
      // Pending reservations stay small: prune anything from older days.
      for (const [id, r] of Object.entries(s.reservations))
        if (!(r.day in s.days)) delete s.reservations[id];
      save();
      return { ok: true, reservation };
    },
    // Mint succeeded: the reservation becomes a real call, never refundable.
    async settleReservation(reservation) {
      const s = load();
      if (s.reservations && reservation in s.reservations) {
        delete s.reservations[reservation];
        if (s.journal) delete s.journal[reservation]; // outcome: resolved
        save();
      }
    },
    // Mint failed: exactly-once release of THIS reservation. A duplicate or
    // unknown id is a no-op - it can never release another call's capacity.
    async refundReservation(reservation) {
      const s = load();
      const r = s.reservations?.[reservation];
      if (!r) return; // unknown or already settled/refunded: no-op
      delete s.reservations[reservation];
      if (s.journal) delete s.journal[reservation]; // outcome: released
      if (r.kind !== "owner") {
        const b = s.days[r.day];
        if (b) {
          if ((b.perIp[r.ip] ?? 0) > 0) b.perIp[r.ip] -= 1;
          if (b.total > 0) b.total -= 1;
        }
        if (s.lifetime > 0) s.lifetime -= 1;
      } else if ((s.ownerLifetime ?? 0) > 0) {
        s.ownerLifetime -= 1;
      }
      save();
    },
    // Owner mint: COUNTED but never capped by the visitor abuse budget -
    // the owner's unlimited call COUNT is preserved, and the lifetime count
    // stays the observability point an eventual authorized spend brake can
    // bind. Same reservation lifecycle as visitor mints: only this
    // reservation, exactly once, can be refunded or settled.
    async admitOwner() {
      const s = load();
      // Owner observability is a SEPARATE counter: owner mints never
      // consume the visitor lifetime admission budget (that coupling was
      // never owner-approved). Owner calls stay unlimited in count - but
      // the unresolved-outcome journal is a hard safety invariant for
      // everyone: full journal, no mint.
      s.journal = s.journal ?? {};
      if (Object.keys(s.journal).length >= 100)
        return { ok: false, scope: "journal-full" };
      s.ownerLifetime = (s.ownerLifetime ?? 0) + 1;
      const reservation = `r_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
      s.reservations = s.reservations ?? {};
      s.reservations[reservation] = {
        ip: "owner",
        day: dayKey(now()),
        kind: "owner",
      };
      s.journal[reservation] = {
        status: "admitted",
        at: now(),
        kind: "owner",
        day: dayKey(now()),
        sessionId: null,
        errorClass: null,
      };
      save();
      return { ok: true, reservation };
    },
    // Outcome update: mark a journaled reservation ambiguous (mint outcome
    // unknown or settle failed after a live session). Idempotent and
    // structured: the original admission timestamp is preserved across
    // repeated updates. A MISSING entry means the settle committed but its
    // ack was lost (or a crash between admission and outcome write): the
    // record is RECREATED with whatever is known (a known live session id
    // is never thrown away) and flagged recovered - visible, never silent.
    async recordAmbiguous(rec) {
      const s = load();
      s.journal = s.journal ?? {};
      let j = s.journal[rec.reservation];
      if (!j) {
        j = s.journal[rec.reservation] = {
          status: "admitted",
          at: now(),
          kind: "unknown",
          day: dayKey(now()),
          sessionId: null,
          errorClass: null,
          recovered: true,
        };
      }
      j.status = "ambiguous";
      if (rec.sessionId && j.sessionId && rec.sessionId !== j.sessionId) {
        // Conflicting known ids: reject the update's identity claim - the
        // original session id and errorClass win; provenance (kind/day/
        // time) is untouched. The record stays charged for manual review.
      } else {
        // An update without a session id never erases a previously
        // known one (preserve non-empty on absence).
        j.sessionId = rec.sessionId ?? j.sessionId ?? null;
        j.errorClass = String(rec.errorClass ?? "unknown");
      }
      if (rec.settleFailed) j.settleFailed = true;
      save();
    },
    // Unresolved outcomes awaiting reconciliation: ambiguous records AND
    // admitted-only records older than the stale threshold (a mint resolves
    // in seconds; an old admitted-only entry is a crashed/lost outcome and
    // must be VISIBLE, original metadata preserved). The journal is an
    // unresolved-outcome safety record only - settled normal calls leave no
    // durable trace here, and this is NOT a billing accrual.
    async listAmbiguous({ staleMs = 10 * 60000 } = {}) {
      const s = load();
      return Object.entries(s.journal ?? {})
        .filter(
          ([, j]) =>
            j.status === "ambiguous" ||
            (j.status === "admitted" && now() - j.at > staleMs),
        )
        .map(([reservation, j]) => ({
          reservation,
          ...j,
          staleAdmission: j.status === "admitted" || undefined,
        }));
    },
    async clearAmbiguous(reservation) {
      const s = load();
      if (s.journal && reservation in s.journal) {
        delete s.journal[reservation];
        save();
      }
    },
    async peek() {
      const s = load();
      return {
        initializedAt: s.initializedAt,
        lifetime: s.lifetime,
        ownerLifetime: s.ownerLifetime ?? 0,
        today: s.days[dayKey(now())] ?? null,
      };
    },
  };
}
