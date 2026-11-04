// Spoken-turn regressions found replaying natural call phrasing against the
// Northstar corpus. Each case was RED on main 6edac74:
//  - "Was the original fee $42,000?" got "Yes, the earlier record was
//    $48,000": a "Yes" that confirms a figure the record contradicts.
//  - Openers and contractions ("Also,", "Yeah,", "Wasn't it") were read as an
//    unknown party name and refused, although the record answers them.
//  - "Who signs off on the fee?" answered the amount instead of the approver.
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadBundle } from "./spoken-eval.mjs";
import { spokenTurn } from "../src/spoken.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const b = loadBundle(path.join(root, "examples/corpus-md"));
const say = (q) => spokenTurn(q, b, null).spoken;

test("history yes/no: 'Yes' only when the named figure is the earlier record", () => {
  for (const q of [
    "Was the original fee $42,000?",
    "Was it 42,000 originally?",
  ])
    assert.match(say(q), /^No, the earlier record was \$48,000\./, q);
  for (const q of [
    "Was it 48,000 originally?",
    "Wasn't it 48,000 before?",
    "It was 48,000 before, wasn't it?",
  ])
    assert.match(say(q), /^Yes, the earlier record was \$48,000\./, q);
  // a wh-question gets the record, not an affirmation
  for (const q of [
    "What was the original fee?",
    "But I remember forty eight thousand. What happened?",
  ])
    assert.match(say(q), /^The earlier record was \$48,000\./, q);
  // a figure absent from the record is still named as absent
  assert.match(say("Was the original fee $50,000?"), /don't see \$50,000/);
});

test("spoken openers and contractions are not unknown names", () => {
  assert.match(
    say("Also, what is the fee?"),
    /\$42,000 is the latest proposal/,
  );
  assert.match(
    say("Just checking, has finance approved the fee?"),
    /not approved/,
  );
  assert.match(say("Wasnt it 48000 before"), /earlier record was \$48,000/);
  assert.match(say("Didn't they quote 30,000 earlier?"), /don't see 30,000/);
});

test("unknown parties still abstain, with or without an opener", () => {
  for (const q of [
    "What is the Acme fee?",
    "Also, what is the Acme fee?",
    "Acme's fee, is it approved?",
    "Sorry, what did Brightline quote?",
  ])
    assert.doesNotMatch(say(q), /\$\d/, q);
});

test("'who signs off' asks for the approver, not the amount", () => {
  for (const q of [
    "Who signs off?",
    "Yeah, who signs off?",
    "Who signs off on the fee?",
  ])
    assert.match(say(q), /client finance sign-off/, q);
});
