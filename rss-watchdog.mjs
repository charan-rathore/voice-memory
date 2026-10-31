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
export const MIB = 1024 * 1024;

// Environment overrides: VM_RSS_WATCHDOG=off disables the watchdog entirely
// (test suites run a model cache plus the test runner in one process and
// are not bound by the 512 MiB deployment limit). VM_RSS_ADMIT_HIGH_WATER_MB
// and VM_RSS_RESTART_HIGH_WATER_MB retune the thresholds for a host with a
// different limit; the defaults are measured against Render's free tier.
export function createRssWatchdog({
  rss = () => process.memoryUsage().rss,
  now = () => Date.now(),
  intervalMs = 5000,
  admitHighWater = (Number(process.env.VM_RSS_ADMIT_HIGH_WATER_MB) || 460) * MIB,
  restartHighWater = (Number(process.env.VM_RSS_RESTART_HIGH_WATER_MB) || 496) * MIB,
  forceAfterMs = 30000,
  onEvent = (e) => console.warn("rss-watchdog", JSON.stringify(e)),
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
  const state = () => ({
    inFlight,
    rssBytes: rss(),
    admitHighWater,
    restartHighWater,
    overSince,
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
