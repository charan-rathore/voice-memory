// Records, facts, the records graph and the reading-view digest, on the
// fictional held-out packets (evaluation/packets). These pin the behaviour
// the packet benchmarks measure, so a regression shows up here first.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseBuffer } from "../ingest/parse.mjs";
import { shutdownOcr } from "../ingest/ocr.mjs";
import {
  recordsOf,
  factAnswer,
  recordStatus,
  conceptOf,
} from "../src/record-facts.mjs";
import { recordGraph } from "../src/record-graph.mjs";
import { contentTokens, stemToken } from "../src/rag-tokens.mjs";

const pdf = (f) =>
  readFileSync(new URL("../evaluation/packets/" + f, import.meta.url));
const docs = {};
before(async () => {
  for (const f of [
    "procurement-packet.pdf",
    "riverbend-clinic-packet.pdf",
    "lease-packet.pdf",
  ])
    docs[f] = (await parseBuffer(pdf(f), f)).doc;
});
after(() => shutdownOcr());
const ask = (f, q) =>
  factAnswer(q, [
    {
      source: { id: "s", text: docs[f].text },
      doc: docs[f],
      records: recordsOf(docs[f]),
    },
  ]);

test("the tokenizer port matches the vendored TypeScript token for token", async (t) => {
  let ts;
  try {
    ts = await import("../vendor/web/src/lib/rag/text.ts");
  } catch {
    return t.skip("this Node cannot import TypeScript directly");
  }
  for (const s of [
    "The amended Ferritin results were corrected: 50 ng/mL, discharged patients.",
    "Münchenstraße Grüße – naïve café; 1,35,000 INR; caching expired stamped",
    "Ward notes: expected go-home 10 Nov 2026. Delivered on 14 Nov 2026!",
  ]) {
    assert.deepEqual(contentTokens(s), ts.contentTokens(s), s);
    for (const w of s.toLowerCase().split(/\W+/).filter(Boolean))
      assert.equal(stemToken(w), ts.stemToken(w), w);
  }
});

test("record status: provisional words win, body text never sets a status", () => {
  assert.equal(
    recordStatus("# Q\n\nDRAFT / NOT APPROVED").authority,
    "provisional",
  );
  assert.equal(
    recordStatus("# DISCHARGE\n\nSIGNED / FINAL").authority,
    "authoritative",
  );
  assert.equal(
    recordStatus("# INVOICE\n\nESTIMATE - NOT FINAL").authority,
    "provisional",
  );
  assert.equal(
    recordStatus(
      "# BILL\n\nFINAL POSTED\n\n| a | b |\n\nReplaces the 22 Oct estimate",
    ).authority,
    "authoritative",
  );
  // A charge is never a diagnosis.
  assert.equal(conceptOf("Imaging / diagnostics"), "diagnosis");
  const clinic = recordsOf(docs["riverbend-clinic-packet.pdf"]);
  const imaging = clinic
    .flatMap((r) => r.facts)
    .filter((f) => /laboratory/i.test(f.label));
  assert.ok(imaging.every((f) => f.concept !== "diagnosis"));
});

test("a file without patient headers still splits into its records", () => {
  const recs = recordsOf(docs["procurement-packet.pdf"]);
  assert.deepEqual(
    recs.map((r) => [r.title, r.authority]),
    [
      ["QUOTATION Q-7781", "provisional"],
      ["PURCHASE ORDER PO-55120", "authoritative"],
      ["DELIVERY NOTE DN-901", "authoritative"],
      ["INVOICE INV-2209", "authoritative"],
    ],
  );
  const facts = recs.flatMap((r) => r.facts);
  // "Label: value" lines are facts too, split where a text layer joined them.
  assert.ok(
    facts.some(
      (f) => f.label === "Approved by" && f.value.startsWith("Priya Nair"),
    ),
  );
  assert.ok(
    facts.some(
      (f) => f.label === "Estimated delivery" && f.value === "10 Nov 2026",
    ),
  );
  // every fact keeps its exact span
  for (const f of facts)
    assert.ok(
      docs["procurement-packet.pdf"].text
        .slice(f.start, f.end)
        .includes(f.label.split(" ")[0]),
    );
});

