import { readFileSync } from "node:fs";
// Post-exposure safety regression. These are synthetic owner-partition
// tests, not an independent understanding benchmark.
import test from "node:test";
import assert from "node:assert/strict";
import { importBundle, validateEvidence } from "../dist/engine.mjs";
import {
  bindRecordIdentities,
  identityReportsFor,
  recordSubject,
  patientDecision,
} from "../clinical/answer.mjs";
import { subjectOf, reportMeta } from "../clinical/observations.mjs";
import { ownerView, originalCitation } from "../src/owner-view.mjs";
import { createLocalServer } from "../src/server.mjs";
const texts = [
  "Patient: Alice Smith, ID AL-101\nDate of birth: 12 January 1980\nDischarged: 24 October 2026\nTransport requires BLUE-A-ONLY.",
  "Patient: Alice Smith, ID AL-101\nDate of birth: 3 July 1965\nDischarged: 30 October 2026\nTransport requires RED-B-ONLY.",
];
function make(packet = false) {
  const bundle = importBundle(
    packet
      ? [{ title: "Packet", text: texts.join("\n\n") }]
      : texts.map((text, i) => ({ title: "Record" + i, text })),
    { scope: "identity-conflict" },
  );
  let at = 0;
  bundle.sourceRecords = texts.map((text, i) => {
    const source = bundle.sources[packet ? 0 : i],
      start = packet ? at : 0;
    at += text.length + 2;
    return {
      sourceId: source.id,
      title: source.title,
      span: { start, end: start + text.length },
      meta: reportMeta(text),
    };
  });
  bundle.records = bundle.sources.map((source) => ({
    source,
    records: bundle.sourceRecords
      .filter((r) => r.sourceId === source.id)
      .map((r) => ({
        start: r.span.start,
        end: r.span.end,
        title: r.title,
        facts: [],
      })),
  }));
  bundle.clinical = [];
  return bundle;
}
for (const packet of [false, true])
  test(`conflicted nonclinical IDs share one partition across preflight, masking, and restoration (${packet ? "packet" : "files"})`, () => {
    const b = make(packet);
    const identities = bindRecordIdentities(b),
      owners = identities.map(subjectOf);
    assert.equal(new Set(owners).size, 2);
    assert.ok(owners.every((id) => id.startsWith("doc:")));
    const decision = patientDecision("When was AL-101 discharged?", identities);
    assert.equal(decision.clarify, true);
    assert.equal(decision.multiple, undefined);
    assert.equal(decision.patient, null);
    assert.equal(
      patientDecision("When was Alice Smith discharged?", identities).clarify,
      true,
    );
    const entries = b.records.flatMap((e) => e.records.map((r) => ({ e, r })));
    assert.deepEqual(
      entries.map(({ e, r }) => recordSubject(e, r)),
      owners,
    );
    const v = ownerView(b, owners[0]);
    assert.equal(identityReportsFor(v).length, 1);
    assert.match(v.sources.map((s) => s.text).join(" "), /BLUE-A-ONLY/);
    assert.doesNotMatch(JSON.stringify(v.rows), /RED-B-ONLY/);
    const original = b.sources[0],
      derived = v.sources[0];
    const start = original.text.indexOf("Transport requires BLUE"),
      end = start + "Transport requires BLUE-A-ONLY.".length;
    const ev = {
      sourceId: original.id,
      hash: derived.hash,
      start,
      end,
      quote: derived.text.slice(start, end),
    };
    const allowed = (c) =>
      b.sourceRecords.some(
        (r) =>
          subjectOf(r) === owners[0] &&
          r.sourceId === c.sourceId &&
          r.span.start <= c.start &&
          r.span.end >= c.end,
      );
    const restored = originalCitation(ev, b, v, allowed);
    assert.ok(restored);
    assert.equal(validateEvidence(restored, b), true);
    const other = b.sourceRecords[1],
      source = b.sources.find((s) => s.id === other.sourceId);
    const forbidden = {
      sourceId: source.id,
      hash: source.hash,
      start: other.span.start,
      end: other.span.end,
      quote: source.text.slice(other.span.start, other.span.end),
    };
    assert.equal(originalCitation(forbidden, b, v, allowed), null);
    // Rebuilding a different set must not retain old conflict flags or owner keys.
    const clean = {
      sources: [b.sources[0]],
      records: [{ source: b.sources[0], records: [b.records[0].records[0]] }],
      sourceRecords: [b.sourceRecords[0]],
      clinical: [],
    };
    assert.equal(bindRecordIdentities(clean)[0].identityOwner, "AL-101");
    assert.equal(b.sourceRecords[0].meta.patient.idConflict, true);
  });

test("clinical and document-local owners agree when a nonclinical record contradicts a lab ID", () => {
  const b = make(true);
  const r = b.sourceRecords[0];
  b.clinical = [
    {
      sourceId: r.sourceId,
      segment: 0,
      span: r.span,
      meta: r.meta,
      observations: [],
    },
  ];
  bindRecordIdentities(b);
  assert.equal(subjectOf(b.clinical[0]), subjectOf(b.sourceRecords[0]));
  assert.equal(b.clinical[0].meta.patient.idConflict, true);
});

