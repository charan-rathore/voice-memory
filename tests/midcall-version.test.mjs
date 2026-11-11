import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createVoiceAdapter } from "../src/voice-adapter.mjs";
import { importBundle } from "../dist/engine.mjs";
import { server } from "../src/server.mjs";

// Mid-call document changes: the corpus version an answer used must be
// explicit, a newer version's arrival must be disclosed, and the two must
// never be silently mixed inside one conversation.

const brief = (day) => [
  {
    title: "Launch brief",
    text: `${day} owns the security review. Pilot launch is proposed for Friday.`,
  },
];
const v1 = () => importBundle(brief("Maya"));
const v2 = () => importBundle(brief("Nina"));
const TOKEN = "f".repeat(32);
const request = (token, text) =>
  new Request("http://localhost/v1/chat/completions", {
    method: "POST",
    headers: { authorization: "Bearer " + token },
    body: JSON.stringify({
      stream: true,
      messages: [{ role: "user", content: text }],
    }),
  });
const ask = async (a, token, q) => {
  const r = await a.handle(request(token, q));
  const raw = await r.text();
  const text = raw
    .split("\n")
    .filter((line) => line.startsWith("data: {"))
    .map((line) => JSON.parse(line.slice(6)).choices?.[0]?.delta?.content ?? "")
    .join("");
  return { status: r.status, text };
};

function scopedAdapter() {
  const a = createVoiceAdapter();
  let bundle;
  const bind = a.bind.bind(a),
    retarget = a.retarget.bind(a);
  a.bind = (b, token) => {
    bundle = b;
    return bind(b, token);
  };
  a.retarget = (token, b) => {
    bundle = b;
    return retarget(token, b);
  };
  a.setBundleResolver(() => ({ bundle, call: "test-call", caseId: "owned" }));
  return a;
}

test("voice: a mid-call corpus update is disclosed once, then the new version answers", async () => {
  const a = scopedAdapter();
  a.bind(v1(), TOKEN);
  const first = await ask(a, TOKEN, "Who owns the security review?");
  assert.equal(first.status, 200);
  assert.ok(!first.text.includes("changed since my previous answer"));
  assert.ok(
    (a.lastTurn(TOKEN).result.evidence ?? []).some((e) =>
      JSON.stringify(e).includes("Maya"),
    ),
  );
  // The owner edits the document mid-call: retarget drops the live grant.
  a.retarget(TOKEN, v2());
  const second = await ask(a, TOKEN, "Who owns the security review?");
  assert.equal(second.status, 200);
  assert.match(second.text, /changed since my previous answer/);
  const evidence = (a.lastTurn(TOKEN).result.evidence ?? []).map((e) =>
    JSON.stringify(e),
  );
  assert.ok(
    evidence.some((e) => e.includes("Nina")),
    "the answer after the update must come from the new version",
  );
  assert.ok(
    evidence.every((e) => !e.includes("Maya")),
    "no stale-version evidence may leak into the new answer",
  );
  const noticeTurn = a.lastTurn(TOKEN);
  assert.equal(noticeTurn.versionNotice, true);
  // One-shot: the next evidence answer carries no notice.
  const third = await ask(a, TOKEN, "Who owns the security review?");
  assert.equal(third.status, 200);
  assert.ok(!third.text.includes("changed since my previous answer"));
});

test("voice: a retarget before any spoken evidence answer raises no false notice", async () => {
  const a = scopedAdapter();
  a.bind(v1(), TOKEN);
  a.retarget(TOKEN, v2());
  const r = await ask(a, TOKEN, "Who owns the security review?");
  assert.equal(r.status, 200);
  assert.ok(!r.text.includes("changed since my previous answer"));
});

test("voice: re-importing identical content is not a corpus change", async () => {
  const a = scopedAdapter();
  a.bind(v1(), TOKEN);
  await ask(a, TOKEN, "Who owns the security review?");
  a.retarget(TOKEN, v1());
  const r = await ask(a, TOKEN, "Who owns the security review?");
  assert.equal(r.status, 200);
  assert.ok(!r.text.includes("changed since my previous answer"));
});

test("voice: social talk does not consume the pending update notice", async () => {
  const a = scopedAdapter();
  a.bind(v1(), TOKEN);
  await ask(a, TOKEN, "Who owns the security review?");
  a.retarget(TOKEN, v2());
  const social = await ask(a, TOKEN, "thank you");
  assert.equal(social.status, 200);
  assert.ok(!social.text.includes("changed since my previous answer"));
  const real = await ask(a, TOKEN, "Who owns the security review?");
  assert.equal(real.status, 200);
  assert.match(real.text, /changed since my previous answer/);
});

