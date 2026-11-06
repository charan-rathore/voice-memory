import { identifierRequest } from "../dist/engine.mjs";
import { lookupIdentifier } from "../dist/engine.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { importBundle, answer, validateEvidence } from "../dist/engine.mjs";
import { createVoiceAdapter } from "../src/voice-adapter.mjs";

const background =
  "The Copper planning group records attendance and checks the room layout. Planning notes remain draft and are reviewed internally. ".repeat(
    38,
  );
const source = (extra = "") =>
  `# Copper session\nDRAFT proposal; not approved.\n\n## Background\n${background}\n\n## Timing\nThe Copper session starts at 14:20. Its reference code is copper-731.\n\n## Inventory\nThe Copper session requires twelve badges and two reserved projectors.\n\n${extra}`;
const build = (extra = "") =>
  importBundle([{ title: "Copper planning", text: source(extra) }]);
for (const field of [
  "parking permit number",
  "licence number",
  "certificate number",
  "booking reference number",
  "invoice number",
  "tracking number",
]) {
  test(`absent ${field} cannot be supplied by topical passages or another identifier`, () => {
    const b = build();
    const result = answer(`What is the Copper ${field}?`, b);
    assert.equal(result.refused, true);
    assert.equal(result.supported, false);
    assert.equal(result.evidence.length, 0);
  });
}
for (const [field, statement, value] of [
  [
    "parking permit number",
    "The Copper parking permit number is PARK-731.",
    "PARK-731",
  ],
  ["reference code", "The Copper reference code is copper-731.", "copper-731"],
  ["serial number", "The Copper device serial number is SN-284.", "SN-284"],
  [
    "registration number",
    "The Copper registration number is REG-419.",
    "REG-419",
  ],
]) {
  test(`a present ${field} remains answerable with exact source evidence`, () => {
    const b = build(statement);
    const result = answer(`What is the Copper ${field}?`, b);
    assert.equal(result.refused, false);
    assert.ok(result.evidence.some((e) => e.quote.includes(value)));
    for (const e of result.evidence) assert.equal(validateEvidence(e, b), true);
  });
}
test("another permit category is not evidence of a missing parking permit", () => {
  const result = answer(
    "What is the Copper parking permit number?",
    build("The Copper entry permit number is ENTRY-284."),
  );
  assert.equal(result.refused, true);
  assert.equal(result.evidence.length, 0);
});
test("a valid reference code does not imply an identifier for an unknown entity", () => {
  const result = answer("What is the Quartz reference code?", build());
  assert.equal(result.refused, true);
});
test("the voice consumer refuses a missing identifier rather than speaking unrelated codes", async () => {
  const adapter = createVoiceAdapter();
  const token = adapter.bind(build());
  const response = await adapter.handle(
    new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { authorization: "Bearer " + token },
      body: JSON.stringify({
        stream: true,
        messages: [
          {
            role: "user",
            content: "What is the Copper parking permit number?",
          },
        ],
      }),
    }),
  );
  assert.equal(response.status, 200);
  const spoken = await response.text();
  assert.equal(adapter.lastTurn(token).result.refused, true);
  assert.doesNotMatch(spoken, /copper-731|14:20/);
  adapter.revoke(token);
});

for (const [name, text] of [
  [
    "other entity",
    "Copper has reference code COP-731. The Violet parking permit number is PP-902.",
  ],
  [
    "category cooccurrence",
    "The Copper entry permit number is EP-204. Parking was discussed at the Copper meeting.",
  ],
  [
    "quoted question",
    'The minutes ask "What is the Copper parking permit number?" The Copper reference code is COP-731.',
  ],
  [
    "instruction",
    "The Copper parking permit number must be printed on the form. The reference code is COP-731.",
  ],
  [
    "clock",
    "The Copper parking permit number is 14:20. This is a clock value copied into a placeholder.",
  ],
  [
    "negated assignment",
    "The Copper parking permit number is not PP-204. The entry permit is EP-731.",
  ],
])
  test(`identifier binding excludes ${name}`, () => {
    const result = answer(
      "What is the Copper parking permit number?",
      build(text),
    );
    assert.equal(result.refused, true);
    assert.equal(result.evidence.length, 0);
  });