test("answers come from the most authoritative record; provisional values are named as superseded", () => {
  const total = ask(
    "procurement-packet.pdf",
    "What is the total price of the order?",
  );
  assert.match(total.spoken, /11,900/);
  assert.doesNotMatch(total.spoken.split(". ")[0], /12,400/);
  const deliv = ask(
    "procurement-packet.pdf",
    "Were the chairs delivered on 10 November?",
  );
  assert.match(
    deliv.spoken,
    /^Not according to the most authoritative record\./,
  );
  assert.match(deliv.spoken, /14 Nov 2026/);
  // the draft's date is named for what it is
  assert.match(
    deliv.spoken,
    /10 November you mention is from the Quotation q-7781 \(p\.1, draft\)/,
  );
  assert.match(
    ask("procurement-packet.pdf", "When were the chairs delivered?").spoken,
    /14 Nov 2026\. The earlier Quotation q-7781 \(p\.1, draft\) said Estimated delivery: 10 Nov 2026; it is superseded/,
  );
  const quote = ask("procurement-packet.pdf", "Was the 12,400 quote approved?");
  assert.match(quote.spoken, /11,900/);
  assert.match(quote.spoken, /12,400.* you mention is from the Quotation/);
  assert.match(
    ask("procurement-packet.pdf", "Who approved the purchase order?").spoken,
    /Priya Nair/,
  );
  assert.match(
    ask("procurement-packet.pdf", "How much is still owed to the supplier?")
      .spoken,
    /6,900/,
  );
  // a later authoritative record over an earlier one; a draft never wins
  assert.match(
    ask("lease-packet.pdf", "What will the rent be from January 2027?").spoken,
    /48,000/,
  );
  assert.match(
    ask("lease-packet.pdf", "How much is the security deposit?").spoken,
    /1,35,000/,
  );
  // the residual amount, not the amount payable before payments
  assert.match(
    ask("riverbend-clinic-packet.pdf", "How much does the patient still owe?")
      .spoken,
    /4,050/,
  );
  // "when" wants a date, from the signed note, never the draft plan
  const dis = ask(
    "riverbend-clinic-packet.pdf",
    "When was the patient discharged?",
  );
  assert.match(dis.spoken, /05 Nov 2026/);
  assert.doesNotMatch(dis.spoken.split(". ")[0], /03 Nov/);
});

test("the same amount printed differently is not a superseded value", () => {
  const a = ask("riverbend-clinic-packet.pdf", "What was the total bill?");
  assert.match(a.spoken, /24,050/);
  assert.ok(a.superseded.every((x) => !/24,050/.test(x.fact.value)));
});

test("a question about something the documents never mention is not answered", () => {
  assert.equal(
    ask("procurement-packet.pdf", "What is the warranty period on the chairs?"),
    null,
  );
  assert.equal(ask("lease-packet.pdf", "Is there a parking fee?"), null);
});

test("records graph: grounded, no self-loops, identity kept apart", () => {
  const sources = Object.entries(docs).map(([f, d], i) => ({
    id: "s" + i,
    title: f,
    text: d.text,
  }));
  const bundle = {
    sources,
    records: sources.map((src, i) => ({
      source: src,
      records: recordsOf(Object.values(docs)[i]),
    })),
  };
  const g = recordGraph(bundle);
  const ids = new Set(g.nodes.map((n) => n.id));
  assert.ok(
    g.edges.every((e) => e.from !== e.to),
    "no self-loops",
  );
  assert.ok(
    g.edges.every((e) => ids.has(e.from) && ids.has(e.to)),
    "no dangling edges",
  );
  for (const n of g.nodes.filter((n) => n.kind === "value")) {
    assert.ok(n.evidence, n.id);
    const src = sources.find((s) => s.id === n.evidence.sourceId);
    assert.equal(
      src.text.slice(n.evidence.start, n.evidence.end),
      n.evidence.quote,
    );
  }
  const sup = g.edges.filter((e) => e.kind === "supersedes");
  const lab = (id) => g.nodes.find((n) => n.id === id).label;
  assert.ok(
    sup.some((e) => /11,900/.test(lab(e.from)) && /12,400/.test(lab(e.to))),
  );
  assert.ok(
    sup.some((e) => /14 Nov/.test(lab(e.from)) && /10 Nov/.test(lab(e.to))),
  );
  // a superseded value really differs in amount from what replaced it
  for (const e of sup) assert.notEqual(lab(e.from), lab(e.to));
  assert.ok(
    g.edges.some(
      (e) =>
        e.kind === "same name, different ID" &&
        [e.from, e.to].sort().join() ===
          ["patient:RB-30211", "patient:RB-30244"].join(),
    ),
  );
});

