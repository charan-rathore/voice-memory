// The shared conversation contract (src/conversation-turn.mjs): one turn
// pipeline for typed and voice. These tests drive the real resolver and
// commit functions; only the record interface is a fixture, and it alone
// holds facts, so every fact asserted here came from "the record".
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  resolveConversationTurn,
  commitConversationTurn,
  createConversationState,
  describeState,
  compactAnswer,
  normalizeUtterance,
  shorterOf,
} from "../src/conversation-turn.mjs";

const VOCAB = [
  { id: "ferritin", label: "ferritin", aliases: ["ferritin", "फेरिटिन"] },
  {
    id: "creatinine",
    label: "creatinine",
    aliases: ["creatinine", "क्रिएटिनिन"],
  },
  { id: "tsh", label: "TSH", aliases: ["tsh", "thyroid", "टीएसएच"] },
  { id: "deal.fee", label: "the fee", aliases: ["fee", "fees", "फीस", "फ़ीस"] },
  {
    id: "deal.deadline",
    label: "the deadline",
    aliases: ["deadline", "डेडलाइन"],
  },
];

const FERRITIN_VALUE =
  "Ferritin is 50 ng/mL. Some general background: ferritin shows how much iron the body stores. Your doctor can read it alongside your other results.";

// A record store: facts, an amendment, an unapproved proposal, a missing
// field, and a TSH that matches two people unless an ID is given.
function fakeRecords({ ambiguousTsh = true, version = "bundle-v1" } = {}) {
  const calls = [];
  const F = {
    ferritin: {
      value: {
        spoken: FERRITIN_VALUE,
        factIds: ["lab:ferritin:amended"],
        temporal: true,
      },
      reason: {
        spoken:
          "The amended report says the original 5 was a transcription error.",
        factIds: ["lab:ferritin:amended"],
        temporal: true,
      },
      history: {
        spoken:
          "Before the amendment, the report showed 5 ng/mL; that value was superseded.",
        factIds: ["lab:ferritin:original"],
        temporal: true,
      },
      change: {
        spoken: "Ferritin was amended from 5 to 50 ng/mL.",
        factIds: ["lab:ferritin:amended", "lab:ferritin:original"],
        temporal: true,
      },
    },
    creatinine: {
      value: {
        spoken: "Creatinine is 1.1 mg/dL.",
        factIds: ["lab:creatinine:sep"],
      },
    },
    "deal.fee": {
      value: {
        spoken: "$42,000 is the latest proposal, and it is not approved.",
        factIds: ["deal:fee:rev2"],
        verdict: "PROPOSED",
      },
      status: {
        spoken: "$42,000 is the latest proposal, and it is not approved.",
        factIds: ["deal:fee:rev2"],
        verdict: "PROPOSED",
      },
      change: {
        spoken:
          "The fee went from $38,000 to $42,000. The $42,000 revision is not approved.",
        factIds: ["deal:fee:rev1", "deal:fee:rev2"],
        verdict: "PROPOSED",
        temporal: true,
      },
    },
  };
  return {
    calls,
    vocabulary: VOCAB,
    version,
    resolve(req) {
      calls.push(req);
      if (req.subject.id === "tsh") {
        if (ambiguousTsh && !req.candidateId)
          return {
            status: "ambiguous",
            candidates: [
              { id: "SYN-0003", label: "SYN-0003" },
              { id: "SYN-0007", label: "SYN-0007" },
            ],
          };
        const v = req.candidateId === "SYN-0007" ? "4.8" : "2.1";
        const who = req.candidateId ? ` for ${req.candidateId}` : "";
        return {
          status: "answered",
          spoken: `TSH${who} is ${v} mIU/L.`,
          verdict: "LATEST",
          factIds: [`lab:tsh:${req.candidateId ?? "only"}`],
        };
      }
      const byDim = F[req.subject.id];
      const f =
        byDim?.[req.dimension] ??
        (req.dimension === "status" ? null : byDim?.value);
      if (!f)
        return {
          status: "unanswered",
          spoken: `These documents don't record ${req.subject.label}.`,
          verdict: "UNKNOWN",
        };
      return {
        status: "answered",
        verdict: f.verdict ?? "LATEST",
        citations: f.factIds.map((id) => ({ sourceId: id })),
        ...f,
      };
    },
  };
}

