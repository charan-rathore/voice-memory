// Meeting-transcript claim model: general claim-evolution, authority and
// citation-evidence binding over conversational records (transcripts,
// minutes, decision logs). Built against two SYNTHETIC fictional corpora:
// Mariner (examples/corpus-mariner.mjs) and Harbor (examples/corpus-harbor.mjs,
// an AUTHORED synthetic control conversation - same author, written to catch
// overfitting; it is NOT independent or unseen held-out validation).
// Expectations follow the independent human answer key for Mariner.
import test from "node:test";
import assert from "node:assert/strict";
import {
  importBundle,
  answer,
  extractClaims,
  resolveClaims,
  questionFields,
} from "../dist/engine.mjs";
import { MARINER_DOCS } from "../examples/corpus-mariner.mjs";
import { HARBOR_DOCS } from "../examples/corpus-harbor.mjs";

const ALL_FIELDS = [
  "fee",
  "paymentSplit",
  "deadline",
  "scope",
  "signoffWho",
  "signoffTiming",
  "signedAgreement",
  "launchApproval",
  "reporting",
];

const toBundle = (docs) => ({
  sources: docs.map((d, i) => ({
    id: "s" + i,
    title: d.title,
    text: d.text,
    hash: "h" + i,
  })),
});

const marinerClaims = extractClaims(toBundle(MARINER_DOCS), ALL_FIELDS).filter(
  (c) => c.value,
);
const harborClaims = extractClaims(toBundle(HARBOR_DOCS), ALL_FIELDS).filter(
  (c) => c.value,
);
const digits = (v) => String(v).replace(/[^\d]/g, "");
const feesOf = (claims) => claims.filter((c) => c.field === "fee");
const byDigits = (claims, d) =>
  claims.find((c) => digits(c.value) === digits(d));

// ---------- Mariner: claim extraction and evolution ----------

test("mariner: fee history 72k proposed -> 58k superseded -> 54k approved internal", () => {
  const fees = feesOf(marinerClaims);
  const f72 = byDigits(fees, "72000");
  const f58 = byDigits(fees, "58000");
  const f54 = byDigits(fees, "54000");
  assert.ok(f72, "USD 72,000 fee claim extracted (ISO-code currency)");
  assert.ok(f58, "USD 58,000 fee claim extracted");
  assert.ok(f54, "USD 54,000 fee claim extracted");
  assert.notEqual(f72.status, "approved", "72k was proposed, not approved");
  const f54ok = fees.filter(
    (c) => digits(c.value) === "54000" && c.status === "approved",
  );
  assert.ok(f54ok.length, "a USD 54,000 approved claim exists");
  assert.ok(
    f54ok.some((c) => c.authority === "internal"),
    "54k approved by INTERNAL finance",
  );
  const res = resolveClaims(fees);
  const supersededDigits = res.superseded.map((c) => digits(c.value));
  assert.ok(
    supersededDigits.includes("58000"),
    "58k marked superseded history",
  );
  assert.ok(
    supersededDigits.includes("72000"),
    "72k superseded by later revisions",
  );
  const active = [
    ...new Set(
      res.active
        .get("fee")
        .filter((c) => digits(c.value).length > 2)
        .map((c) => digits(c.value)),
    ),
  ];
  assert.deepEqual(active, ["54000"], "only 54k remains active");
});

test("mariner: question lines mint no claims and never appear in claim quotes", () => {
  for (const c of marinerClaims) {
    assert.ok(
      !c.quote.includes("?"),
      `claim quote must be an assertion, got: ${c.quote.slice(0, 80)}`,
    );
  }
  assert.ok(
    !marinerClaims.some((c) => /has 50\/50 been agreed/i.test(c.quote)),
  );
  assert.ok(!marinerClaims.some((c) => /was the fee rejected/i.test(c.quote)));
  assert.ok(
    !marinerClaims.some((c) =>
      /do we have an executed data processing addendum/i.test(c.quote),
    ),
  );
});