test("records about different patients never supersede each other", async () => {
  const { doc } = await parseBuffer(
    readFileSync(
      new URL(
        "../clinical/fixtures/files/packet-synthetic.pdf",
        import.meta.url,
      ),
    ),
    "packet.pdf",
  );
  const src = { id: "p", title: "packet.pdf", text: doc.text };
  const g = recordGraph({
    sources: [src],
    records: [{ source: src, records: recordsOf(doc) }],
  });
  const recOf = new Map(
    g.edges.filter((e) => e.kind === "records").map((e) => [e.to, e.from]),
  );
  const patientOf = new Map(
    g.edges.filter((e) => e.kind === "has record").map((e) => [e.to, e.from]),
  );
  for (const e of g.edges.filter((e) => e.kind === "supersedes")) {
    const a = patientOf.get(recOf.get(e.from));
    const b = patientOf.get(recOf.get(e.to));
    assert.ok(!a || !b || a === b, `${e.from} (${a}) replaces ${e.to} (${b})`);
  }
});

test("records graph: an unidentified record never supersedes a known patient's record", () => {
  const src = { id: "h", title: "harborline.pdf", text: "placeholder" };
  const mk = (index, patient, authority, value) => ({
    index,
    pages: [index],
    patient,
    start: 0,
    end: 0,
    title: "Billing",
    status: authority === "authoritative" ? "FINAL POSTED" : "ESTIMATE ONLY",
    authority,
    facts: [
      {
        id: `${index}.1`,
        record: index,
        concept: "total charges",
        line: null,
        label: "Total charges",
        value,
        start: 0,
        end: 1,
      },
    ],
  });
  const graphOf = (records) =>
    recordGraph({ sources: [src], records: [{ source: src, records }] });
  const supOf = (g) => g.edges.filter((e) => e.kind === "supersedes");
  // An unidentified FINAL record must not replace a known patient's ESTIMATE.
  const anonOverKnown = graphOf([
    mk(1, "HLG-P1047", "provisional", "USD 100.00"),
    mk(2, null, "authoritative", "USD 150.00"),
  ]);
  assert.equal(
    supOf(anonOverKnown).length,
    0,
    "unidentified record replaced a known patient's record",
  );
  // Same patient, preliminary vs amended: the chain still works.
  const samePatient = graphOf([
    mk(3, "HLG-P1047", "provisional", "USD 100.00"),
    mk(4, "HLG-P1047", "authoritative", "USD 150.00"),
  ]);
  assert.equal(
    supOf(samePatient).length,
    1,
    "same-patient correction no longer supersedes",
  );
  // Both unidentified: existing competition behavior is unchanged.
  const bothAnon = graphOf([
    mk(5, null, "provisional", "USD 100.00"),
    mk(6, null, "authoritative", "USD 150.00"),
  ]);
  assert.equal(supOf(bothAnon).length, 1);
});

test("fact answers: an unidentified record does not supersede a known patient's record", () => {
  const src = {
    id: "h",
    text: "Total charges USD 100.00 estimated. Total charges USD 150.00 final.",
  };
  const mk = (index, patient, authority, value) => ({
    index,
    pages: [index],
    patient,
    start: 0,
    end: 0,
    title: "Billing",
    status: authority === "authoritative" ? "FINAL POSTED" : "ESTIMATE ONLY",
    authority,
    facts: [
      {
        id: `${index}.1`,
        record: index,
        concept: "total charges",
        line: null,
        label: "Total charges",
        value,
        start: 0,
        end: 1,
      },
    ],
  });
  const a = factAnswer("What were the total charges?", [
    {
      source: src,
      records: [
        mk(1, "HLG-P1047", "provisional", "USD 100.00"),
        mk(2, null, "authoritative", "USD 150.00"),
      ],
    },
  ]);
  assert.ok(a);
  assert.match(a.spoken, /150/);
  assert.equal(
    a.superseded.length,
    0,
    "a known patient's record was called superseded by an unidentified record",
  );
});

test("a fact's citation page comes from its own span, not the record's first page", () => {
  const t1 =
    "Billing Summary\n\n| Item | Amount |\n| Consultation | USD 100.00 |\n";
  const t2 =
    "Billing Summary\n\n| Item | Amount |\n| Total charges | USD 150.00 |\n";
  const text = t1 + t2;
  const doc = {
    text,
    pages: [{ number: 1 }, { number: 2 }],
    elements: [
      {
        id: "h1",
        type: "heading",
        text: "Billing Summary",
        page: 1,
        start: 0,
        end: 15,
        indexed: true,
      },
      {
        id: "t1",
        type: "table",
        page: 1,
        start: 17,
        end: t1.length - 1,
        indexed: true,
      },
      {
        id: "h2",
        type: "heading",
        text: "Billing Summary",
        page: 2,
        start: t1.length,
        end: t1.length + 15,
        indexed: true,
      },
      {
        id: "t2",
        type: "table",
        page: 2,
        start: t1.length + 17,
        end: text.length - 1,
        indexed: true,
      },
    ],
  };
  const recs = recordsOf(doc);
  assert.equal(recs.length, 1);
  assert.deepEqual(recs[0].pages, [1, 2]);
  const f150 = recs[0].facts.find((f) => /150/.test(f.value));
  assert.ok(f150, "page-2 fact missing");
  assert.deepEqual(f150.pages, [2], "fact pages not resolved from its span");
  const src = { id: "s", title: "bill.pdf", text };
  const g = recordGraph({
    sources: [src],
    records: [{ source: src, records: recs }],
  });
  const n = g.nodes.find((n) => n.kind === "value" && /150/.test(n.label));
  assert.ok(n, "graph node for page-2 fact missing");
  assert.equal(n.evidence.page, 2, "citation page is the record's first page");
});

