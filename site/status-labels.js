// What a graph node's status means, in words, by DOMAIN. The domain comes
// from the node the engine sent (its `domain`, else its id: lab readings are
// "obs:...", record values "value:..."), never from which page or case is
// showing, so a contract term can never be worded like a lab reading or the
// reverse. Source statuses are not changed here; only how they read.
(function (root) {
  function domainOf(n) {
    if (n && (n.domain === "lab" || n.domain === "record")) return n.domain;
    const id = String((n && n.id) || "");
    if (/^obs:/.test(id)) return "lab";
    if (/^value:/.test(id)) return "record";
    return null;
  }
  const LAB = {
    current: "latest reported reading",
    preliminary: "preliminary reading",
    superseded: "corrected (replaced by the amended report)",
    amended: "amended (corrected version)",
    final: "final report",
  };
  const RECORD = {
    proposed: "proposed, not approved",
    discussed: "discussed only",
    requested: "requested, not approved",
    "internal-target": "internal target, not a commitment",
    superseded: "superseded by a later record",
    open: "unresolved: competing records",
    unresolved: "unresolved",
    rejected: "rejected",
    current: "most recent proposal, not approved",
  };
  function statusLabel(n) {
    if (!n || !n.status) return null;
    const d = domainOf(n);
    if (d === "lab") return LAB[n.status] || n.status;
    if (d === "record") {
      if (n.noSignedRecord) return "no signed record";
      if (n.status === "approved")
        return n.authority
          ? "approved by " + n.authority
          : "approved (approver not stated)";
      return RECORD[n.status] || n.status;
    }
    // documents and anything else: the printed word, never "in force"
    return n.status === "current" ? "latest" : n.status;
  }
  const api = { statusLabel, domainOf };
  if (typeof module === "object" && module.exports) module.exports = api;
  root.VM_STATUS = api;
})(typeof window !== "undefined" ? window : globalThis);
