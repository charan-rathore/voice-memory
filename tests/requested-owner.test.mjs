import { test } from "node:test";
import assert from "node:assert/strict";
import {
  unboundRequestedOwner,
  namedRecordOwners,
} from "../src/requested-owner.mjs";
const bundle = {
  records: [
    {
      records: [
        {
          patient: "SYN-281",
          facts: [{ label: "Record ID", value: "CR-418" }],
        },
        { patient: "SYN-392", facts: [] },
      ],
    },
  ],
};
test("an unbound identifier in a printed namespace vetoes substitution", () => {
  assert.equal(
    unboundRequestedOwner("What were SYN-999 total charges?", bundle),
    "SYN-999",
  );
  assert.equal(
    unboundRequestedOwner("What is mass for CR-419?", bundle),
    "CR-419",
  );
});
test("known IDs and unrelated numeric tokens do not trigger this narrow veto", () => {
  for (const q of [
    "What were syn-281 total charges?",
    "What is CR-418 mass?",
    "What is Vitamin B-12?",
    "What happened on 2026-11-07?",
    "What is HbA1c?",
  ])
    assert.equal(unboundRequestedOwner(q, bundle), null);
});
test("unsupported namespaces are not silently claimed as resolved", () => {
  assert.equal(
    unboundRequestedOwner("What is mass for DR-627?", bundle),
    null,
    "no ownership guarantee outside learned namespace",
  );
});

test("complete opaque ID tokens do not become shorter unknown owners", () => {
  const b = {
    records: [
      {
        records: [
          { patient: "RX-7", facts: [] },
          { patient: "RX-8-A", facts: [] },
        ],
      },
    ],
  };
  for (const q of [
    "What were RX-8-A charges?",
    "What were XR-RX-8-A charges?",
    "What is RX-8_2?",
  ])
    assert.equal(unboundRequestedOwner(q, b), null);
  assert.equal(unboundRequestedOwner("What were RX-8 charges?", b), "RX-8");
});

test("owner matching scans each distinct record's facts only once", () => {
  let reads = 0;
  const record = {
    patient: "SYN-281",
    get facts() {
      reads++;
      return Array.from({ length: 100 }, () => ({
        label: "Charge",
        value: "USD 1",
      }));
    },
  };
  assert.deepEqual(
    namedRecordOwners("What were SYN-281 charges?", Array(100).fill(record)),
    ["SYN-281"],
  );
  assert.ok(reads <= 2, `repeated record facts scanned ${reads} times`);
});
