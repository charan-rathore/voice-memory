import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeSpoken, wordsToNumber } from "../src/spoken-normalize.mjs";

test("spoken amounts become document notation", () => {
  assert.equal(
    normalizeSpoken("did they approve forty two thousand"),
    "did they approve $42,000",
  );
  assert.equal(
    normalizeSpoken("is the retainer still ninety five hundred"),
    "is the retainer still $9,500",
  );
  assert.equal(
    normalizeSpoken("mark the twelve thousand eight hundred retainer approved"),
    "mark the $12,800 retainer approved",
  );
  assert.equal(wordsToNumber("seventy one thousand five hundred"), 71500);
});

test("splits, ordinals and go-live", () => {
  assert.equal(normalizeSpoken("is it fifty fifty"), "is it 50/50");
  assert.equal(
    normalizeSpoken("is the 50 50 split agreed"),
    "is the 50/50 split agreed",
  );
  assert.equal(
    normalizeSpoken("is go live moved to november third"),
    "is go-live moved to 3 November",
  );
  assert.equal(
    normalizeSpoken("is the deadline november twenty second"),
    "is the deadline 22 November",
  );
  assert.equal(
    normalizeSpoken("is it the 22nd of november"),
    "is it the 22 November",
  );
});

test("notation only: small words, fillers and non-numbers are left alone", () => {
  assert.equal(normalizeSpoken("which one"), "which one");
  assert.equal(
    normalizeSpoken("I have one question about two regions"),
    "I have one question about two regions",
  );
  assert.equal(normalizeSpoken("um so what's still open"), "what's still open");
  assert.equal(
    normalizeSpoken("क्या मेरा हीमोग्लोबिन कम है"),
    "क्या मेरा हीमोग्लोबिन कम है",
  );
});

test("recogniser spellings: bare digits and dropped -ed", () => {
  assert.equal(
    normalizeSpoken("but i remember 48000 what happened"),
    "i remember 48,000 what happened",
  );
  assert.equal(
    normalizeSpoken("is there a sign contract"),
    "is there a signed contract",
  );
  assert.equal(normalizeSpoken("the 2026 plan"), "the 2026 plan");
  assert.equal(normalizeSpoken("room 4512 is booked"), "room 4512 is booked");
  assert.equal(normalizeSpoken("is the fee 9500"), "is the fee $9,500");
});