// One call: resolve and (by default) commit each utterance.
function call({
  records = fakeRecords(),
  callId = "c1",
  version = "bundle-v1",
  mode = "typed",
} = {}) {
  let state = null;
  const turns = [];
  return {
    records,
    get state() {
      return state;
    },
    set state(s) {
      state = s;
    },
    turns,
    say(utterance, { deliver = "completed", ...extra } = {}) {
      const r = resolveConversationTurn(
        { utterance, callId, sourceVersion: version, mode, records, ...extra },
        state,
      );
      state =
        r.turn.outcome === "duplicate"
          ? r.state
          : commitConversationTurn(r.state, r.turn.turnId, {
              completed: deliver === "completed",
            });
      turns.push(r.turn);
      return r.turn;
    },
  };
}

const sentences = (s) => (s.match(/[^.!?।]+[.!?।]+/g) ?? [s]).length;

// ------------------------------------------------------------ 1 why after a result
test("direct result, then 'why was it changed?' answers the reason only", () => {
  const c = call();
  c.say("What is the ferritin?");
  const t = c.say("Why was it changed?");
  assert.equal(t.outcome, "answered");
  assert.equal(t.understanding.subject, "ferritin");
  assert.equal(t.understanding.dimension, "reason");
  assert.equal(t.understanding.followUp, true);
  assert.match(t.answer.spoken, /transcription error/);
  assert.doesNotMatch(
    t.answer.spoken,
    /Ferritin is 50|general background|doctor/i,
  );
});

test("Hinglish 'kyun badla?' after a result asks for the same reason", () => {
  const c = call();
  c.say("ferritin kitna hai?");
  const t = c.say("kyun badla?");
  assert.equal(t.understanding.subject, "ferritin");
  assert.equal(t.understanding.dimension, "reason");
  assert.match(t.answer.spoken, /transcription error/);
});

// ------------------------------------------------------------ 2 and before that
test("'and before that?' returns history only when the record set up a sequence", () => {
  const c = call();
  c.say("What is the ferritin?");
  const t = c.say("And before that?");
  assert.equal(t.outcome, "answered");
  assert.equal(t.understanding.dimension, "history");
  assert.match(t.answer.spoken, /5 ng\/mL/);

  const d = call();
  d.say("What is the creatinine?");
  const u = d.say("And before that?");
  assert.equal(u.outcome, "clarify", "no temporal referent: ask, never guess");
  assert.equal(d.records.calls.length, 1, "the record is not asked again");
});

// ------------------------------------------------------------ 3 direct subject
test("'What is the TSH?' after ferritin is about TSH, never ferritin", () => {
  const c = call({ records: fakeRecords({ ambiguousTsh: false }) });
  c.say("What is the ferritin?");
  c.say("Why was it changed?");
  const t = c.say("What is the TSH?");
  assert.equal(t.understanding.subject, "tsh");
  assert.equal(t.understanding.followUp, false);
  assert.equal(c.records.calls.at(-1).subject.id, "tsh");
  assert.doesNotMatch(t.answer.spoken, /ferritin/i);
});

// ------------------------------------------------------------ 4 clarification
test("ambiguous 'TSH?' asks; 'SYN-0003' resolves only that clarification", () => {
  const c = call();
  const ask = c.say("TSH?");
  assert.equal(ask.outcome, "clarify");
  assert.match(ask.answer.spoken, /SYN-0003.*SYN-0007/);
  assert.equal(c.state.pending.kind, "ambiguous");
  const t = c.say("SYN-0003");
  assert.equal(t.outcome, "answered");
  assert.equal(t.understanding.referencedTurnId, ask.turnId);
  assert.deepEqual(
    [c.records.calls.at(-1).subject.id, c.records.calls.at(-1).candidateId],
    ["tsh", "SYN-0003"],
  );
  assert.match(t.answer.spoken, /SYN-0003/);
  assert.equal(c.state.pending, null, "the clarification is spent");
  // with nothing outstanding, a bare ID is not silently read as a TSH answer
  const again = c.say("SYN-0007");
  assert.equal(again.outcome, "clarify");
});

