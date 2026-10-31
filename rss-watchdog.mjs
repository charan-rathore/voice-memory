// RSS watchdog: admission control plus graceful restart under memory
// pressure. Render's free tier hard-kills the process at 512 MiB RSS. The
// heaviest workload we have measured (7-doc import + dense warmup + hybrid
// query) peaked at 485 MiB, leaving 27 MiB of headroom, so the thresholds
// below are derived from that measurement rather than picked round:
//   - ADMIT_HIGH_WATER  460 MiB: stop accepting NEW expensive work early
//     enough that one more in-flight import's transient allocation still
//     fits under the observed peak.
//   - RESTART_HIGH_WATER 496 MiB: 16 MiB under the kill line; restart
//     gracefully while the process can still choose how it exits.
// The watchdog cannot guarantee zero dropped requests - an OOM kill is
// outside the process's control. What it guarantees: new expensive work is
// refused with 503 + Retry-After BEFORE memory runs out, a restart is
// deferred until in-flight requests finish, and when a forced exit does
// drop requests the dropped count is logged, never hidden.
import { readFileSync } from "node:fs";

// The watchdog's thresholds only protect if they sit below the host's real
// kill line. "512 MB" on a plan page does not say whether the host means
// 512 MiB (536870912 bytes) or 512 decimal MB (500000000 bytes, or a
// mebibyte reading of 488.3 MiB): read the actual cgroup limit instead of
// trusting marketing units. v2 reports "max" when unlimited; v1 reports a
// huge sentinel near LONG_MAX when unlimited.
const V1_UNLIMITED_SENTINEL = 1e15;
export function readHostMemoryLimit({
  v2Path = "/sys/fs/cgroup/memory.max",
  v1Path = "/sys/fs/cgroup/memory/memory.limit_in_bytes",
} = {}) {
  try {
    const v2 = readFileSync(v2Path, "utf8").trim();
    if (v2 !== "max") {
      const n = Number(v2);
      if (Number.isFinite(n) && n > 0) return { bytes: n, source: "cgroup-v2" };
    }
  } catch {}
  try {
    const n = Number(readFileSync(v1Path, "utf8").trim());
    if (Number.isFinite(n) && n > 0 && n < V1_UNLIMITED_SENTINEL)
      return { bytes: n, source: "cgroup-v1" };
  } catch {}
  return { bytes: null, source: null };
}

export const MIB = 1024 * 1024;

// The host's real kill line is read from the cgroup limit (see
// readHostMemoryLimit) and surfaced on /api/readiness as memory.hostLimit:
// 496 MiB is protective only if that line is at least 512 MiB.
//
// Environment overrides: VM_RSS_WATCHDOG=off disables the watchdog entirely
// (test suites run a model cache plus the test runner in one process and
// are not bound by the 512 MiB deployment limit). VM_RSS_ADMIT_HIGH_WATER_MB
// and VM_RSS_RESTART_HIGH_WATER_MB retune the thresholds for a host with a
// different limit; the defaults are measured against Render's free tier.
export function createRssWatchdog({
  rss = () => process.memoryUsage().rss,
  now = () => Date.now(),
  intervalMs = 5000,
  admitHighWater = (Number(process.env.VM_RSS_ADMIT_HIGH_WATER_MB) || 460) *
    MIB,
  restartHighWater = (Number(process.env.VM_RSS_RESTART_HIGH_WATER_MB) || 496) *
    MIB,
  forceAfterMs = 30000,
  onEvent = (e) => console.warn("rss-watchdog", JSON.stringify(e)),
  limitPaths = undefined,
  exit = (code) => process.exit(code),
  disabled = process.env.VM_RSS_WATCHDOG === "off",
} = {}) {
  if (disabled) {
    return {
      state: () => ({ disabled: true }),
      admit: () => true,
      beginRequest: () => {},
      endRequest: () => {},
      stop: () => {},
      tick: () => {},
    };
  }
  let inFlight = 0;
  let overSince = null;
  let stopped = false;
  // Read once: the cgroup limit does not change during the process lifetime.
  const hostLimit = readHostMemoryLimit(limitPaths);
  const state = () => ({
    inFlight,
    rssBytes: rss(),
    admitHighWater,
    restartHighWater,
    overSince,
    hostLimit,
  });
  const maybeRestart = () => {
    if (stopped) return;
    const current = rss();
    if (current < restartHighWater) {
      overSince = null;
      return;
    }
    if (overSince === null) {
      overSince = now();
      onEvent({ type: "pressure", ...state() });
    }
    if (inFlight === 0) {
      stopped = true;
      onEvent({ type: "restart", dropped: 0, ...state() });
      exit(1);
      return;
    }
    if (now() - overSince >= forceAfterMs) {
      stopped = true;
      onEvent({ type: "forced-restart", dropped: inFlight, ...state() });
      exit(1);
    }
  };
  const timer = setInterval(maybeRestart, intervalMs);
  timer.unref?.();
  return {
    state,
    // Admission gate for expensive routes (import, upload, query, voice).
    admit() {
      if (rss() >= admitHighWater) {
        onEvent({ type: "admission-refused", ...state() });
        return false;
      }
      return true;
    },
    beginRequest() {
      inFlight += 1;
    },
    endRequest() {
      inFlight = Math.max(0, inFlight - 1);
      if (inFlight === 0 && overSince !== null) maybeRestart();
    },
    stop() {
      clearInterval(timer);
    },
    // Test hook: run one sampling pass synchronously.
    tick: maybeRestart,
  };
}