test("a question naming a patient is never answered from an unidentified record", () => {
  const src = {
    id: "h",
    text: "Ferritin HLG-P1047 5 ng/mL preliminary. Ferritin 50 ng/mL amended. Ferritin 8 ng/mL.",
  };
  const mk = (index, patient, authority, value) => ({
    index,
    pages: [index],
    patient,
    start: 0,
    end: 0,
    title: "Lab",
    status: authority === "authoritative" ? "AMENDED" : "PRELIMINARY",
    authority,
    facts: [
      {
        id: `${index}.1`,
        record: index,
        concept: "ferritin",
        line: null,
        label: "Ferritin",
        value,
        start: 0,
        end: 1,
      },
    ],
  });
  const a = factAnswer("What was HLG-P1047 ferritin?", [
    {
      source: src,
      records: [
        mk(1, "HLG-P1047", "provisional", "5 ng/mL"),
        mk(2, null, "authoritative", "50 ng/mL"),
        mk(3, "HLG-P1048", "authoritative", "8 ng/mL"),
      ],
    },
  ]);
  assert.ok(a, "named patient's own record should answer");
  assert.equal(a.record.patient, "HLG-P1047");
  assert.match(a.spoken, /5 ng\/mL/);
  // When the named patient has no record of the fact, fail closed instead
  // of borrowing an unidentified record.
  const b = factAnswer("What was HLG-P1048 TSH?", [
    {
      source: src,
      records: [mk(4, null, "authoritative", "1.4 mIU/L")],
    },
  ]);
  assert.equal(b, null, "unidentified record answered for a named patient");
});

test("a name-only question over two same-name patients clarifies, never picks", () => {
  const text1 =
    "PATIENT NAME | PATIENT ID\nMaya Sharma | HLG-P1047\n\n| Test | Value |\n| Ferritin | 5 ng/mL |";
  const text2 =
    "PATIENT NAME | PATIENT ID\nMaya Sharma | HLG-P1048\n\n| Test | Value |\n| Ferritin | 8 ng/mL";
  const mk = (index, patient, value, start, end) => ({
    index,
    pages: [index],
    patient,
    start,
    end,
    title: "Lab Results",
    status: "FINAL",
    authority: "authoritative",
    facts: [
      {
        id: `${index}.1`,
        record: index,
        concept: "ferritin",
        line: null,
        label: "Ferritin",
        value,
        start,
        end: Math.min(start + 8, end),
      },
    ],
  });
  const src = { id: "h", text: text1 + "\n\n" + text2 };
  const records = [
    mk(1, "HLG-P1047", "5 ng/mL", 0, text1.length),
    mk(2, "HLG-P1048", "8 ng/mL", text1.length + 2, src.text.length),
  ];
  const a = factAnswer("What was Maya Sharma ferritin?", [
    { source: src, records },
  ]);
  assert.ok(a, "an ambiguity must still answer with a clarification");
  assert.equal(a.clarify, true);
  assert.equal(a.lead, null, "no value may be picked for an ambiguous name");
  assert.match(a.spoken, /HLG-P1047/);
  assert.match(a.spoken, /HLG-P1048/);
  for (const q of [
    "what was maya sharma ferritin?",
    "WHAT WAS MAYA SHARMA FERRITIN?",
  ]) {
    const lower = factAnswer(q, [{ source: src, records }]);
    assert.equal(
      lower?.clarify,
      true,
      "name identity must not depend on capitalization",
    );
    assert.equal(lower.lead, null);
  }
  // One patient with that name: answered normally.
  const b = factAnswer("What was Maya Sharma ferritin?", [
    { source: src, records: [records[0]] },
  ]);
  assert.ok(b && !b.clarify);
  assert.match(b.spoken, /5 ng\/mL/);
  // A question naming the ID is specific: no clarification needed.
  const c = factAnswer("What was HLG-P1048 ferritin?", [
    { source: src, records },
  ]);
  assert.ok(c && !c.clarify);
  assert.match(c.spoken, /8 ng\/mL/);
});
