// Graph status wording by domain. RED on main 6edac74: site/graph.js showed
// every `current` status as "in force" (a lab reading is not "in force"), its
// legend called lab values "Value in force", and an internal finance approval
// (USD 54,000, client unsigned) was drawn as "Approved / agreed" with no
// approver. Signature records that say "NO client-signed service agreement"
// showed the chip "open".
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { importBundle } from "../dist/engine.mjs";
import { MARINER_DOCS } from "../examples/corpus-mariner.mjs";
import { NORTHSTAR_DOCS } from "../examples/corpus-northstar.mjs";
import { fullGraph } from "../src/public-api.mjs";
import { approvalAuthority } from "../memory/graph.mjs";
import { createMemory } from "../memory/memory.mjs";

const sandbox = { window: { caseId: "deal" } };
vm.runInNewContext(
  readFileSync(new URL("../site/status-labels.js", import.meta.url), "utf8"),
  sandbox,
);
const { statusLabel } = sandbox.window.VM_STATUS;

test("lab readings and record values never share wording", () => {
  const lab = { id: "obs:s1:tsh", kind: "value", status: "current" };
  const rec = { id: "value:fee:usd-58-000", kind: "value", status: "current" };
  assert.equal(statusLabel(lab), "latest reported reading");
  assert.equal(statusLabel(rec), "most recent proposal, not approved");
  assert.equal(
    statusLabel({ id: "obs:s1:tsh", status: "superseded" }),
    "corrected (replaced by the amended report)",
  );
  assert.equal(
    statusLabel({ id: "obs:s1:tsh", status: "preliminary" }),
    "preliminary reading",
  );
  // the page's case is not consulted: a lab node on the deal page is still lab
  sandbox.window.caseId = "health";
  assert.equal(statusLabel(rec), "most recent proposal, not approved");
  for (const s of ["current", "approved", "proposed", "superseded", "open"])
    for (const id of ["obs:s1:tsh", "value:fee:x", "doc:abc"])
      assert.doesNotMatch(statusLabel({ id, status: s }) ?? "", /in force/i);
});

test("approval names who approved, from the words before the verb only", () => {
  assert.equal(
    approvalAuthority(
      "Farah (finance approver): INTERNAL finance APPROVES the USD 54,000 project fee.",
    ),
    "internal finance",
  );
  assert.equal(
    approvalAuthority(
      "Rina (steering chair): The committee APPROVES phase-one scope of East and West sites only.",
    ),
    "steering committee",
  );
  assert.equal(
    approvalAuthority(
      "As-of status: TWO SITES APPROVED, USD 54,000 INTERNALLY APPROVED, CLIENT UNSIGNED.",
    ),
    null,
    "the client is not the approver",
  );
  assert.equal(approvalAuthority("Outcome: Two-site scope APPROVED."), null);
});

test("mariner graph: internal approval, missing signature, superseded fees", () => {
  const g = fullGraph(importBundle(MARINER_DOCS), createMemory());
  const v = (label) =>
    g.nodes.find((n) => n.kind === "value" && n.label === label);
  const fee = v("USD 54,000");
  assert.equal(fee.status, "approved", "source status unchanged");
  assert.equal(fee.authority, "internal finance");
  assert.equal(statusLabel(fee), "approved by internal finance");
  assert.equal(statusLabel(v("30/70")), "approved by internal finance");
  assert.equal(
    statusLabel(v("East and West sites")),
    "approved by steering committee",
  );
  for (const old of ["USD 72,000", "USD 58,000"])
    assert.equal(statusLabel(v(old)), "superseded by a later record", old);
  assert.equal(
    statusLabel(v("December 10")),
    "internal target, not a commitment",
  );
  const unsigned = g.nodes.filter(
    (n) => n.kind === "value" && n.field === "signedAgreement",
  );
  assert.ok(unsigned.length >= 2);
  for (const n of unsigned) {
    assert.equal(statusLabel(n), "no signed record", n.label);
    assert.doesNotMatch(statusLabel(n), /\bsigned\b(?! record)/);
  }
  // no value on this corpus may read as signed or client-agreed
  for (const n of g.nodes.filter((n) => n.kind === "value"))
    assert.doesNotMatch(
      statusLabel(n) ?? "",
      /^signed|agreed|client approved/i,
      n.label,
    );
});

test("northstar graph: the revised fee reads as proposed, not approved", () => {
  const g = fullGraph(importBundle(NORTHSTAR_DOCS), createMemory());
  const fee = g.nodes.find((n) => n.kind === "value" && n.label === "$42,000");
  assert.ok(fee);
  assert.match(statusLabel(fee), /not approved|unresolved/);
  const old = g.nodes.find((n) => n.kind === "value" && n.label === "$48,000");
  assert.equal(statusLabel(old), "superseded by a later record");
});

test("graph page loads the label helper before graph.js and uses it", () => {
  const html = readFileSync(
    new URL("../site/graph.html", import.meta.url),
    "utf8",
  );
  assert.ok(html.indexOf("status-labels.js") < html.indexOf('src="graph.js"'));
  const js = readFileSync(new URL("../site/graph.js", import.meta.url), "utf8");
  assert.doesNotMatch(js, /in force/);
  assert.match(js, /VM_STATUS\.statusLabel\(n\)/);
});