test("mariner: 30/70 internally approved, client not accepted; 50/50 only discussed", () => {
  const splits = marinerClaims.filter((c) => c.field === "paymentSplit");
  const s3070 = splits.filter((c) => c.value === "30/70");
  assert.ok(s3070.length, "30/70 split extracted from spelled-out percents");
  const appr = s3070.find(
    (c) => c.status === "approved" && c.authority === "internal",
  );
  assert.ok(appr, "finance internally approves 30/70");
  const clientNeg = s3070.find(
    (c) => c.status === "unresolved" && c.authority === "client",
  );
  assert.ok(clientNeg, "customer has NOT accepted 30/70 is recorded");
  assert.ok(
    !splits.some((c) => c.value === "50/50" && c.status === "approved"),
    "50/50 never approved",
  );
  const res = resolveClaims(splits);
  const apprVals = (res.approved.get("paymentSplit") ?? []).map((c) => c.value);
  assert.deepEqual(
    [...new Set(apprVals)],
    ["30/70"],
    "30/70 is the approved split",
  );
  assert.ok(
    (res.active.get("paymentSplit") ?? []).every(
      (c) => c.value !== "50/50" || c.status !== "approved",
    ),
  );
});

test("mariner: steering approval binds to scope only, NOT the fee", () => {
  const fees = feesOf(marinerClaims);
  const bodyFee = fees.filter((c) => c.authority === "body");
  assert.ok(
    bodyFee.length && bodyFee.every((c) => c.status === "unresolved"),
    "committee/steering approval recorded as NOT extending to fee",
  );
  const scopeApproved = marinerClaims.some(
    (c) =>
      c.field === "scope" && c.status === "approved" && c.authority === "body",
  );
  assert.ok(scopeApproved, "committee approved the scope");
});

test("mariner: scope East and West approved; original four-site superseded", () => {
  const scopes = marinerClaims.filter((c) => c.field === "scope");
  const approved = scopes.find(
    (c) =>
      c.status === "approved" && /east/i.test(c.value) && /west/i.test(c.value),
  );
  assert.ok(approved, "East and West sites approved claim");
  const res = resolveClaims(scopes);
  const four = scopes.find((c) => /four/i.test(c.value));
  assert.ok(four, "original four-site record extracted");
  assert.ok(
    res.superseded.includes(four),
    "four-site proposal superseded as phase-one scope",
  );
});

test("mariner: launch target history ends at December 10 internal target", () => {
  const dls = marinerClaims.filter((c) => c.field === "deadline");
  const dec10 = dls.find((c) => /december\s*10/i.test(c.value));
  assert.ok(dec10, "month-first date 'December 10' extracted");
  assert.equal(dec10.status, "internal-target");
  const res = resolveClaims(dls);
  const active = res.active.get("deadline");
  assert.equal(active.length, 1, "one live launch target");
  assert.ok(/december\s*10/i.test(active[0].value));
});

test("mariner: unsigned agreement and unsigned addendum recorded as negatives", () => {
  const ag = marinerClaims.filter((c) => c.field === "signedAgreement");
  const clientSigned = ag.find((c) => /client-signed/i.test(c.value));
  assert.ok(clientSigned, "no client-signed service agreement recorded");
  assert.equal(
    clientSigned.status,
    "unresolved",
    "a NO-signature record is itself unresolved, never approved",
  );
  assert.ok(
    ag.some((c) => c.status === "unresolved" && /addendum/i.test(c.value)),
    "no signed addendum recorded",
  );
});

// ---------- Mariner: answer-level (engine) ----------

const mb = importBundle(MARINER_DOCS);
const askM = (q) => answer(q, mb);

test("mariner answers: latest fee is 54k internal-only, unsigned", () => {
  const r = askM("What is the latest fee?");
  assert.match(r.answer, /54,?000/);
  assert.match(r.answer, /internal/i);
  assert.match(r.answer, /not accepted|unsigned|not signed|no client/i);
  assert.doesNotMatch(r.answer, /72,?000(?!.*history)/);
});