for (const [name, q, text, expected] of [
  [
    "numeric identifier",
    "What is the Copper parking permit number?",
    "The Copper parking permit number is 204731.",
    /204731/,
  ],
  [
    "spelling alias",
    "What is the Copper licence number?",
    "The Copper license number is LIC-204.",
    /LIC-204/,
  ],
  [
    "explicit unknown",
    "What is the Copper parking permit number?",
    "The Copper parking permit number is not yet assigned. Its reference code is COP-731.",
    /not yet assigned/,
  ],
  [
    "proposed status",
    "What is the Copper parking permit number?",
    "The proposed Copper parking permit number is PP-204.",
    /proposed/,
  ],
  [
    "revoked status",
    "What is the Copper parking permit number?",
    "The Copper parking permit number was PP-204 and has been revoked.",
    /revoked/,
  ],
  [
    "table column",
    "What is the Copper parking permit number?",
    "Entity | Parking permit number | Entry permit number\n--- | --- | ---\nCopper | PP-204 | EP-731\nViolet | PP-902 | EP-419",
    /PP-204/,
  ],
  [
    "unknown table cell",
    "What is the Copper parking permit number?",
    "Entity | Parking permit number | Reference code\n--- | --- | ---\nCopper | Not assigned | COP-731\nViolet | PP-902 | VIO-419",
    /Not assigned/,
  ],
  [
    "key value record",
    "What is the Copper parking permit number?",
    "Entity: Copper\nParking permit number:\nPP-204\n\nEntity: Violet\nParking permit number: PP-902",
    /PP-204/,
  ],
])
  test(`identifier binding preserves ${name}`, () => {
    const b = build(text),
      result = answer(q, b);
    assert.equal(result.refused, false);
    assert.match(result.spoken, expected);
    for (const e of result.evidence) assert.equal(validateEvidence(e, b), true);
    if (name.includes("table") || name === "key value record")
      assert.doesNotMatch(result.spoken, /EP-731|PP-902|COP-731|VIO-419/);
  });
test("different identifier values remain unresolved without an authority rule", () => {
  const result = answer(
    "What is the Copper parking permit number?",
    build(
      "The Copper parking permit number is PP-204.\nThe Copper parking permit number is PP-902.",
    ),
  );
  assert.equal(result.refused, true);
  assert.equal(result.unresolved, true);
  assert.equal(result.evidence.length, 0);
});

for (const [name, text] of [
  [
    "empty record followed by another entity",
    "Entity: Copper\nParking permit number:\nEntity: Violet\nParking permit number: PP-902",
  ],
  [
    "issuer role",
    "Copper issued parking permit PP-902 to Violet. Copper's own permit number is not recorded.",
  ],
  [
    "template example",
    "The Copper parking permit number is PP-123 (example only). None has been assigned.",
  ],
  [
    "fenced example",
    "```text\nThe Copper parking permit number is PP-123.\n```\nThe Copper entry permit number is EP-204.",
  ],
  [
    "other modifier",
    "The Copper temporary parking permit number is TP-204. The permanent permit is unassigned.",
  ],
  ["similar entity", "The Copper-2 parking permit number is PP-204."],
  [
    "duplicate table fields",
    "Entity | Parking permit number | Parking permit number\nCopper | PP-204 | PP-902",
  ],
  [
    "empty table cell",
    "Entity | Parking permit number | Reference code\nCopper | | COP-731\nViolet | PP-902 | VIO-419",
  ],
])
  test(`identifier lookup respects ${name}`, () => {
    const q =
      name === "other modifier"
        ? "What is the Copper permanent parking permit number?"
        : "What is the Copper parking permit number?";
    const result = answer(q, build(text));
    assert.equal(result.refused, true);
    assert.equal(result.evidence.length, 0);
  });