for (const packet of [false, true])
  test(`actual upload/ask and BYO refuse a contradicted ID; selected source stays isolated (${packet ? "PDF packet" : "files"})`, async () => {
    const names = [
      "VM_BYO_VOICE",
      "VM_COUNTERS_ALLOW_FILE",
      "VM_DOCUMENT_REASONING",
    ];
    const saved = Object.fromEntries(names.map((n) => [n, process.env[n]]));
    process.env.VM_BYO_VOICE = "on";
    process.env.VM_COUNTERS_ALLOW_FILE = "on";
    process.env.VM_DOCUMENT_REASONING = "on";
    const seen = [];
    const gemini = {
      enabled: () => true,
      searchEnabled: () => false,
      interpret: async (...a) => {
        seen.push(a);
        return null;
      },
      planClaims: async (...a) => {
        seen.push(a);
        return null;
      },
      documentRead: async (...a) => {
        seen.push(a);
        return null;
      },
      documentAudit: async (...a) => {
        seen.push(a);
        return null;
      },
    };
    const s = createLocalServer({ port: 0, gemini });
    await new Promise((r) => s.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${s.address().port}/api/public`;
    try {
      const ws = await fetch(base + "/workspace", { method: "POST" }).then(
        (r) => r.json(),
      );
      if (packet) {
        const up = await fetch(`${base}/workspace/${ws.id}/upload`, {
          method: "POST",
          headers: { "x-file-name": "conflict.pdf" },
          body: readFileSync(
            new URL(
              "./fixtures/identity-conflict-nonclinical.pdf",
              import.meta.url,
            ),
          ),
        });
        assert.equal(up.status, 202);
      } else {
        for (let i = 0; i < texts.length; i++)
          await fetch(`${base}/workspace/${ws.id}/upload`, {
            method: "POST",
            headers: { "x-file-name": `record${i}.txt` },
            body: texts[i],
          });
      }
      let state;
      for (let i = 0; i < 300; i++) {
        state = await fetch(`${base}/workspace/${ws.id}`).then((r) => r.json());
        if (state.ready && state.documents.every((d) => d.status === "ready"))
          break;
        await new Promise((r) => setTimeout(r, 20));
      }
      assert.ok(state.ready);
      const ask = (question, patient = null, semantic = true) =>
        fetch(base + "/ask", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            case: ws.id,
            question,
            patient,
            semantic,
          }),
        }).then((r) => r.json());
      const ambiguous = await ask("When was AL-101 discharged?");
      assert.equal(ambiguous.final.verdict, "AMBIGUOUS_PATIENT");
      assert.deepEqual(ambiguous.final.citations, []);
      assert.match(ambiguous.final.text, /conflicting/);
      assert.equal(seen.length, 0);
      const count = await ask("How many patients are there?");
      assert.match(count.final.text, /2 record identities/);
      const sourceIds = [
        ...new Set(
          [...count.final.text.matchAll(/doc:([A-Za-z0-9_-]+(?:#\d+)?)/g)].map(
            (m) => m[1],
          ),
        ),
      ];
      assert.equal(sourceIds.length, 2);
      for (let i = 0; i < sourceIds.length; i++) {
        const selected = "doc:" + sourceIds[i];
        const answer = await ask("When was she discharged?", selected, false);
        assert.match(answer.final.text, i === 0 ? /24 Oct/ : /30 Oct/);
        assert.doesNotMatch(answer.final.text, i === 0 ? /30 Oct/ : /24 Oct/);
        assert.doesNotMatch(
          JSON.stringify(answer.final.citations),
          i === 0 ? /RED-B-ONLY|30 October/ : /BLUE-A-ONLY|24 October/,
        );
        assert.ok(
          answer.final.citations.every(
            (c) => c.documentId === count.final.citations[i].documentId,
          ),
        );
        seen.length = 0;
        await ask(
          "Which transport arrangements were required?",
          selected,
          true,
        );
        assert.ok(seen.length > 0);
        assert.doesNotMatch(
          JSON.stringify(seen),
          i === 0 ? /RED-B-ONLY/ : /BLUE-A-ONLY/,
        );
      }
      seen.length = 0;
      const key = await fetch(base + "/llm/key", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ case: ws.id }),
      }).then((r) => r.json());
      const voice = await fetch(base + "/llm/v1/chat/completions", {
        method: "POST",
        headers: {
          authorization: "Bearer " + key.apiKey,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          stream: true,
          messages: [{ role: "user", content: "When was AL-101 discharged?" }],
        }),
      });
      assert.equal(voice.status, 200);
      const body = await voice.text();
      assert.match(body, /conflicting records/);
      assert.doesNotMatch(body, /24 October|30 October/);
      assert.equal(seen.length, 0);
    } finally {
      await new Promise((r) => s.close(r));
      for (const n of names)
        if (saved[n] === undefined) delete process.env[n];
        else process.env[n] = saved[n];
    }
  });