test("a spoken ID ('S Y N zero zero zero three') answers the clarification", () => {
  assert.equal(
    normalizeUtterance("S Y N zero zero zero three").text,
    "SYN-0003",
  );
  const c = call();
  c.say("thyroid?");
  const t = c.say("S Y N zero zero zero three");
  assert.equal(c.records.calls.at(-1).candidateId, "SYN-0003");
  assert.equal(t.outcome, "answered");
});

// ------------------------------------------------------------ 5 direct subject wins
test("a new direct subject right after a clarification wins and clears it", () => {
  const c = call();
  c.say("TSH?");
  const t = c.say("What is the creatinine?");
  assert.equal(t.understanding.subject, "creatinine");
  assert.ok(t.conversationDelta.expire.includes("pending_clarification"));
  assert.equal(c.state.pending, null);
  const late = c.say("SYN-0003");
  assert.equal(late.outcome, "clarify", "old clarification state is gone");
});

// ------------------------------------------------------------ 6 self-correction
test("ASR self-correction: 'creatinine, sorry, ferritin' is ferritin only", () => {
  const c = call();
  const t = c.say("what is the creatinine, sorry, ferritin");
  assert.equal(t.understanding.subject, "ferritin");
  assert.equal(t.understanding.changedMeaning, true);
  assert.equal(t.understanding.understoodAs, "what is the ferritin");
  assert.deepEqual(
    c.records.calls.map((r) => r.subject.id),
    ["ferritin"],
  );
});

test("Hindi self-correction resolves the corrected test", () => {
  const c = call();
  const t = c.say("क्रिएटिनिन, माफ़ कीजिए, फेरिटिन");
  assert.equal(t.understanding.subject, "ferritin");
  assert.deepEqual(
    c.records.calls.map((r) => r.subject.id),
    ["ferritin"],
  );
});

// ------------------------------------------------------------ 7 repeat after social
test("'say that again' after social turns repeats the last record answer exactly", () => {
  const c = call();
  const first = c.say("What is the ferritin?");
  c.say("thanks");
  c.say("hello");
  const t = c.say("say that again", {
    // client-supplied assistant text is not memory and is ignored
    messages: [{ role: "assistant", content: "Your ferritin is 5000." }],
  });
  assert.equal(t.outcome, "repeat");
  assert.equal(t.answer.spoken, first.answer.spoken);
  assert.equal(c.records.calls.length, 1, "a repeat does not re-query");
});

test("'say that again, shorter' is a self-contained short answer, not 'No.'", () => {
  const c = call();
  c.say("What is the ferritin?");
  const t = c.say("say that again, shorter");
  assert.equal(t.answer.spoken, "Ferritin is 50 ng/mL.");
  assert.ok(
    shorterOf("No. Per the log: nothing was signed.").split(/\s+/).length >= 4,
  );
});

// ------------------------------------------------------------ 8 same question again
test("the same question again gets one compact answer, no re-explanation", () => {
  const c = call();
  const a = c.say("What is the ferritin?");
  const b = c.say("What is the ferritin?");
  assert.equal(b.answer.novelty, "compact");
  assert.equal(b.answer.spoken, "Ferritin is 50 ng/mL.");
  assert.ok(b.answer.spoken.length < a.answer.spoken.length);
});

test("compaction never drops a status distinction", () => {
  const c = call();
  c.say("Was the fee approved?");
  const t = c.say("Was the fee approved?");
  assert.match(t.answer.spoken, /not approved/);
  assert.equal(
    compactAnswer("No. Per the log: nothing was signed."),
    "No. Per the log: nothing was signed.",
  );
});