test("mariner answers: approved payment terms are 30/70 internal, not client-accepted", () => {
  const r = askM("Which payment terms were approved?");
  assert.match(r.answer, /30\s*\/\s*70/);
  assert.match(r.answer, /internal/i);
  assert.match(r.answer, /not accepted|has not accepted|customer/i);
});

test("mariner answers: steering did not approve the fee (scope only)", () => {
  const r = askM("Did steering approve the fee?");
  assert.match(r.answer, /^no\b|\bno[,.]/i);
  assert.match(r.answer, /scope/i);
  if (r.evidence?.length)
    assert.ok(
      r.evidence.some((e) => /applies to scope|scope of/i.test(e.quote)),
      "citation supports the exact verdict",
    );
});

test("mariner answers: client contract unsigned with supporting citation", () => {
  const r = askM("Is the client contract signed?");
  assert.match(r.answer, /\bno\b/i);
  if (r.evidence?.length)
    assert.ok(
      r.evidence.some((e) =>
        /no client-signed|not constitute|no signed/i.test(e.quote),
      ),
      "citation is a negative-signature record, got: " +
        r.evidence.map((e) => e.quote.slice(0, 60)).join(" | "),
    );
});

test("mariner answers: fee was not rejected", () => {
  const r = askM("Was the fee rejected?");
  assert.match(r.answer, /no rejection|not rejected|no\b.*rejected/i);
});

test("mariner answers: original proposal was four sites", () => {
  const r = askM("How many sites were originally proposed?");
  assert.match(r.answer, /four/i);
});

test("mariner answers: latest launch target is December 10, internal only", () => {
  const r = askM("What is the latest launch target?");
  assert.match(r.answer, /december\s+10/i);
  assert.match(r.answer, /internal/i);
  assert.match(
    r.answer,
    /not a contractual|not binding|no binding|tentative|target/i,
  );
});

test("mariner answers: original fee was 72k proposed not approved", () => {
  const r = askM("What was the original fee?");
  assert.match(r.answer, /72,?000/);
  assert.match(r.answer, /not approved|proposed|never approved/i);
});

test("mariner answers: August revised fee was 58k, later replaced", () => {
  const r = askM("What was the revised fee in August?");
  assert.match(r.answer, /58,?000/);
  assert.match(r.answer, /proposed|superseded|replaced|not.*approved/i);
});

test("mariner answers: 50/50 was discussed only", () => {
  const r = askM("Was the 50/50 split agreed?");
  assert.match(r.answer, /\bno\b/i);
  assert.match(r.answer, /discussed/i);
});

test("mariner answers: approved sites are East and West", () => {
  const r = askM("Which sites were approved?");
  assert.match(r.answer, /east/i);
  assert.match(r.answer, /west/i);
});

test("mariner answers: addendum unsigned", () => {
  const r = askM("Is the data processing addendum signed?");
  assert.match(r.answer, /\bno\b/i);
});

test("mariner answers: invoice amount is not the fee (absence-of-record)", () => {
  const r = askM("What is the invoice amount?");
  assert.doesNotMatch(r.answer, /54,?000/);
  assert.match(
    r.answer,
    /no invoice|not recorded|could not find|no .*invoice/i,
  );
});

test("mariner answers: retention period is 30 days internal, not 90", () => {
  const r = askM("What is the retention period?");
  assert.match(r.answer, /30[ -]days?/i);
  assert.doesNotMatch(r.answer, /^[^.]*\b90[ -]days?\b[^.]*\.$/);
});

test("mariner answers: client signatory not recorded", () => {
  const r = askM("Who is the client signatory?");
  assert.match(
    r.answer,
    /no named|not recorded|could not find|no .*signatory/i,
  );
});

// ---------- Held-out paraphrases ----------

