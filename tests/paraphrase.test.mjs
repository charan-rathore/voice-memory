// paraphrase.mjs without the model: units carry their document context and
// exact offsets, fusion favours meaning over words, and the gate refuses
// low-confidence and two-document ties. The model-backed numbers live in
// evaluation/paraphrase-bench.mjs (CI, bench workflow).
import { test } from "node:test";
import assert from "node:assert/strict";
import { importBundle } from "../dist/engine.mjs";
import {
  unitsOf,
  rankUnits,
  gate,
  GATE,
  paraphraseLookup,
} from "../src/paraphrase.mjs";

const bundle = importBundle([
  {
    title: "01_Proposal.md",
    text: "# Pilot Proposal\nAuthor: P. Rao. Date: 2026-09-04. Type: proposal.\n1. The fixed engagement fee is $48,000 for three regions.\n2. The pilot deadline is 15 November 2026.",
  },
  {
    title: "02_Email.md",
    text: "# Client Email\nAuthor: R. Kapoor. Date: 2026-10-06. Type: email extract.\n1. The client asks to keep the original deadline for the pilot.",
  },
]);

test("units are single sentences with their document's context and exact offsets", () => {
  const { units } = unitsOf(bundle);
  assert.equal(units.length, 3);
  for (const u of units) {
    assert.equal(u.src.text.slice(u.sent.start, u.sent.end), u.sent.text);
    assert.match(
      u.text,
      /^(Pilot Proposal, proposal, 2026-09-04|Client Email, email extract, 2026-10-06): /,
    );
  }
});

// fake unit vectors: one-hot per unit, so the query picks a unit exactly
const withVectors = (vecs) => {
  const idx = unitsOf(bundle);
  idx.vectors = vecs.map((v) => Float32Array.from(v));
  return idx;
};

test("with no shared words the ranking follows meaning", () => {
  withVectors([
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ]);
  // a paraphrase shares no words with the deadline sentence
  const r = rankUnits(
    "when must it be ready",
    bundle,
    Float32Array.from([0, 0.9, 0.1]),
  );
  assert.match(r[0].unit.sent.text, /deadline is 15 November/);
});

test("the gate refuses low confidence and cross-document ties", () => {
  const top = (cos, rival) => [
    { unit: { src: "a" }, cosine: cos },
    { unit: { src: "a" }, cosine: cos - 0.001 },
    { unit: { src: "b" }, cosine: rival },
  ];
  assert.equal(gate(top(GATE.minCosine - 0.01, 0.1)), null, "below the floor");
  assert.ok(gate(top(0.9, 0.5)), "clear winner");
  assert.equal(
    gate(top(0.9, 0.9 - 0.001), { minCosine: 0.6, minMargin: 0.02 }),
    null,
    "another document says nearly the same",
  );
  assert.equal(gate([]), null);
});

test("without the model resident it abstains instead of waiting", async () => {
  const fresh = importBundle([
    {
      title: "x.md",
      text: "One sentence about the pilot fee, which is forty eight thousand dollars.",
    },
  ]);
  assert.equal(await paraphraseLookup("how much does it cost", fresh), null);
});

test("the lookup's query prefix exists (a missing constant silently disabled every rescue)", async () => {
  const P = await import("../src/paraphrase.mjs");
  assert.equal(typeof P.QUERY_PREFIX, "string");
});

test("the agreement path enforces the cross-document margin (false-confidence regression)", () => {
  // Two documents discuss the same fee; the lexical leader clears the
  // agreement cosine floor but a rival document is within the margin. The
  // old code spoke it anyway - a topically-similar sentence presented as
  // the answer. The gate must abstain.
  const ranked = [
    { unit: { src: "a" }, cosine: 0.62, lexical: 1.0, fused: 0.7 },
    { unit: { src: "b" }, cosine: 0.61, lexical: 0.2, fused: 0.55 },
    { unit: { src: "a" }, cosine: 0.4, lexical: 0.1, fused: 0.35 },
  ];
  assert.equal(
    gate(ranked, { minCosine: 0.72, minMargin: 0.02, agree: 0.5 }),
    null,
    "lexical agreement cannot settle a between-document ambiguity",
  );
  const clear = [
    { unit: { src: "a" }, cosine: 0.62, lexical: 1.0, fused: 0.7 },
    { unit: { src: "b" }, cosine: 0.3, lexical: 0.2, fused: 0.25 },
  ];
  const hit = gate(clear, { minCosine: 0.72, minMargin: 0.02, agree: 0.5 });
  assert.ok(hit, "a lexical leader with a real margin still passes");
  assert.equal(hit.agreed, true);
  assert.ok(hit.margin >= 0.02);
});

test("a sentence stating a superseded value is never promoted (stale-fee regression)", async () => {
  const { statesUnresolvedValue } = await import("../src/paraphrase.mjs");
  const two = importBundle([
    {
      title: "01_Proposal.md",
      text: "# Northstar Pilot Proposal\nAuthor: P. Rao. Date: 2026-10-04. Type: proposal.\n1. The fixed engagement fee is $42,000 for three regions.",
    },
    {
      title: "02_Revision.md",
      text: "# Northstar Pilot Proposal - revised\nAuthor: P. Rao. Date: 2026-10-20. Type: revision.\n1. The fixed engagement fee is revised to $48,000, superseding the earlier $42,000.",
    },
  ]);
  assert.equal(
    statesUnresolvedValue(
      two,
      "The fixed engagement fee is $42,000 for three regions.",
    ),
    true,
    "the October 4 value is superseded by the October 20 revision",
  );
  assert.equal(
    statesUnresolvedValue(
      two,
      "The fixed engagement fee is revised to $48,000.",
    ),
    false,
    "the current value is speakable",
  );
  const single = importBundle([
    {
      title: "x.md",
      text: "# Note\nDate: 2026-10-04. Type: note.\n1. The fee is $42,000.",
    },
  ]);
  assert.equal(
    statesUnresolvedValue(single, "The fee is $42,000."),
    false,
    "no amendment chain, no refusal",
  );
});