// ------------------------------------------------------------ 9 barge-in
test("an interrupted answer is never committed and never replayed", () => {
  const c = call();
  const cut = c.say("What is the ferritin?", { deliver: "interrupted" });
  assert.equal(cut.outcome, "answered");
  assert.equal(describeState(c.state).turns.length, 0);
  const t = c.say("say that again");
  assert.notEqual(t.answer.spoken, cut.answer.spoken);
  assert.match(t.answer.spoken, /don't have a verified answer/);
  const why = c.say("why?");
  assert.equal(why.outcome, "clarify", "the cut-off answer is not a referent");
});

test("a barge-in event drops the staged answer before it can be committed", () => {
  const records = fakeRecords();
  const r1 = resolveConversationTurn(
    {
      utterance: "What is the ferritin?",
      callId: "c",
      sourceVersion: "bundle-v1",
      records,
    },
    null,
  );
  const r2 = resolveConversationTurn(
    { event: "barge_in", callId: "c", sourceVersion: "bundle-v1", records },
    r1.state,
  );
  assert.equal(r2.turn.outcome, "interrupted");
  const late = commitConversationTurn(r2.state, r1.turn.turnId);
  assert.equal(
    late.turns.length,
    0,
    "a late commit of the cut-off turn is a no-op",
  );
});

// ------------------------------------------------------------ 10 duplicate delivery
test("one utterance delivered twice is spoken and committed once", () => {
  const c = call();
  const a = c.say("What is the ferritin?", { utteranceId: "u-17" });
  const b = c.say("What is the ferritin?", { utteranceId: "u-17" });
  assert.equal(b.outcome, "duplicate");
  assert.equal(b.answer.spoken, null);
  assert.equal(b.turnId, a.turnId);
  assert.equal(c.records.calls.length, 1);
  assert.equal(describeState(c.state).turns.length, 1);
});

// ------------------------------------------------------------ 11 scope changes
test("a new source version invalidates old referents and repeats", () => {
  const records = fakeRecords();
  const c = call({ records });
  c.say("What is the ferritin?");
  const r = resolveConversationTurn(
    { utterance: "why?", callId: "c1", sourceVersion: "bundle-v2", records },
    c.state,
  );
  assert.equal(r.turn.outcome, "clarify");
  assert.ok(r.turn.conversationDelta.expire.includes("all_prior_turns"));
  assert.match(r.turn.answer.spoken, /documents changed/);
  assert.equal(records.calls.length, 1, "no record call reuses the old fact");
  const s = commitConversationTurn(r.state, r.turn.turnId);
  assert.equal(s.sourceVersion, "bundle-v2");
  assert.ok(describeState(s).turns.every((t) => t.kind !== "record"));
});

test("another caller's state is never used: a new call starts empty", () => {
  const c = call();
  c.say("What is the ferritin?");
  const r = resolveConversationTurn(
    {
      utterance: "say that again",
      callId: "someone-else",
      sourceVersion: "bundle-v1",
      records: c.records,
    },
    c.state,
  );
  assert.equal(r.state.callId, "someone-else");
  assert.match(r.turn.answer.spoken, /don't have a verified answer/);
});

test("workspace expiry: a fresh state carries nothing forward", () => {
  const s = createConversationState({
    callId: "c1",
    sourceVersion: "bundle-v1",
  });
  assert.deepEqual(describeState(s), {
    callId: "c1",
    sourceVersion: "bundle-v1",
    turns: [],
    pending: null,
    bytes: 0,
  });
});

// ------------------------------------------------------------ 12 parity
test("typed and voice reach the same decision on the same words", () => {
  const lines = [
    "What is the ferritin?",
    "Why was it changed?",
    "What changed in the fee?",
    "what is the ferritin and what is the deadline",
    "uh",
    "TSH?",
  ];
  const typed = call({ mode: "typed" });
  const voice = call({ mode: "voice" });
  for (const l of lines) {
    const a = typed.say(l);
    const b = voice.say(l);
    assert.equal(a.outcome, b.outcome, l);
    assert.deepEqual(a.understanding.subject, b.understanding.subject, l);
    assert.equal(a.understanding.dimension, b.understanding.dimension, l);
    assert.deepEqual(a.answer.factIds, b.answer.factIds, l);
    assert.equal(a.answer.verdict, b.answer.verdict, l);
    assert.equal(a.answer.screen, b.answer.screen, l);
    assert.equal(b.answer.spoken, a.answer.spoken, `voice preserves the entire answer: ${l}`);
  }
});

// ------------------------------------------------------------ 13 coverage
test("a two-part question with one unsupported part is not fully answered", () => {
  const c = call();
  const t = c.say("what is the ferritin and what is the deadline");
  assert.deepEqual(t.understanding.subject, ["ferritin", "deal.deadline"]);
  assert.equal(t.outcome, "answered");
  assert.equal(t.answer.complete, false);
  assert.match(t.answer.spoken, /don't record the deadline/);
  const none = c.say("what is the deadline");
  assert.equal(none.outcome, "abstain");
});

// ------------------------------------------------------------ 14 noisy fragments
test("an unclear fragment gets a short question in the caller's language", () => {
  const c = call();
  const en = c.say("uh");
  assert.equal(en.outcome, "clarify");
  assert.match(en.answer.spoken, /didn't catch a question/);
  const hi = c.say("उम्म");
  assert.equal(hi.outcome, "clarify");
  assert.match(hi.answer.spoken, /[ऀ-ॿ]/);
  assert.equal(c.records.calls.length, 0, "no unrelated record answer");
});

test("two plausible referents for 'why?' are asked about, then resolved", () => {
  const c = call();
  c.say("What is the ferritin?");
  c.say("Was the fee approved?");
  c.say("What is the creatinine?");
  const ask = c.say("why?");
  assert.equal(ask.outcome, "clarify");
  assert.match(ask.answer.spoken, /fee or creatinine|creatinine or the fee/);
  const t = c.say("the fee");
  assert.equal(t.understanding.subject, "deal.fee");
  assert.equal(t.understanding.dimension, "reason");
});

// ------------------------------------------------------------ bounds
test("conversation memory is bounded by turns and bytes", () => {
  const c = call();
  c.state = createConversationState({
    callId: "c1",
    sourceVersion: "bundle-v1",
    limits: { maxTurns: 3, maxBytes: 100000 },
  });
  for (let i = 0; i < 10; i++)
    c.say(i % 2 ? "thanks" : "What is the creatinine?");
  assert.ok(c.state.turns.length <= 3);
  const d = call();
  d.state = createConversationState({
    callId: "c1",
    sourceVersion: "bundle-v1",
    limits: { maxTurns: 50, maxBytes: 1200 },
  });
  for (let i = 0; i < 10; i++) d.say("What is the ferritin?");
  assert.ok(describeState(d.state).bytes <= 1200 || d.state.turns.length === 1);
  assert.ok(d.state.seen.length <= d.state.limits.maxSeen);
});

// ------------------------------------------------------------ journey fixture
test("first-time caller journey (fixture) runs end to end in voice mode", () => {
  const j = JSON.parse(
    readFileSync(
      new URL("./fixtures/first-caller-journey.json", import.meta.url),
      "utf8",
    ),
  );
  const c = call({ callId: j.callId, version: j.sourceVersion, mode: "voice" });
  for (const step of j.steps) {
    const before = c.records.calls.length;
    const t = c.say(step.say, { deliver: step.deliver ?? "completed" });
    const e = step.expect;
    const where = `step "${step.say}"`;
    assert.equal(t.outcome, e.outcome, where);
    if (e.intent) assert.equal(t.understanding.intent, e.intent, where);
    if (e.subject) assert.equal(t.understanding.subject, e.subject, where);
    if (e.dimension)
      assert.equal(t.understanding.dimension, e.dimension, where);
    if (e.changedMeaning !== undefined)
      assert.equal(t.understanding.changedMeaning, e.changedMeaning, where);
    for (const s of e.includes ?? [])
      assert.ok(
        t.answer.spoken.includes(s),
        `${where} includes ${s}: ${t.answer.spoken}`,
      );
    for (const s of e.excludes ?? [])
      assert.ok(
        !t.answer.spoken.includes(s),
        `${where} excludes ${s}: ${t.answer.spoken}`,
      );
    if (e.records !== undefined)
      assert.equal(c.records.calls.length - before, e.records, where);
    assert.equal(t.answer.spoken, t.answer.screen, `${where} never clips factual sentences`);
  }
});