test("paraphrase: fee at the very beginning", () => {
  const r = askM("How much was the fee at the very beginning?");
  assert.match(r.answer, /72,?000/);
});

test("paraphrase: has the customer signed off on the contract", () => {
  const r = askM("Has the customer signed off on the contract?");
  assert.match(r.answer, /\bno\b/i);
});

test("paraphrase: current payment schedule", () => {
  const r = askM("What is the current payment schedule?");
  assert.match(r.answer, /30\s*\/\s*70/);
});

// ---------- Negative controls ----------

test("negative: a fabricated fee value is never confirmed", () => {
  const r = askM("Was the USD 99,000 fee approved?");
  assert.doesNotMatch(r.answer, /^yes\b|\byes[,.!]/i);
});

test("negative: no invoice exists, even naming the fee amount", () => {
  const r = askM("Has the invoice for USD 54,000 been issued?");
  assert.doesNotMatch(r.answer, /^yes\b|\byes[,.!]/i);
});

// ---------- Harbor: held-out unseen conversation ----------

test("harbor: fee evolution 41k -> 36.5k -> 34k internal-approved", () => {
  const fees = feesOf(harborClaims);
  const res = resolveClaims(fees);
  const active = [
    ...new Set(
      res.active
        .get("fee")
        .filter((c) => digits(c.value).length > 2)
        .map((c) => digits(c.value)),
    ),
  ];
  assert.deepEqual(active, ["34000"]);
  assert.ok(
    fees.some(
      (c) =>
        digits(c.value) === "34000" &&
        c.status === "approved" &&
        c.authority === "internal",
    ),
    "34k approved internally",
  );
});

test("harbor: 25/75 internal-approved, customer not accepted; 40/60 discussed", () => {
  const splits = harborClaims.filter((c) => c.field === "paymentSplit");
  assert.ok(
    splits.some(
      (c) =>
        c.value === "25/75" &&
        c.status === "approved" &&
        c.authority === "internal",
    ),
  );
  assert.ok(
    splits.some(
      (c) =>
        c.value === "25/75" &&
        c.status === "unresolved" &&
        c.authority === "client",
    ),
  );
  assert.ok(
    !splits.some((c) => c.value === "40/60" && c.status === "approved"),
  );
});

test("harbor: no question-line claims", () => {
  for (const c of harborClaims) assert.ok(!c.quote.includes("?"));
});

const hb = importBundle(HARBOR_DOCS);

test("harbor answers: board did not approve the fee (scope only)", () => {
  const r = answer("Did the board approve the fee?", hb);
  assert.match(r.answer, /\bno\b/i);
  assert.match(r.answer, /scope/i);
});

test("harbor answers: original proposal was three depots", () => {
  const r = answer("How many depots were originally proposed?", hb);
  assert.match(r.answer, /three/i);
});

test("harbor answers: latest go-live target is December 4 internal", () => {
  const r = answer("What is the latest go-live target?", hb);
  assert.match(r.answer, /december\s+4/i);
  assert.match(r.answer, /internal/i);
});

test("harbor answers: approved payment split 25/75 internal not client-accepted", () => {
  const r = answer("Which payment terms were approved?", hb);
  assert.match(r.answer, /25\s*\/\s*75/);
  assert.match(r.answer, /internal/i);
});

test("harbor answers: latest fee EUR 34,000 internal, unsigned", () => {
  const r = answer("What is the latest fee?", hb);
  assert.match(r.answer, /34,?000|34,000/);
  assert.match(r.answer, /internal/i);
  assert.match(r.answer, /not accepted|unsigned|not signed|no client/i);
});

// ---------- Routing ----------

test("routing: launch target questions reach the deadline field", () => {
  assert.ok(
    questionFields("What is the latest launch target?").includes("deadline"),
  );
  assert.ok(
    questionFields("What is the latest go-live target?").includes("deadline"),
  );
});

