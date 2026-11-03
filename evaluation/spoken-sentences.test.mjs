// Sentence splitter: dotted numbers (times, currencies, versions) must not
// fragment records or lose surrounding text.
import test from "node:test";
import assert from "node:assert/strict";
import { importBundle } from "../dist/engine.mjs";
import { sentencesOf } from "../src/spoken-routes.mjs";

const sents = (text) =>
  sentencesOf(importBundle([{ title: "t.pdf", text }]).sources[0]).map(
    (s) => s.text,
  );

const PAD = "Planning Committee Meeting Minutes, 24 January 2025.";

test("decimal time keeps the whole record", () => {
  assert.deepEqual(sents(`${PAD}\nBill Lobban left the meeting at 11.08am.`), [
    "Planning Committee Meeting Minutes, 24 January 2025.",
    "Bill Lobban left the meeting at 11.08am.",
  ]);
});

test("currency keeps the whole record", () => {
  const got = sents(`${PAD}\nThe application fee was $42.50.`);
  assert.ok(got.includes("The application fee was $42.50."), got.join(" | "));
});

test("semver keeps surrounding text, all characters", () => {
  assert.deepEqual(
    sents("The version is 1.2.3 and it works.\nRelease 2.0 shipped.\nThen 2.0.1 fixed it."),
    [
      "The version is 1.2.3 and it works.",
      "Release 2.0 shipped.",
      "Then 2.0.1 fixed it.",
    ],
  );
});

test("plain sentence-ending integers still terminate", () => {
  const got = sents(`${PAD}\nThe fee was 50. The fee was 60.`);
  assert.ok(got.includes("The fee was 50."), got.join(" | "));
  assert.ok(got.includes("The fee was 60."), got.join(" | "));
});
