import test from "node:test";
import assert from "node:assert/strict";
import { importBundle, answer } from "../dist/engine.mjs";
const q = [
  ["Who received order ORCHID-33?", "receiver"],
  ["Who is the recipient for ORCHID-33?", "receiver"],
  ["Who was the parcel delivered to for ORCHID-33?", "receiver"],
  ["What is the tracking number for ORCHID-33?", "tracking"],
  ["What is the carrier reference for ORCHID-33?", "tracking"],
  ["What is the shipment tracking code for ORCHID-33?", "tracking"],
];
for (const [query, kind] of q) {
  test(
    "missing " +
      kind +
      " refuses but preserves inspectable candidates: " +
      query,
    () => {
      const b = importBundle([
        {
          title: "order",
          text: "Order ORCHID-33; Account manager Noor Vale; Internal reference 771204; parcel ready for pickup.",
        },
      ]);
      const r = answer(query, b);
      assert.equal(r.supported, false);
      assert.notEqual(r.evidenceStatus, "positive");
      assert.ok(r.reviewEvidence.length);
    },
  );
  test("explicit " + kind + " remains answerable: " + query, () => {
    const b = importBundle([
      {
        title: "order",
        text: `Order ORCHID-33; Receiver Isha Sen; ${/carrier reference/i.test(query) ? "Carrier reference" : "Tracking number"} PKG-004701; parcel ready for pickup.`,
      },
    ]);
    const r = answer(query, b);
    assert.equal(r.supported, true);
    assert.equal(r.evidenceStatus, "positive");
    assert.ok(
      r.evidence.some((e) =>
        e.quote.includes(kind === "receiver" ? "Isha Sen" : "PKG-004701"),
      ),
    );
  });
}
for (const field of [
  "units",
  "items",
  "packages",
  "cartons",
  "shipment weight",
  "dispatched quantity",
]) {
  const query = `What is the ${field} for parcel PINE-62?`;
  test("absent quantity field remains unknown: " + field, () => {
    const b = importBundle([
      {
        title: "parcel",
        text: "Parcel PINE-62; Account coordinator Mira Chen; Internal control number 88031; Package ready for dispatch.",
      },
    ]);
    const r = answer(query, b);
    assert.equal(r.supported, false);
    assert.notEqual(r.evidenceStatus, "positive");
  });
  test("explicit quantity field remains useful: " + field, () => {
    const text =
      "Parcel PINE-62; Units: 23; Items: 24; Packages: 25; Cartons: 26; Shipment weight: 27 kg; Dispatched quantity: 28 items.";
    const r = answer(query, importBundle([{ title: "parcel", text }]));
    assert.equal(r.supported, true);
    assert.equal(r.evidenceStatus, "positive");
  });
}
test("weight without printed units and unknown receiver are not populated support", () => {
  for (const [text, query] of [
    [
      "Parcel PINE-62; Shipment weight: 27; Internal control number 88031.",
      "What is the shipment weight for PINE-62?",
    ],
    [
      "Order ORCHID-33; Receiver: unknown; Account manager Noor Vale.",
      "Who received order ORCHID-33?",
    ],
  ])
    assert.equal(
      answer(query, importBundle([{ title: "record", text }])).supported,
      false,
    );
});

test("explicit recorded absence differs from mere missing fields", () => {
  const b = importBundle([
    {
      title: "record",
      text: "Order ORCHID-33; Tracking number: not recorded; Recipient: not specified; Internal reference 771204.",
    },
  ]);
  for (const query of [
    "What is the tracking number for ORCHID-33?",
    "Who is the recipient for ORCHID-33?",
  ]) {
    const r = answer(query, b);
    assert.equal(r.supported, true);
    assert.ok(
      r.evidence.some((e) => /not recorded|not specified/.test(e.quote)),
    );
  }
});
test("natural modified counts and unrelated-file coverage remain useful", () => {
  const docs = [
    {
      title: "safety",
      text: "The east warehouse recorded 14 open safety items during the October safety review.",
    },
    { title: "ivy", text: "Contract IVY-08 review window: 5 business days." },
    {
      title: "draft",
      text: "MAPLE-54 proposed draft engagement fee is $1,200, awaiting review.",
    },
    {
      title: "signed",
      text: "MAPLE-54 signed final engagement fee is $1,450, approved for this service.",
    },
  ];
  assert.equal(
    answer(
      "How many open safety items did the east warehouse record?",
      importBundle(docs),
    ).supported,
    true,
  );
  const r = answer("What is the review window for IVY-08?", importBundle(docs));
  assert.equal(r.supported, true);
  assert.ok(r.evidence.every((e) => e.title === "ivy"));
});