test("routing: invoice questions do not alias to the fee field", () => {
  assert.ok(!questionFields("What is the invoice amount?").includes("fee"));
});

test("content sentences with dates never become section dates (F1)", () => {
  const docs = [
    {
      title: "Minutes",
      text: "# Minutes\nDeadline is 2026-09-01.\nSee the 2026-08-05 minutes.\nThe fee was agreed on 2026-09-05 in writing and recorded.\nJordan: The pilot fee is proposed at USD 10,000.\n",
    },
  ];
  const claims = extractClaims(toBundle(docs), ALL_FIELDS);
  const fee = claims.find((c) => c.field === "fee");
  assert.ok(fee, "fee claim minted");
  assert.equal(
    fee.docDate,
    "",
    "content-sentence dates must not date the claim",
  );
});

test("bare fractions with plan/draft cues are not payment splits (F2)", () => {
  const docs = [
    {
      title: "Plan",
      text: "# Plan\nDev: The rollout plan covers 2/3 of the depots.\nMira: The draft milestone table shows phase 1/2 complete.\nJordan: Finance internally approves a 30 percent upfront / 70 percent after acceptance split.\n",
    },
  ];
  const claims = extractClaims(toBundle(docs), ALL_FIELDS);
  const splits = claims.filter((c) => c.field === "paymentSplit");
  assert.deepEqual(
    splits.map((c) => c.value),
    ["30/70"],
  );
});

test("modal capability is not approval (F4)", () => {
  const docs = [
    {
      title: "Ops",
      text: "# Ops\nDev: We can accept delivery in October.\nJordan: We can accept the pilot fee of USD 50,000 in October.\n",
    },
  ];
  const claims = extractClaims(toBundle(docs), ALL_FIELDS);
  assert.equal(
    claims.filter((c) => c.status === "approved").length,
    0,
    "'can accept' is capability, never approval",
  );
  const fee = claims.find((c) => c.field === "fee");
  assert.ok(fee, "fee claim still minted");
  assert.notEqual(
    fee.status,
    "approved",
    "modal accept is not an approved fee",
  );
});

test("dated supersession never demotes an undated record across documents (F9)", () => {
  const docs = [
    {
      title: "Acme pilot note",
      text: "# Acme pilot\nJordan: The fee is USD 40,000, proposed.\n",
    },
    {
      title: "Acme pilot revision",
      text: "# Acme pilot\nDate: 2026-09-01\nJordan: The earlier USD 40,000 fee proposal is superseded; the fee is USD 45,000.\n",
    },
  ];
  const claims = extractClaims(toBundle(docs), ALL_FIELDS);
  const { active, superseded } = resolveClaims(claims);
  const fees = active.get("fee") ?? [];
  const old = claims.find((c) => c.value.includes("40,000") && !c.docDate);
  assert.ok(old, "undated 40k claim exists");
  assert.ok(
    !superseded.includes(old),
    "undated record is not silently demoted by a dated statement",
  );
  assert.ok(
    fees.some((c) => c.value.includes("40,000")) &&
      fees.some((c) => c.value.includes("45,000")),
    "undated and dated records compete honestly",
  );
});

test("month questions bind the asked or latest year, never a hardcoded one (F6)", () => {
  const docs = [
    {
      title: "Acme pilot 2025",
      text: "# Acme pilot\nDate: 2025-08-10\nJordan: The pilot fee is proposed at USD 30,000.\n",
    },
    {
      title: "Acme pilot 2026",
      text: "# Acme pilot\nDate: 2026-08-10\nJordan: The pilot fee is proposed at USD 36,000.\n",
    },
  ];
  const b = importBundle(docs);
  const r26 = answer("What was the fee in August?", b);
  assert.match(r26.answer, /36,000/, "latest year's August record answers");
  assert.match(r26.answer, /2026/, "the year is disclosed");
  const r25 = answer("What was the fee in August 2025?", b);
  assert.match(r25.answer, /30,000/, "explicit year is honored");
});