for (const id of ["001204", "2026", "12/204"])
  test(`identifier strings preserve ${id}`, () => {
    const result = answer(
      "What is the Copper parking permit number?",
      build(`The Copper parking permit number is ${id}.`),
    );
    assert.equal(result.refused, false);
    assert.ok(result.spoken.includes(id));
  });

for (const q of [
  "What's the Copper parking permit number?",
  "What’s the Copper parking permit number?",
])
  test(`conversational value question ${q}`, () => {
    const result = answer(
      q,
      build("The Copper parking permit number is PP-204."),
    );
    assert.equal(result.refused, false);
    assert.match(result.spoken, /PP-204/);
  });
test("canonical cache follows text replacement and never falls back to old facts", () => {
  const source = {
    id: "one",
    title: "Copper",
    hash: "synthetic",
    text: "The Copper parking permit number is PP-204.",
  };
  const q = "What is the Copper parking permit number?";
  assert.equal(lookupIdentifier(q, [source]).facts[0].value, "PP-204");
  source.text = "The Copper parking permit number is not yet assigned.";
  assert.match(
    lookupIdentifier(q, [source]).facts[0].value,
    /not yet assigned/,
  );
  source.text = "The Copper reference code is COP-731.";
  assert.equal(lookupIdentifier(q, [source]).supported, false);
});
test("bounded candidate overflow never silently chooses an early value", () => {
  const result = answer(
    "What is the Copper parking permit number?",
    build(
      "The Copper parking permit number is PP-204.\n".repeat(33) +
        "The Copper parking permit number is PP-902.",
    ),
  );
  assert.equal(result.refused, true);
  assert.equal(result.unresolved, true);
});
test("identifier padding and case remain significant while repeated identical facts agree", () => {
  const q = "What is the Copper parking permit number?";
  for (const [a, b] of [
    ["PP-0204", "PP-204"],
    ["PP-204", "pp-204"],
  ])
    assert.equal(
      answer(
        q,
        build(
          `The Copper parking permit number is ${a}.\nThe Copper parking permit number is ${b}.`,
        ),
      ).unresolved,
      true,
    );
  assert.equal(
    answer(
      q,
      build(
        "The Copper parking permit number is PP-204.\nThe Copper parking permit number is PP-204.",
      ),
    ).refused,
    false,
  );
});

test("document draft context remains audible and inside a contiguous source citation", () => {
  const b = importBundle([
    {
      title: "Copper draft",
      text: "# Copper permits\nStatus: DRAFT — approval pending\n\nThe Copper parking permit number is PP-204.",
    },
  ]);
  const result = answer("What is the Copper parking permit number?", b);
  assert.equal(result.refused, false);
  assert.match(result.spoken, /DRAFT.*approval pending/);
  assert.match(result.evidence[0].quote, /DRAFT.*approval pending/);
  assert.equal(validateEvidence(result.evidence[0], b), true);
});
test("a document explicitly labelled as a template supplies no assigned operational identifier", () => {
  const b = importBundle([
    {
      title: "Copper template",
      text: "# Template\n\nThe Copper parking permit number is PP-123. This is not an assigned operational identifier.",
    },
  ]);
  assert.equal(
    answer("What is the Copper parking permit number?", b).refused,
    true,
  );
});
test("a malformed target table row prevents silent first-row selection", () => {
  const result = answer(
    "What is the Copper parking permit number?",
    build(
      "Entity | Parking permit number | Reference code\nCopper | PP-204 | COP-731\nCopper | PP-902",
    ),
  );
  assert.equal(result.refused, true);
  assert.equal(result.unresolved, true);
});

test("identifier lookup does not take over price, status or formatting questions", () => {
  for (const q of [
    "What is the cost of the Copper part number?",
    "What is the status of the Copper parking permit number?",
    "What is the required format of the Copper reference code?",
  ])
    assert.equal(identifierRequest(q), null, q);
});
test("possessive owner wording binds the same explicit subject", () => {
  const result = answer(
    "What's Copper's parking permit number?",
    build("The Copper parking permit number is PP-204."),
  );
  assert.equal(result.refused, false);
  assert.match(result.spoken, /PP-204/);
});