test("gross weight and how-heavy preserve printed units, never borrow unit from question", () => {
  for (const query of [
    "What is the gross weight for PINE-62?",
    "How heavy is parcel PINE-62?",
    "What is the gross weight in kg for PINE-62?",
  ]) {
    const yes = answer(
      query,
      importBundle([
        {
          title: "parcel",
          text: "Parcel PINE-62; Approved quantity: 12 units; Gross weight: 7.5 kg.",
        },
      ]),
    );
    assert.equal(yes.supported, true, query);
    const no = answer(
      query,
      importBundle([
        {
          title: "parcel",
          text: "Parcel PINE-62; Approved quantity: 12; Gross weight: 7.5; Account coordinator Mira Chen.",
        },
      ]),
    );
    assert.equal(no.supported, false, query);
  }
});
test("explicit requested weight unit cannot be replaced by another printed unit", () => {
  const r = answer(
    "What is the gross weight in kg for PINE-62?",
    importBundle([
      {
        title: "parcel",
        text: "Parcel PINE-62; Gross weight: 7.5 lb; Account coordinator Mira Chen.",
      },
    ]),
  );
  assert.equal(r.supported, false);
});

test("one source cannot lend a later orders tracking/receiver to an earlier order", () => {
  const b = importBundle([
    {
      title: "two orders",
      text: "Order ORCHID-33; Account manager Noor Vale; Internal reference 771204.\nOrder ORCHID-34; Receiver Isha Sen; Tracking number PKG-004701.",
    },
  ]);
  for (const query of [
    "Who received order ORCHID-33?",
    "What is the tracking number for ORCHID-33?",
  ])
    assert.equal(answer(query, b).supported, false, query);
  for (const query of [
    "Who received order ORCHID-34?",
    "What is the tracking number for ORCHID-34?",
  ])
    assert.equal(answer(query, b).supported, true, query);
});
test("negative receiver/tracking relations are not dropped before labeled values", () => {
  for (const [text, query] of [
    [
      "Order ORCHID-33; Not the receiver: Isha Sen; Account manager Noor Vale.",
      "Who is the receiver for ORCHID-33?",
    ],
    [
      "Order ORCHID-33; Not a tracking number: PKG-004701; Internal reference 771204.",
      "What is the tracking number for ORCHID-33?",
    ],
  ])
    assert.equal(
      answer(query, importBundle([{ title: "negative", text }])).supported,
      false,
    );
});
test("same-prefix distinct files preserve exact requested identity and missing-ID refusal", () => {
  const b = importBundle([
    {
      title: "pine62",
      text: "Parcel PINE-62; Units: 12; Tracking number: 555021; Recipient: Mira Chen.",
    },
    {
      title: "pine63",
      text: "Parcel PINE-63; Units: 24; Tracking number: 555022; Recipient: Noor Vale.",
    },
  ]);
  for (const [id, title] of [
    ["PINE-62", "pine62"],
    ["PINE-63", "pine63"],
  ])
    for (const query of [
      `How many units for ${id}?`,
      `What is the tracking number for ${id}?`,
      `Who is the recipient for ${id}?`,
    ]) {
      const r = answer(query, b);
      assert.equal(r.supported, true, query);
      assert.ok(
        r.evidence.every((e) => e.title === title),
        query,
      );
    }
  for (const query of [
    "How many units for PINE-64?",
    "What is the tracking number for PINE-64?",
  ])
    assert.equal(answer(query, b).supported, false);
});

test("reviewed unsupported role, modifier and ID controls stay non-positive", () => {
  for (const [text, q] of [
    [
      "Order ORCHID-33; Receiver Isha Sen was never appointed.",
      "Who is the receiver for ORCHID-33?",
    ],
    [
      "Order ORCHID-33; Receiver remains to be confirmed.",
      "Who is the receiver for ORCHID-33?",
    ],
    [
      "Order ORCHID-33; Invalid tracking number: PKG-004701.",
      "What is the tracking number for ORCHID-33?",
    ],
    [
      "The east warehouse recorded 14 closed safety items during the October safety review.",
      "How many open safety items did the east warehouse record?",
    ],
    [
      "PINE-620; Units: 12; Recipient Mira Chen.",
      "Who is the recipient for PINE-62?",
    ],
    [
      "Parcel PINE-62; Net weight: 7.5 kg.",
      "What is the gross weight for PINE-62?",
    ],
    [
      "Parcel PINE-62; Approved quantity: 12 units; Dispatched quantity: 8 items.",
      "How many approved items for PINE-62?",
    ],
  ])
    assert.equal(
      answer(
        q,
        importBundle([
          { title: "record", text: text + "\nDocument recorded for review." },
        ]),
      ).supported,
      false,
      text,
    );
});
test("comma-separated explicit receiver name remains supported", () => {
  const r = answer(
    "Who received order ORCHID-33?",
    importBundle([
      {
        title: "order",
        text: "Order ORCHID-33; Receiver: Sen, Isha. Document recorded for review.",
      },
    ]),
  );
  assert.equal(r.supported, true);
});

test("explicit labelled name Will Smith is not a modal clause", () => {
  const r = answer(
    "Who received order ORCHID-33?",
    importBundle([
      {
        title: "order",
        text: "Order ORCHID-33; Receiver: Will Smith; Document recorded for review.",
      },
    ]),
  );
  assert.equal(r.supported, true);
});
