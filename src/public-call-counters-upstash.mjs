// Durable call-counter backend for an Upstash Redis REST store.
// PREPARATION ONLY: nothing here runs unless the two env vars are set and
// the account exists with the owner's permission (permission is PENDING -
// do not describe this store as approved anywhere).
// With no env configured the selector FAILS CLOSED (no silent file-backend
// fallback) unless VM_COUNTERS_ALLOW_FILE=on explicitly opts into the
// non-durable local file backend (dev/test only).
//
// Unlike the file backend, the check-and-count runs INSIDE Redis as one
// Lua script, so it is atomic across processes and instances - the property
// the file backend cannot give. Failures fail closed (no mint).
//
// Env: VM_UPSTASH_REDIS_REST_URL, VM_UPSTASH_REDIS_REST_TOKEN.
// Keys: vmc:day:<yyyy-mm-dd> (hash: total + per-visitor fields, 8-day TTL),
//       vmc:lifetime (string counter, no TTL; VISITOR mints only),
//       vmc:owner_lifetime (string counter, no TTL; owner observability -
//       deliberately separate: owner mints never consume the visitor
//       admission budget), vmc:res:<id> (reservation, 2-day TTL),
//       vmc:gap (cross-instance mint gap, value = owning reservation id,
//       PX = gap ms), vmc:journal (hash: reservation -> pre-mint outcome
//       journal entry; written atomically with admission, resolved entries
//       deleted; >=100 unresolved refuses every mint, owner included).
// UTC day semantics match the file backend.

const ADMIT_LUA = `
local day = KEYS[1]
local ip = ARGV[1]
local perIpDay = tonumber(ARGV[2])
local globalDay = tonumber(ARGV[3])
local lifetimeMax = tonumber(ARGV[4])
local res = ARGV[5]
local gapMs = tonumber(ARGV[7])
-- Cross-instance mint gap, enforced INSIDE the atomic script: two
-- concurrent instances cannot both pass. The gap is rate smoothing
-- (one call at a time), not accounting.
if gapMs and gapMs > 0 and redis.call('EXISTS', KEYS[4]) == 1 then return 'gap' end
-- Pre-mint journal, atomic with admission: a full journal of unresolved
-- outcomes refuses the mint (no journal write, no vendor mint).
if redis.call('HLEN', KEYS[5]) >= 100 then return 'journal-full' end
local lifetime = tonumber(redis.call('GET', KEYS[2]) or '0')
if lifetime >= lifetimeMax then return 'lifetime' end
local total = tonumber(redis.call('HGET', day, 'total') or '0')
if total >= globalDay then return 'global-day' end
local mine = tonumber(redis.call('HGET', day, ip) or '0')
if mine >= perIpDay then return 'visitor-day' end
redis.call('HINCRBY', day, ip, 1)
redis.call('HINCRBY', day, 'total', 1)
redis.call('EXPIRE', day, 691200)
redis.call('INCR', KEYS[2])
redis.call('SET', KEYS[3], 'v|' .. ip .. '|' .. ARGV[6], 'EX', 172800)
redis.call('HSET', KEYS[5], res, 'v|' .. ip .. '|' .. ARGV[6] .. '|admitted|' .. ARGV[8])
if gapMs and gapMs > 0 then redis.call('SET', KEYS[4], res, 'PX', gapMs) end
return 'ok'
`;

// Refund targets the ADMISSION day's bucket (the day is stored in the
// reservation value), never today's: an old failed mint must not release
// capacity from the current day. A reservation past its 2-day TTL reads as
// missing -> 'noop': a conservative capacity leak, never an auto-refund.
const REFUND_LUA = `
local v = redis.call('GET', KEYS[3])
if not v then return 'noop' end
redis.call('DEL', KEYS[3])
redis.call('HDEL', KEYS[6], ARGV[1])
if redis.call('GET', KEYS[4]) == ARGV[1] then redis.call('DEL', KEYS[4]) end
local p1 = string.find(v, '|')
local kind = string.sub(v, 1, p1 - 1)
if kind == 'v' then
  local rest = string.sub(v, p1 + 1)
  local p2 = string.find(rest, '|')
  local ip = string.sub(rest, 1, p2 - 1)
  local day = 'vmc:day:' .. string.sub(rest, p2 + 1)
  local mine = tonumber(redis.call('HGET', day, ip) or '0')
  if mine > 0 then redis.call('HINCRBY', day, ip, -1) end
  local total = tonumber(redis.call('HGET', day, 'total') or '0')
  if total > 0 then redis.call('HINCRBY', day, 'total', -1) end
  local lifetime = tonumber(redis.call('GET', KEYS[2]) or '0')
  if lifetime > 0 then redis.call('DECR', KEYS[2]) end
else
  -- Owner reservation: adjust ONLY the owner observability counter,
  -- exactly once. The visitor lifetime budget is never touched.
  local ol = tonumber(redis.call('GET', KEYS[5]) or '0')
  if ol > 0 then redis.call('DECR', KEYS[5]) end
end
return 'released'
`;

