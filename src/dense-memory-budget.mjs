import { readFileSync } from "node:fs";
const MIB = 1048576;
// A configured ceiling is a policy cap, never proof of host enforcement.
// If both are known, the smaller one controls optional model admission.
export function denseMemoryBudget({
  configuredMb = process.env.VM_MEMORY_LIMIT_MB,
  read = readFileSync,
} = {}) {
  let hostBytes = null,
    hostSource = null;
  for (const [path, source] of [
    ["/sys/fs/cgroup/memory.max", "cgroup-v2"],
    ["/sys/fs/cgroup/memory/memory.limit_in_bytes", "cgroup-v1"],
  ]) {
    try {
      const text = read(path, "utf8").trim();
      const n = Number(text);
      if (text !== "max" && Number.isFinite(n) && n > 0 && n < 2 ** 50) {
        hostBytes = n;
        hostSource = source;
        break;
      }
    } catch {}
  }
  let configuredBytes = null;
  if (configuredMb !== undefined && configuredMb !== "") {
    const n = Number(configuredMb);
    if (!Number.isFinite(n) || n <= 0 || !Number.isFinite(n * MIB))
      return {
        limitBytes: null,
        source: "invalid-config",
        hostBytes,
        hostSource,
        configuredBytes: null,
      };
    configuredBytes = n * MIB;
  }
  const limitBytes =
    hostBytes === null
      ? configuredBytes
      : configuredBytes === null
        ? hostBytes
        : Math.min(hostBytes, configuredBytes);
  const source =
    limitBytes === null
      ? null
      : hostBytes !== null && hostBytes === limitBytes
        ? hostSource
        : "configured";
  return { limitBytes, source, hostBytes, hostSource, configuredBytes };
}