test("voice: an in-flight turn during a retarget fails closed, never mixes", async () => {
  const a = scopedAdapter();
  a.bind(v1(), TOKEN);
  await ask(a, TOKEN, "Who owns the security review?");
  // Start a turn, then change the corpus before its body is read: the
  // grant the turn admitted on is gone, so it must reject rather than
  // answer from either version.
  const pending = a.handle(request(TOKEN, "Who owns the security review?"));
  a.retarget(TOKEN, v2());
  const r = await pending;
  assert.equal(r.status, 401);
  // The next turn rebinds and discloses the new version.
  const next = await ask(a, TOKEN, "Who owns the security review?");
  assert.equal(next.status, 200);
  assert.match(next.text, /changed since my previous answer/);
});

const root = "http://127.0.0.1:4319";
before(async () => new Promise((r) => server.listen(4319, "127.0.0.1", r)));
after(async () => new Promise((r) => server.close(r)));
async function session() {
  const r = await fetch(root + "/api/session");
  return {
    cookie: r.headers.get("set-cookie").split(";")[0],
    csrf: (await r.json()).csrf,
  };
}
const post = (s, p, body) =>
  fetch(root + "/api/" + p, {
    method: "POST",
    headers: {
      cookie: s.cookie,
      origin: root,
      "X-CSRF-Token": s.csrf,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

test("typed: every answer names its corpus version and flags a change", async () => {
  const s = await session();
  assert.equal(
    (await post(s, "import", { documents: brief("Maya") })).status,
    200,
  );
  const q = () =>
    post(s, "query", { question: "Who owns the security review?" });
  const first = await (await q()).json();
  assert.match(first.corpus.version, /^[0-9a-f]{64}$/);
  assert.equal(first.corpus.changedSinceLastAnswer, false);
  const again = await (await q()).json();
  assert.equal(again.corpus.version, first.corpus.version);
  assert.equal(again.corpus.changedSinceLastAnswer, false);
  // The owner edits the document: the next answer must say so, once.
  assert.equal(
    (await post(s, "import", { documents: brief("Nina") })).status,
    200,
  );
  const changed = await (await q()).json();
  assert.equal(changed.corpus.changedSinceLastAnswer, true);
  assert.notEqual(changed.corpus.version, first.corpus.version);
  const settled = await (await q()).json();
  assert.equal(settled.corpus.changedSinceLastAnswer, false);
  // Reverting to the identical earlier content is that same version again.
  assert.equal(
    (await post(s, "import", { documents: brief("Maya") })).status,
    200,
  );
  const reverted = await (await q()).json();
  assert.equal(reverted.corpus.version, first.corpus.version);
  assert.equal(reverted.corpus.changedSinceLastAnswer, true);
});

test("typed: an answer concurrent with a corpus swap is single-version or refused", async () => {
  const s = await session();
  assert.equal(
    (await post(s, "import", { documents: brief("Maya") })).status,
    200,
  );
  for (let i = 0; i < 20; i++) {
    const docs = brief(i % 2 ? "Maya" : "Nina");
    const [imp, qr] = await Promise.all([
      post(s, "import", { documents: docs }),
      post(s, "query", { question: "Who owns the security review?" }),
    ]);
    assert.equal(imp.status, 200);
    if (qr.status === 200) {
      const body = await qr.json();
      const quotes = (body.evidence ?? []).map((e) => JSON.stringify(e));
      const tuesday = quotes.some((q) => q.includes("Maya"));
      const thursday = quotes.some((q) => q.includes("Nina"));
      assert.ok(
        !(tuesday && thursday),
        "one answer must never mix evidence from two corpus versions",
      );
    } else {
      const body = await qr.json();
      assert.match(
        body.error ?? "",
        /Documents changed while answering/,
        "the only acceptable failure is the explicit documents-changed refusal",
      );
    }
  }
});

// Shared bearer boundaries: one caller must never learn another caller's
// update state, even when both callers use the very same credential.
test("voice: shared fixed credential isolates version notices by call handle", async () => {
  const a = createVoiceAdapter();
  let bundle = v1(),
    call = "call-A";
  a.bind(bundle, TOKEN);
  a.setBundleResolver(() => ({ bundle, call, caseId: "owned" }));
  await ask(a, TOKEN, "Who owns the security review?");
  bundle = v2();
  a.retarget(TOKEN, bundle);
  call = "call-B";
  const other = await ask(a, TOKEN, "Who owns the security review?");
  assert.doesNotMatch(other.text, /changed since my previous answer/);
  call = "call-A";
  const same = await ask(a, TOKEN, "Who owns the security review?");
  assert.match(same.text, /changed since my previous answer/);
});

test("voice: unscoped fixed bearer never claims a call-specific update", async () => {
  const a = createVoiceAdapter();
  a.bind(v1(), TOKEN);
  await ask(a, TOKEN, "Who owns the security review?");
  a.retarget(TOKEN, v2());
  const next = await ask(a, TOKEN, "Who owns the security review?");
  assert.doesNotMatch(next.text, /changed since my previous answer/);
  assert.match(a.lastTurn(TOKEN).corpus.version, /^[0-9a-f]{64}$/);
});

test("voice: resolver bundle swap mid-answer speaks the existing refusal without old facts", async () => {
  const a = createVoiceAdapter();
  let bundle = v1(),
    lookups = 0;
  a.bind(bundle, TOKEN);
  a.setBundleResolver(() => {
    lookups++;
    if (lookups >= 2) bundle = v2();
    return { bundle, call: "call-A", caseId: "owned" };
  });
  const r = await ask(a, TOKEN, "Who owns the security review?");
  assert.equal(r.status, 200);
  assert.match(r.text, /documents changed or became unavailable/);
  assert.doesNotMatch(r.text, /Maya|Nina/);
  assert.equal(a.lastTurn(TOKEN).spokenTurn.intent, "SCOPE_CHANGED");
  assert.deepEqual(a.lastTurn(TOKEN).spokenTurn.citations, []);
});

test("voice: update notice precedes both grounded facts and document refusals", async () => {
  const a = scopedAdapter();
  a.bind(v1(), TOKEN);
  await ask(a, TOKEN, "Who owns the security review?");
  a.retarget(TOKEN, v2());
  const changed = await ask(a, TOKEN, "What is the server password?");
  assert.match(
    changed.text,
    /^Your documents changed since my previous answer/,
  );
  assert.doesNotMatch(changed.text, /Maya|Nina/);
  assert.equal(a.lastTurn(TOKEN).versionNotice, true);
  assert.equal((a.lastTurn(TOKEN).spokenTurn?.citations ?? []).length, 0);
  // The notice was already given with the refusal; unchanged factual turns
  // must not repeat it or suggest another new version arrived.
  const fact = await ask(a, TOKEN, "Who owns the security review?");
  assert.doesNotMatch(fact.text, /changed since my previous answer/);
  assert.match(fact.text, /Nina/);
});

test("voice: unavailable scope never announces facts from an updated set", async () => {
  const a = createVoiceAdapter();
  let bundle = v1(),
    gone = false;
  a.bind(bundle, TOKEN);
  a.setBundleResolver(() =>
    gone
      ? { expired: true, call: "call-A", caseId: "owned" }
      : { bundle, call: "call-A", caseId: "owned" },
  );
  await ask(a, TOKEN, "Who owns the security review?");
  gone = true;
  const r = await ask(a, TOKEN, "Who owns the security review?");
  assert.doesNotMatch(r.text, /Maya|Nina|using the updated documents/);
});

test("voice: superseded turn cannot consume or roll back a newer version notice", async () => {
  const { cite } = await import("../src/spoken-routes.mjs");
  const a = scopedAdapter();
  a.bind(v1(), TOKEN);
  let delayed = false;
  const pending = [];
  a.setAnswerResolver(async ({ bundle }) => {
    if (delayed) await new Promise((r) => pending.push(r));
    const src = bundle.sources[0],
      end = src.text.indexOf(".") + 1;
    return {
      lead: {
        text: src.text.slice(0, end),
        verdict: "QUOTED",
        citations: [cite(src, { start: 0, end })],
      },
    };
  });
  await ask(a, TOKEN, "Who owns the security review?");
  a.retarget(TOKEN, v2());
  delayed = true;
  const first = ask(a, TOKEN, "Who owns the security review?");
  await new Promise((r) => setImmediate(r));
  const second = ask(a, TOKEN, "Who owns the security review?");
  await new Promise((r) => setImmediate(r));
  assert.equal(pending.length, 2);
  pending[1]();
  const newer = await second;
  assert.equal(newer.status, 200);
  assert.match(newer.text, /^Your documents changed since my previous answer/);
  assert.match(newer.text, /Nina/);
  pending[0]();
  const superseded = await first;
  assert.equal(superseded.status, 409);
  delayed = false;
  const next = await ask(a, TOKEN, "Who owns the security review?");
  assert.equal(next.status, 200);
  assert.doesNotMatch(next.text, /changed since my previous answer/);
});