const dayKey = (ms) => new Date(ms).toISOString().slice(0, 10);

export function createUpstashCallCounters({
  url,
  token,
  now = () => Date.now(),
  fetchImpl = fetch,
}) {
  if (!url || !token) throw new Error("Upstash counters need url and token.");
  const call = async (body) => {
    const r = await fetchImpl(`${url.replace(/\/$/, "")}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });
    if (!r.ok) {
      const e = Error(`Counter store returned ${r.status}.`);
      e.status = 503;
      throw e;
    }
    const j = await r.json();
    if (j.error) {
      const e = Error("Counter store rejected the command.");
      e.status = 503;
      throw e;
    }
    return j.result;
  };
  const keys = () => {
    const d = dayKey(now());
    return { day: `vmc:day:${d}`, lifetime: "vmc:lifetime", res: null, d };
  };
  const limits = (o) => [
    String(o.perIpDay),
    String(o.globalDay),
    String(o.lifetimeMax),
  ];
  return {
    async admitVisitor(ip, lim) {
      const k = keys();
      const res = `r_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
      const out = await call([
        "EVAL",
        ADMIT_LUA,
        "5",
        k.day,
        k.lifetime,
        `vmc:res:${res}`,
        "vmc:gap",
        "vmc:journal",
        ip,
        ...limits(lim),
        res,
        k.d,
        String(Math.max(0, Math.floor(lim.gapMs ?? 0))),
        String(now()),
      ]);
      return out === "ok"
        ? { ok: true, reservation: res }
        : { ok: false, scope: out };
    },
    async settleReservation(reservation) {
      await call([
        "EVAL",
        `redis.call('DEL', KEYS[1]) redis.call('HDEL', KEYS[2], ARGV[1]) return 'ok'`,
        "2",
        `vmc:res:${reservation}`,
        "vmc:journal",
        reservation,
      ]);
    },
    async refundReservation(reservation) {
      const k = keys();
      await call([
        "EVAL",
        REFUND_LUA,
        "6",
        k.day,
        k.lifetime,
        `vmc:res:${reservation}`,
        "vmc:gap",
        "vmc:owner_lifetime",
        "vmc:journal",
        reservation,
      ]);
    },
    // Owner mints are COUNTED but not capped by the visitor abuse budget:
    // "owner unlimited call count" is preserved, and the shared lifetime
    // count stays the observability point an eventual authorized spend
    // brake can bind. Same reservation lifecycle as visitor mints.
    async admitOwner() {
      const k = keys();
      const res = `r_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
      // Same pre-mint journal invariant as visitor mints: full journal, no
      // mint (safety invariant, not a count cap).
      const out = await call([
        "EVAL",
        `if redis.call('HLEN', KEYS[3]) >= 100 then return 'journal-full' end redis.call('INCR', KEYS[1]) redis.call('SET', KEYS[2], ARGV[1], 'EX', 172800) redis.call('HSET', KEYS[3], ARGV[2], ARGV[3]) return 'ok'`,
        "3",
        "vmc:owner_lifetime",
        `vmc:res:${res}`,
        "vmc:journal",
        `o|owner|${k.d}`,
        res,
        `o|owner|${k.d}|admitted|${now()}`,
      ]);
      if (out === "journal-full") return { ok: false, scope: "journal-full" };
      return { ok: true, reservation: res };
    },
    // Outcome update on the pre-mint journal: mark the reservation
    // ambiguous. The entry MUST exist from admission; a missing entry
    // breaks the no-journal-no-mint invariant and fails closed.
    // Idempotent, structured: any previous ambiguous tail is cut and the
    // ORIGINAL admission head (kind|who|day|admitted|at) is preserved, so
    // repeated updates never corrupt the timestamp. A missing entry means
    // settle committed but its ack was lost (or a crash): RECOVER it with
    // what is known (a known live session id is never thrown away) rather
    // than dropping the record.
    // Idempotent structured update, same semantics as the file backend:
    // original provenance (kind/day/time) is preserved; an update WITHOUT
    // a session id never erases a previously known one; an update with a
    // CONFLICTING non-empty session id is rejected - the original id and
    // errorClass win. A missing entry is a lost-ack recovery: it is
    // recreated even beyond the 100 admission threshold (that threshold
    // refuses NEW mints; it is not a storage ceiling and recovery never
    // drops the record).
    async recordAmbiguous(rec) {
      await call([
        "EVAL",
        `local v = redis.call('HGET', KEYS[1], ARGV[1]) local head local oldsid = '' local olderr = '' if v then local pos = string.find(v, '|ambiguous|', 1, true) if pos then head = string.sub(v, 1, pos - 1) local tail = string.sub(v, pos + 11) local sep = string.find(tail, '|', 1, true) oldsid = string.sub(tail, 1, sep - 1) olderr = string.sub(tail, sep + 1) else head = v end else head = 'u|unknown|' .. ARGV[5] .. '|admitted|' .. ARGV[4] end local sid = ARGV[2] local err = ARGV[3] if sid == '' then sid = oldsid elseif oldsid ~= '' and oldsid ~= sid then sid = oldsid err = olderr end redis.call('HSET', KEYS[1], ARGV[1], head .. '|ambiguous|' .. sid .. '|' .. err) return 'ok'`,
        "1",
        "vmc:journal",
        rec.reservation,
        rec.sessionId ?? "",
        String(rec.errorClass ?? "unknown"),
        String(rec.at ?? now()),
        dayKey(now()),
      ]);
    },
    // Unresolved ambiguous outcomes awaiting reconciliation. The journal
    // value encodes kind|who|day|status|at[|ambiguous|sessionId|errorClass].
    async listAmbiguous() {
      const all = await call(["HGETALL", "vmc:journal"]);
      const out = [];
      const staleMs = 10 * 60000;
      for (let i = 0; i + 1 < (all?.length ?? 0); i += 2) {
        // Value layout: kind|who|day|admitted|at[|ambiguous|sessionId|errorClass]
        const parts = String(all[i + 1]).split("|");
        const n = parts.length;
        const kind =
          parts[0] === "o" ? "owner" : parts[0] === "v" ? "visitor" : "unknown";
        if (n >= 7 && parts[n - 3] === "ambiguous") {
          out.push({
            reservation: all[i],
            kind,
            day: parts[2] ?? "",
            at: Number(parts[n - 4] ?? 0),
            sessionId: parts[n - 2] || null,
            errorClass: parts[n - 1] || "unknown",
            settleFailed: parts[n - 1] === "settle-failed" || undefined,
          });
        } else if (n === 5 && now() - Number(parts[4]) > staleMs) {
          // Admitted-only and OLD: the mint outcome was lost (crash /
          // lost ack). Must stay visible with its original metadata.
          out.push({
            reservation: all[i],
            kind,
            day: parts[2] ?? "",
            at: Number(parts[4]),
            sessionId: null,
            errorClass: null,
            staleAdmission: true,
          });
        }
      }
      return out;
    },
    async clearAmbiguous(reservation) {
      await call(["HDEL", "vmc:journal", reservation]);
    },
    // Connectivity proof for the durable store; throws 503 on failure.
    async verify() {
      await call(["PING"]);
      return true;
    },
    async peek() {
      const k = keys();
      const lifetime = await call(["GET", k.lifetime]);
      const ownerLifetime = await call(["GET", "vmc:owner_lifetime"]);
      const total = await call(["HGET", k.day, "total"]);
      return {
        lifetime: Number(lifetime ?? 0),
        ownerLifetime: Number(ownerLifetime ?? 0),
        today: { total: Number(total ?? 0) },
      };
    },
  };
}

// Backend selection, shared by the public mint and the owner mint.
// - Both Upstash env vars set: the durable backend.
// - Neither set: the local JSON file backend (caller fallback; local/dev
//   only, rate smoothing, NOT multi-instance safe, NOT a money ceiling).
// - PARTIAL config (exactly one var) ALWAYS fails closed: a half-configured
//   durable store is a misconfiguration, never a silent downgrade.
// - VM_COUNTERS_REQUIRE_DURABLE=on (production mode): missing durable
//   config fails closed instead of falling back to the file backend.
// Durable-by-default: production safety must not depend on remembering an
// opt-in env var.
// - Both Upstash env vars set: the durable backend.
// - PARTIAL config (exactly one var) ALWAYS fails closed.
// - Neither set: fails closed UNLESS VM_COUNTERS_ALLOW_FILE=on explicitly
//   opts into the non-durable file backend (local dev/test only; single
//   writer; NOT multi-instance safe; NOT a money ceiling).
// The caller should also await adapter.verify() once at boot; a store that
// cannot be reached fails closed on every admission anyway (503).
export function selectCallCounters({ env = process.env, now, fetchImpl } = {}) {
  const url = env.VM_UPSTASH_REDIS_REST_URL;
  const token = env.VM_UPSTASH_REDIS_REST_TOKEN;
  if (url && token) {
    return createUpstashCallCounters({
      url,
      token,
      ...(now ? { now } : {}),
      ...(fetchImpl ? { fetchImpl } : {}),
    });
  }
  if (url || token) {
    const e = Error(
      "Partial counter-store config: set BOTH VM_UPSTASH_REDIS_REST_URL and VM_UPSTASH_REDIS_REST_TOKEN, or neither.",
    );
    e.status = 503;
    throw e;
  }
  if (env.VM_COUNTERS_ALLOW_FILE === "on") {
    return null; // explicit opt-in: caller falls back to the file backend
  }
  const e = Error(
    "No durable call-counter store configured (set VM_UPSTASH_REDIS_REST_URL and VM_UPSTASH_REDIS_REST_TOKEN). Refusing to use the non-durable file backend without the explicit VM_COUNTERS_ALLOW_FILE=on local dev/test opt-in.",
  );
  e.status = 503;
  throw e;
}