test("a sentence presenting one side of an unresolved conflict is never promoted (competing-fees regression)", async () => {
  const { statesUnresolvedValue } = await import("../src/paraphrase.mjs");
  // The reviewer's S2 fixture shape: generic titles, no established
  // engagement identity, no amendment wording - the claims compete.
  const conflict = importBundle([
    {
      title: "a-2026-10-proposal.pdf",
      text: "Date: 2026-10-04\nType: Proposal\n# Proposal\nThe consulting fee is $42,000 for the full engagement.\nPayment is due within thirty days of invoice.",
    },
    {
      title: "b-2026-10-revision.pdf",
      text: "Date: 2026-10-20\nType: Revision\n# Revision\nThe consulting fee is $48,000 after the scope change.\nPayment is due within thirty days of invoice.",
    },
  ]);
  assert.equal(
    statesUnresolvedValue(
      conflict,
      "The consulting fee is $42,000 for the full engagement.",
    ),
    true,
    "the older side of an unresolved conflict abstains",
  );
  assert.equal(
    statesUnresolvedValue(
      conflict,
      "The consulting fee is $48,000 after the scope change.",
    ),
    true,
    "the newer side abstains too - the engine's conflict answer speaks instead",
  );
  assert.equal(
    statesUnresolvedValue(
      conflict,
      "Payment is due within thirty days of invoice.",
    ),
    false,
    "an uncontested fact stays speakable",
  );
});

test("production boundary: promotedAnswer abstains unless a developer explicitly opts in", async () => {
  const { promotedAnswer, paraphrasePromoteEnabled } = await import(
    "../src/paraphrase.mjs"
  );
  const saved = process.env.VM_PARAPHRASE_PROMOTE;
  try {
    delete process.env.VM_PARAPHRASE_PROMOTE;
    assert.equal(paraphrasePromoteEnabled(), false);
    // A null bundle throws inside paraphraseLookup; a null result here
    // proves the promotion machinery was never reached on the default
    // (production) path - no gate, primary or agreement, is consulted.
    assert.equal(await promotedAnswer("anything", null), null);
    process.env.VM_PARAPHRASE_PROMOTE = "1";
    assert.equal(paraphrasePromoteEnabled(), true);
    await assert.rejects(
      () => promotedAnswer("anything", null),
      "with the opt-in set the preserved machinery is reached",
    );
  } finally {
    if (saved === undefined) delete process.env.VM_PARAPHRASE_PROMOTE;
    else process.env.VM_PARAPHRASE_PROMOTE = saved;
  }
});

test("a preliminary document beside its amendment is a replaced source", async () => {
  const { replacedSource, unitsOf: u } = await import("../src/paraphrase.mjs");
  const lab = importBundle([
    {
      title: "a-2026-10-prelim.md",
      text: "# Laboratory report (PRELIMINARY)\nDate: 2026-10-13.\n1. Ferritin 5 ng/mL.",
    },
    {
      title: "a-2026-10-amended.md",
      text: "# Laboratory report (AMENDED)\nDate: 2026-10-15.\n1. Ferritin 50 ng/mL. Amended: ferritin corrected from 5 to 50.",
    },
  ]);
  const [prelim, amended] = lab.sources;
  assert.equal(replacedSource(lab, prelim), true);
  assert.equal(replacedSource(lab, amended), false);
  // alone, a preliminary report is the only record: not replaced
  const alone = importBundle(
    [lab.sources[0]].map((s) => ({ title: s.title, text: s.text })),
  );
  assert.equal(replacedSource(alone, alone.sources[0]), false);
  assert.ok(u(lab).units.length >= 2);
});

test("closestLine abstains without the model and never claims to be an answer", async () => {
  const { closestLine } = await import("../src/paraphrase.mjs");
  const fresh = importBundle([
    {
      title: "x.md",
      text: "# Note\nDate: 2026-01-01.\n1. The budget review moved to Friday.",
    },
  ]);
  // no resident model in unit tests: no pointer, no wait beyond the cap
  const t0 = Date.now();
  assert.equal(await closestLine("when is the money meeting", fresh), null);
  assert.ok(Date.now() - t0 < 4000);
});

test("discovery gate: in one document the margin is over the next line, not another document", async () => {
  const { discoveryGate, gate: promote } = await import(
    "../src/paraphrase.mjs"
  );
  const src = { id: "only" };
  const u = (cosine, lexical) => ({ unit: { src }, cosine, lexical });
  // two near-identical lines in a single file: the promotion gate sees no
  // rival document and passes; discovery sees a tie and refuses
  const tie = [u(0.86, 2), u(0.855, 1), u(0.4, 0)];
  assert.ok(promote(tie, { minCosine: 0.72, minMargin: 0.02 }));
  assert.equal(
    discoveryGate(tie, { minCosine: 0.7, minMargin: 0.03, lexTop: 3 }),
    null,
  );
  // a clear leader that keywords also rank near the top is shown
  const clear = [u(0.86, 2), u(0.7, 3), u(0.4, 0)];
  assert.ok(
    discoveryGate(clear, { minCosine: 0.7, minMargin: 0.03, lexTop: 3 }),
  );
  // a clear leader that keywords don't support at all is not
  const noWords = [u(0.86, 0), u(0.7, 3), u(0.4, 1)];
  assert.equal(
    discoveryGate(noWords, { minCosine: 0.7, minMargin: 0.03, lexTop: 3 }),
    null,
  );
});
